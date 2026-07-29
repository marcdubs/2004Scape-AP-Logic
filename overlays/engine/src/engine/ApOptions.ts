// Archipelago user-facing feature toggles (data/config/ap-options.json).
// Single engine-side loader consumed by ApChecks (music-watch gating) and the
// AP_OPTION script command (rs2-side addon gating, e.g. whether Bank Box /
// Tree Compass / Teleporting Focus / NPC Teleport can roll as rewards).
//
// The generator/validator/simulator tools have their OWN loader
// (tools/sim/PlacementEngine.ts loadApOptions - tools must not import engine
// src and vice versa): keep the file format and the DEFAULTS below in sync
// with it. Missing file, bad JSON, or an unknown/missing key all fail open to
// the default (true) - same policy as every other AP table. Cached for the
// process lifetime: options are a boot-time decision, same as placements
// (restart the server after editing ap-options.json).
//
// Most options are booleans. A few are NUMERIC tuning knobs (NUMERIC_DEFAULTS
// below, e.g. gatherSpeed); they live in the same file and are read through the
// same ap_option command from rs2, which returns the number as-is (booleans
// come back as 1/0).

import fs from 'fs';

import Environment from '#/util/Environment.js';
import { printInfo, printWarning } from '#/util/Logger.js';

const OPTIONS_PATH = 'data/config/ap-options.json';

const DEFAULTS: Record<string, boolean> = {
    musicChecks: true,
    addonBankBox: true,
    addonTreeCompass: true,
    addonTeleportingFocus: true,
    addonNpcTeleport: true,
    // item-category toggles (AP slot options): false = that family's items are
    // not in the pool and the system is unrestricted from the start
    // (ApUnlockOverrides.getUnlockCount reports 99 for its keys).
    gearProgression: true,
    toolProgression: true,
    skillCaps: true,
    // progressive XP rate: multiplier scales with the trained stat's level
    // instead of the flat world.json xpRate - see apXpMultiplier below.
    progressiveXpRate: true,
    // live slot options that default OFF - must be listed here because
    // getApOption fails open to true for unknown keys.
    infiniteRun: false
};

