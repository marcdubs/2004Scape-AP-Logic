// Placement-mode core (docs/placement-mode.md): the location catalog, item pool builders,
// and reachability engine shared by tools/ap/GenerateSeed.ts (the assumed-fill generator)
// and the placement-aware extensions to SimulateProgression.ts / tools/logic/ValidateSeed.ts.
// Deliberately lives under tools/sim/ (not tools/ap/) so both the generator AND the
// simulator/validator import the SAME reachability rules - "reuse the sim engine's
// reachability, do not reimplement" per the design brief.
//
// This module owns two concerns:
//  1. The location catalog - the full list of check ids placement mode can put an item
//     on, built from the quest database + the hardcoded stage/kill/skill id lists that
//     mirror ApChecks.ts / ap_checks.rs2 / ap-checks.json EXACTLY (verified against those
//     files this session - see the comments on each list below for the source).
//  2. The item pool (gear/tools/skill-cap copies) and the reachability function used to
//     decide which locations are accessible given a partial set of collected items.
//
// Reachability model (documented, not silently simplified):
//  - Skill caps come from `progressive_<stat>` counts via the exact
//    `20 + 10*count, min 99` formula ConfigLoader.ts/ApUnlockOverrides.ts use (reused via
//    `allSkillCaps`, not reimplemented).
//  - Quest completability is Engine.ts's `completableQuests` fixpoint (skills/quests/QP),
//    the same rule the vanilla-path simulator uses.
//  - `ds_*` (Dragon Slayer stage checks) collapse to the `dragon` quest's OWN requirement
//    (QP >= 32, no skill gate) - ApChecks.ts's varp watches fire progressively as the
//    player walks through the quest, but nothing in quests.json models sub-quest
//    granularity, so "reachable once Dragon Slayer is startable" is the honest level of
//    fidelity available without inventing new data. Documented simplification, not a bug.
//  - `barcrawl_bar_*`, `first_xp_*`, `first_kill`/notable kills are always reachable
//    (sphere-0-ish, bronze kit suffices) - matches the design brief exactly.
//  - `level_<skill>_<N>` is reachable iff the skill's current cap >= N. Tool tiers
//    (progressive_pickaxe/axe) are deliberately NOT a reachability gate here, for the same
//    reason progression-sim.md documents for the vanilla-path engine: verified directly
//    against mining.rs2/woodcut.rs2 that tier 0 (bronze) is unconditionally free on BOTH
//    tools (bronze pickaxe: `ap_pickaxe_tier` returns 0, and `count < 0` is never true;
//    bronze axe: last fallback branch has no unlock check at all) - so a player can always
//    train any skill to its cap with the bronze tool. Tool progression items are real pool
//    items (placed, collected, announced) but affect *efficiency/flavor* only, never
//    reachability - matching the verified engine behavior rather than inventing a stricter
//    model the game doesn't actually enforce.
//  - Gear tiers (progressive_melee/armour/ranged/magic) are NOT a reachability gate on any
//    location or goal either: verified against levelrequire.rs2's `ap_gear_locked` - tier 0
//    (level < 5 equipment, i.e. bronze AND iron) is always free regardless of unlock count,
//    and nothing in quests.json/goals.json references a gear-tier requirement (the KBD
//    goal's 40/40/40/40 combat floor is a SKILL-cap judgment call, not a gear check - see
//    progression-sim.md). Gear/tool copies are therefore placed as "free-floating"
//    progression items in the assumed-fill sense: nothing depends on them, so they can
//    land anywhere reachable at the time they're processed (typically early, since removing
//    one from the pool never removes a location from reachability). This is intentional,
//    not a gap - it mirrors how many AP games place cosmetic/QoL progression separately
//    from hard-logic progression.

import fs from 'fs';
import path from 'path';

import { completableQuests } from './Engine.js';
import { GatherProcessConfig, UnlocksConfig, allSkillCaps } from './ConfigLoader.js';
import { Goal, QuestReq, STAT_NAMES, StatName } from './types.js';

// ---------------------------------------------------------------------------
// Location catalog
// ---------------------------------------------------------------------------

export type LocationKind = 'quest' | 'ds' | 'barcrawl' | 'first_xp' | 'first_kill' | 'level' | 'activity' | 'music';

export interface LocationDef {
    id: string;
    kind: LocationKind;
    /** For 'level' locations: the skill and the milestone N. For 'activity': the hard skill gate the vanilla script enforces, if any. */
    skill?: StatName;
    level?: number;
    /** For 'quest' locations: the quests.json id (id === `quest_${questId}`, matches the quest dirname). */
    questId?: string;
    /** Never receives a progression item (GenerateSeed's assumed fill skips it); it still exists as a filler location. */
    fillerOnly?: boolean;
}

