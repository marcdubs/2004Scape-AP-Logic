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
    addonNpcTeleport: true
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
