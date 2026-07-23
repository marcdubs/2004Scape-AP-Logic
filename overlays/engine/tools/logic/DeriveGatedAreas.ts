import fs from 'fs';
import path from 'path';

import { GatedArea, GatedAreaBox, GatedAreaRequire, loadGatedAreas } from './GatedAreas.js';
import { loadRegionGraph, RegionGraph } from './RegionGraph.js';

// Turns ScanDoors' deterministic gated-passage list (tools/map/door-scan.json) into DRAFT
// ap-gated-areas.json entries, so the runtime area-gate (ApAreaGates) and the seed
// validator (ValidateSeed) cover EVERY gated area, not just the 7 hand-curated guilds.
// See docs/entrance-logic.md "Workstream A" (this automates its "curate by grepping every
// door/gate script" step) and problems.txt #9.
//
// PIPELINE (all deterministic):
//   1. ScanDoors -> door-scan.json  (which passages are gated + their condition + coords)
//   2. BuildRegionGraph --extra-closed-doors door-scan.json  (isolate every gated pocket)
//   3. THIS TOOL: for each gated door, read back the isolated pocket's exact bbox (the box)
//      and parse its condition into a require expression.
//
// It writes a *.generated.json DRAFT and never clobbers the authoritative curated file:
//   - the 7 curated entries are copied through verbatim (hand-tuned boxes/requires win),
//   - doors already inside a curated box are skipped (already covered),
//   - entries whose require couldn't be parsed with confidence, or whose pocket didn't
//     isolate, are still emitted but flagged in `_review` for a human to finish.
// Box derivation is exact (region flood-fill); only the require parse and multi-floor
// capture are best-effort - hence "draft, review before promoting".
//
// Run from the engine dir, AFTER steps 1-2:
//   npx tsx tools/map/ScanDoors.ts
//   npx tsx tools/logic/BuildRegionGraph.ts --extra-closed-doors tools/map/door-scan.json --out tools/logic/region-graph.gated.json
//   npx tsx tools/logic/DeriveGatedAreas.ts

const DOOR_SCAN = 'tools/map/door-scan.json';
// hand/subagent-resolved requires for doors the auto-parser can't handle (bitfield gates,
// Thieving-level locked doors, `!`/compound conditions) AND explicit excludes for gates
// that aren't real progression gates (agility-obstacle cooldowns, board-game ranks,
// intra-quest puzzle levers, non-door interactables ScanDoors over-caught). Keyed by the
// source-door loc name. `{ "exclude": true, "reason": ... }` drops a door entirely;
// `{ "require": {...} }` overrides the parsed require. This is the reviewed data artifact
// the subagent pass produced - see problems.txt #9.
const REQUIRE_OVERRIDES = 'data/config/ap-gated-areas.requires.json';
const REGION_GRAPH = process.argv.includes('--region-graph') ? process.argv[process.argv.indexOf('--region-graph') + 1] : 'tools/logic/region-graph.gated.json';
const CONFIG_DIR = 'data/config';
const OUT = path.join(CONFIG_DIR, 'ap-gated-areas.generated.json');
const SCRIPTS_ROOT = path.resolve(process.cwd(), '../content/scripts');

// a building interior pocket is small; anything bigger is mainland or an open area that
// didn't actually isolate (another ungated entrance exists).
const MAX_POCKET_TILES = 4000;
const BOX_PAD = 1;
// a compact building pocket is well under this; larger bboxes mean the flood-fill caught a
// sprawling/irregular region whose rectangle over-captures - flag for hand-trim.
const BOX_AREA_REVIEW_THRESHOLD = 1500;

type GatedPassage = {
    loc: string;
    displayName?: string;
    gateKind?: 'quest' | 'skill' | 'item' | 'members';
    condition?: string;
    placementCoords?: string[];
};

// ---------------------------------------------------------------------------
// constants: `^name = int` lines across every quest .constant file
// ---------------------------------------------------------------------------

function loadConstants(): Map<string, number> {
    const consts = new Map<string, number>();
    const stack = [SCRIPTS_ROOT];
    while (stack.length) {
        const dir = stack.pop()!;
        if (!fs.existsSync(dir)) {
            continue;
        }
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                stack.push(full);
            } else if (e.name.endsWith('.constant')) {
                for (const line of fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
                    const m = line.match(/^\^(\w+)\s*=\s*(-?\d+)\s*$/);
                    if (m) {
                        consts.set(m[1], parseInt(m[2], 10));
                    }
                }
            }
        }
    }
    return consts;
}