// ---------------------------------------------------------------------------
// AP options (data/config/ap-options.json) - user-facing feature toggles, e.g.
// whether the 230 music-track checks exist at all (an AP game already paired
// with lots of checks may want them off). Read by the generator/validator/
// simulator here AND independently by the runtime watcher (ApChecks.ts's own
// inline loader - engine src cannot import from tools/) - keep the file format
// and defaults in sync between the two loaders. Missing file or bad JSON =
// every option at its default (fail-open, same policy as every other AP table).
// ---------------------------------------------------------------------------

export interface ApOptions {
    /** Music-track unlock checks exist (catalog + watches). Default true. */
    musicChecks: boolean;
}

export function loadApOptions(configDir: string): ApOptions {
    const defaults: ApOptions = { musicChecks: true };
    try {
        const file = path.join(configDir, 'ap-options.json');
        if (!fs.existsSync(file)) {
            return defaults;
        }
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        return {
            musicChecks: typeof parsed.musicChecks === 'boolean' ? parsed.musicChecks : defaults.musicChecks
        };
    } catch {
        return defaults;
    }
}

// Dragon Slayer stage watches - copied verbatim from data/config/ap-checks.json's
// "dragonquest" entries (read this session; static/shipped, not seed-regenerated - see
// docs/placement-mode.md "Locations"). If a future session adds/renames stages there,
// update this list to match - it is the authoritative source, this is a mirror.
export const DS_STAGE_IDS = ['ds_started', 'ds_oziach', 'ds_ship_ready', 'ds_map_complete', 'ds_sailed', 'ds_complete'] as const;

export const BARCRAWL_BAR_IDS = Array.from({ length: 10 }, (_, i) => `barcrawl_bar_${i + 1}`);

// Activity/minigame checks (check surface #7, added 2026-07-17) - mirrors
// ap-checks.json's ap_activities bit watches + %magearena gte watches, and the
// ~ap_activity_mark hooks in the overlaid vanilla scripts (ap_checks.rs2 has the
// bit map). skill/level record the hard gate the vanilla script itself enforces
// (verified in-source this session: wilderness course refuses entry under 52
// agility, barbarian ledge under 35, ranging guild door under 40 ranged, trawler
// fish need 15 fishing, kolodion needs 60 magic); entries without one are
// sphere-0-ish. The three trail tiers are fillerOnly: CLUE ACQUISITION is
// monster-drop RNG (trail_clue_drop.rs2), so logic must never require finishing
// a trail - they still fire as checks and hold filler.
export const ACTIVITY_LOCATIONS: readonly Omit<LocationDef, 'kind'>[] = [
    { id: 'trail_easy_complete', fillerOnly: true },
    { id: 'trail_medium_complete', fillerOnly: true },
    { id: 'trail_hard_complete', fillerOnly: true },
    { id: 'trawler_win', skill: 'fishing', level: 15 },
    { id: 'agility_gnome_course' },
    { id: 'agility_barbarian_course', skill: 'agility', level: 35 },
    { id: 'agility_wilderness_course', skill: 'agility', level: 52 },
    { id: 'gnomeball_goal' },
    { id: 'agility_arena_ticket' },
    { id: 'ranging_guild_ticket', skill: 'ranged', level: 40 },
    { id: 'mage_arena_kolodion', skill: 'magic', level: 60 },
    { id: 'mage_arena_god_cape', skill: 'magic', level: 60 },
    { id: 'mage_arena_god_staff', skill: 'magic', level: 60 }
];

// Family D (docs/checks-and-unlocks.md unlock family D): quests locked behind a
// `quest_<id>` pool item. Until the item is collected the quest can neither be
// STARTED in-game (engine/src/engine/ApQuestGates.ts vetoes the 0 -> started varp
// write - keep its EXTRA_GATE_VARPS + ApUnlockOverrides' QUEST_GATE_LABELS and the
// content overlay's update_questlist in sync with this list) nor completed in logic
// (Engine.gateSatisfied). Expanded 2026-07-17 (user decision: "all quests in the
// pool") from the original curated 17 to EVERY quest except: dragon (user decision
// 2026-07-16: the Dragon Slayer goal quest stays 32 QP + combat floor, no gate
// item) and horror (its completion watch is a varbit - the varp-write veto can't
// key off it reliably).
export const QUEST_GATE_IDS: readonly string[] = ['arena', 'arthur', 'ball', 'biohazard', 'blackarmgang', 'blackknight', 'chompybird', 'cog', 'cook', 'crest', 'death', 'demon', 'desertrescue', 'doric', 'druid', 'druidspirit', 'drunkmonk', 'eadgar', 'elemental_workshop', 'elena', 'fishingcompo', 'fluffs', 'gobdip', 'grail', 'grandtree', 'haunted', 'hazeelcult', 'hero', 'hetty', 'hunt', 'ikov', 'imp', 'itexam', 'itgronigen', 'itwatchtower', 'junglepotion', 'legends', 'mcannon', 'mortton', 'murder', 'priest', 'priestperil', 'prince', 'regicide', 'romeojuliet', 'runemysteries', 'scorpcatcher', 'seaslug', 'sheep', 'sheepherder', 'squire', 'tbwt', 'totem', 'tree', 'troll', 'upass', 'vampire', 'viking', 'waterfall', 'zanaris', 'zombiequeen'];

