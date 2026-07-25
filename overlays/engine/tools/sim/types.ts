// Shared types for the progression simulator (2004Scape-AP-Logic docs/progression-sim.md).
// See that doc for the full design writeup - this file is the schema contract between
// the requirements database (data/quests.json, data/goals.json), the expansion engine
// (Engine.ts) and the renderers (Narrate.ts).

// Canonical stat-name spelling, matching ApUnlockOverrides.ts's STAT_NAMES array
// (engine/src/engine/ApUnlockOverrides.ts) so skill-cap lookups line up exactly with
// the runtime unlock table's "progressive_<stat>" keys. Deliberately excludes the two
// reserved/unused slots (stat18/stat19).
export const STAT_NAMES = [
    'attack',
    'defence',
    'strength',
    'hitpoints',
    'ranged',
    'prayer',
    'magic',
    'cooking',
    'woodcutting',
    'fletching',
    'fishing',
    'firemaking',
    'crafting',
    'smithing',
    'mining',
    'herblore',
    'agility',
    'thieving',
    'runecraft'
] as const;

export type StatName = (typeof STAT_NAMES)[number];

// One entry per quest in Server/content/scripts/quests/ (65 dirs; 63 award QP, one is
// non-quest support content ("interfaces"), one is the Barcrawl activity which is
// modeled as a goal instead - see goals.json).
export interface QuestReq {
    /** Matches the quest's varp/questlist prefix, e.g. "dragon" for %dragonquest. */
    id: string;
    /** Display name, matches the in-game quest journal title. */
    name: string;
    /** Quest points AWARDED on completion (script-verified against general/configs/quest.constant). */
    qp: number;
    /** Quest points REQUIRED to START this quest, if any (e.g. Dragon Slayer needs 32). */
    requiredQp?: number;
    /** Base skill levels required to COMPLETE the quest (not just start it). Keys are StatName. */
    skills?: Partial<Record<StatName, number>>;
    /** Other quest ids that must be completed first (ALL required - see questsAny for OR-groups). */
    quests?: string[];
    /**
     * Alternative-prerequisite groups: at least ONE quest id from each inner array must
     * be complete. Used for Shield of Arrav's two-faction resolution folded into a single
     * "blackarmgang" quest id - kept generic in case a future entry needs the same shape.
     */
    questsAny?: string[][];
    /**
     * Family-D placement gate (docs/checks-and-unlocks.md unlock family D): the
     * ap-unlocks.json key (`quest_<id>`) that must be >= 1 before this quest can be
     * started/completed. NEVER present in quests.json itself - attached at load time by
     * placement-aware consumers via PlacementEngine.applyQuestGates() when the active
     * ap-placements.json declares questGates. Absent = quest ungated.
     */
    gateKey?: string;
    /** Narrative-only notable items (fetched via NPCs/drops/fixed locations, not gathersanity/processsanity - see progression-sim.md "Item requirements" for why). */
    items?: string[];
    /** Narrative-only notable kills. */
    kills?: string[];
    /** Narrative/logic region tags this quest touches: "karamja" | "crandor" | "wilderness_deep" | "zanaris". */
    regions?: string[];
    /** Free-text notes: caveats, alternate paths, things NOT modeled as hard gates. */
    notes?: string;
    /** How the fields above were established. "script" = grepped/read against the live checkout this session; "knowledge" = era knowledge only. */
    verified: 'script' | 'knowledge';
}

// A win condition. Mirrors QuestReq's requirement shape (qp/skills/quests/regions) but
// isn't itself a completable quest entry - goals are the fixpoint's target, not a node
// other things depend on.
export interface Goal {
    id: string;
    name: string;
    requiredQp?: number;
    /** Quest ids that must be completed (e.g. KBD's goal has none; Dragon Slayer's goal is quests:["dragon"]). */
    quests?: string[];
    skills?: Partial<Record<StatName, number>>;
    items?: string[];
    regions?: string[];
    /** Always present - goals are judgment calls more often than quests are; document the call inline. */
    notes: string;
}

export interface QuestDatabase {
    quests: QuestReq[];
    meta: {
        totalQuests: number;
        totalQpAvailable: number;
        scriptVerifiedCount: number;
        knowledgeVerifiedCount: number;
        generatedNotes: string;
    };
}

export interface GoalDatabase {
    goals: Goal[];
}

/**
 * Skills you cannot train until a quest is complete. Lives here (with STAT_NAMES)
 * because both the placement/reachability side and the item-graph side need it.
 *
 * TWO KINDS OF ENTRY, and the difference matters - don't "correct" the second one:
 *
 *  - runecraft -> runemysteries : a HARD SCRIPT GATE. Rune essence exists only inside
 *    the essence mine, and skill_runecraft/scripts/essence_mine.rs2:2 refuses the
 *    teleport with "You need to have completed the Rune Mysteries Quest to use this
 *    feature." Nothing else in the corpus yields blankrune - no shop, no drop table - so
 *    every scrap of Runecrafting XP in the game is behind that quest.
 *
 *  - herblore -> druid (Druidic Ritual) : a DELIBERATE BALANCE CHOICE (user call,
 *    2026-07-25). This revision's herblore scripts carry no Druidic Ritual check, so it
 *    is technically trainable from the start - but doing so without the quest is
 *    miserable enough in practice that the logic treats it as gated. The effect is only
 *    to stop the fill hiding progression behind early Herblore checks; it never blocks
 *    anything, since no quest requires a Herblore level and no item source is skilled
 *    herblore today.
 *
 * Without these, a `level_runecraft_20` or `first_xp_herblore` check reads as sphere-0
 * and the fill will happily hide progression behind XP you cannot reasonably earn yet.
 */
export const SKILL_QUEST_GATES: Readonly<Record<string, string>> = {
    runecraft: 'runemysteries',
    herblore: 'druid'
};

/** True if `skill` is trainable at all given the quests completed so far. */
export function skillUnlocked(skill: string | undefined, completed: ReadonlySet<string>): boolean {
    if (skill === undefined) {
        return true;
    }
    const quest = SKILL_QUEST_GATES[skill];
    return quest === undefined || completed.has(quest);
}