// Numeric tuning knobs. Percentages, so 100 = vanilla and the "unset" reading is
// obvious in the file. Clamped on load to the [min, max] beside each default -
// a typo'd 100000 should not silently turn every skill into a vending machine.
const NUMERIC_DEFAULTS: Record<string, { value: number; min: number; max: number }> = {
    // gathering (mining/woodcutting/fishing) success-roll scaling, applied by the
    // AP_GATHER_RANDOM command - see apGatherThreshold below. Defaults to 2x, not
    // vanilla's 100: same reasoning as progressiveXpRate defaulting on - a
    // randomizer run wants supplies at the pace the rest of the pacing assumes,
    // and 2004 gathering rates are the standout outlier (GitHub #13). Set 100 for
    // untouched 2004 odds.
    gatherSpeed: { value: 200, min: 25, max: 1000 },
    // How fast a depleted MINING rock comes back, as a percentage of the vanilla
    // timer (which content/scripts/skill_mining/configs/mine.dbrow sets per rock
    // and ~scale_by_playercount then shortens as a world fills up - so a solo
    // world always waits the full vanilla time). 100 = vanilla, 300 = a third of
    // the wait. Default 300 because the vanilla numbers assume a populated world
    // with several rocks' worth of competition: gem rocks are 200 ticks (2 min),
    // runite 2400 (24 min), and on a one-player randomizer that is dead time, not
    // difficulty. Applied by ~ap_rock_respawn (scripts/ap/ap.rs2); woodcutting
    // and fishing respawns are untouched.
    rockRespawnSpeed: { value: 300, min: 10, max: 1000 },

    // ---- reward roll tuning (ap_rewards.rs2) ----
    // How many items a "pack" category (ores/bars/herbs/runes/crafting_runecraft) hands out per
    // reward. Each roll is independently level-biased, so a pack reads like a
    // drop table rather than one lonely stack. 1 turns packs back into the
    // single-item categories everything else uses.
    rewardPackRolls: { value: 3, min: 1, max: 10 },
    // Aspiration knob: how many levels ABOVE your own a tier has to be for its
    // roll weight to halve (see ~ap_tier_weight). Small = strict, you almost
    // only ever get what you can already use; large = generous, high tiers show
    // up early as "someday" prizes. 8 puts runite ore at roughly 1-2% of an ore
    // pack roll for a level-40 smith.
    rewardAspirationLevels: { value: 8, min: 1, max: 40 },
    // Obsolescence knob: weight lost per level you are ABOVE a tier, in
    // thousandths (see ~ap_tier_weight, which starts every usable tier at 1000
    // and floors it at 120). 8 means a tier is at the floor once you are ~110
    // levels past it - i.e. bronze never fully stops coming, but by level 60 it
    // is roughly 1/8th as likely as the best thing you can use.
    rewardObsolescence: { value: 8, min: 0, max: 100 },

    // Category weights for the "roll anything" reward (Mystery Reward, and every
    // solo-mode filler check). Relative, not percentages - the roll is
    // proportional-to-weight over whatever these sum to, so 0 disables a
    // category outright and doubling one key doubles its share. Defaults lean
    // hard on the packs and on XP/cash: gear categories are the ones players
    // out-tier fastest, and coal/bars/herbs/runes are the actual bottlenecks in
    // a randomized world (drop, gathering and processing shuffles all make raw
    // materials harder to get, never easier).
    rewardWeightOres: { value: 110, min: 0, max: 1000 },
    rewardWeightBars: { value: 100, min: 0, max: 1000 },
    rewardWeightHerbs: { value: 85, min: 0, max: 1000 },
    rewardWeightRunes: { value: 85, min: 0, max: 1000 },
    // flax / leather / rune essence, three rolls at a time - the crafting and
    // runecraft grind inputs, which no other pack covers.
    rewardWeightCraftingRunecraft: { value: 80, min: 0, max: 1000 },
    rewardWeightXp: { value: 85, min: 0, max: 1000 },
    rewardWeightCash: { value: 65, min: 0, max: 1000 },
    rewardWeightFood: { value: 55, min: 0, max: 1000 },
    rewardWeightPotions: { value: 55, min: 0, max: 1000 },
    rewardWeightCrafting: { value: 45, min: 0, max: 1000 },
    rewardWeightTools: { value: 45, min: 0, max: 1000 },
    rewardWeightRunecraft: { value: 40, min: 0, max: 1000 },
    rewardWeightAddons: { value: 40, min: 0, max: 1000 },
    rewardWeightArmour: { value: 40, min: 0, max: 1000 },
    rewardWeightWeapons: { value: 40, min: 0, max: 1000 },
    rewardWeightArrows: { value: 35, min: 0, max: 1000 },
    rewardWeightRangedGear: { value: 30, min: 0, max: 1000 },
    rewardWeightCaskets: { value: 30, min: 0, max: 1000 },
    rewardWeightKeepsakes: { value: 25, min: 0, max: 1000 }
};

let cache: Record<string, boolean> | null = null;
let numericCache: Record<string, number> | null = null;

function load(): void {
    const options = { ...DEFAULTS };
    const numbers: Record<string, number> = {};
    for (const [key, spec] of Object.entries(NUMERIC_DEFAULTS)) {
        numbers[key] = spec.value;
    }

    cache = options;
    numericCache = numbers;

    if (!fs.existsSync(OPTIONS_PATH)) {
        printInfo('AP options: no ap-options.json, all options at defaults');
        return;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8')) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'boolean') {
                options[key] = value;
            } else if (typeof value === 'number' && Number.isFinite(value)) {
                const spec = NUMERIC_DEFAULTS[key];
                const clamped = spec ? Math.min(Math.max(Math.round(value), spec.min), spec.max) : Math.round(value);
                if (spec && clamped !== Math.round(value)) {
                    printWarning(`AP options: ${key}=${value} out of range [${spec.min}, ${spec.max}], clamped to ${clamped}`);
                }
                numbers[key] = clamped;
            }
        }
        const all = [...Object.entries(options), ...Object.entries(numbers)];
        printInfo(`AP options: ${all.map(([k, v]) => `${k}=${v}`).join(' ')}`);
    } catch (err) {
        printWarning(`AP options: failed to parse ${OPTIONS_PATH}, using defaults (${err instanceof Error ? err.message : err})`);
    }
}

/** True if the named option is enabled. Unknown names default to true (fail open). */
export function getApOption(name: string): boolean {
    if (cache === null) {
        load();
    }
    return cache![name] ?? true;
}

/**
 * Numeric reading of an option, for the rs2 ap_option command (which is typed
 * (string)(int)). A numeric key returns its value; a boolean key returns 1/0;
 * an unknown key fails open to 1, the same "enabled" answer getApOption gives.
 */
