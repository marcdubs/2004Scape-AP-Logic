// Archipelago path helper - the runtime router (docs/tracker-map.md "Pathfinding
// helper"). Answers "which entrances do I take, in what order, to get from here to
// there in the fewest movement ticks" for both front ends: the in-game ::appath command
// (AP_PATH_* opcodes -> ap_path.rs2) and the browser tracker's /ap/path route.
//
// ---- The two halves ----
// BuildWalkGraph.ts precomputed every WALKING distance once, seed-independently (see its
// header for why that is possible at all). This module supplies the other half - the
// per-seed wiring - and runs the actual search:
//
//   walk edges      <- ap-walk-graph.json matrices (fixed forever)
//   entrance edges  <- ap-entrances.json overrides (swapped on every reseed)
//
// Because the expensive half is precomputed, a query is a Dijkstra over ~1.7k nodes:
// sub-millisecond. Reseeding needs no rebuild of anything - just a fresh overrides file,
// exactly like every other randomizer table in this project.
//
// ---- Arbitrary start/goal tiles ----
// A player stands wherever they stand, which is almost never a graph node. So a query
// floods the walk grid outward from the start tile (and, when the goal is a raw coord
// rather than a named place, from the goal too) to attach it to the graph nodes sharing
// its region. That flood is the only per-query cost that scales with map size, so it is
// bounded and grown on demand rather than run to exhaustion.

import fs from 'fs';

import { CoordGrid } from '#/engine/CoordGrid.js';
import { WALK_DIR_DX, WALK_DIR_DZ, WALK_DIR_COUNT, WalkGrid, getWalkGrid } from '#/engine/ApWalkGrid.js';
import { getTrackerState } from '#/engine/ApTracker.js';
import { printInfo, printWarning } from '#/util/Logger.js';

const WALK_GRAPH_PATH = 'data/config/ap-walk-graph.json';
const ENTRANCES_PATH = 'data/config/ap-entrances.json';
const ENTRANCE_POOL_PATH = 'data/config/ap-entrance-pool.json';

/**
 * Tick cost charged for using an entrance, in the same unit as a walking step.
 *
 * The honest physical cost is ~2-3 ticks (the click, the climb animation, the tele).
 * Rounding up to 5 prices in the part the tick count misses - reaching the exact trigger
 * tile, waiting out the interface - and keeps the router from proposing a conga line of
 * six ladders to shave a handful of steps off a walk. It stays well under the cost of any
 * real detour, so a genuine shortcut still wins.
 */
const ENTRANCE_STEP_COST = 5;

/** Flood radius tried first when attaching an off-graph tile, then grown on a miss. */
const ATTACH_FLOOD_STEPS = [160, 480, 2000];

interface RawNode {
    id: number;
    kind: 'trigger' | 'arrival' | 'place';
    raw: string;
    stand: string;
    level: number;
    x: number;
    z: number;
    region: number;
    name: string;
    snap: number;
    sideKey?: string;
    op?: number;
    near?: string;
    nearDist?: number;
    nearVia?: boolean;
}

interface WalkGraphFile {
    meta?: Record<string, unknown>;
    nodes: RawNode[];
    places: Record<string, number>;
    matrices: Record<string, { nodes: number[]; dist: number[] }>;
}

export interface PathTile {
    level: number;
    x: number;
    z: number;
}

export type PathLegKind = 'walk' | 'entrance';

export interface PathLeg {
    kind: PathLegKind;
    /** movement ticks for this leg (entrance legs use ENTRANCE_STEP_COST). */
    steps: number;
    from: PathTile;
    to: PathTile;
    /** human label: the destination for a walk leg, the entrance's description for a hop. */
    name: string;
    /** set on entrance legs whose use is conditional (dramen staff, quest varp, ...). */
    requirement?: string;
    /** set on entrance legs the tracker has not yet seen the player use. */
    undiscovered?: boolean;
    /**
     * Nearest named place to this leg's endpoint. Entrance descriptions in the pool are
     * engine-shaped ("laddertop at 2_49_53_8_54"), so this is what makes a leg list
     * legible: "the laddertop near Falador".
     */
    near?: string;
    /**
     * True when `near` names the landmark at the OTHER end of this entrance rather than one
     * within walking distance - i.e. read it as "below/behind X", not "next to X". Set for
     * underground and interior nodes, whose own regions contain no map label.
     */
    nearVia?: boolean;
}

