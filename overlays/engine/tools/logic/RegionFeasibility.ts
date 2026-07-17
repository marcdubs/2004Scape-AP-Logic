// Region-feasibility + spawn-distance model for the placement generator (and any
// other tool that needs "which quests are physically completable under this seed's
// entrance table, and how far from spawn"). Built from the same inputs ValidateSeed
// consumes - region-graph.json, ap-entrances.json, ap-gated-areas.json, ap-spawn.json,
// quest-regions.generated.json, curated quest-regions.json - but evaluated at
// MAXIMAL player state (all skill caps, all QP, all items eventually obtainable),
// because the fill controls exactly those variables. Deliberately CONSERVATIVE where
// the validator is: a gate whose require the validator can never resolve (unknown
// varp, hero/legends quest flags) counts as closed here too, so feasibility never
// exceeds what ValidateSeed will later accept - the generator must not place
// progression on a check the strict validator then reports stranded.
//
// Distance scores: BFS hop-count over the same edge set from the seed's spawn
// region, refined by euclidean tile distance - `hops * 10000 + euclid` - so "same
// number of transitions, physically closer" ranks earlier. Used by GenerateSeed's
// spawn-proximity weighting ("progressive checks by accessibility").

import fs from 'fs';
import path from 'path';

import { QuestReq } from '../sim/types.js';

import { WorldTile, parseRawCoord } from './Coords.js';
import { GatedAreaRequire, loadGatedAreas } from './GatedAreas.js';
import { RequirementGroup, buildRequirementGroups, collectScriptEdges, loadGeneratedQuestRegions, usableWorldEdges } from './GeneratedQuestRegions.js';
import { RegionGraph, loadRegionGraph } from './RegionGraph.js';

const VANILLA_SPAWN_RAW = '0_50_50_21_18'; // matches ValidateSeed/ApSpawnOverrides.

interface CuratedFile {
    anchors: Record<string, { level: number; x: number; z: number }>;
    alwaysConnected: { from: string; to: string }[];
    openAreas?: { name: string; connectTo: string[]; boxes: { levels: number[]; x1: number; z1: number; x2: number; z2: number }[] }[];
    generated?: { ignore?: Record<string, string[]>; ignoreGlobal?: string[] };
    quests: Record<string, { requiredAnchors: string[] }>;
}

/** Mirrors ValidateSeed's resolveVarp knowledge at maximal state: qp/stat/item always
 *  satisfiable (the fill provides them), prayer_guild satisfiable, hero/legends quest
 *  flags and unknown varps closed (fail-closed there too). */
function requireSatisfiableAtMax(req: GatedAreaRequire): boolean {
    const r = req as { varp?: string; stat?: string; item?: string; allOf?: GatedAreaRequire[] };
    if (r.allOf) {
        return r.allOf.every(requireSatisfiableAtMax);
    }
    if (r.varp !== undefined) {
        return r.varp === 'qp' || r.varp === 'prayer_guild';
    }
    return true; // stat / item forms.
}

export interface RegionModel {
    graph: RegionGraph;
    spawnTile: WorldTile;
    spawnRegion: number;
    /** Regions reachable at maximal state under this seed's tables. */
    reachable: Set<number>;
    /** BFS hop distance (edge transitions) from the spawn region. */
    hops: Map<number, number>;
    /** Extracted requirement groups per quest/goal id (curated ignores applied). */
    groups: Map<string, RequirementGroup[]>;
}

