// Loads the seed-state JSON tables the simulator consumes. Mirrors the fail-open
// convention used by every Ap*Overrides engine module (ApUnlockOverrides.ts,
// ApSpawnOverrides.ts, ApGatherOverrides.ts, ApProcessOverrides.ts): a missing file
// means "vanilla" for that axis, never an error. See docs/progression-sim.md
// "Seed-awareness" for the full mapping of file -> what it changes about the sim.

import fs from 'fs';
import path from 'path';

import { STAT_NAMES, StatName } from './types.js';

export interface SpawnConfig {
    label: string;
    mode: 'city' | 'chunk' | 'vanilla';
    raw?: string;
}

export interface UnlocksConfig {
    /** null = no ap-unlocks.json on disk = everything unlocked (vanilla-open AP run). */
    present: boolean;
    unlocks: Map<string, number>;
}

export interface GatherProcessConfig {
    present: boolean;
    seed?: number;
    mode?: string;
    skills: string[];
    /** obj id (string, as serialized) -> obj id, vanilla product -> seeded product. */
    map: Map<string, string>;
}

export interface SeedConfig {
    configDir: string;
    spawn: SpawnConfig;
    unlocks: UnlocksConfig;
    gather: GatherProcessConfig;
    process: GatherProcessConfig;
    entrancesPresent: boolean;
}

function readJson<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch (err) {
        console.warn(`progression-sim: failed to parse ${filePath}, treating as absent (${err instanceof Error ? err.message : err})`);
        return null;
    }
}

const VANILLA_HOME_LABEL = 'Lumbridge (vanilla)';

function loadSpawn(configDir: string): SpawnConfig {
    const parsed = readJson<{ home?: string; mode?: string; label?: string }>(path.join(configDir, 'ap-spawn.json'));
    if (parsed === null || !parsed.home) {
        return { label: VANILLA_HOME_LABEL, mode: 'vanilla' };
    }
    const mode = parsed.mode === 'chunk' ? 'chunk' : 'city';
    const label = parsed.label && parsed.label.length > 0 ? parsed.label : `seeded spawn (${parsed.home})`;
    return { label, mode, raw: parsed.home };
}

function loadUnlocks(configDir: string): UnlocksConfig {
    const parsed = readJson<{ unlocks?: Record<string, number> }>(path.join(configDir, 'ap-unlocks.json'));
    if (parsed === null) {
        return { present: false, unlocks: new Map() };
    }
    const unlocks = new Map<string, number>();
    for (const [name, count] of Object.entries(parsed.unlocks ?? {})) {
        if (typeof count === 'number' && Number.isInteger(count) && count >= 0) {
            unlocks.set(name, count);
        }
    }
    return { present: true, unlocks };
}

function loadGatherOrProcess(configDir: string, filename: string): GatherProcessConfig {
    const parsed = readJson<{ seed?: number; mode?: string; skills?: string[]; map?: Record<string, string | number> }>(path.join(configDir, filename));
    if (parsed === null) {
        return { present: false, skills: [], map: new Map() };
    }
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(parsed.map ?? {})) {
        map.set(String(k), String(v));
    }
    return { present: true, seed: parsed.seed, mode: parsed.mode, skills: parsed.skills ?? [], map };
}

export function loadSeedConfig(configDir: string): SeedConfig {
    return {
        configDir,
        spawn: loadSpawn(configDir),
        unlocks: loadUnlocks(configDir),
        gather: loadGatherOrProcess(configDir, 'ap-gather.json'),
        process: loadGatherOrProcess(configDir, 'ap-process.json'),
        entrancesPresent: fs.existsSync(path.join(configDir, 'ap-entrances.json'))
    };
}

// --- Unlock-derived queries, mirroring ApUnlockOverrides.ts's semantics exactly ---
// (99 = unbounded when the table is absent; present-but-missing-key = 0 received).

export function getUnlockCount(unlocks: UnlocksConfig, name: string): number {
    if (!unlocks.present) {
        return 99;
    }
    return unlocks.unlocks.get(name) ?? 0;
}

const HITPOINTS_STAT: StatName = 'hitpoints';

/** Base-level ceiling for a stat under progressive skill caps - see ApUnlockOverrides.ts getSkillCap. */
export function getSkillCap(unlocks: UnlocksConfig, stat: StatName): number {
    if (!unlocks.present) {
        return 99;
    }
    if (stat === HITPOINTS_STAT) {
        return 99; // never capped - combat-safety guarantee, mirrors the engine module.
    }
    const count = unlocks.unlocks.get(`progressive_${stat}`) ?? 0;
    return Math.min(99, 20 + 10 * count);
}

export function allSkillCaps(unlocks: UnlocksConfig): Record<StatName, number> {
    const out = {} as Record<StatName, number>;
    for (const stat of STAT_NAMES) {
        out[stat] = getSkillCap(unlocks, stat);
    }
    return out;
}