export interface PathResult {
    ok: true;
    legs: PathLeg[];
    totalSteps: number;
    /** the resolved destination's display name. */
    destination: string;
    /** entrance hops in the route. */
    hops: number;
}

export interface PathFailure {
    ok: false;
    reason: string;
}

export interface PathOptions {
    /**
     * Route only through entrances the tracker has already recorded the player using.
     * The browser tracker sets this: revealing an unused entrance's destination in a route
     * would spoil exactly what the discovery journal exists to withhold.
     */
    discoveredOnly?: boolean;
}

interface GraphEdge {
    to: number;
    cost: number;
    kind: PathLegKind;
    /** entrance edges only. */
    label?: string;
    requirement?: string;
    sideKey?: string;
}

interface Graph {
    nodes: RawNode[];
    adjacency: GraphEdge[][];
    places: Record<string, number>;
    /** node ids grouped by region, for attaching off-graph tiles. */
    byRegion: Map<number, number[]>;
    entranceEdges: number;
    walkEdges: number;
    seed: number | null;
}

let graph: Graph | null = null;
let loadFailed = false;

function readJson<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch (err) {
        printWarning(`AP path helper: failed to read ${filePath} (${err instanceof Error ? err.message : err})`);
        return null;
    }
}

function build(): Graph | null {
    const file = readJson<WalkGraphFile>(WALK_GRAPH_PATH);
    if (!file || !Array.isArray(file.nodes) || file.nodes.length === 0) {
        printInfo(`AP path helper: no usable ${WALK_GRAPH_PATH} - run BuildWalkGraph.ts to enable routing`);
        return null;
    }

    const nodes = file.nodes;
    const adjacency: GraphEdge[][] = nodes.map(() => []);
    const byRegion = new Map<number, number[]>();
    for (const node of nodes) {
        const list = byRegion.get(node.region);
        if (list) {
            list.push(node.id);
        } else {
            byRegion.set(node.region, [node.id]);
        }
    }

    // ---- walk edges from the precomputed per-region matrices ----
    let walkEdges = 0;
    for (const [, matrix] of Object.entries(file.matrices ?? {})) {
        const ids = matrix.nodes;
        const n = ids.length;
        for (let i = 0; i < n - 1; i++) {
            for (let j = i + 1; j < n; j++) {
                const d = matrix.dist[i * n - (i * (i + 1)) / 2 + (j - i - 1)];
                if (d < 0) {
                    continue; // recorded as unreachable by the builder.
                }
                adjacency[ids[i]].push({ to: ids[j], cost: d, kind: 'walk' });
                adjacency[ids[j]].push({ to: ids[i], cost: d, kind: 'walk' });
                walkEdges += 2;
            }
        }
    }

    // ---- entrance edges: this seed's wiring ----
    // Index arrival nodes by their pre-probe coord, which is what an override's destination
    // literal names. Trigger nodes are indexed by "coord:op", matching the override keys and
    // the requires table.
    const arrivalByRaw = new Map<string, number>();
    const triggerBySideKey = new Map<string, number>();
    const arrivalBySideKey = new Map<string, number>();
    for (const node of nodes) {
        if (node.kind === 'arrival') {
            if (!arrivalByRaw.has(node.raw)) {
                arrivalByRaw.set(node.raw, node.id);
            }
            if (node.sideKey) {
                arrivalBySideKey.set(node.sideKey, node.id);
            }
        } else if (node.kind === 'trigger' && node.sideKey) {
            triggerBySideKey.set(node.sideKey, node.id);
        }
    }

    const seedFile = readJson<{ seed?: number; overrides?: Record<string, string> }>(ENTRANCES_PATH);
    const overrides = seedFile?.overrides ?? {};
    const pool = readJson<{ requires?: Record<string, { name?: string; require?: Record<string, unknown> }> }>(ENTRANCE_POOL_PATH);
    const requires = pool?.requires ?? {};

    let entranceEdges = 0;
    let unresolvedDestinations = 0;
    for (const [sideKey, triggerId] of triggerBySideKey) {
        const trigger = nodes[triggerId];

        // Where does this entrance go for THIS seed? An override if it was shuffled,
        // otherwise its own vanilla arrival. Both are ordinary edges to the router.
        const overridden = overrides[sideKey];
        let arrivalId: number | undefined;
        if (overridden !== undefined) {
            arrivalId = arrivalByRaw.get(overridden);
            if (arrivalId === undefined) {
                // The seed points somewhere that is not any pool side's arrival tile. Should
                // not happen with a RandomizeEntrances-built table, so count it rather than
                // guessing at a nearby node.
                unresolvedDestinations++;
                continue;
            }
        } else {
            arrivalId = arrivalBySideKey.get(sideKey);
            if (arrivalId === undefined) {
                continue;
            }
        }

        const gate = requires[sideKey];
        adjacency[triggerId].push({
            to: arrivalId,
            cost: ENTRANCE_STEP_COST,
            kind: 'entrance',
            label: trigger.name,
            sideKey,
            // Conditional entrances stay in the graph and carry their condition into the
            // leg instead of being dropped: telling a player "take the Zanaris shed, you
            // need a dramen staff" beats silently pretending no route exists.
            requirement: gate ? (gate.name ?? describeRequirement(gate.require)) : undefined
        });
        entranceEdges++;
    }

    if (unresolvedDestinations > 0) {
        printWarning(`AP path helper: ${unresolvedDestinations} entrance override(s) point at a tile that is not a known arrival - those hops are missing from routes`);
    }

    printInfo(`AP path helper: graph ready - ${nodes.length} node(s), ${walkEdges} walk edge(s), ${entranceEdges} entrance edge(s), ${Object.keys(file.places ?? {}).length} named place(s)`);

    return {
        nodes,
        adjacency,
        places: file.places ?? {},
        byRegion,
        entranceEdges,
        walkEdges,
        seed: seedFile?.seed ?? null
    };
}

