// Renderers: spheres -> steps -> story, per the user's locked verbosity design.
// -v0: sphere summary. -v1: per-step actions with requirements. -v2: full narration
// referencing the actual seed (spawn label, unlock counts, gather/process swaps,
// entrance flavor). All three are deterministic (no RNG in prose selection) - given the
// same SimResult they always render identically, which matters since -v2 output is a
// user-facing artifact people will compare seed to seed.

import { Blocker, SimResult } from './Engine.js';
import { QuestReq, StatName } from './types.js';

type QuestIndex = Map<string, QuestReq>;

function fmtSkills(skills: Partial<Record<StatName, number>> | undefined): string {
    if (!skills || Object.keys(skills).length === 0) {
        return '';
    }
    return Object.entries(skills)
        .map(([stat, lvl]) => `${stat} ${lvl}`)
        .join(', ');
}

function fmtBlocker(b: Blocker, indent: string): string[] {
    const lines = [`${indent}- ${b.subjectName}: ${b.reason}`];
    for (const child of b.children) {
        lines.push(...fmtBlocker(child, indent + '  '));
    }
    return lines;
}

export function buildQuestIndex(quests: QuestReq[]): QuestIndex {
    return new Map(quests.map(q => [q.id, q]));
}

export function renderV0(result: SimResult): string[] {
    const lines: string[] = [];
    lines.push(`=== Progression Simulation (spheres -> goals) ===`);
    lines.push(`Spawn: ${result.seedConfig.spawn.label}`);
    lines.push(`Skill caps: ${result.seedConfig.unlocks.present ? 'seeded (ap-unlocks.json present)' : 'uncapped (vanilla - no ap-unlocks.json)'}`);
    lines.push('');

    for (const s of result.spheres) {
        const parts: string[] = [];
        if (s.questsCompleted.length > 0) {
            parts.push(s.questsCompleted.map(q => q.name).join(', '));
        }
        if (parts.length === 0 && s.goalsReached.length === 0) {
            continue;
        }
        let line = `Sphere ${s.sphere}: ${parts.join('; ') || '(no new quests)'}`;
        if (s.goalsReached.length > 0) {
            line += ` -- GOAL${s.goalsReached.length > 1 ? 'S' : ''} REACHED: ${s.goalsReached.map(g => g.name).join(', ')}`;
        }
        lines.push(line);
    }

    lines.push('');
    lines.push(`Total quests completed: ${result.completedQuests.length}/${result.completedQuests.length + result.unreachedQuests.length} (${result.totalQp} QP)`);
    lines.push('');
    lines.push('Goals:');
    for (const gs of result.goalStatus) {
        if (gs.reached) {
            lines.push(`  [x] ${gs.goal.name} - reached at sphere ${gs.sphereReached}`);
        } else {
            lines.push(`  [ ] ${gs.goal.name} - BLOCKED`);
            for (const b of gs.blockers) {
                lines.push(...fmtBlocker(b, '        '));
            }
        }
    }
    lines.push('');
    lines.push(result.allGoalsReached ? 'RESULT: all goals reachable.' : 'RESULT: blocked - see blocker report above.');
    return lines;
}

export function renderV1(result: SimResult, index: QuestIndex): string[] {
    const lines = renderV0(result);
    lines.push('');
    lines.push('=== Per-quest requirements (v1) ===');
    for (const s of result.spheres) {
        if (s.questsCompleted.length === 0) {
            continue;
        }
        lines.push(`Sphere ${s.sphere}:`);
        for (const qc of s.questsCompleted) {
            const quest = index.get(qc.id);
            if (!quest) {
                continue;
            }
            const reqs: string[] = [];
            if (quest.requiredQp !== undefined) {
                reqs.push(`${quest.requiredQp} QP`);
            }
            const skillStr = fmtSkills(quest.skills);
            if (skillStr) {
                reqs.push(skillStr);
            }
            if (quest.quests && quest.quests.length > 0) {
                reqs.push(`prereq: ${quest.quests.map(id => index.get(id)?.name ?? id).join(', ')}`);
            }
            if (quest.questsAny && quest.questsAny.length > 0) {
                reqs.push(`prereq (any): ${quest.questsAny.map(g => g.map(id => index.get(id)?.name ?? id).join('|')).join('; ')}`);
            }
            const reqStr = reqs.length > 0 ? ` -- needs ${reqs.join('; ')}` : ' -- no requirements';
            lines.push(`  - complete "${quest.name}" (+${quest.qp} QP)${reqStr}`);
            if (quest.regions && quest.regions.includes('karamja')) {
                lines.push(`      (travel: Karamja - 30gp boat from Port Sarim, trivially reachable)`);
            }
        }
    }
    return lines;
}

const KARAMJA_BARS_V2 = [
    'Blue Moon Inn and the Jolly Boar Inn in Varrock',
    'the Rising Sun in Falador',
    'the Flying Horse Inn in Ardougne East',
    "the Forester's Arms in Seers' Village",
    'the Rusty Anchor in Port Sarim',
    'the Dragon Inn in Yanille',
    "Blurberry's Bar in Tree Gnome Village",
    "the Dead Man's Chest in Brimhaven (Karamja)",
    "Karamja Spirits at Zambo's (Karamja)"
];