export function buildRegionModel(configDir: string, toolsLogicDir = path.join('tools', 'logic')): RegionModel | null {
    const graphPath = path.join(toolsLogicDir, 'region-graph.json');
    const generatedPath = path.join(toolsLogicDir, 'data', 'quest-regions.generated.json');
    const curatedPath = path.join(toolsLogicDir, 'data', 'quest-regions.json');
    if (!fs.existsSync(graphPath) || !fs.existsSync(generatedPath)) {
        return null;
    }
    const graph = loadRegionGraph(graphPath);
    const generated = loadGeneratedQuestRegions(generatedPath)!;
    const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8')) as CuratedFile;
    const groups = buildRequirementGroups(generated, curated.generated);

    // ---- edge set (region -> regions), maximal-state require evaluation ----
    const adj = new Map<number, Set<number>>();
    const addEdge = (a: number, b: number) => {
        if (a === 0 || b === 0 || a === b) {
            return;
        }
        if (!adj.has(a)) {
            adj.set(a, new Set());
        }
        adj.get(a)!.add(b);
    };

    const overriddenTriggers = new Set<string>();
    const entFile = path.join(configDir, 'ap-entrances.json');
    if (fs.existsSync(entFile)) {
        const parsed = JSON.parse(fs.readFileSync(entFile, 'utf8')) as { overrides?: Record<string, string>; gates?: Record<string, { require: GatedAreaRequire }> };
        for (const [from, to] of Object.entries(parsed.overrides ?? {})) {
            if (!/^\d+_\d+_\d+_\d+_\d+:\d+$/.test(from) || !/^\d+_\d+_\d+_\d+_\d+$/.test(to)) {
                continue;
            }
            const coordRaw = from.split(':')[0];
            overriddenTriggers.add(coordRaw);
            const gate = parsed.gates?.[from];
            if (gate && !requireSatisfiableAtMax(gate.require)) {
                continue;
            }
            addEdge(graph.resolveRegion(parseRawCoord(coordRaw)), graph.resolveRegion(parseRawCoord(to)));
        }
    }

    for (const e of [...collectScriptEdges(generated), ...usableWorldEdges(generated, overriddenTriggers)]) {
        for (const from of e.fromRegions) {
            addEdge(from, e.toRegion);
        }
    }

    const anchorRegions = new Map<string, number>();
    for (const [name, def] of Object.entries(curated.anchors)) {
        anchorRegions.set(name, graph.resolveRegion({ level: def.level, x: def.x, z: def.z }));
    }
    for (const ac of curated.alwaysConnected) {
        const a = anchorRegions.get(ac.from) ?? 0;
        const b = anchorRegions.get(ac.to) ?? 0;
        addEdge(a, b);
        addEdge(b, a);
    }

    // curated open areas: every member region connects bidirectionally to each
    // connectTo anchor (hub topology - ValidateSeed's all-at-once step, expressed as
    // edges so the BFS also assigns hop distances through the area).
    for (const area of curated.openAreas ?? []) {
        const members = new Set<number>();
        for (const box of area.boxes) {
            for (const level of box.levels) {
                for (let x = box.x1; x <= box.x2; x++) {
                    for (let z = box.z1; z <= box.z2; z++) {
                        const id = graph.regionAt(x, z, level);
                        // tile cap mirrors ValidateSeed's OPEN_AREA_MEMBER_TILE_CAP:
                        // never let a box swallow an upper-level void megaregion.
                        if (id !== 0 && (graph.regionsById.get(id)?.tileCount ?? 0) <= 100000) {
                            members.add(id);
                        }
                    }
                }
            }
        }
        for (const name of area.connectTo) {
            const hub = anchorRegions.get(name) ?? 0;
            for (const m of members) {
                addEdge(hub, m);
                addEdge(m, hub);
            }
        }
    }

    // gated areas: interior regions connect from their border when the require is
    // max-satisfiable. Same box scan ValidateSeed's resolveGatedAreas performs.
    const gated = loadGatedAreas(configDir);
    for (const area of gated.areas) {
        if (!requireSatisfiableAtMax(area.require)) {
            continue;
        }
        for (const box of area.boxes) {
            const inside = new Set<number>();
            const outside = new Set<number>();
            for (let x = box.x1 - 1; x <= box.x2 + 1; x++) {
                for (let z = box.z1 - 1; z <= box.z2 + 1; z++) {
                    const id = graph.regionAt(x, z, box.level);
                    if (id === 0) {
                        continue;
                    }
                    (x >= box.x1 && x <= box.x2 && z >= box.z1 && z <= box.z2 ? inside : outside).add(id);
                }
            }
            for (const o of outside) {
                for (const i of inside) {
                    if (!outside.has(i)) {
                        addEdge(o, i);
                    }
                }
            }
        }
    }

    // ---- spawn + BFS ----
    let spawnRaw = VANILLA_SPAWN_RAW;
    const spawnFile = path.join(configDir, 'ap-spawn.json');
    if (fs.existsSync(spawnFile)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(spawnFile, 'utf8')) as { home?: string };
            if (parsed.home && /^\d+_\d+_\d+_\d+_\d+$/.test(parsed.home)) {
                spawnRaw = parsed.home;
            }
        } catch {
            /* vanilla fallback */
        }
    }
    const spawnTile = parseRawCoord(spawnRaw);
    const spawnRegion = graph.resolveRegion(spawnTile);

    const hops = new Map<number, number>();
    if (spawnRegion !== 0) {
        hops.set(spawnRegion, 0);
        const queue: number[] = [spawnRegion];
        for (let qi = 0; qi < queue.length; qi++) {
            const cur = queue[qi];
            const d = hops.get(cur)!;
            for (const nb of adj.get(cur) ?? []) {
                if (!hops.has(nb)) {
                    hops.set(nb, d + 1);
                    queue.push(nb);
                }
            }
        }
    }

    return { graph, spawnTile, spawnRegion, reachable: new Set(hops.keys()), hops, groups };
}