/** The ap-unlocks.json key a family-D gate reads for quest `questId`. */
export function questGateKey(questId: string): string {
    return `quest_${questId}`;
}

/** One single-copy pool item per QUEST_GATE_IDS entry (display names from quests.json). */
export function buildQuestGateCopies(quests: QuestReq[]): ProgressionCopy[] {
    const byId = new Map(quests.map(q => [q.id, q]));
    return QUEST_GATE_IDS.map(id => {
        const key = questGateKey(id);
        return {
            uid: key,
            placementItem: key,
            placementCount: 1,
            display: `Quest unlock: ${byId.get(id)?.name ?? id}`,
            isGroupSynthetic: false,
            apply(counts: Map<string, number>): void {
                bump(counts, key, 1);
            }
        };
    });
}

/**
 * Returns a copy of `quests` with `gateKey` attached to every id in `gateIds` (source
 * objects untouched - the parsed quests.json data may be shared with ungated callers).
 */
export function applyQuestGates(quests: QuestReq[], gateIds: readonly string[]): QuestReq[] {
    const gated = new Set(gateIds);
    return quests.map(q => (gated.has(q.id) ? { ...q, gateKey: questGateKey(q.id) } : q));
}

// The 14 notable-kill ids + first_kill, copied verbatim from ap_checks.rs2's
// `ap_track_kill` OR-chain (read this session - see that file for the npc_type mapping).
export const NOTABLE_KILL_IDS = [
    'first_kill_goblin',
    'first_kill_cow',
    'first_kill_chicken',
    'first_kill_rat',
    'first_kill_guard',
    'first_kill_dwarf',
    'first_kill_skeleton',
    'first_kill_zombie',
    'first_kill_ghost',
    'first_kill_moss_giant',
    'first_kill_ice_giant',
    'first_kill_lesser_demon',
    'first_kill_black_knight',
    'first_kill_green_dragon'
];

