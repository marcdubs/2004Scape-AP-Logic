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

let cache: Record<string, boolean> | null = null;

function load(): Record<string, boolean> {
    const options = { ...DEFAULTS };

    if (!fs.existsSync(OPTIONS_PATH)) {
        printInfo('AP options: no ap-options.json, all options at defaults');
        return options;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8')) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'boolean') {
                options[key] = value;
            }
        }
        printInfo(`AP options: ${Object.entries(options).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    } catch (err) {
        printWarning(`AP options: failed to parse ${OPTIONS_PATH}, using defaults (${err instanceof Error ? err.message : err})`);
    }

    return options;
}

/** True if the named option is enabled. Unknown names default to true (fail open). */
export function getApOption(name: string): boolean {
    if (cache === null) {
        cache = load();
    }
    return cache[name] ?? true;
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

    try {
        let parsed: Record<string, unknown> = {};
        if (fs.existsSync(OPTIONS_PATH)) {
            parsed = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8')) as Record<string, unknown>;
        }
        parsed[name] = value;
        fs.writeFileSync(OPTIONS_PATH, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
        cache = null;
        printInfo(`AP options: ${name} set to ${value} (from Archipelago slot_data)`);
    } catch (err) {
        printWarning(`AP options: failed to set ${name}=${value} (${err instanceof Error ? err.message : err})`);
    }
}

/**
 * Effective XP multiplier for a stat at the given base level. Progressive mode
 * (default on): 5x at level 1, doubling every 15 levels - 10x at 15, 20x at
 * 30, 40x at 45, 80x at 60, 160x at 75, 320x at 90+ - so pacing scales across
 * the whole game without hand-editing world.json's xpRate mid-run. Doubling
 * every 15 (not the originally proposed 10) keeps late levels meaningful: the
 * XP curve itself doubles every ~7 levels, and a 10-level doubling tracks it
 * so closely that levels 30+ cost ~1-4 actions each and capped-skill XP
 * banking would auto-complete whole +20 cap brackets. At /15, level 98->99 is
 * still ~77 actions (~5 min). It REPLACES the flat xpRate while on; toggling
 * progressiveXpRate off restores vanilla flat-rate behavior. AP reward XP
 * (AP_STAT_ADVANCE_RAW) bypasses multipliers entirely and never reaches this.
 */
export function apXpMultiplier(baseLevel: number): number {
    if (!getApOption('progressiveXpRate')) {
        return Environment.node.xpRate;
    }
    return 5 * 2 ** Math.floor(baseLevel / 15);
}
