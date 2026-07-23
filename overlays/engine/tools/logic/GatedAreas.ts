// Loader + require-evaluator for data/config/ap-gated-areas.json (docs/entrance-logic.md
// "Shared schema", owned/produced by Workstream A - ApAreaGates.ts). This file is READ
// ONLY here; Workstream C never writes it. Fail-open per the doc: missing file = every
// area unlocked (same convention as every other Ap*Overrides table in this project).
//
// Consumed by two tools in this directory:
//  - BuildRegionGraph.ts: uses `boxes` (with a small tile margin) to decide which
//    door/gate locs must stay CLOSED during the flood-fill (so a curated gated area
//    becomes its own isolated region instead of silently merging into the mainland via
//    an opened door - see that file's "door handling" comment for the full reasoning).
//  - ValidateSeed.ts: uses `require` to gate the conditional join-edge between a gated
//    area's isolated region(s) and the region(s) surrounding them.

import fs from 'fs';
import path from 'path';

// v1.1 (workstream A, mid-build addendum): a 4th require form, `{ stat, gte }` - a
// BASE skill-level gate (Crafting/Wizards'/Mining guilds have no backing varp at all,
// unlike the QP/quest-stage guilds). Checked against the seed's skill CAP (see
// statSatisfied below), not a "current" level - this project models skills as
// instantly trainable up to their seed-fixed cap (docs/progression-sim.md "central
// simplification"), matching how tools/sim/Engine.ts treats quest skill requirements.
// v1.2 (bit forms, DeriveGatedAreas + subagent pass): many quest doors gate on a single
// BIT inside a bitfield varp (testbit(%varp, ^bitconst)) rather than a whole-number
// threshold. `bit` = that bit must be SET (door's testbit(...) = ^true form); `bitClear`
// = that bit must be CLEAR (the = ^false form). The bit INDEX is the resolved value of the
// ^constant. Both ValidateSeed (here) and the engine's ApAreaGates.ts must handle them.
export type GatedAreaRequire =
    | { varp: string; gte: number }
    | { varp: string; bit: number }
    | { varp: string; bitClear: number }
    | { item: string }
    | { stat: string; gte: number }
    | { allOf: GatedAreaRequire[] };

export interface GatedAreaBox {
    level: number;
    x1: number;
    z1: number;
    x2: number;
    z2: number;
}

export interface GatedArea {
    name: string;
    boxes: GatedAreaBox[];
    require: GatedAreaRequire;
    message?: string;
}

export interface GatedAreasConfig {
    present: boolean;
    areas: GatedArea[];
}

function isRequire(x: unknown): x is GatedAreaRequire {
    if (!x || typeof x !== 'object') {
        return false;
    }
    const r = x as Record<string, unknown>;
    if (typeof r.varp === 'string' && (typeof r.gte === 'number' || typeof r.bit === 'number' || typeof r.bitClear === 'number')) {
        return true;
    }
    if (typeof r.item === 'string') {
        return true;
    }
    if (typeof r.stat === 'string' && typeof r.gte === 'number') {
        return true;
    }
    if (Array.isArray(r.allOf)) {
        return r.allOf.every(isRequire);
    }
    return false;
}

export function loadGatedAreas(configDir: string): GatedAreasConfig {
    const file = path.join(configDir, 'ap-gated-areas.json');
    if (!fs.existsSync(file)) {
        return { present: false, areas: [] };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { areas?: unknown[] };
        const areas: GatedArea[] = [];
        for (const raw of parsed.areas ?? []) {
            const a = raw as Record<string, unknown>;
            if (typeof a.name !== 'string' || !Array.isArray(a.boxes) || !isRequire(a.require)) {
                console.warn(`ap-gated-areas.json: skipping malformed area entry ${JSON.stringify(raw).slice(0, 120)}`);
                continue;
            }
            const boxes: GatedAreaBox[] = [];
            for (const rawBox of a.boxes) {
                const b = rawBox as Record<string, unknown>;
                if ([b.level, b.x1, b.z1, b.x2, b.z2].some(v => typeof v !== 'number')) {
                    console.warn(`ap-gated-areas.json: skipping malformed box in area "${a.name}"`);
                    continue;
                }
                boxes.push({ level: b.level as number, x1: b.x1 as number, z1: b.z1 as number, x2: b.x2 as number, z2: b.z2 as number });
            }
            areas.push({ name: a.name, boxes, require: a.require as GatedAreaRequire, message: typeof a.message === 'string' ? a.message : undefined });
        }
        return { present: true, areas };
    } catch (err) {
        console.warn(`ap-gated-areas.json: failed to parse, treating as absent (${err instanceof Error ? err.message : err})`);
        return { present: false, areas: [] };
    }
}

/** True if (level,x,z) falls inside `box` expanded by `margin` tiles on every side. */
export function tileNearBox(level: number, x: number, z: number, box: GatedAreaBox, margin: number): boolean {
    return level === box.level && x >= box.x1 - margin && x <= box.x2 + margin && z >= box.z1 - margin && z <= box.z2 + margin;
}

/** True if (level,x,z) falls strictly inside `box` (no margin) - used to attribute region membership. */
export function tileInBox(level: number, x: number, z: number, box: GatedAreaBox): boolean {
    return level === box.level && x >= box.x1 && x <= box.x2 && z >= box.z1 && z <= box.z2;
}

// ---- require evaluation (ValidateSeed's sphere loop) ----

export interface RequireContext {
    /** Current varp/varbit-ish state the seed simulation tracks (qp, quest-completion stage varps, ...). Missing key = 0. */
    varps: Map<string, number>;
    /** Items considered "obtainable" this sphere (narrative - see docs/progression-sim.md "Item requirements": no seed table currently gates on this, kept for completeness / the `unlock` backlog item). A plain `{ has(item) }` interface (not `Set<string>`) so callers can pass an "everything obtainable" stub without materializing a real set. */
    heldItems: { has(item: string): boolean };
    /** Seed-fixed skill CAPS (max trainable base level this seed allows), lowercase stat name -> cap. Missing key = 99 (uncapped), matching ConfigLoader.ts's getSkillCap semantics. */
    statCaps: Map<string, number>;
}

export function requireSatisfied(req: GatedAreaRequire, ctx: RequireContext): boolean {
    if ('allOf' in req) {
        return req.allOf.every(r => requireSatisfied(r, ctx));
    }
    if ('varp' in req) {
        const val = ctx.varps.get(req.varp) ?? 0;
        if ('bit' in req) {
            return ((val >> req.bit) & 1) === 1;
        }
        if ('bitClear' in req) {
            return ((val >> req.bitClear) & 1) === 0;
        }
        return val >= req.gte;
    }
    if ('stat' in req) {
        return (ctx.statCaps.get(req.stat.toLowerCase()) ?? 99) >= req.gte;
    }
    return ctx.heldItems.has(req.item);
}

export function describeRequire(req: GatedAreaRequire): string {
    if ('allOf' in req) {
        return `(${req.allOf.map(describeRequire).join(' AND ')})`;
    }
    if ('varp' in req) {
        if ('bit' in req) {
            return `%${req.varp} bit ${req.bit} set`;
        }
        if ('bitClear' in req) {
            return `%${req.varp} bit ${req.bitClear} clear`;
        }
        return `%${req.varp} >= ${req.gte}`;
    }
    if ('stat' in req) {
        return `${req.stat} (base) >= ${req.gte}`;
    }
    return `holds ${req.item}`;
}