function describeRequirement(require: Record<string, unknown> | undefined): string {
    if (!require) {
        return 'a requirement';
    }
    if (typeof require.item === 'string') {
        return require.item.replace(/_/g, ' ');
    }
    if (typeof require.varp === 'string') {
        return `quest progress (${require.varp})`;
    }
    return 'a requirement';
}

function getGraph(): Graph | null {
    if (graph !== null) {
        return graph;
    }
    if (loadFailed) {
        return null;
    }
    graph = build();
    if (graph === null) {
        loadFailed = true;
    }
    return graph;
}

/** Drops the cached graph so the next query re-reads both tables (reseed / rebuild). */
export function reloadPathfinder(): void {
    graph = null;
    loadFailed = false;
}

// ---- off-graph attachment ----------------------------------------------------------
// Generation-stamped per-mapsquare scratch, so repeated queries never pay to clear ~8M
// cells. Same trick BuildWalkGraph uses; kept in module state because a player spamming
// ::appath should reuse the buffers, not reallocate them.

const SQUARE_TILES = 64;
const LEVELS = 4;
const PER_SQUARE = LEVELS * SQUARE_TILES * SQUARE_TILES;
const distBySquare = new Map<number, Int32Array>();
const genBySquare = new Map<number, Int32Array>();
let generation = 0;

let queueX = new Int32Array(1 << 16);
let queueZ = new Int32Array(1 << 16);

function squareId(x: number, z: number): number {
    return ((x >> 6) << 9) | (z >> 6);
}
function localIdx(x: number, z: number, level: number): number {
    return level * SQUARE_TILES * SQUARE_TILES + (z & 63) * SQUARE_TILES + (x & 63);
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
function packTile(level: number, x: number, z: number): number {
    return (level << 28) | (x << 14) | z;
}

/**
 * Walking distances from `source` to every graph node it can reach within `maxSteps`.
 * Uniform step cost means plain BFS is optimal, so no priority queue is needed here.
 */
function attachFlood(grid: WalkGrid, source: PathTile, wanted: Map<number, number[]>, maxSteps: number): Map<number, number> {
    generation++;
    const found = new Map<number, number>();

    const startScratch = scratchFor(squareId(source.x, source.z));
    const startIdx = localIdx(source.x, source.z, source.level);
    startScratch.gen[startIdx] = generation;
    startScratch.dist[startIdx] = 0;

    let head = 0;
    let tail = 0;
    queueX[tail] = source.x;
    queueZ[tail] = source.z;
    tail++;

    for (const id of wanted.get(packTile(source.level, source.x, source.z)) ?? []) {
        found.set(id, 0);
    }

    while (head < tail) {
        const cx = queueX[head];
        const cz = queueZ[head];
        head++;

        const d = scratchFor(squareId(cx, cz)).dist[localIdx(cx, cz, source.level)] + 1;
        if (d > maxSteps) {
            continue;
        }
        const mask = grid.maskAt(cx, cz, source.level);
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
            const idx = localIdx(nx, nz, source.level);
            if (scratch.gen[idx] === generation) {
                continue;
            }
            scratch.gen[idx] = generation;
            scratch.dist[idx] = d;

            for (const id of wanted.get(packTile(source.level, nx, nz)) ?? []) {
                if (!found.has(id)) {
                    found.set(id, d);
                }
            }

            if (tail >= queueX.length) {
                const cap = queueX.length * 2;
                const nqx = new Int32Array(cap);
                const nqz = new Int32Array(cap);
                nqx.set(queueX);
                nqz.set(queueZ);
                queueX = nqx;
                queueZ = nqz;
            }
            queueX[tail] = nx;
            queueZ[tail] = nz;
            tail++;
        }
    }

    return found;
}

