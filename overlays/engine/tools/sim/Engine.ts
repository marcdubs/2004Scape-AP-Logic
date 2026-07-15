// The reachability engine: given seed-aware skill caps + the quest requirements
// database, computes which quests/goals are attainable and in what order (spheres).
// See docs/progression-sim.md for the full design writeup and the "Simplifications"
// section for what this deliberately does NOT model (time/xp cost, AP item receipt
// ORDER, region locks beyond the documented judgment calls).
//
// Core simplification (documented prominently, per the design brief): skill training
// has no time/xp cost in this model - a skill is "trained" the instant it's needed, up
// to its seed-fixed cap (from ap-unlocks.json, constant for the whole run - simulating
// mid-run AP item receipt ORDER is a later feature, noted below and in the doc). This
// means a "sphere" is entirely about QUEST unlocks (QP thresholds + prerequisite
// quests), not about skill grinding - which matches how Archipelago logic actually
// works (reachability, not real-time pacing).

import { GatherProcessConfig, SeedConfig, allSkillCaps, getSkillCap, getUnlockCount } from './ConfigLoader.js';
import { Goal, QuestReq, StatName } from './types.js';

export interface Blocker {
    /** e.g. "quest:legends" or "goal:kbd" */
    subject: string;
    subjectName: string;
    reason: string;
    /** Nested blockers this one depends on (e.g. a blocked prereq quest's own blockers). */
    children: Blocker[];
}

export interface SphereEvent {
    sphere: number;
    questsCompleted: { id: string; name: string }[];
    goalsReached: { id: string; name: string }[];
}

export interface SimResult {
    seedConfig: SeedConfig;
    skillCaps: Record<StatName, number>;
    spheres: SphereEvent[];
    completedQuests: string[];
    totalQp: number;
    goalStatus: { goal: Goal; reached: boolean; sphereReached: number | null; blockers: Blocker[] }[];
    allGoalsReached: boolean;
    unreachedQuests: { quest: QuestReq; blockers: Blocker[] }[];
}

type ReqLike = {
    requiredQp?: number;
    skills?: Partial<Record<StatName, number>>;
    quests?: string[];
    questsAny?: string[][];
};

function skillsSatisfied(req: ReqLike, caps: Record<StatName, number>): boolean {
    if (!req.skills) {
        return true;
    }
    for (const [stat, level] of Object.entries(req.skills) as [StatName, number][]) {
        if (caps[stat] < level) {
            return false;
        }
    }
    return true;
}

function questsSatisfied(req: ReqLike, completed: Set<string>): boolean {
    if (req.quests) {
        for (const id of req.quests) {
            if (!completed.has(id)) {
                return false;
            }
        }
    }
    if (req.questsAny) {
        for (const group of req.questsAny) {
            if (!group.some(id => completed.has(id))) {
                return false;
            }
        }
    }
    return true;
}

function qpSatisfied(req: ReqLike, qp: number): boolean {
    return req.requiredQp === undefined || qp >= req.requiredQp;
}

function isSatisfied(req: ReqLike, caps: Record<StatName, number>, completed: Set<string>, qp: number): boolean {
    return skillsSatisfied(req, caps) && questsSatisfied(req, completed) && qpSatisfied(req, qp);
}

/**
 * Diagnoses why `req` isn't satisfied given the FINAL fixpoint state, recursing into
 * unmet quest prerequisites (cycle-safe via `visiting`). This is the "precise blocker
 * report" the design brief asks for: every leaf blocker names the exact unsatisfiable
 * requirement (a capped stat vs. what's needed, a missing QP threshold, or a
 * prerequisite quest that itself never completed).
 */
function diagnose(
    req: ReqLike,
    caps: Record<StatName, number>,
    completed: Set<string>,
    qp: number,
    questsById: Map<string, QuestReq>,
    visiting: Set<string> = new Set()
): Blocker[] {
    const blockers: Blocker[] = [];

    if (req.skills) {
        for (const [stat, level] of Object.entries(req.skills) as [StatName, number][]) {
            if (caps[stat] < level) {
                blockers.push({
                    subject: `skill:${stat}`,
                    subjectName: stat,
                    reason: `${stat} capped at ${caps[stat]} by unlocks; needs ${level}`,
                    children: []
                });
            }
        }
    }

    if (req.requiredQp !== undefined && qp < req.requiredQp) {
        blockers.push({
            subject: 'qp',
            subjectName: 'Quest Points',
            reason: `has ${qp} QP; needs ${req.requiredQp}`,
            children: []
        });
    }

    const diagnoseQuestId = (id: string): Blocker => {
        const quest = questsById.get(id);
        const name = quest?.name ?? id;
        if (completed.has(id)) {
            // Shouldn't be called for completed ids, but stay defensive.
            return { subject: `quest:${id}`, subjectName: name, reason: 'complete', children: [] };
        }
        if (visiting.has(id)) {
            return { subject: `quest:${id}`, subjectName: name, reason: 'cycle detected (should not happen - quest dependency graph is expected to be a DAG)', children: [] };
        }
        if (!quest) {
            return { subject: `quest:${id}`, subjectName: id, reason: 'unknown quest id referenced in requirements database', children: [] };
        }
        visiting.add(id);
        const childBlockers = diagnose(quest, caps, completed, qp, questsById, visiting);
        visiting.delete(id);
        return {
            subject: `quest:${id}`,
            subjectName: name,
            reason: childBlockers.length > 0 ? 'not completed - blocked itself' : 'not completed (reachable, but not yet reached - should not happen after a full fixpoint run)',
            children: childBlockers
        };
    };

    if (req.quests) {
        for (const id of req.quests) {
            if (!completed.has(id)) {
                blockers.push(diagnoseQuestId(id));
            }
        }
    }

    if (req.questsAny) {
        for (const group of req.questsAny) {
            if (!group.some(id => completed.has(id))) {
                blockers.push({
                    subject: `questsAny:${group.join('|')}`,
                    subjectName: `one of [${group.map(id => questsById.get(id)?.name ?? id).join(', ')}]`,
                    reason: `none of these are completed`,
                    children: group.map(diagnoseQuestId)
                });
            }
        }
    }

    return blockers;
}