/** Every extracted requirement group has at least one max-state-reachable region. */
export function questRegionFeasible(model: RegionModel, id: string): boolean {
    const groups = model.groups.get(id);
    if (!groups) {
        return true; // no extracted data = no spatial claim (pre-extractor semantics).
    }
    return groups.every(g => g.regions.some(r => model.reachable.has(r)));
}

/**
 * Spatial difficulty score: max over required groups (the hardest mandatory leg) of
 * min over that group's alternatives of `hops*10000 + euclid-from-spawn`. Infinity
 * when some group is unreachable (use questRegionFeasible first). No extracted data
 * scores 0 hops at spawn distance 0 - callers give those a neutral score instead.
 */
export function questDistanceScore(model: RegionModel, id: string): number {
    const groups = model.groups.get(id);
    if (!groups || groups.length === 0) {
        return Number.NaN; // "no data" - caller substitutes its neutral score.
    }
    let worst = 0;
    for (const g of groups) {
        let best = Infinity;
        for (const t of g.tiles) {
            const h = model.hops.get(t.region);
            if (h === undefined) {
                continue;
            }
            const tile = parseRawCoord(t.raw);
            const euclid = Math.hypot(tile.x - model.spawnTile.x, tile.z - model.spawnTile.z);
            best = Math.min(best, h * 10000 + euclid);
        }
        worst = Math.max(worst, best);
    }
    return worst;
}

/**
 * Closes region feasibility over the quest DAG at maximal state: a quest is feasible
 * iff its own regions are, every hard prerequisite is, and enough QP is earnable from
 * feasible quests. Mirrors ValidateSeed's chain rules with skills/gates assumed
 * granted (the fill controls those). Fixpoint, same shape as the validator's.
 */
export function feasibleQuestSet(model: RegionModel, quests: QuestReq[]): Set<string> {
    const feasible = new Set<string>();
    for (;;) {
        let changed = false;
        const qpNow = quests.filter(q => feasible.has(q.id)).reduce((a, q) => a + q.qp, 0);
        for (const q of quests) {
            if (feasible.has(q.id)) {
                continue;
            }
            if (!questRegionFeasible(model, q.id)) {
                continue;
            }
            if (q.quests && !q.quests.every(id => feasible.has(id))) {
                continue;
            }
            if (q.questsAny && !q.questsAny.every(grp => grp.some(id => feasible.has(id)))) {
                continue;
            }
            if ((q.requiredQp ?? 0) > qpNow) {
                continue;
            }
            feasible.add(q.id);
            changed = true;
        }
        if (!changed) {
            return feasible;
        }
    }
}