export function renderV2(result: SimResult, index: QuestIndex): string[] {
    const lines = renderV1(result, index);
    lines.push('');
    lines.push('=== Walkthrough narration (v2) ===');
    lines.push('');
    lines.push(
        `You wake up at ${result.seedConfig.spawn.label}${result.seedConfig.spawn.mode === 'vanilla' ? '' : ` (${result.seedConfig.spawn.mode}-mode seeded spawn)`}. The mainland is one connected walkable region under this seed - entrance randomization guarantees every gate pairs both ways and ::home always gets you unstuck, so travel is flavor here, not logic.`
    );
    if (result.seedConfig.unlocks.present) {
        lines.push(`Your Archipelago unlocks are fixed for this run (this simulator does not yet model mid-run item receipt order - see docs/progression-sim.md roadmap): every skill starts capped at 20, +10 per Progressive item received, giving these ceilings right now: ${Object.entries(result.skillCaps).map(([s, v]) => `${s} ${v}`).join(', ')}.`);
    } else {
        lines.push('No ap-unlocks.json for this seed - every skill is free to train to 99, so this is effectively a vanilla-open run.');
    }
    if (result.seedConfig.gather.present) {
        lines.push(`Gathering is shuffled (seed ${result.seedConfig.gather.seed}, mode ${result.seedConfig.gather.mode}) across ${result.seedConfig.gather.skills.join('/')} - what lands in your inventory when you chop, mine or fish will not match the vanilla flavor text. None of the tracked quests currently require a specific gathered item by name (see quests.json notes), so this only affects flavor, not reachability.`);
    }
    if (result.seedConfig.process.present) {
        lines.push(`Processing is shuffled too (seed ${result.seedConfig.process.seed}, mode ${result.seedConfig.process.mode}) across ${result.seedConfig.process.skills.join('/')} - cooking, smithing, crafting and fletching recipes hand back a shuffled product on the same "structure stays put, content moves" rule as gathering.`);
    }
    lines.push('');

    for (const s of result.spheres) {
        if (s.questsCompleted.length === 0 && s.goalsReached.length === 0) {
            continue;
        }
        lines.push(`-- Sphere ${s.sphere} --`);
        for (const qc of s.questsCompleted) {
            const quest = index.get(qc.id);
            if (!quest) {
                continue;
            }
            const prereqNote = quest.quests && quest.quests.length ? `, with ${quest.quests.map(id => index.get(id)?.name ?? id).join(' and ')} already behind you` : '';
            lines.push(`${quest.name} opens up now${quest.requiredQp !== undefined ? ` (you've crossed ${quest.requiredQp} QP)` : ''}${prereqNote}.`);
            if (quest.notes) {
                lines.push(`  ${quest.notes}`);
            }
            if (quest.regions?.includes('karamja')) {
                lines.push(`  It's set on Karamja - hop the 30gp boat from Port Sarim, it's a formality under this model.`);
            }
        }
        for (const g of s.goalsReached) {
            lines.push(`>>> GOAL REACHED: ${g.name} <<<`);
        }
        lines.push('');
    }

    lines.push('-- Barcrawl route, for flavor --');
    lines.push(`The ten bars: ${KARAMJA_BARS_V2.join('; ')}.`);
    lines.push('');

    if (!result.allGoalsReached) {
        lines.push('-- Dead ends --');
        for (const gs of result.goalStatus.filter(g => !g.reached)) {
            lines.push(`${gs.goal.name} never opens up this run:`);
            lines.push(...gs.blockers.flatMap(b => fmtBlocker(b, '  ')));
        }
        const trulyStuck = result.unreachedQuests.filter(u => u.blockers.length > 0);
        if (trulyStuck.length > 0) {
            lines.push('');
            lines.push(`${trulyStuck.length} quest(s) never become reachable this run: ${trulyStuck.map(u => u.quest.name).join(', ')}.`);
        }
    }

    return lines;
}

export function toJsonSafe(result: SimResult): unknown {
    return {
        spawn: result.seedConfig.spawn,
        configDir: result.seedConfig.configDir,
        unlocksPresent: result.seedConfig.unlocks.present,
        gatherPresent: result.seedConfig.gather.present,
        processPresent: result.seedConfig.process.present,
        skillCaps: result.skillCaps,
        spheres: result.spheres,
        completedQuests: result.completedQuests,
        totalQp: result.totalQp,
        allGoalsReached: result.allGoalsReached,
        goals: result.goalStatus.map(gs => ({
            id: gs.goal.id,
            name: gs.goal.name,
            reached: gs.reached,
            sphereReached: gs.sphereReached,
            blockers: gs.blockers
        })),
        unreachedQuests: result.unreachedQuests.map(u => ({
            id: u.quest.id,
            name: u.quest.name,
            blockers: u.blockers
        }))
    };
}