/**
 * Attaches an arbitrary tile to the graph, returning walking distances to nearby nodes.
 * Grows the flood radius rather than starting unbounded: the common case (a player in a
 * town, metres from a dozen entrances) resolves in the smallest pass.
 */
function attach(grid: WalkGrid, g: Graph, tile: PathTile, extra?: { tile: PathTile; id: number }): Map<number, number> {
    const stand = grid.resolveStandTile(tile.x, tile.z, tile.level) ?? tile;

    // Only nodes on the same level can be walked to - the grid has no inter-level steps
    // (that is what entrances are), so restricting the target set keeps the flood honest.
    const wanted = new Map<number, number[]>();
    const want = (level: number, x: number, z: number, id: number): void => {
        const key = packTile(level, x, z);
        const list = wanted.get(key);
        if (list) {
            list.push(id);
        } else {
            wanted.set(key, [id]);
        }
    };

    for (const node of g.nodes) {
        if (node.level !== stand.level) {
            continue;
        }
        want(node.level, node.x, node.z, node.id);
    }

    // The goal tile itself, when it is a raw coord rather than a named place. Without this
    // the router could not express "just walk there" - the two virtual endpoints would
    // share a region yet have no edge between them, and a route needing no entrance at all
    // would come back as unreachable.
    if (extra && extra.tile.level === stand.level) {
        want(extra.tile.level, extra.tile.x, extra.tile.z, extra.id);
    }

    for (const maxSteps of ATTACH_FLOOD_STEPS) {
        const found = attachFlood(grid, stand, wanted, maxSteps);
        if (found.size > 0) {
            return found;
        }
    }
    return new Map();
}

// ---- the search --------------------------------------------------------------------

interface Attachment {
    /** graph node id -> walking cost from/to the virtual endpoint. */
    edges: Map<number, number>;
    tile: PathTile;
    name: string;
    /** set when the endpoint IS a graph node (a named place), so no virtual node is needed. */
    nodeId?: number;
}

function tileOf(node: RawNode): PathTile {
    return { level: node.level, x: node.x, z: node.z };
}

/**
 * Dijkstra from `start` to `goal` over graph nodes plus up to two virtual endpoints.
 * Virtual ids are numbered after the real ones: START = n, GOAL = n + 1.
 */
