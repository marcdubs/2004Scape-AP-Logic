// Builds ap-walk-graph.json: the seed-independent skeleton the Archipelago path helper
// runs Dijkstra over (docs/tracker-map.md "Pathfinding helper"). Offline tool - run with
// tsx from Server/engine, never boots the game server.
//
// ---- What this precomputes, and why it can be precomputed at all ----
// A route across a randomized world alternates between two kinds of movement:
//   1. WALKING, whose cost depends only on map geometry - which never changes when you
//      reseed, and
//   2. USING AN ENTRANCE, whose destination is exactly what the seed shuffles.
// Only (2) is seed-dependent. So the expensive half - all-pairs walking distances between
// every tile a route could possibly enter or leave the walking phase at - is computed
// ONCE here and reused for every seed forever. Reseeding then only needs the tiny
// per-seed link table (ap-entrances.json), which ApPathfinder.ts overlays at runtime.
// Measured: the full precompute below is a couple of seconds; a query against its output
// is sub-millisecond.
//
// ---- Nodes ----
// Two nodes per entrance side: the TRIGGER tile (the ladder/door you click, i.e. where a
// walking phase ends) and the ARRIVAL tile (where you pop out, i.e. where the next
// walking phase begins). Keeping them separate is what lets the per-seed layer rewire
// arrivals without touching any walking distance. Plus one node per world-map label, so
// the helper can answer "route me to Varrock" against names a player actually recognizes.
//
// ---- Edges ----
// Walking edges are emitted for every pair of nodes sharing a region-graph region, as a
// per-region distance matrix. All pairs, not a k-nearest sparsification: within a region
// the walking metric obeys the triangle inequality, so the direct edge IS the shortest
// walk and a sparser graph could only make Dijkstra return worse-than-optimal routes.
// Distances are BFS step counts over ap-walk-grid.bin, so they honor real wall/door
// direction rules and count a diagonal as the one tick it actually costs.
//
// Nodes in different regions get no walking edge by construction - crossing between
// regions is precisely what entrances are for, and that is the per-seed layer's job.

import fs from 'fs';
import path from 'path';

import { WALK_DIR_DX, WALK_DIR_DZ, WALK_DIR_COUNT, WalkGrid, WALK_GRID_PATH } from '#/engine/ApWalkGrid.js';

import { WorldTile, parseRawCoord, toRawCoord } from './Coords.js';
import { RegionGraph, loadRegionGraph } from './RegionGraph.js';

const CONFIG_DIR = process.argv.includes('--config-dir') ? process.argv[process.argv.indexOf('--config-dir') + 1] : 'data/config';
const REGION_GRAPH_PATH = process.argv.includes('--region-graph') ? process.argv[process.argv.indexOf('--region-graph') + 1] : path.join('tools', 'logic', 'region-graph.json');
const ENTRANCE_POOL_PATH = path.join(CONFIG_DIR, 'ap-entrance-pool.json');
const WORLDMAP_META_PATH = process.argv.includes('--worldmap-meta') ? process.argv[process.argv.indexOf('--worldmap-meta') + 1] : path.join('public', 'ap', 'worldmap-meta.json');
const OUT_PATH = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(CONFIG_DIR, 'ap-walk-graph.json');

// How far to probe outward when an entrance trigger sits on a tile nobody can stand on
// (loc footprints - ladders, doors, signposts - routinely do). Matches
// RegionGraph.resolveRegion's default for the same reason: an entrance's own tile is a
// precise gameplay fact, so a near miss is all we should ever have to correct for.
const STAND_PROBE_RADIUS = 3;

// Map labels get a far wider probe. They are typographic, not positional: the renderer
// places them for legibility, so "Port Sarim" and "Catherby" both land on water and
// "Troll Stronghold" on cliff face. At radius 3 those four dropped out of the graph
// entirely, taking useful destinations with them. A label only ever names the area around
// it, so snapping tens of tiles to the nearest standable ground is faithful to intent.
const PLACE_PROBE_RADIUS = 24;

interface PoolSide {
    trigger: string;
    op: number;
    arrival: string;
    description?: string;
}
interface EntrancePool {
    gates?: { pool?: string; a: PoolSide; b: PoolSide }[];
    oneWays?: PoolSide[];
}

type NodeKind = 'trigger' | 'arrival' | 'place';