// Music-track unlock checks (check surface #8, added 2026-07-17). Generated from
// content's music.dbrow: every track with an `unlock` field (230 of 233; only
// Newbie Melody lacks one), each a unique (musicmulti_1..9, bit) pair - the
// matching bit watches live in ap-checks.json. Unlocks fire from
// [label,music_playbyregion] (music.rs2): first entry into any mapsquare mapped
// in musicregion.dbrow does a guarded ~music_setvar -> Player.setVar -> the
// watcher. All 230 are region-triggered, i.e. "reached area X for the first
// time" exploration checks. fillerOnly for now (set at buildLocationCatalog):
// 230 always-reachable locations would otherwise dominate assumed fill and turn
// most seeds into world-tour progression - flip deliberately if that's wanted.
export const MUSIC_TRACK_IDS: readonly string[] = [
    'music_adventure', 'music_al_kharid', 'music_alone', 'music_ambient_jungle', 'music_arabian', 'music_arabian2', 'music_arabian3',
    'music_arabique', 'music_army_of_darkness', 'music_arrival', 'music_attack1', 'music_attack2', 'music_attack3', 'music_attack4',
    'music_attack5', 'music_attack6', 'music_attention', 'music_autumn_voyage', 'music_background', 'music_ballad_of_enchantment',
    'music_baroque', 'music_beyond', 'music_big_chords', 'music_book_of_spells', 'music_camelot', 'music_cave_background', 'music_cavern',
    'music_chain_of_command', 'music_crystal_cave', 'music_crystal_sword', 'music_dangerous', 'music_dark', 'music_deep_wildy',
    'music_desert_voyage', 'music_doorways', 'music_dream', 'music_dunjun', 'music_egypt', 'music_emotion', 'music_emperor',
    'music_expanse', 'music_expecting', 'music_expedition', 'music_faerie', 'music_fanfare', 'music_fanfare3', 'music_fishing',
    'music_flute_salad', 'music_forever', 'music_gaol', 'music_garden', 'music_gnome_king', 'music_gnome_theme', 'music_gnome_village',
    'music_gnome_village2', 'music_gnome', 'music_gnomeball', 'music_greatness', 'music_harmony', 'music_high_seas', 'music_horizon',
    'music_iban', 'music_in_the_manor', 'music_inspiration', 'music_intrepid', 'music_jolly_r', 'music_jungle_island', 'music_jungly1',
    'music_jungly2', 'music_jungly3', 'music_knightly', 'music_lasting', 'music_legion', 'music_lightness', 'music_lightwalk',
    'music_long_ago', 'music_long_way_home', 'music_lullaby', 'music_mage_arena', 'music_magic_dance', 'music_magical_journey',
    'music_march', 'music_medieval', 'music_mellow', 'music_miles_away', 'music_miracle_dance', 'music_monarch_waltz', 'music_moody',
    'music_neverland', 'music_nightfall', 'music_oriental', 'music_overture', 'music_parade', 'music_quest', 'music_regal', 'music_reggae',
    'music_reggae2', 'music_riverside', 'music_royale', 'music_rune_essence', 'music_sad_meadow', 'music_scape_cave', 'music_scape_sad',
    'music_scape_wild', 'music_sea_shanty', 'music_sea_shanty2', 'music_serenade', 'music_serene', 'music_shine', 'music_soundscape',
    'music_spirit', 'music_splendour', 'music_spooky', 'music_spooky_jungle', 'music_starlight', 'music_start', 'music_still_night',
    'music_talking_forest', 'music_the_desert', 'music_the_shadow', 'music_the_tower', 'music_theme', 'music_trawler',
    'music_trawler_minor', 'music_tree_spirits', 'music_tribal_background', 'music_tribal', 'music_tribal2', 'music_trinity',
    'music_troubled', 'music_underground', 'music_unknown_land', 'music_underground_pass', 'music_upcoming', 'music_venture',
    'music_vision', 'music_voodoo_cult', 'music_voyage', 'music_wander', 'music_waterfall', 'music_wilderness2', 'music_wilderness3',
    'music_wilderness4', 'music_witching', 'music_wonder', 'music_wonderous', 'music_workshop', 'music_lonesome', 'music_scape_soft',
    'music_shining', 'music_yesteryear', 'music_fanfare2', 'music_tomorrow', 'music_duel_arena', 'music_ice_melody', 'music_wolf_mountain',
    'music_harmony2', 'music_venture2', 'music_landlubber', 'music_undercurrent', 'music_nomad', 'music_zealot', 'music_cellar_song',
    'music_heart_and_mind', 'music_close_quarters', 'music_escape', 'music_grumpy', 'music_chompy_hunt', 'music_twilight',
    'music_morytania', 'music_dead_quiet', 'music_village', 'music_bone_dance', 'music_mausoleum', 'music_forbidden', 'music_cursed',
    'music_understanding', 'music_principality', 'music_tremble', 'music_kingdom', 'music_hermit', 'music_stagnant', 'music_breeze',
    'music_stratosphere', 'music_time_out', 'music_natural', 'music_grotto', 'music_waterlogged', 'music_artistry', 'music_aztec',
    'music_elven_mist', 'music_forest', 'music_lost_soul', 'music_meridian', 'music_woodland', 'music_overpass', 'music_contest',
    'music_sojourn', 'music_crystal_castle', 'music_marzipan', 'music_insect_queen', 'music_mad_eadgar', 'music_bandit_camp',
    'music_sunburn', 'music_competition', 'music_everywhere', 'music_exposed', 'music_well_of_voyage', 'music_righteousness',
    'music_shadowland', 'music_lair', 'music_deadlands', 'music_rellekka', 'music_saga', 'music_borderland', 'music_legend',
    'music_warrior', 'music_lighthouse', 'music_out_of_the_deep', 'music_the_navigator', 'music_wildwood', 'music_barbarianism',
    'music_complication', 'music_down_to_earth', 'music_courage', 'music_superstition', 'music_pirates_of_peril', 'music_dangerous_road',
    'music_faithless', 'music_tiptoe'
];

// The 18 cappable skills (STAT_NAMES minus hitpoints, which is never capped - see
// ConfigLoader.ts/ApUnlockOverrides.ts). Matches ApChecks.ts's onXpGain exactly (it skips
// PlayerStat.HITPOINTS for both first_xp and level_ checks).
export const CAPPABLE_SKILLS: StatName[] = STAT_NAMES.filter(s => s !== 'hitpoints');

export const LEVEL_MILESTONES = [10, 20, 30, 40, 50, 60, 70, 80, 90];