/**
 * Generic (currently unused by any entry in quests.json - see docs/progression-sim.md
 * "Item requirements") helper for the seed-aware item-swap check the design brief
 * describes: given a vanilla obj id a quest step needs, find what NOW produces it under
 * gathersanity/processsanity shuffle (swap maps are bijective in "shuffle" mode), or
 * report it orphaned (possible under "chaos" mode). Kept as a ready extension point
 * rather than deleted, since a future quests.json entry may need it.
 */
export function findGatherOrProcessSource(vanillaObjId: string, config: GatherProcessConfig): { sourceObjId: string; found: true } | { found: false } {
    if (!config.present) {
        return { sourceObjId: vanillaObjId, found: true }; // vanilla: the item's own vanilla source still yields it.
    }
    for (const [source, product] of config.map.entries()) {
        if (product === vanillaObjId) {
            return { sourceObjId: source, found: true };
        }
    }
    // Not a swap target: either it was never a pool product (vanilla passthrough) or,
    // in chaos mode, it lost its only mapping (orphaned).
    if (config.mode === 'chaos') {
        return { found: false };
    }
    return { sourceObjId: vanillaObjId, found: true };
}

export function runSimulation(quests: QuestReq[], goals: Goal[], seedConfig: SeedConfig): SimResult {
    const caps = allSkillCaps(seedConfig.unlocks);
    const questsById = new Map(quests.map(q => [q.id, q]));

    const completed = new Set<string>();
    let qp = 0;
    const spheres: SphereEvent[] = [];
    const goalReachedAtSphere = new Map<string, number>();

    let sphere = 0;
    const goalSatisfiedNow = (g: Goal) => isSatisfied(g, caps, completed, qp);

    // Sphere 0 goal check (in case a goal needs literally nothing).
    for (const g of goals) {
        if (goalSatisfiedNow(g) && !goalReachedAtSphere.has(g.id)) {
            goalReachedAtSphere.set(g.id, 0);
        }
    }

    for (;;) {
        const newlyCompleted: QuestReq[] = [];
        for (const q of quests) {
            if (completed.has(q.id)) {
                continue;
            }
            if (isSatisfied(q, caps, completed, qp)) {
                newlyCompleted.push(q);
            }
        }

        if (newlyCompleted.length === 0) {
            break; // fixpoint
        }

        sphere += 1;
        for (const q of newlyCompleted) {
            completed.add(q.id);
            qp += q.qp;
        }

        const newlyReachedGoals: Goal[] = [];
        for (const g of goals) {
            if (!goalReachedAtSphere.has(g.id) && goalSatisfiedNow(g)) {
                goalReachedAtSphere.set(g.id, sphere);
                newlyReachedGoals.push(g);
            }
        }

        spheres.push({
            sphere,
            questsCompleted: newlyCompleted.map(q => ({ id: q.id, name: q.name })),
            goalsReached: newlyReachedGoals.map(g => ({ id: g.id, name: g.name }))
        });

        // Deliberately NOT stopping early once every goal is reached: running to full
        // fixpoint gives complete data for -v1/-v2 ("what else became reachable along the
        // way") and for the unreachedQuests report (genuinely dead quests vs. ones nobody
        // needed to bother with). 63 quests converges in a handful of iterations either way.
    }

    const goalStatus = goals.map(g => {
        const reached = goalReachedAtSphere.has(g.id);
        return {
            goal: g,
            reached,
            sphereReached: reached ? goalReachedAtSphere.get(g.id)! : null,
            blockers: reached ? [] : diagnose(g, caps, completed, qp, questsById)
        };
    });

    const unreachedQuests = quests
        .filter(q => !completed.has(q.id))
        .map(q => ({ quest: q, blockers: diagnose(q, caps, completed, qp, questsById) }));

    return {
        seedConfig,
        skillCaps: caps,
        spheres,
        completedQuests: [...completed],
        totalQp: qp,
        goalStatus,
        allGoalsReached: goalStatus.every(g => g.reached),
        unreachedQuests
    };
}