function search(g: Graph, start: Attachment, goal: Attachment, opts: PathOptions, discovered: Set<string>): PathResult | PathFailure {
    const n = g.nodes.length;
    const START = start.nodeId ?? n;
    const GOAL = goal.nodeId ?? n + 1;
    const total = n + 2;

    const dist = new Float64Array(total).fill(Infinity);
    const prev = new Int32Array(total).fill(-1);
    const prevEdge: (GraphEdge | null)[] = new Array(total).fill(null);
    const done = new Uint8Array(total);

    // Goal-side attachment as a reverse lookup: node -> cost to reach the goal tile.
    const goalEdges = goal.nodeId === undefined ? goal.edges : null;

    dist[START] = 0;

    // Node count is ~1.7k, so a linear scan for the minimum costs ~1.7k^2 = 3M
    // comparisons worst case - microseconds, and far simpler than a binary heap. If the
    // graph ever grows an order of magnitude, revisit.
    for (;;) {
        let best = -1;
        let bestDist = Infinity;
        for (let i = 0; i < total; i++) {
            if (!done[i] && dist[i] < bestDist) {
                bestDist = dist[i];
                best = i;
            }
        }
        if (best === -1 || best === GOAL) {
            break;
        }
        done[best] = 1;

        const relax = (to: number, cost: number, edge: GraphEdge): void => {
            const next = bestDist + cost;
            if (next < dist[to]) {
                dist[to] = next;
                prev[to] = best;
                prevEdge[to] = edge;
            }
        };

        if (best === START && start.nodeId === undefined) {
            for (const [nodeId, cost] of start.edges) {
                relax(nodeId, cost, { to: nodeId, cost, kind: 'walk' });
            }
            continue;
        }

        for (const edge of g.adjacency[best]) {
            if (edge.kind === 'entrance' && opts.discoveredOnly && edge.sideKey && !discovered.has(edge.sideKey)) {
                continue; // not yet used by the player - invisible to a discovery-limited route.
            }
            relax(edge.to, edge.cost, edge);
        }

        if (goalEdges) {
            const cost = goalEdges.get(best);
            if (cost !== undefined) {
                relax(GOAL, cost, { to: GOAL, cost, kind: 'walk' });
            }
        }
    }

    if (!Number.isFinite(dist[GOAL])) {
        return {
            ok: false,
            reason: opts.discoveredOnly
                ? `no route to ${goal.name} using only entrances you have already explored`
                : `no route to ${goal.name} found`
        };
    }

    // ---- rebuild the leg list ----
    const chain: { node: number; edge: GraphEdge | null }[] = [];
    for (let at = GOAL; at !== -1; at = prev[at]) {
        chain.push({ node: at, edge: prevEdge[at] });
        if (at === START) {
            break;
        }
    }
    chain.reverse();

    const tileFor = (id: number): PathTile => (id === START ? start.tile : id === GOAL ? goal.tile : tileOf(g.nodes[id]));
    const nameFor = (id: number): string => (id === START ? start.name : id === GOAL ? goal.name : g.nodes[id].name);
    // A node's own name already IS the landmark when it is a place node, so don't say
    // "Varrock (near Varrock)".
    const nearFor = (id: number): { near?: string; nearVia?: boolean } => {
        if (id === START || id === GOAL) {
            return {};
        }
        const node = g.nodes[id];
        if (node.kind === 'place' || node.near === undefined || node.near === node.name) {
            return {};
        }
        return { near: node.near, ...(node.nearVia ? { nearVia: true } : {}) };
    };

    const legs: PathLeg[] = [];
    for (let i = 1; i < chain.length; i++) {
        const edge = chain[i].edge;
        if (!edge) {
            continue;
        }
        const fromId = chain[i - 1].node;
        const toId = chain[i].node;
        const leg: PathLeg = {
            kind: edge.kind,
            steps: edge.cost,
            from: tileFor(fromId),
            to: tileFor(toId),
            name: edge.kind === 'entrance' ? (edge.label ?? nameFor(fromId)) : nameFor(toId),
            // A walk leg is described by where it ends; an entrance leg by where you use it.
            ...nearFor(edge.kind === 'entrance' ? fromId : toId)
        };
        if (edge.requirement) {
            leg.requirement = edge.requirement;
        }
        if (edge.kind === 'entrance' && edge.sideKey && !discovered.has(edge.sideKey)) {
            leg.undiscovered = true;
        }
        legs.push(leg);
    }

    // Consecutive walk legs can appear when the route passes through a node without
    // changing mode (walk to a trigger, then walk on). Merge them: the player only cares
    // about the walk that ends at something they must interact with.
    const merged: PathLeg[] = [];
    for (const leg of legs) {
        const last = merged[merged.length - 1];
        if (last && last.kind === 'walk' && leg.kind === 'walk') {
            last.steps += leg.steps;
            last.to = leg.to;
            last.name = leg.name;
            last.near = leg.near;
            last.nearVia = leg.nearVia;
            continue;
        }
        merged.push(leg);
    }

    return {
        ok: true,
        legs: merged,
        totalSteps: Math.round(dist[GOAL]),
        destination: goal.name,
        hops: merged.filter(l => l.kind === 'entrance').length
    };
}

function discoveredEntrances(): Set<string> {
    const state = getTrackerState();
    return new Set(Object.keys(state.entrances ?? {}));
}