export function buildLocationCatalog(quests: QuestReq[], options?: Partial<ApOptions>): LocationDef[] {
    const locs: LocationDef[] = [];

    for (const q of quests) {
        locs.push({ id: `quest_${q.id}`, kind: 'quest', questId: q.id });
    }
    for (const id of DS_STAGE_IDS) {
        locs.push({ id, kind: 'ds' });
    }
    for (const id of BARCRAWL_BAR_IDS) {
        locs.push({ id, kind: 'barcrawl' });
    }
    for (const skill of CAPPABLE_SKILLS) {
        locs.push({ id: `first_xp_${skill}`, kind: 'first_xp', skill });
    }
    locs.push({ id: 'first_kill', kind: 'first_kill' });
    for (const id of NOTABLE_KILL_IDS) {
        locs.push({ id, kind: 'first_kill' });
    }
    for (const skill of CAPPABLE_SKILLS) {
        for (const n of LEVEL_MILESTONES) {
            locs.push({ id: `level_${skill}_${n}`, kind: 'level', skill, level: n });
        }
    }
    for (const a of ACTIVITY_LOCATIONS) {
        locs.push({ ...a, kind: 'activity' });
    }
    if (options?.musicChecks !== false) {
        for (const id of MUSIC_TRACK_IDS) {
            locs.push({ id, kind: 'music', fillerOnly: true }); // see MUSIC_TRACK_IDS comment
        }
    }

    return locs;
}

// ---------------------------------------------------------------------------
// Item pool
// ---------------------------------------------------------------------------

export type PoolMode = 'per-skill' | 'groups';

/** Group membership for `--pool groups` (documented in docs/placement-mode.md item pool section). */
export const SKILL_GROUPS: Record<string, StatName[]> = {
    gathering: ['mining', 'fishing', 'woodcutting'],
    artisan: ['smithing', 'cooking', 'crafting', 'fletching', 'firemaking', 'herblore', 'runecraft'],
    combat: ['attack', 'strength', 'defence', 'ranged', 'magic', 'prayer'],
    support: ['agility', 'thieving']
};

const GEAR_FAMILIES: { key: string; label: string }[] = [
    { key: 'progressive_melee', label: 'Melee' },
    { key: 'progressive_armour', label: 'Armour' },
    { key: 'progressive_ranged', label: 'Ranged' },
    { key: 'progressive_magic', label: 'Magic' }
];

// tier -> the base-level threshold that unlocks it (ap_gear_locked in levelrequire.rs2).
const GEAR_TIER_LEVELS = [5, 10, 20, 30, 40, 45, 60];

// Exact material names, verified against mining.rs2 (ap_pickaxe_tier) and woodcut.rs2's
// axe fallback cascade.
const PICKAXE_TIERS = ['iron', 'steel', 'mithril', 'adamant', 'rune'];
const AXE_TIERS = ['iron', 'steel', 'black', 'mithril', 'adamant', 'rune'];

/**
 * One "copy" of a progression item as it will be placed at a single location. `apply`
 * mutates a running counts map to reflect collecting this copy - the single indirection
 * point that lets group-mode items (which are NOT real ap-unlocks.json keys - see
 * `groupKey` below) expand into per-member-skill bumps for reachability purposes while the
 * placements file still records the item under its own (synthetic, for groups) key.
 */
export interface ProgressionCopy {
    /** Unique within a single pool build - used for pool bookkeeping only, never written anywhere. */
    uid: string;
    /** The `item` value written into ap-placements.json. Real ap-unlocks.json key for gear/tools/per-skill caps; a synthetic `progressive_<group>` key for group-mode caps (see docs/placement-mode.md and GenerateSeed.ts's INTEGRATION note on why the engine's grantUnlock must special-case these). */
    placementItem: string;
    /** The `count` value written into ap-placements.json. */
    placementCount: number;
    /** Display/announcement string. */
    display: string;
    /** True for group-mode cap copies - flagged so GenerateSeed.ts can call out the engine integration requirement explicitly rather than silently. */
    isGroupSynthetic: boolean;
    /** Mutates `counts` (real ap-unlocks.json-shaped keys) to reflect collecting this copy. */
    apply(counts: Map<string, number>): void;
}

function bump(counts: Map<string, number>, key: string, by: number): void {
    counts.set(key, (counts.get(key) ?? 0) + by);
}

