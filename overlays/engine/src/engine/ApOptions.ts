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
    skillCaps: true
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