/**
 * Named places the helper can route to. Carries each place's tile as well as its name, so
 * a caller can use a place as a route ORIGIN too (the router takes a coord for that, not a
 * key) - which is what the tracker's "From" picker needs.
 */
export function listPlaces(): { key: string; name: string; raw: string; level: number; x: number; z: number }[] {
    const g = getGraph();
    if (!g) {
        return [];
    }
    return Object.entries(g.places)
        .map(([key, id]) => {
            const node = g.nodes[id];
            return { key, name: node.name, raw: node.stand, level: node.level, x: node.x, z: node.z };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolves a destination the user typed. Accepts a place key ("varrock"), a display name
 * ("Al Kharid"), or a raw "level_mapX_mapZ_localX_localZ" coord literal.
 */
function resolveDestination(g: Graph, grid: WalkGrid, query: string): Attachment | PathFailure {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
        return { ok: false, reason: 'no destination given' };
    }

    if (/^\d+_\d+_\d+_\d+_\d+$/.test(trimmed)) {
        const [level, mapX, mapZ, localX, localZ] = trimmed.split('_').map(Number);
        const asked = { level, x: mapX * 64 + localX, z: mapZ * 64 + localZ };
        // Probe here rather than inside attach, so the tile the flood targets and the tile
        // reported as the route's end are the same one.
        const tile = grid.resolveStandTile(asked.x, asked.z, asked.level) ?? asked;
        const edges = attach(grid, g, tile);
        if (edges.size === 0) {
            return { ok: false, reason: `nothing reachable near ${trimmed}` };
        }
        return { edges, tile, name: trimmed };
    }

    const key = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const id = g.places[key];
    if (id === undefined) {
        // Offer near misses rather than a bare failure - typing "varock" should not be a
        // dead end.
        const suggestions = Object.keys(g.places)
            .filter(k => k.startsWith(key.slice(0, 4)) || k.includes(key))
            .slice(0, 5)
            .map(k => g.nodes[g.places[k]].name);
        return {
            ok: false,
            reason: suggestions.length > 0 ? `unknown place '${trimmed}' - did you mean ${suggestions.join(', ')}?` : `unknown place '${trimmed}'`
        };
    }

    return { edges: new Map(), tile: tileOf(g.nodes[id]), name: g.nodes[id].name, nodeId: id };
}

/**
 * The main entry point. `from` is a live tile (the player's position, or the tracker's
 * chosen origin); `to` is anything resolveDestination accepts.
 */
export function findPath(from: PathTile, to: string, opts: PathOptions = {}): PathResult | PathFailure {
    const grid = getWalkGrid();
    if (!grid) {
        return { ok: false, reason: 'the path helper is unavailable (no walk grid built)' };
    }
    const g = getGraph();
    if (!g) {
        return { ok: false, reason: 'the path helper is unavailable (no walk graph built)' };
    }

    const goal = resolveDestination(g, grid, to);
    if ('ok' in goal) {
        return goal;
    }

    // When the goal is a raw tile it gets the virtual id n+1 (see `search`), so the start
    // flood must be able to find it directly - otherwise a walk-only route is unexpressible.
    const goalVirtualId = g.nodes.length + 1;
    const startEdges = attach(grid, g, from, goal.nodeId === undefined ? { tile: goal.tile, id: goalVirtualId } : undefined);
    if (startEdges.size === 0) {
        return { ok: false, reason: 'cannot find anywhere to walk from your current position' };
    }

    const start: Attachment = { edges: startEdges, tile: from, name: 'here' };

    // Already standing on the destination - a route of zero legs is a valid answer.
    const goalId = goal.nodeId ?? goalVirtualId;
    if (startEdges.get(goalId) === 0) {
        return { ok: true, legs: [], totalSteps: 0, destination: goal.name, hops: 0 };
    }

    // The discovered set is always needed: `discoveredOnly` decides whether unexplored
    // entrances are excluded outright, but even an unrestricted route flags them so a
    // caller can present "you have not been through here yet".
    return search(g, start, goal, opts, discoveredEntrances());
}

/** Convenience wrapper for callers holding a packed coord (the script opcodes do). */
export function findPathFromPacked(packed: number, to: string, opts: PathOptions = {}): PathResult | PathFailure {
    const { level, x, z } = CoordGrid.unpackCoord(packed);
    return findPath({ level, x, z }, to, opts);
}

export { ENTRANCE_STEP_COST };