export function buildItemPool(mode: PoolMode): ProgressionCopy[] {
    const pool: ProgressionCopy[] = [];

    // --- gear: 7 copies per family (tiers 1..7), count += 1 each (engine gate is
    // `ap_unlock_count(key) < tier`, so N copies collected == tier N unlocked). ---
    for (const family of GEAR_FAMILIES) {
        for (let tier = 1; tier <= 7; tier++) {
            // Display is deliberately tier-neutral (standard AP convention): every copy
            // is mechanically identical (count += 1, engine unlocks tier N at count N),
            // so the player always receives their NEXT tier regardless of which pool
            // copy they find - a tier-flavored label would misstate the grant.
            pool.push({
                uid: `${family.key}#${tier}`,
                placementItem: family.key,
                placementCount: 1,
                display: `Progressive ${family.label}`,
                isGroupSynthetic: false,
                apply: counts => bump(counts, family.key, 1)
            });
        }
    }

    // --- tools: pickaxe x5 (tiers 1..5), axe x6 (tiers 1..6), count += 1 each.
    // Tier-neutral displays for the same reason as gear above. ---
    for (let tier = 1; tier <= PICKAXE_TIERS.length; tier++) {
        pool.push({
            uid: `progressive_pickaxe#${tier}`,
            placementItem: 'progressive_pickaxe',
            placementCount: 1,
            display: 'Progressive Pickaxe',
            isGroupSynthetic: false,
            apply: counts => bump(counts, 'progressive_pickaxe', 1)
        });
    }
    for (let tier = 1; tier <= AXE_TIERS.length; tier++) {
        pool.push({
            uid: `progressive_axe#${tier}`,
            placementItem: 'progressive_axe',
            placementCount: 1,
            display: 'Progressive Axe',
            isGroupSynthetic: false,
            apply: counts => bump(counts, 'progressive_axe', 1)
        });
    }

    // --- skill caps ---
    if (mode === 'per-skill') {
        // 4 copies per skill, count += 2 each (cap = 20 + 10*count -> 20/40/60/80/99... at
        // 0/1/2/3/4 copies the *cumulative* count is 0/2/4/6/8 -> caps 20/40/60/80/100(min99)).
        for (const skill of CAPPABLE_SKILLS) {
            const key = `progressive_${skill}`;
            for (let copy = 1; copy <= 4; copy++) {
                pool.push({
                    uid: `${key}#cap${copy}`,
                    placementItem: key,
                    placementCount: 2,
                    display: `+20 ${capitalize(skill)} cap (${copy}/4)`,
                    isGroupSynthetic: false,
                    apply: counts => bump(counts, key, 2)
                });
            }
        }
    } else {
        // 8 copies per group; EACH copy bumps every member skill's real cap key by +1
        // (== +10 level) simultaneously. Recorded in ap-placements.json under a synthetic
        // `progressive_<group>` item key that is NOT a real ap-unlocks.json entry - see
        // ProgressionCopy.isGroupSynthetic and GenerateSeed.ts's printed integration note.
        for (const [groupName, members] of Object.entries(SKILL_GROUPS)) {
            const groupKey = `progressive_${groupName}`;
            for (let copy = 1; copy <= 8; copy++) {
                pool.push({
                    uid: `${groupKey}#cap${copy}`,
                    placementItem: groupKey,
                    placementCount: 1,
                    display: `+10 cap to all of ${members.map(capitalize).join('/')} (${groupName} group, ${copy}/8)`,
                    isGroupSynthetic: true,
                    apply: counts => {
                        for (const m of members) {
                            bump(counts, `progressive_${m}`, 1);
                        }
                    }
                });
            }
        }
    }

    return pool;
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// The real ap-unlocks.json keys placement mode's starting state controls (gear families,
// tool families, and one progressive_<skill> per cappable skill). Used both to write the
// zeroed starting table and to know which keys `capsFromCounts`/reachability should read.
export function realUnlockKeys(): string[] {
    const keys = GEAR_FAMILIES.map(f => f.key).concat(['progressive_pickaxe', 'progressive_axe']);
    for (const skill of CAPPABLE_SKILLS) {
        keys.push(`progressive_${skill}`);
    }
    return keys;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

export function capsFromCounts(counts: Map<string, number>): Record<StatName, number> {
    const synthetic: UnlocksConfig = { present: true, unlocks: counts };
    return allSkillCaps(synthetic);
}

export interface ReachabilityResult {
    caps: Record<StatName, number>;
    completedQuests: Set<string>;
    qp: number;
    reachable: Set<string>;
}

/**
 * Pure location-reachability rule, factored out so callers that already have their OWN
 * (possibly richer - e.g. region-aware) notion of `completed`/`qp` can reuse the exact
 * same location rules without going through `completableQuests` a second time. This is
 * what tools/logic/ValidateSeed.ts's placement extension calls directly, feeding its own
 * region-gated `completed`/`qp` in place of PlacementEngine's travel-agnostic ones - see
 * docs/entrance-logic.md/placement-mode.md on why region logic stays ValidateSeed's job,
 * not duplicated here.
 */
export function reachableFromState(locations: LocationDef[], quests: QuestReq[], completed: Set<string>, qp: number, caps: Record<StatName, number>): Set<string> {
    const dragonReachable = completed.has('dragon') || (quests.find(q => q.id === 'dragon')?.requiredQp ?? 0) <= qp;

    const reachable = new Set<string>();
    for (const loc of locations) {
        switch (loc.kind) {
            case 'quest':
                if (loc.questId && completed.has(loc.questId)) {
                    reachable.add(loc.id);
                }
                break;
            case 'ds':
                // See file header: Dragon Slayer stage checks collapse to the quest's own
                // startability requirement (QP >= 32), not per-stage granularity.
                if (dragonReachable) {
                    reachable.add(loc.id);
                }
                break;
            case 'barcrawl':
            case 'first_kill':
                reachable.add(loc.id); // sphere-0-ish, bronze kit suffices.
                break;
            case 'first_xp':
                reachable.add(loc.id); // every skill starts trainable (cap >= 20 >= 1).
                break;
            case 'level':
                if (loc.skill && loc.level !== undefined && caps[loc.skill] >= loc.level) {
                    reachable.add(loc.id);
                }
                break;
            case 'activity':
                // Gated only by the vanilla script's own skill requirement (recorded on
                // the def), applied against progressive caps like 'level'; ungated
                // activities are sphere-0-ish, same reasoning as barcrawl/first_kill.
                if (loc.skill === undefined || loc.level === undefined || caps[loc.skill] >= loc.level) {
                    reachable.add(loc.id);
                }
                break;
            case 'music':
                reachable.add(loc.id); // map fully open by design - walking there is always possible.
                break;
        }
    }
    return reachable;
}

/** Full reachability computation for a given (already-flattened) item counts map - the travel-agnostic (no region graph) path used by GenerateSeed and the vanilla-path placement-aware simulator. */
export function computeReachability(locations: LocationDef[], quests: QuestReq[], counts: Map<string, number>): ReachabilityResult {
    const caps = capsFromCounts(counts);
    // counts doubles as the family-D unlock state: `quest_<id>` keys land in it via
    // applyPlacementItem/ProgressionCopy.apply just like every real unlock key.
    const { completed, qp } = completableQuests(quests, caps, counts);
    const reachable = reachableFromState(locations, quests, completed, qp, caps);
    return { caps, completedQuests: completed, qp, reachable };
}

/** Goal reachability given caps/completed/qp, reusing the exact ReqLike shape Engine.ts's goal-status logic uses. */
export function goalReachable(goal: Goal, caps: Record<StatName, number>, completed: Set<string>, qp: number): boolean {
    if (goal.skills) {
        for (const [stat, level] of Object.entries(goal.skills) as [StatName, number][]) {
            if (caps[stat] < level) {
                return false;
            }
        }
    }
    if (goal.quests) {
        for (const id of goal.quests) {
            if (!completed.has(id)) {
                return false;
            }
        }
    }
    if (goal.requiredQp !== undefined && qp < goal.requiredQp) {
        return false;
    }
    return true;
}

// re-exported for callers that only have a GatherProcessConfig-shaped seed config lying
// around (kept generic/unused today - see Engine.ts's findGatherOrProcessSource for the
// matching "ready extension point, not dead code" precedent).
export type { GatherProcessConfig };

// ---------------------------------------------------------------------------
// ap-placements.json loading + item application (shared by GenerateSeed's own spoiler
// re-simulation, SimulateProgression's placement-aware sphere loop, and ValidateSeed's
// placement extension - one loader/applier, three consumers).
// ---------------------------------------------------------------------------

export interface PlacementRecord {
    item: string;
    count: number;
    display: string;
}

export interface PlacementsFile {
    present: boolean;
    seed?: number;
    pool?: PoolMode;
    /** Family-D gated quest ids declared by this seed (empty = no quest gates, incl. every pre-family-D seed). */
    questGates: string[];
    placements: Map<string, PlacementRecord>;
}

export function loadPlacements(configDir: string): PlacementsFile {
    const file = path.join(configDir, 'ap-placements.json');
    if (!fs.existsSync(file)) {
        return { present: false, questGates: [], placements: new Map() };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
            seed?: number;
            pool?: string;
            questGates?: unknown[];
            placements?: Record<string, { item?: string; count?: number; display?: string }>;
        };
        const placements = new Map<string, PlacementRecord>();
        for (const [locId, rec] of Object.entries(parsed.placements ?? {})) {
            if (!rec || typeof rec.item !== 'string') {
                continue;
            }
            placements.set(locId, {
                item: rec.item,
                count: typeof rec.count === 'number' ? rec.count : 0,
                display: typeof rec.display === 'string' ? rec.display : rec.item
            });
        }
        return {
            present: true,
            seed: parsed.seed,
            pool: parsed.pool === 'groups' ? 'groups' : 'per-skill',
            questGates: (parsed.questGates ?? []).filter((id): id is string => typeof id === 'string'),
            placements
        };
    } catch (err) {
        console.warn(`ap-placements.json: failed to parse, treating as absent (${err instanceof Error ? err.message : err})`);
        return { present: false, questGates: [], placements: new Map() };
    }
}

const GROUP_KEY_RE = /^progressive_(gathering|artisan|combat|support)$/;

/**
 * Applies ONE placement record's effect to a running real-key counts map. Handles the
 * group-mode synthetic keys (`progressive_gathering` etc - see ProgressionCopy above)
 * transparently: expands into a +count bump on every member skill's REAL
 * `progressive_<skill>` key, exactly matching what buildItemPool('groups')'s copies do at
 * generation time. This is the function a placement-aware consumer (SimulateProgression,
 * ValidateSeed) calls when a location holding this item becomes reachable - it never needs
 * to know whether the item came from a per-skill or groups pool.
 */
export function applyPlacementItem(rec: PlacementRecord, counts: Map<string, number>): void {
    if (rec.item === 'filler') {
        return;
    }
    const groupMatch = GROUP_KEY_RE.exec(rec.item);
    if (groupMatch) {
        for (const member of SKILL_GROUPS[groupMatch[1]]) {
            bump(counts, `progressive_${member}`, rec.count);
        }
        return;
    }
    bump(counts, rec.item, rec.count);
}

// ---------------------------------------------------------------------------
// Forward sphere simulation over a FINAL placements map (ground truth - what a real
// player collecting every reachable check each sphere would actually experience).
// Shared by tools/ap/GenerateSeed.ts (spoiler generation + its own beatability
// self-check) and SimulateProgression.ts's placement-aware -v0/-v1/-v2 path, so both
// tools narrate identically for the same placements file.
// ---------------------------------------------------------------------------

export interface SphereFind {
    location: string;
    item: string;
    display: string;
}

export interface PlacementSphereEvent {
    sphere: number;
    finds: SphereFind[];
}

export interface PlacementGoalStatus {
    goal: Goal;
    reached: boolean;
    sphereReached: number | null;
}

export interface PlacementSimResult {
    spheres: PlacementSphereEvent[];
    finalCounts: Map<string, number>;
    finalCaps: Record<StatName, number>;
    completedQuests: Set<string>;
    qp: number;
    goalStatus: PlacementGoalStatus[];
    allGoalsReached: boolean;
    visitedLocations: Set<string>;
    unreachedLocations: string[];
}

/**
 * Runs the placement-mode sphere loop the design brief describes: compute reachable
 * checks -> collect their items -> recompute, until fixpoint. `startingCounts` lets a
 * caller seed a non-empty ap-unlocks.json baseline (placement mode always writes an
 * all-zero one, but this stays general rather than assuming that).
 */
export function simulatePlacementSpheres(
    locations: LocationDef[],
    quests: QuestReq[],
    goals: Goal[],
    placements: Map<string, PlacementRecord>,
    startingCounts?: Map<string, number>
): PlacementSimResult {
    const counts = new Map<string, number>(startingCounts ?? []);
    const visited = new Set<string>();
    const spheres: PlacementSphereEvent[] = [];
    const goalReachedAt = new Map<string, number>();

    let sphere = 0;
    let caps = capsFromCounts(counts);
    let completed = new Set<string>();
    let qp = 0;

    const checkGoals = () => {
        for (const g of goals) {
            if (!goalReachedAt.has(g.id) && goalReachable(g, caps, completed, qp)) {
                goalReachedAt.set(g.id, sphere);
            }
        }
    };

    for (;;) {
        const state = completableQuests(quests, caps, counts);
        completed = state.completed;
        qp = state.qp;
        const reachable = reachableFromState(locations, quests, completed, qp, caps);

        if (sphere === 0) {
            checkGoals(); // a goal that needs literally nothing (e.g. Barcrawl).
        }

        const newlyReachable = [...reachable].filter(id => !visited.has(id));
        if (newlyReachable.length === 0) {
            break; // fixpoint
        }

        const finds: SphereFind[] = [];
        for (const id of newlyReachable) {
            visited.add(id);
            const rec = placements.get(id);
            if (rec && rec.item !== 'filler') {
                applyPlacementItem(rec, counts);
                finds.push({ location: id, item: rec.item, display: rec.display });
            }
        }

        sphere += 1;
        caps = capsFromCounts(counts);
        const after = completableQuests(quests, caps, counts);
        completed = after.completed;
        qp = after.qp;
        checkGoals();

        spheres.push({ sphere, finds });
    }

    const goalStatus: PlacementGoalStatus[] = goals.map(g => ({
        goal: g,
        reached: goalReachedAt.has(g.id),
        sphereReached: goalReachedAt.get(g.id) ?? null
    }));

    const unreachedLocations = locations.map(l => l.id).filter(id => !visited.has(id));

    return {
        spheres,
        finalCounts: counts,
        finalCaps: caps,
        completedQuests: completed,
        qp,
        goalStatus,
        allGoalsReached: goalStatus.every(g => g.reached),
        visitedLocations: visited,
        unreachedLocations
    };
}