type RequireOverride = { require?: GatedAreaRequire; exclude?: boolean; reason?: string; note?: string };

function loadRequireOverrides(): Map<string, RequireOverride> {
    const map = new Map<string, RequireOverride>();
    if (!fs.existsSync(REQUIRE_OVERRIDES)) {
        return map;
    }
    const raw = JSON.parse(fs.readFileSync(REQUIRE_OVERRIDES, 'utf8')) as Record<string, RequireOverride>;
    for (const [loc, ov] of Object.entries(raw)) {
        if (!loc.startsWith('_')) { // allow `_comment` keys
            map.set(loc, ov);
        }
    }
    return map;
}

// ---------------------------------------------------------------------------
// require parsing (condition text -> structured require, or null + reason)
// ---------------------------------------------------------------------------

// resolve a threshold token: a literal int, or a `^const`.
function resolveThreshold(tok: string, consts: Map<string, number>): number | null {
    const lit = tok.match(/^-?\d+$/);
    if (lit) {
        return parseInt(tok, 10);
    }
    const c = tok.replace(/^\^/, '');
    return consts.has(c) ? consts.get(c)! : null;
}

// map a comparison to the minimum passing value ("gte"). Works regardless of whether the
// script phrased the gate as the PASS branch (%qp >= 32) or the BLOCK branch (%qp < 32):
// both describe a door that needs 32, so both normalise to gte 32.
function toGte(op: string, n: number): number | null {
    switch (op) {
        case '>=': case '<': return n;
        case '>': case '<=': return n + 1;
        case '=': return n; // exact-stage gate (usually the "complete" constant) - treat as its floor
        default: return null; // '!' etc. - ambiguous
    }
}

type ParseResult = { require: GatedAreaRequire | null; review?: string };

function parseRequire(cond: string, kind: string | undefined, consts: Map<string, number>): ParseResult {
    const compound = /[|&]/.test(cond) || /\bcalc\b/.test(cond);

    // item: last_useitem = X | inv_total(inv, X) ... | inv_contains(inv, X)
    const item = cond.match(/last_useitem\s*[=!]\s*(\w+)/) ?? cond.match(/inv_(?:total|contains)\s*\(\s*\w+\s*,\s*(\w+)/);
    if (kind === 'item' && item) {
        return { require: { item: item[1] }, review: compound ? 'compound condition - verify item is the real gate' : undefined };
    }

    // skill: stat_base(stat) OP N  /  stat_level(stat) OP N
    const stat = cond.match(/stat_(?:base|level)\s*\(\s*(\w+)\s*\)\s*(<=|>=|<|>|=)\s*(-?\d+)/);
    if (kind === 'skill' && stat) {
        const gte = toGte(stat[2], parseInt(stat[3], 10));
        return gte === null ? { require: null, review: `unhandled stat operator '${stat[2]}'` }
            : { require: { stat: stat[1], gte }, review: compound ? 'compound condition - verify stat is the real gate' : undefined };
    }

    // varp/quest: %name OP threshold
    const varp = cond.match(/%(\w+)\s*(<=|>=|<|>|=|!)\s*(\^?\w+)/);
    if (varp) {
        const n = resolveThreshold(varp[3], consts);
        if (n === null) {
            return { require: null, review: `could not resolve threshold '${varp[3]}'` };
        }
        const gte = toGte(varp[2], n);
        if (gte === null) {
            return { require: null, review: `ambiguous operator '${varp[2]}' on %${varp[1]}` };
        }
        return { require: { varp: varp[1], gte }, review: compound ? 'compound condition (| or &) - verify this is the binding gate' : undefined };
    }

    return { require: null, review: `no recognizable gate token in condition: ${cond.slice(0, 80)}` };
}

// ---------------------------------------------------------------------------
// pocket-box derivation from the region graph (built with the gated doors closed)
// ---------------------------------------------------------------------------

type Coord = { level: number; x: number; z: number };

function parseCoord(raw: string): Coord {
    const [level, mapX, mapZ, localX, localZ] = raw.split('_').map(Number);
    return { level, x: mapX * 64 + localX, z: mapZ * 64 + localZ };
}

function boxOfRegion(rg: RegionGraph, id: number, level: number): GatedAreaBox | null {
    const r = rg.regionsById.get(id);
    if (!r) {
        return null;
    }
    return { level, x1: r.bbox.minX - BOX_PAD, z1: r.bbox.minZ - BOX_PAD, x2: r.bbox.maxX + BOX_PAD, z2: r.bbox.maxZ + BOX_PAD };
}

// The pocket = the small, non-mainland region touching the (blocked) door tile. Probe the
// 4-neighbourhood out to radius 2; among the region ids found, keep the smallest that
// isn't mainland and isn't huge. Then stack same-footprint pockets on other levels
// (upper floors reached only via internal stairs behind the same door).
function derivePocketBoxes(rg: RegionGraph, doors: Coord[]): { boxes: GatedAreaBox[]; note: string } {
    const mainland = rg.meta.mainlandRegionId;
    const chosen = new Map<string, { id: number; level: number; tiles: number }>();

    for (const d of doors) {
        let best: { id: number; tiles: number } | null = null;
        for (let r = 1; r <= 2; r++) {
            for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
                const id = rg.regionAt(d.x + dx, d.z + dz, d.level);
                if (id === 0 || id === mainland) {
                    continue;
                }
                const region = rg.regionsById.get(id);
                if (!region || region.tileCount > MAX_POCKET_TILES) {
                    continue;
                }
                if (!best || region.tileCount < best.tiles) {
                    best = { id, tiles: region.tileCount };
                }
            }
        }
        if (best) {
            chosen.set(`${best.id}:${d.level}`, { id: best.id, level: d.level, tiles: best.tiles });
        }
    }

    if (chosen.size === 0) {
        return { boxes: [], note: 'no isolated pocket at any placement - another ungated entrance likely exists, or the door faces open terrain (not an area gate)' };
    }

    const boxes: GatedAreaBox[] = [];
    let addedUpper = false;
    for (const { id, level } of chosen.values()) {
        const box = boxOfRegion(rg, id, level);
        if (!box) {
            continue;
        }
        boxes.push(box);
        // stack upper/lower floors sitting directly above/below this pocket footprint.
        const cx = Math.round((box.x1 + box.x2) / 2);
        const cz = Math.round((box.z1 + box.z2) / 2);
        for (let lvl = 0; lvl < rg.meta.levels; lvl++) {
            if (lvl === level) {
                continue;
            }
            const upId = rg.regionAt(cx, cz, lvl);
            if (upId === 0 || upId === rg.meta.mainlandRegionId) {
                continue;
            }
            const up = rg.regionsById.get(upId);
            if (up && up.tileCount <= MAX_POCKET_TILES) {
                const upBox = boxOfRegion(rg, upId, lvl);
                if (upBox) {
                    boxes.push(upBox);
                    addedUpper = true;
                }
            }
        }
    }
    return { boxes, note: addedUpper ? 'box(es) from region flood-fill incl. stacked floor(s) - verify upper-floor extents' : 'box(es) from region flood-fill (exact pocket extent)' };
}