export function getApOptionInt(name: string): number {
    if (numericCache === null) {
        load();
    }
    const numeric = numericCache![name];
    if (numeric !== undefined) {
        return numeric;
    }
    if (cache![name] !== undefined) {
        return cache![name] ? 1 : 0;
    }
    return 1;
}

/**
 * Sets one option: merges it into ap-options.json on disk (so it survives
 * restarts) and drops the cache so the next getApOption reflects it. Used by
 * ApClient to honor options pushed via Archipelago slot_data - the player
 * configures these on the AP YAML/website side and the game server adopts them
 * on connect, no hand-editing. No-op when the effective value already matches.
 */
export function setApOption(name: string, value: boolean): void {
    if (getApOption(name) === value) {
        return;
    }
    write(name, value);
}

/**
 * Numeric counterpart of setApOption, for the tuning knobs in NUMERIC_DEFAULTS.
 * Same slot_data adoption path; the value is range-checked on the next load()
 * exactly like a hand-edited one.
 */
export function setApOptionInt(name: string, value: number): void {
    if (!Number.isFinite(value) || getApOptionInt(name) === Math.round(value)) {
        return;
    }
    write(name, Math.round(value));
}

function write(name: string, value: boolean | number): void {
    try {
        let parsed: Record<string, unknown> = {};
        if (fs.existsSync(OPTIONS_PATH)) {
            parsed = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8')) as Record<string, unknown>;
        }
        parsed[name] = value;
        fs.writeFileSync(OPTIONS_PATH, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
        cache = null;
        numericCache = null;
        printInfo(`AP options: ${name} set to ${value} (from Archipelago slot_data)`);
    } catch (err) {
        printWarning(`AP options: failed to set ${name}=${value} (${err instanceof Error ? err.message : err})`);
    }
}

/**
 * Effective XP multiplier for a stat at the given base level. Progressive mode
 * (default on): 10x at level 1, doubling every 15 levels - 20x at 15, 40x at
 * 30, 80x at 45, 160x at 60, 320x at 75, 640x at 90+ - so pacing scales across
 * the whole game without hand-editing world.json's xpRate mid-run. Doubling
 * every 15 (not the originally proposed 10) keeps late levels meaningful: the
 * XP curve itself doubles every ~7 levels, and a 10-level doubling tracks it
 * so closely that levels 30+ cost ~1-4 actions each and capped-skill XP
 * banking would auto-complete whole +20 cap brackets. At /15, level 98->99 is
 * still ~38 actions (~2.5 min). It REPLACES the flat xpRate while on; toggling
 * progressiveXpRate off restores vanilla flat-rate behavior. AP reward XP
 * (AP_STAT_ADVANCE_RAW) bypasses multipliers entirely and never reaches this.
 */
export function apXpMultiplier(baseLevel: number): number {
    if (!getApOption('progressiveXpRate')) {
        return Environment.node.xpRate;
    }
    return 10 * 2 ** Math.floor(baseLevel / 15);
}

/**
 * gatherSpeed applied to a vanilla stat_random success threshold (the
 * level-interpolated 1..256 "value" STAT_RANDOM compares against a 0..255 roll).
 * Used only by AP_GATHER_RANDOM, i.e. the mining / woodcutting / fishing success
 * rolls - every other stat_random caller (cooking burn, fletching, thieving,
 * ...) keeps vanilla odds.
 *
 * Scaling the threshold rather than flooring it at "always succeed" is
 * deliberate: a higher pickaxe/axe tier and a higher level still buy a visibly
 * better rate at any setting, so progression keeps its shape - it just moves
 * faster. Clamped to [1, 256]: 256 always succeeds (value > chance, chance <=
 * 255) and 1 keeps vanilla's "never actually impossible" floor for the
 * slow-it-down direction (gatherSpeed < 100).
 *
 * NOTE the per-cycle action delay is untouched, so throughput is still capped at
 * one resource per swing/cast interval (3-8 ticks depending on tool) no matter
 * how high this goes. This knob removes failed cycles; it does not compress the
 * animation loop.
 */
export function apGatherThreshold(value: number): number {
    const percent = getApOptionInt('gatherSpeed');
    if (percent === 100) {
        return value;
    }
    return Math.min(Math.max(Math.floor((value * percent) / 100), 1), 256);
}