interface WalkNode {
    id: number;
    kind: NodeKind;
    /** canonical "level_mapX_mapZ_localX_localZ" of the *meaningful* tile (pre-probe). */
    raw: string;
    /** the walkable tile actually measured from (post-probe); equals raw when it was walkable. */
    stand: WorldTile;
    region: number;
    name: string;
    /** trigger/arrival only: the entrance-side key ApPathfinder joins against. */
    sideKey?: string;
    /** trigger only: the op that distinguishes climb-up from climb-down on one tile. */
    op?: number;
    /** how far the stand-tile probe had to move from `raw` (0 = raw was already walkable). */
    snap: number;
    /** nearest map label sharing this node's region, for human-readable leg descriptions. */
    near?: string;
    nearDist?: number;
    /** true when `near` was inherited from the other side of this entrance, not walked to. */
    nearVia?: boolean;
}

function readJson<T>(filePath: string, what: string): T {
    if (!fs.existsSync(filePath)) {
        console.error(`BuildWalkGraph: ${filePath} not found - ${what}`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

/**
 * Normalizes a world-map label into a lookup key players can type. Labels carry '/' as a
 * hard line break for the map renderer ("Kingdom Of/Misthalin"), not as punctuation.
 */
function placeKey(text: string): string {
    return text
        .replace(/\//g, ' ')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

function placeLabel(text: string): string {
    return text.replace(/\//g, ' ').replace(/\s+/g, ' ').trim();
}

// Labels that are annotations rather than destinations - they carry no place a player
// could be routed to.
const NON_PLACE_LABEL_RE = /^\(|due \d{4}|^coming/i;

async function main(): Promise<void> {
    const t0 = Date.now();

    if (!fs.existsSync(WALK_GRID_PATH)) {
        console.error(`BuildWalkGraph: ${WALK_GRID_PATH} not found - run BuildRegionGraph.ts first (it emits the walk grid)`);
        process.exit(1);
    }
    const grid = new WalkGrid(fs.readFileSync(WALK_GRID_PATH));
    console.log(`BuildWalkGraph: walk grid loaded - ${grid.stats.squareCount} mapsquare(s), ${grid.stats.walkableTiles} walkable tile(s)`);

    const regionGraph: RegionGraph = loadRegionGraph(REGION_GRAPH_PATH);
    // Name the --export-pool command exactly. This message used to read "run
    // ExportEntrances.ts / RandomizeEntrances.ts first", which was wrong in both halves:
    // ExportEntrances.ts writes tools/map/entrances.json (a different catalog entirely),
    // and a bare RandomizeEntrances.ts RE-ROLLS the live entrance table - on an
    // Archipelago run that silently destroys the layout the multiworld's fill reasoned
    // over. --export-pool is the only safe form: a dry run that writes the pool and no
    // table (found 2026-08-03, after the message sent a mid-playthrough user hunting).
    const pool = readJson<EntrancePool>(
        ENTRANCE_POOL_PATH,
        `run: npx tsx tools/map/RandomizeEntrances.ts --export-pool ${ENTRANCE_POOL_PATH}\n` +
            '  (--export-pool is a dry run: it writes the pool only, never the entrance table)'
    );

    // ---- collect nodes ----
    const nodes: WalkNode[] = [];
    let droppedNoStand = 0;
    const dropped: string[] = [];
    const farSnaps: string[] = [];

    /**
     * Stand-tile resolution for a map LABEL, which differs from an entrance's in a way that
     * matters. Nearest-walkable is wrong here: labels are drawn over the settlement they
     * name, so the closest walkable tile is routinely a shop or house *interior* - a sealed
     * little region of its own. Resolving that way put Falador in a 207-tile pocket,
     * Edgeville in a 20-tile room, and Port Sarim in a 41-tile one, none of them reachable
     * from anywhere, silently making those towns un-routable.
     *
     * A label names the open area around it, so among every walkable candidate in range,
     * prefer the one sitting in the LARGEST region (the street/overworld), breaking ties by
     * proximity to the label itself. Entrances keep nearest-walkable: a ladder inside a
     * building genuinely belongs to that building's region, and snapping it outdoors would
     * be a lie.
     */
    function resolvePlaceTile(tile: WorldTile, radius: number): { stand: WorldTile; region: number } | null {
        let best: { stand: WorldTile; region: number; tiles: number; snap: number } | null = null;

        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                const x = tile.x + dx;
                const z = tile.z + dz;
                if (!grid.isWalkable(x, z, tile.level)) {
                    continue;
                }
                const region = regionGraph.regionAt(x, z, tile.level);
                if (region === 0) {
                    continue;
                }
                const tiles = regionGraph.regionsById.get(region)?.tileCount ?? 0;
                const snap = Math.max(Math.abs(dx), Math.abs(dz));
                if (best === null || tiles > best.tiles || (tiles === best.tiles && snap < best.snap)) {
                    best = { stand: { level: tile.level, x, z }, region, tiles, snap };
                }
            }
        }

        return best ? { stand: best.stand, region: best.region } : null;
    }

    /**
     * Stand-tile resolution for an entrance TRIGGER. Nearest-walkable is the right rule (a
     * ladder inside a building belongs to that building), but it is not a COMPLETE one:
     * a trigger's own tile is usually an unwalkable loc footprint, and when that footprint
     * sits on a boundary the nearest walkable tiles lie on BOTH sides of it, tied on
     * distance. resolveStandTile then breaks the tie by ring-scan order (dx/dz ascending,
     * i.e. whatever is south-west), which is arbitrary - and picking the wrong side is not
     * a rounding error, it silently attaches the trigger to a region the player using it is
     * never standing in, so the graph gets an exit it can never walk to.
     *
     * Found 2026-08-03 on a live seed: a ship's deck ladder at 2_47_50_24_24 has deck tiles
     * (region 1890) to its north and the level-2 mainland (region 2) to its south, both one
     * tile away. The probe took the south tile, so the deck held two arrival nodes and no
     * trigger - you could be dropped onto that deck and the router would insist there was no
     * route anywhere, even with every entrance revealed. 48 regions were dead ends this way.
     *
     * `preferRegion` is the region of the arrival on the far side of this same physical gate
     * - i.e. exactly where a player stands after coming back through it, which is the tile
     * they must be on to use this trigger. When a candidate in that region exists, it wins;
     * otherwise this degrades to plain nearest-walkable.
     */
    function resolveTriggerStand(tile: WorldTile, radius: number, preferRegion?: number): { stand: WorldTile; region: number } | null {
        let best: { stand: WorldTile; region: number; snap: number; preferred: boolean } | null = null;

        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                const x = tile.x + dx;
                const z = tile.z + dz;
                if (!grid.isWalkable(x, z, tile.level)) {
                    continue;
                }
                const region = regionGraph.regionAt(x, z, tile.level);
                if (region === 0) {
                    continue;
                }
                const snap = Math.max(Math.abs(dx), Math.abs(dz));
                const preferred = preferRegion !== undefined && region === preferRegion;
                // Preferred region first, then nearest - so the fallback is exactly the old
                // nearest-walkable behavior whenever the gate gives us nothing to prefer.
                if (best === null || (preferred && !best.preferred) || (preferred === best.preferred && snap < best.snap)) {
                    best = { stand: { level: tile.level, x, z }, region, snap, preferred };
                }
            }
        }

        return best ? { stand: best.stand, region: best.region } : null;
    }

    /** Region a raw coord resolves to once probed onto walkable ground, or undefined. */
    function regionOfRaw(raw: string): number | undefined {
        let tile: WorldTile;
        try {
            tile = parseRawCoord(raw);
        } catch {
            return undefined;
        }
        const stand = grid.resolveStandTile(tile.x, tile.z, tile.level, STAND_PROBE_RADIUS);
        if (!stand) {
            return undefined;
        }
        const region = regionGraph.regionAt(stand.x, stand.z, stand.level);
        return region === 0 ? undefined : region;
    }

    function addNode(kind: NodeKind, raw: string, name: string, sideKey?: string, op?: number, preferRegion?: number): WalkNode | null {
        let tile: WorldTile;
        try {
            tile = parseRawCoord(raw);
        } catch {
            dropped.push(`${kind} ${raw} (${name}): unparseable coord`);
            droppedNoStand++;
            return null;
        }

        const radius = kind === 'place' ? PLACE_PROBE_RADIUS : STAND_PROBE_RADIUS;

        let stand: WorldTile;
        let region: number;
        if (kind === 'place') {
            const resolved = resolvePlaceTile(tile, radius);
            if (!resolved) {
                dropped.push(`${kind} ${raw} (${name}): no walkable tile within ${radius}`);
                droppedNoStand++;
                return null;
            }
            stand = resolved.stand;
            region = resolved.region;
        } else {
            const nearest = resolveTriggerStand(tile, radius, preferRegion);
            if (!nearest) {
                // Nothing walkable within the probe radius. Almost always a genuinely sealed
                // spot (an arrival tile inside a quest instance, a label dropped on water) -
                // record it so the count is auditable rather than silently shrinking the graph.
                dropped.push(`${kind} ${raw} (${name}): no walkable tile within ${radius}`);
                droppedNoStand++;
                return null;
            }
            stand = nearest.stand;
            region = nearest.region;
        }

        const snap = Math.max(Math.abs(stand.x - tile.x), Math.abs(stand.z - tile.z));
        if (snap > STAND_PROBE_RADIUS) {
            // A long snap means the label sat well off any walkable ground, so the node
            // could plausibly have landed on the wrong side of a wall. Surface it rather
            // than trusting it silently.
            farSnaps.push(`${name}: ${raw} -> ${toRawCoord(stand)} (${snap} tiles)`);
        }

        const node: WalkNode = { id: nodes.length, kind, raw, stand, region, name, sideKey, op, snap };
        nodes.push(node);
        return node;
    }

    // `standNextTo` is the far side's arrival: the tile this gate returns you to, which is
    // the tile you must be standing on to use this side's trigger. It only disambiguates the
    // probe (see resolveTriggerStand); a one-way has no far side and keeps nearest-walkable.
    function addSide(side: PoolSide, label: string, standNextTo?: string): void {
        const sideKey = `${side.trigger}:${side.op}`;
        addNode('trigger', side.trigger, side.description ?? label, sideKey, side.op, standNextTo === undefined ? undefined : regionOfRaw(standNextTo));
        addNode('arrival', side.arrival, side.description ?? label, sideKey, side.op);
    }

    for (const gate of pool.gates ?? []) {
        // Vanilla gates are reversible - you come back the way you came - so side a's trigger
        // and side b's arrival are the same physical spot, and vice versa. That pairing is
        // the only evidence in the data for which side of a boundary-straddling loc a player
        // actually uses it from, so hand each trigger its partner's arrival.
        addSide(gate.a, 'gate side a', gate.b.arrival);
        addSide(gate.b, 'gate side b', gate.a.arrival);
    }
    for (const oneWay of pool.oneWays ?? []) {
        addSide(oneWay, 'one-way');
    }
    const entranceNodeCount = nodes.length;

    // ---- named places from the world map's own labels ----
    const places: Record<string, number> = {};
    if (fs.existsSync(WORLDMAP_META_PATH)) {
        const meta = readJson<{ labels?: { text: string; x: number; z: number }[] }>(WORLDMAP_META_PATH, 'world map labels');
        const seen = new Map<string, number>();
        for (const label of meta.labels ?? []) {
            if (NON_PLACE_LABEL_RE.test(label.text)) {
                continue;
            }
            const key = placeKey(label.text);
            if (!key) {
                continue;
            }
            const node = addNode('place', toRawCoord({ level: 0, x: label.x, z: label.z }), placeLabel(label.text));
            if (!node) {
                continue;
            }
            // The map legitimately repeats some names ("Ruins" twice in the Wilderness).
            // Keep the first under the bare key and suffix the rest so both stay reachable.
            const count = (seen.get(key) ?? 0) + 1;
            seen.set(key, count);
            places[count === 1 ? key : `${key}${count}`] = node.id;
        }
        console.log(`BuildWalkGraph: ${Object.keys(places).length} named place(s) from ${WORLDMAP_META_PATH}`);
    } else {
        console.log(`BuildWalkGraph: no ${WORLDMAP_META_PATH} - graph will have entrance nodes only, no name lookup`);
    }

    console.log(`BuildWalkGraph: ${nodes.length} node(s) (${entranceNodeCount} entrance-side, ${nodes.length - entranceNodeCount} place), ${droppedNoStand} dropped`);

    // ---- group by region ----
    const byRegion = new Map<number, WalkNode[]>();
    for (const node of nodes) {
        const list = byRegion.get(node.region);
        if (list) {
            list.push(node);
        } else {
            byRegion.set(node.region, [node]);
        }
    }
    const multiNodeRegions = [...byRegion.values()].filter(l => l.length > 1);
    console.log(`BuildWalkGraph: nodes span ${byRegion.size} region(s); ${multiNodeRegions.length} have >1 node and need a distance matrix`);

    // ---- BFS scratch, allocated once and reused across every flood ----
    // Generation stamping instead of clearing: a per-square Int32Array of "which flood
    // last touched this tile" lets a flood reuse the same buffers without paying to zero
    // ~8M cells per source (which, at 1616 sources, would dominate the whole runtime).
    const LEVELS = 4;
    const SQUARE = 64;
    const PER_SQUARE = LEVELS * SQUARE * SQUARE;
    const distBySquare = new Map<number, Int32Array>();
    const genBySquare = new Map<number, Int32Array>();
    let generation = 0;

    function squareId(x: number, z: number): number {
        return ((x >> 6) << 9) | (z >> 6);
    }
    // Packed tile key for the target lookup in the flood's hot loop. x < 16384 and
    // z < 16384 comfortably cover this world (max ~3647 / ~10367), leaving the top bits
    // for the level. Integer keys matter here: a template string per neighbour visit
    // would mean tens of millions of throwaway allocations per build.
    function packTile(level: number, x: number, z: number): number {
        return (level << 28) | (x << 14) | z;
    }
    function localIdx(x: number, z: number, level: number): number {
        return level * SQUARE * SQUARE + (z & 63) * SQUARE + (x & 63);
    }
    function scratchFor(sq: number): { dist: Int32Array; gen: Int32Array } {
        let dist = distBySquare.get(sq);
        let gen = genBySquare.get(sq);
        if (!dist || !gen) {
            dist = new Int32Array(PER_SQUARE);
            gen = new Int32Array(PER_SQUARE);
            distBySquare.set(sq, dist);
            genBySquare.set(sq, gen);
        }
        return { dist, gen };
    }

    let queueX = new Int32Array(1 << 20);
    let queueZ = new Int32Array(1 << 20);
    let queueL = new Int32Array(1 << 20);

    /**
     * Floods outward from one tile over the walk grid, reporting the step distance to every
     * tile in `targets` it reaches. Uniform cost per step (a diagonal is one tick, same as
     * a cardinal), so plain BFS is already optimal - no priority queue needed.
     */
    function floodTo(source: WorldTile, targets: WalkNode[]): Map<number, number> {
        generation++;
        const found = new Map<number, number>();

        // index targets by tile so the flood can recognize them on arrival in O(1).
        const wanted = new Map<number, WalkNode[]>();
        for (const t of targets) {
            const key = packTile(t.stand.level, t.stand.x, t.stand.z);
            const list = wanted.get(key);
            if (list) {
                list.push(t);
            } else {
                wanted.set(key, [t]);
            }
        }

        const startScratch = scratchFor(squareId(source.x, source.z));
        const startIdx = localIdx(source.x, source.z, source.level);
        startScratch.gen[startIdx] = generation;
        startScratch.dist[startIdx] = 0;

        let head = 0;
        let tail = 0;
        queueX[tail] = source.x;
        queueZ[tail] = source.z;
        queueL[tail] = source.level;
        tail++;

        for (const t of wanted.get(packTile(source.level, source.x, source.z)) ?? []) {
            found.set(t.id, 0);
        }

        while (head < tail) {
            const cx = queueX[head];
            const cz = queueZ[head];
            const cl = queueL[head];
            head++;

            const cScratch = scratchFor(squareId(cx, cz));
            const d = cScratch.dist[localIdx(cx, cz, cl)] + 1;
            const mask = grid.maskAt(cx, cz, cl);
            if (mask === 0) {
                continue;
            }

            for (let dir = 0; dir < WALK_DIR_COUNT; dir++) {
                if ((mask & (1 << dir)) === 0) {
                    continue;
                }
                const nx = cx + WALK_DIR_DX[dir];
                const nz = cz + WALK_DIR_DZ[dir];
                const scratch = scratchFor(squareId(nx, nz));
                const idx = localIdx(nx, nz, cl);
                if (scratch.gen[idx] === generation) {
                    continue; // already reached, and BFS reached it no later than now.
                }
                scratch.gen[idx] = generation;
                scratch.dist[idx] = d;

                const hits = wanted.get(packTile(cl, nx, nz));
                if (hits) {
                    for (const t of hits) {
                        if (!found.has(t.id)) {
                            found.set(t.id, d);
                        }
                    }
                    if (found.size === targets.length) {
                        return found; // every target reached - the rest of the region is irrelevant.
                    }
                }

                if (tail >= queueX.length) {
                    const cap = queueX.length * 2;
                    const nqx = new Int32Array(cap);
                    const nqz = new Int32Array(cap);
                    const nql = new Int32Array(cap);
                    nqx.set(queueX);
                    nqz.set(queueZ);
                    nql.set(queueL);
                    queueX = nqx;
                    queueZ = nqz;
                    queueL = nql;
                }
                queueX[tail] = nx;
                queueZ[tail] = nz;
                queueL[tail] = cl;
                tail++;
            }
        }

        return found;
    }

    // ---- per-region distance matrices ----
    // Upper triangle, flattened row-major over the region's node list:
    //   pair(i,j>i) sits at i*n - i*(i+1)/2 + (j - i - 1)
    // Unreachable pairs are -1. In principle there should be none (same 4-connected
    // region implies mutual reachability, and the 8-direction grid is a superset of
    // those steps) so any -1 is a real inconsistency worth reporting, not a normal case.
    const matrices: Record<string, { nodes: number[]; dist: number[] }> = {};
    let floods = 0;
    let unreachablePairs = 0;
    let pairCount = 0;

    for (const [region, list] of byRegion) {
        if (list.length < 2) {
            continue;
        }
        const n = list.length;
        const flat = new Int32Array((n * (n - 1)) / 2).fill(-1);
        const indexOfNode = new Map<number, number>();
        list.forEach((node, i) => indexOfNode.set(node.id, i));

        for (let i = 0; i < n - 1; i++) {
            const rest = list.slice(i + 1);
            const found = floodTo(list[i].stand, rest);
            floods++;
            for (const node of rest) {
                const j = indexOfNode.get(node.id)!;
                const d = found.get(node.id);
                const at = i * n - (i * (i + 1)) / 2 + (j - i - 1);
                if (d === undefined) {
                    unreachablePairs++;
                } else {
                    flat[at] = d;
                }
                pairCount++;
            }
        }

        matrices[String(region)] = { nodes: list.map(node => node.id), dist: [...flat] };
    }

    console.log(`BuildWalkGraph: ${floods} flood(s) produced ${pairCount} pair distance(s) in ${Date.now() - t0}ms`);

    // ---- nearest named place per node ----
    // Entrance descriptions in the pool are engine-shaped ("laddertop at 2_49_53_8_54"),
    // which tells a player nothing about where they are. Every node that shares a region
    // with a map label gets that label attached, so both front ends can say "the ladder
    // near Falador". Free to compute: the distances already exist in the matrices above.
    let named = 0;
    for (const [region, list] of byRegion) {
        const matrix = matrices[String(region)];
        if (!matrix) {
            // Single-node region: a place alone in it is its own landmark, nothing else to name.
            const only = list[0];
            if (only.kind === 'place') {
                only.near = only.name;
                only.nearDist = 0;
                named++;
            }
            continue;
        }

        const n = list.length;
        const placeIdx: number[] = [];
        list.forEach((node, i) => {
            if (node.kind === 'place') {
                placeIdx.push(i);
            }
        });
        if (placeIdx.length === 0) {
            continue;
        }

        const at = (i: number, j: number): number => {
            if (i === j) {
                return 0;
            }
            const [lo, hi] = i < j ? [i, j] : [j, i];
            return matrix.dist[lo * n - (lo * (lo + 1)) / 2 + (hi - lo - 1)];
        };

        list.forEach((node, i) => {
            let bestName: string | undefined;
            let bestDist = Infinity;
            for (const j of placeIdx) {
                const d = at(i, j);
                if (d >= 0 && d < bestDist) {
                    bestDist = d;
                    bestName = list[j].name;
                }
            }
            if (bestName !== undefined) {
                node.near = bestName;
                node.nearDist = bestDist;
                named++;
            }
        });
    }
    // Second pass: a node underground shares a region with no map label (labels are a
    // surface-map feature), so it stays unnamed above. But the two sides of one entrance
    // are two ends of the same hole in the ground, and that pairing is part of the POOL,
    // not the seed - so a cellar's arrival tile can borrow the landmark from the trigger
    // you climbed down, and vice versa. Marked `nearVia` so a caller can phrase it as
    // "below Falador" rather than claiming the label is walking distance away.
    let inherited = 0;
    const bySideKey = new Map<string, WalkNode[]>();
    for (const node of nodes) {
        if (!node.sideKey) {
            continue;
        }
        const list = bySideKey.get(node.sideKey);
        if (list) {
            list.push(node);
        } else {
            bySideKey.set(node.sideKey, [node]);
        }
    }
    for (const sides of bySideKey.values()) {
        const donor = sides.find(node => node.near !== undefined);
        if (!donor) {
            continue;
        }
        for (const node of sides) {
            if (node.near === undefined) {
                node.near = donor.near;
                node.nearVia = true;
                inherited++;
            }
        }
    }

    console.log(`BuildWalkGraph: ${named} of ${nodes.length} node(s) tagged with a nearest named place (+${inherited} inherited from the other side of their entrance)`);
    if (unreachablePairs > 0) {
        console.log(`BuildWalkGraph: WARNING ${unreachablePairs} same-region pair(s) were mutually unreachable over the walk grid - region graph and walk grid disagree`);
    }

    if (farSnaps.length > 0) {
        console.log(`BuildWalkGraph: ${farSnaps.length} node(s) snapped more than ${STAND_PROBE_RADIUS} tiles to reach walkable ground (check these land where a player would expect):`);
        for (const line of farSnaps) {
            console.log(`  ${line}`);
        }
    }

    if (dropped.length > 0) {
        console.log(`BuildWalkGraph: ${dropped.length} dropped node(s):`);
        for (const line of dropped.slice(0, 20)) {
            console.log(`  ${line}`);
        }
        if (dropped.length > 20) {
            console.log(`  ... and ${dropped.length - 20} more`);
        }
    }

    const output = {
        _generated: 'tools/logic/BuildWalkGraph.ts - do not edit by hand',
        generatedAt: new Date().toISOString(),
        meta: {
            nodeCount: nodes.length,
            entranceNodeCount,
            placeCount: Object.keys(places).length,
            regionsWithMatrix: Object.keys(matrices).length,
            pairCount,
            unreachablePairs,
            droppedNodes: droppedNoStand,
            standProbeRadius: STAND_PROBE_RADIUS,
            costModel: 'BFS step count over ap-walk-grid.bin: one unit per movement step, diagonals included, so the unit is a walking tick (running covers two per tick)',
            encoding: 'matrices[regionId].dist is the flattened upper triangle over matrices[regionId].nodes: pair(i,j>i) at i*n - i*(i+1)/2 + (j-i-1); -1 = unreachable',
            buildMs: Date.now() - t0
        },
        nodes: nodes.map(node => ({
            id: node.id,
            kind: node.kind,
            raw: node.raw,
            stand: toRawCoord(node.stand),
            level: node.stand.level,
            x: node.stand.x,
            z: node.stand.z,
            region: node.region,
            name: node.name,
            snap: node.snap,
            ...(node.near !== undefined ? { near: node.near, ...(node.nearDist !== undefined ? { nearDist: node.nearDist } : {}), ...(node.nearVia ? { nearVia: true } : {}) } : {}),
            ...(node.sideKey ? { sideKey: node.sideKey } : {}),
            ...(node.op !== undefined ? { op: node.op } : {})
        })),
        places,
        matrices
    };

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(output));
    const stat = fs.statSync(OUT_PATH);
    console.log(`BuildWalkGraph: wrote ${OUT_PATH} (${(stat.size / 1024 / 1024).toFixed(2)} MiB)`);

    const biggest = [...byRegion.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
    console.log('BuildWalkGraph: regions with the most nodes:');
    for (const [region, list] of biggest) {
        console.log(`  region=${region} nodes=${list.length} pairs=${(list.length * (list.length - 1)) / 2}`);
    }
}

main().catch(err => {
    console.error(`BuildWalkGraph: fatal error (${err instanceof Error ? (err.stack ?? err.message) : err})`);
    process.exitCode = 1;
});