// ---------------------------------------------------------------------------

function tileInBox(level: number, x: number, z: number, b: GatedAreaBox): boolean {
    return level === b.level && x >= b.x1 && x <= b.x2 && z >= b.z1 && z <= b.z2;
}

function main(): void {
    if (!fs.existsSync(DOOR_SCAN)) {
        console.error(`DeriveGatedAreas: ${DOOR_SCAN} missing - run tools/map/ScanDoors.ts first`);
        process.exitCode = 1;
        return;
    }
    if (!fs.existsSync(REGION_GRAPH)) {
        console.error(`DeriveGatedAreas: ${REGION_GRAPH} missing - run:\n  npx tsx tools/logic/BuildRegionGraph.ts --extra-closed-doors ${DOOR_SCAN} --out ${REGION_GRAPH}`);
        process.exitCode = 1;
        return;
    }

    const scan = JSON.parse(fs.readFileSync(DOOR_SCAN, 'utf8')) as { gatedPassages: GatedPassage[] };
    const rg = loadRegionGraph(REGION_GRAPH);
    const consts = loadConstants();
    const overrides = loadRequireOverrides();
    const curated = loadGatedAreas(CONFIG_DIR);
    const curatedBoxes = curated.areas.flatMap(a => a.boxes);

    const derived: (GatedArea & { _sourceDoor: string; _gateKind?: string; _derivation: string; _review?: string })[] = [];
    const review: { loc: string; reason: string }[] = [];
    let skippedCurated = 0;
    let skippedNoPocket = 0;
    let skippedMembers = 0;
    let skippedOverrideExclude = 0;
    let skippedTutorial = 0;

    for (const p of scan.gatedPassages) {
        const coords = (p.placementCoords ?? []).map(parseCoord);
        if (coords.length === 0) {
            continue; // no static placement (dynamic barrier / member-map) - not boxable here
        }
        // Tutorial Island (mapsquare 48,48) is protected everywhere in this project - its
        // %tutorial-gated doors are a normal onboarding sequence, never an AP area gate.
        if (coords.some(c => (c.x >> 6) === 48 && (c.z >> 6) === 48)) {
            skippedTutorial++;
            continue;
        }
        const ov = overrides.get(p.loc);
        if (ov?.exclude) {
            skippedOverrideExclude++;
            continue; // reviewed as not-a-real-gate (cooldown / puzzle lever / non-door / opens unconditionally)
        }
        if (!ov && p.gateKind === 'members') {
            skippedMembers++;
            continue; // membership is an F2P/P2P axis, not an AP progression requirement
        }
        // already covered by a hand-curated box?
        if (coords.some(c => curatedBoxes.some(b => tileInBox(c.level, c.x, c.z, b)))) {
            skippedCurated++;
            continue;
        }

        const { boxes, note } = derivePocketBoxes(rg, coords);
        if (boxes.length === 0) {
            skippedNoPocket++;
            continue;
        }

        // A bounding box over-captures a SPRAWLING region (a long winding cave flood-fills
        // into one big rectangle covering lots of non-pocket tiles). Compact building
        // pockets are safe; oversized ones must be verified/hand-trimmed before they gate,
        // or ApAreaGates would bounce players across unrelated tiles. Flag, don't trust.
        const maxBoxArea = Math.max(...boxes.map(b => (b.x2 - b.x1 + 1) * (b.z2 - b.z1 + 1)));
        const boxTooBig = maxBoxArea > BOX_AREA_REVIEW_THRESHOLD ? `large box (${maxBoxArea} tiles) - sprawling region, verify/hand-trim extent before trusting` : null;

        // reviewed override wins over the auto-parser (bit gates, Thieving levels, etc.)
        const { require, review: reqReview } = ov?.require
            ? { require: ov.require, review: undefined }
            : parseRequire(p.condition ?? '', p.gateKind, consts);
        const name = p.displayName && p.displayName !== 'null' ? `${p.displayName} (${p.loc})` : p.loc;
        const reviewNote = [require === null ? 'REQUIRE UNPARSED - fill by hand' : null, reqReview ?? null, boxTooBig].filter(Boolean).join('; ') || undefined;
        if (reviewNote) {
            review.push({ loc: p.loc, reason: reviewNote });
        }

        derived.push({
            name,
            _sourceDoor: p.loc,
            _gateKind: p.gateKind,
            _derivation: `ScanDoors gate '${p.condition ?? ''}' on door ${p.loc}; ${note}`,
            boxes,
            require: require ?? ({ varp: '__UNPARSED__', gte: 0 } as GatedAreaRequire),
            message: `A strange force bars your way. (${p.displayName ?? p.loc})`,
            ...(reviewNote ? { _review: reviewNote } : {})
        });
    }

    const out = {
        _note: 'DRAFT generated by DeriveGatedAreas.ts. Curated entries copied verbatim; derived entries appended. Review `_review` items (unparsed requires / stacked floors) before promoting this over ap-gated-areas.json. Strip the `_`-prefixed fields when promoting.',
        _stats: {
            curated: curated.areas.length,
            derived: derived.length,
            needsReview: review.length,
            skippedAlreadyCurated: skippedCurated,
            skippedNoIsolatedPocket: skippedNoPocket,
            skippedMembers: skippedMembers,
            skippedOverrideExclude: skippedOverrideExclude,
            skippedTutorial: skippedTutorial
        },
        _reviewList: review,
        areas: [...curated.areas, ...derived]
    };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

    console.log('=== DeriveGatedAreas ===');
    console.log(`curated (kept)            : ${curated.areas.length}`);
    console.log(`derived (new)             : ${derived.length}`);
    console.log(`  of which need review    : ${review.length}`);
    console.log(`skipped - already curated : ${skippedCurated}`);
    console.log(`skipped - no pocket       : ${skippedNoPocket}  (reachable another way, not a real area gate)`);
    console.log(`skipped - members-only    : ${skippedMembers}`);
    console.log(`skipped - override exclude : ${skippedOverrideExclude}  (reviewed not-a-gate)`);
    console.log(`skipped - tutorial island : ${skippedTutorial}`);
    console.log(`\nwrote ${OUT}  (${curated.areas.length + derived.length} areas total)`);
    if (review.length) {
        console.log('\nneeds human require (top 15):');
        for (const r of review.slice(0, 15)) {
            console.log(`  ${r.loc}: ${r.reason}`);
        }
    }
}

main();
