// Seed beatability validator (docs/entrance-logic.md Workstream C). Consumes the
// region graph (BuildRegionGraph.ts's region-graph.json, spatial truth) together with
// the seed's entrance table, gated-area table, and the progression simulator's quest/
// goal database, and runs a combined region+quest sphere-expansion fixpoint: regions
// unlock quests' region requirements, quests/QP unlock gated edges' requirements,
// newly-unlocked edges unlock more regions, repeat to fixpoint. Exit 0 = every goal
// reachable, exit 1 = at least one goal blocked - CI-gateable, mirrors
// tools/sim/SimulateProgression.ts's contract exactly (that tool proves quest-chain
// beatability under vanilla travel assumptions; this one adds "and the shuffled
// entrances actually let you get there").
//
// Usage (from Server/engine):
//   npx tsx tools/logic/ValidateSeed.ts [--config-dir data/config] [--verbose] [--json out.json]
//
// Run BuildRegionGraph.ts first (region-graph.json is a precomputed, checked-in build
// artifact - this tool does not rebuild it).

import fs from 'fs';
import path from 'path';

import { allSkillCaps, loadSeedConfig } from '../sim/ConfigLoader.js';
import { Goal, QuestReq, StatName } from '../sim/types.js';

import { WorldTile, parseRawCoord } from './Coords.js';
import { GatedArea, GatedAreaRequire, RequireContext, describeRequire, loadGatedAreas, requireSatisfied } from './GatedAreas.js';

// ---- CLI args ----

const argv = process.argv.slice(2);
function argVal(flag: string): string | undefined {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
}
const CONFIG_DIR = argVal('--config-dir') ?? 'data/config';
const JSON_OUT = argVal('--json');
const VERBOSE = argv.includes('--verbose') || argv.includes('-v');
const REGION_GRAPH_PATH = argVal('--region-graph') ?? path.join('tools', 'logic', 'region-graph.json');
const QUEST_REGIONS_PATH = path.join('tools', 'logic', 'data', 'quest-regions.json');
const QUESTS_PATH = path.join('tools', 'sim', 'data', 'quests.json');
const GOALS_PATH = path.join('tools', 'sim', 'data', 'goals.json');

// vanilla Lumbridge respawn, matches ApSpawnOverrides.ts's VANILLA_HOME literal exactly.
const VANILLA_SPAWN_RAW = '0_50_50_21_18';

// ---- region graph loading ----

interface RegionGraphMeta {
    mainlandRegionId: number;
    levels: number;
    regionCount: number;
}
interface RegionMetaEntry {
    id: number;
    level: number;
    tileCount: number;
    bbox: { minX: number; maxX: number; minZ: number; maxZ: number };
}

class RegionGraph {
    meta: RegionGraphMeta;
    regionsById: Map<number, RegionMetaEntry>;
    private squares: Map<string, Int32Array>; // "mx_mz" -> Int32Array(levels*4096)
    private levels: number;

    constructor(raw: { meta: RegionGraphMeta; regions: RegionMetaEntry[]; squares: Record<string, Record<string, number[][]>> }) {
        this.meta = raw.meta;
        this.levels = raw.meta.levels;
        this.regionsById = new Map(raw.regions.map(r => [r.id, r]));
        this.squares = new Map();
        for (const [key, perLevel] of Object.entries(raw.squares)) {
            const arr = new Int32Array(this.levels * 4096);
            for (const [levelStr, runs] of Object.entries(perLevel)) {
                const level = Number(levelStr);
                let pos = level * 4096;
                for (const [regionId, runLen] of runs) {
                    arr.fill(regionId, pos, pos + runLen);
                    pos += runLen;
                }
            }
            this.squares.set(key, arr);
        }
    }

    /** Exact region id at this tile, or 0 (not walkable / not part of any loaded mapsquare). */
    regionAt(x: number, z: number, level: number): number {
        const arr = this.squares.get(`${x >> 6}_${z >> 6}`);
        if (!arr) {
            return 0;
        }
        return arr[level * 4096 + (z & 63) * 64 + (x & 63)];
    }

    /**
     * Resolves a "gameplay-meaningful" coordinate (entrance trigger/arrival tile, quest
     * anchor, spawn point) to a region id, probing a small neighborhood if the exact
     * tile itself isn't walkable (loc footprints - ladders, doors, statues - routinely
     * occupy their own trigger tile without being the tile a player actually stands on;
     * BuildRegionGraph.ts's own Lumbridge-anchor resolution uses the same trick). Returns
     * 0 if nothing walkable is found within `radius`.
     */
    resolveRegion(tile: WorldTile, radius = 3): number {
        const direct = this.regionAt(tile.x, tile.z, tile.level);
        if (direct !== 0) {
            return direct;
        }
        for (let r = 1; r <= radius; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) {
                        continue; // only scan the new ring at this radius.
                    }
                    const found = this.regionAt(tile.x + dx, tile.z + dz, tile.level);
                    if (found !== 0) {
                        return found;
                    }
                }
            }
        }
        return 0;
    }
}

function loadRegionGraph(filePath: string): RegionGraph {
    if (!fs.existsSync(filePath)) {
        console.error(`ValidateSeed: ${filePath} not found - run BuildRegionGraph.ts first`);
        process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return new RegionGraph(raw);
}

// ---- entrance table (ap-entrances.json: overrides + optional gates) ----

interface EntranceEdge {
    key: string; // "level_mapX_mapZ_localX_localZ:op"
    triggerTile: WorldTile;
    arrivalTile: WorldTile;
    fromRegion: number;
    toRegion: number;
    require?: GatedAreaRequire;
    gateName?: string;
}

function loadEntranceEdges(configDir: string, graph: RegionGraph): { edges: EntranceEdge[]; present: boolean } {
    const file = path.join(configDir, 'ap-entrances.json');
    if (!fs.existsSync(file)) {
        return { edges: [], present: false };
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { overrides?: Record<string, string>; gates?: Record<string, { require: GatedAreaRequire; name?: string }> };
    const KEY_RE = /^\d+_\d+_\d+_\d+_\d+:\d+$/;
    const COORD_RE = /^\d+_\d+_\d+_\d+_\d+$/;
    const edges: EntranceEdge[] = [];
    for (const [from, to] of Object.entries(parsed.overrides ?? {})) {
        if (!KEY_RE.test(from) || !COORD_RE.test(to)) {
            continue; // malformed entries already warned about by the engine loader; skip silently here.
        }
        const [coordRaw] = from.split(':');
        const triggerTile = parseRawCoord(coordRaw);
        const arrivalTile = parseRawCoord(to);
        const gate = parsed.gates?.[from];
        edges.push({
            key: from,
            triggerTile,
            arrivalTile,
            fromRegion: graph.resolveRegion(triggerTile),
            toRegion: graph.resolveRegion(arrivalTile),
            require: gate?.require,
            gateName: gate?.name
        });
    }
    return { edges, present: true };
}

// ---- gated areas: compute each area's isolated ("gated") region ids and the outside
// region ids immediately bordering its box(es), per docs/entrance-logic.md's pragmatic
// simplification ("area regions are reachable iff require satisfied AND an
// edge/adjacency reaches them"). See BuildRegionGraph.ts's file header for why doors
// near these boxes were kept closed in the first place - this is where that pays off:
// a well-enclosed curated area reliably shows up as its own region id(s), distinct from
// whatever borders it. ----

interface ResolvedGatedArea {
    area: GatedArea;
    gatedRegionIds: Set<number>;
    outsideRegionIds: Set<number>;
}

function resolveGatedAreas(areas: GatedArea[], graph: RegionGraph): ResolvedGatedArea[] {
    return areas.map(area => {
        const insideIds = new Set<number>();
        const outsideIds = new Set<number>();
        for (const box of area.boxes) {
            for (let x = box.x1; x <= box.x2; x++) {
                for (let z = box.z1; z <= box.z2; z++) {
                    const id = graph.regionAt(x, z, box.level);
                    if (id !== 0) {
                        insideIds.add(id);
                    }
                }
            }
            // 1-tile ring immediately outside the (padded) box.
            for (let x = box.x1 - 1; x <= box.x2 + 1; x++) {
                for (let z = box.z1 - 1; z <= box.z2 + 1; z++) {
                    if (x >= box.x1 && x <= box.x2 && z >= box.z1 && z <= box.z2) {
                        continue; // inside the box, not the ring.
                    }
                    const id = graph.regionAt(x, z, box.level);
                    if (id !== 0) {
                        outsideIds.add(id);
                    }
                }
            }
        }
        const gatedRegionIds = new Set([...insideIds].filter(id => !outsideIds.has(id)));
        return { area, gatedRegionIds, outsideRegionIds: outsideIds };
    });
}

// ---- quest-regions.json (this tool's own curated data - see that file's _comment) ----

interface AnchorDef {
    level: number;
    x: number;
    z: number;
    note?: string;
}
interface QuestRegionsFile {
    anchors: Record<string, AnchorDef>;
    alwaysConnected: { from: string; to: string; note?: string }[];
    quests: Record<string, { requiredAnchors: string[]; notes?: string }>;
    goals: Record<string, { requiredAnchors: string[]; notes?: string }>;
}

function loadQuestRegions(): QuestRegionsFile {
    return JSON.parse(fs.readFileSync(QUEST_REGIONS_PATH, 'utf8'));
}

// ---- curated varp resolvers for ap-gated-areas.json's `{varp,gte}` require form.
// These names come straight from the shipped ap-gated-areas.json's "derivation" fields
// (Workstream A) - "qp" is generic and always tracked; the rest are area-specific
// persistent-flag varps this tool doesn't have direct visibility into, so they're
// mapped to the nearest equivalent state this simulation DOES track. Curated and
// growable, same pattern as quest-regions.json - an unrecognized varp name falls back
// to 0 (fail-closed) via GatedAreas.ts's requireSatisfied. ----

function resolveVarp(name: string, qp: number, completed: Set<string>, statCaps: Map<string, number>): number | undefined {
    switch (name) {
        case 'qp':
            return qp;
        case 'heroquest': // Heroes' Guild gate; heroquest>=15 in vanilla means Heroes' Quest complete.
            return completed.has('hero') ? 999 : 0;
        case 'legendsquest': // Legends' Guild gate; legendsquest>=75 means Legends' Quest complete.
            return completed.has('legends') ? 999 : 0;
        case 'prayer_guild': // Not a quest at all - set permanently once base Prayer >= 31 (Abbot Langley dialogue).
            return (statCaps.get('prayer') ?? 99) >= 31 ? 1 : 0;
        default:
            return undefined; // unknown varp -> requireSatisfied treats as 0 (fail-closed).
    }
}

// ---- quest requirement checks (small reimplementation of Engine.ts's private
// skillsSatisfied/questsSatisfied/qpSatisfied - those aren't exported from
// tools/sim/Engine.ts, and the design brief asks this tool to "steal patterns, don't
// import [sim's engine] code unless clean" since region-awareness changes the shape of
// the fixpoint enough that sharing the loop itself isn't a clean fit). ----

function skillsSatisfied(skills: Partial<Record<StatName, number>> | undefined, caps: Record<StatName, number>): boolean {
    if (!skills) {
        return true;
    }
    for (const [stat, level] of Object.entries(skills) as [StatName, number][]) {
        if (caps[stat] < level) {
            return false;
        }
    }
    return true;
}

function questsChainSatisfied(quests: string[] | undefined, questsAny: string[][] | undefined, completed: Set<string>): boolean {
    if (quests && !quests.every(id => completed.has(id))) {
        return false;
    }
    if (questsAny && !questsAny.every(group => group.some(id => completed.has(id)))) {
        return false;
    }
    return true;
}

function regionsSatisfied(requiredAnchors: string[] | undefined, anchorRegions: Map<string, number>, reachableRegions: Set<number>): boolean {
    if (!requiredAnchors) {
        return true;
    }
    return requiredAnchors.every(name => {
        const region = anchorRegions.get(name);
        return region !== undefined && region !== 0 && reachableRegions.has(region);
    });
}

// ---- main ----

interface SphereEvent {
    sphere: number;
    questsCompleted: string[];
    regionsUnlocked: number;
    goalsReached: string[];
}

function main(): void {
    const graph = loadRegionGraph(REGION_GRAPH_PATH);
    const seedConfig = loadSeedConfig(CONFIG_DIR);
    const statCaps = allSkillCaps(seedConfig.unlocks) as Record<StatName, number>;
    const statCapsLower = new Map<string, number>(Object.entries(statCaps).map(([k, v]) => [k.toLowerCase(), v]));

    const { edges: entranceEdges, present: entrancesPresent } = loadEntranceEdges(CONFIG_DIR, graph);
    const gated = loadGatedAreas(CONFIG_DIR);
    const resolvedAreas = resolveGatedAreas(gated.areas, graph);

    const qr = loadQuestRegions();
    const anchorRegions = new Map<string, number>();
    for (const [name, def] of Object.entries(qr.anchors)) {
        anchorRegions.set(name, graph.resolveRegion({ level: def.level, x: def.x, z: def.z }));
    }

    const quests: QuestReq[] = JSON.parse(fs.readFileSync(QUESTS_PATH, 'utf8')).quests;
    const goals: Goal[] = JSON.parse(fs.readFileSync(GOALS_PATH, 'utf8')).goals;
    const questsById = new Map(quests.map(q => [q.id, q]));

    // spawn region
    const spawnFile = path.join(CONFIG_DIR, 'ap-spawn.json');
    let spawnRaw = VANILLA_SPAWN_RAW;
    if (fs.existsSync(spawnFile)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(spawnFile, 'utf8')) as { home?: string };
            if (parsed.home && /^\d+_\d+_\d+_\d+_\d+$/.test(parsed.home)) {
                spawnRaw = parsed.home;
            }
        } catch {
            // fall through to vanilla.
        }
    }
    const spawnTile = parseRawCoord(spawnRaw);
    const spawnRegion = graph.resolveRegion(spawnTile);

    // ---- sphere fixpoint ----
    const reachableRegions = new Set<number>();
    if (spawnRegion !== 0) {
        reachableRegions.add(spawnRegion);
    }
    const completed = new Set<string>();
    let qp = 0;
    const spheres: SphereEvent[] = [];
    const goalSphere = new Map<string, number>();
    let sphere = 0;

    function heldItems() {
        // Item requirements are treated as always-satisfiable (narrative-only), matching
        // tools/sim/Engine.ts's documented policy - no quest or gated area in this
        // dataset currently needs a real gathersanity/processsanity item-swap check
        // (verified during that tool's build; the mechanism stays a ready extension
        // point there, not here).
        return { has: (_item: string) => true };
    }

    function buildCtx(): RequireContext {
        return {
            varps: new Map(
                ['qp', 'heroquest', 'legendsquest', 'prayer_guild']
                    .map(name => [name, resolveVarp(name, qp, completed, statCapsLower)] as const)
                    .filter((e): e is [string, number] => e[1] !== undefined)
            ),
            heldItems: heldItems(),
            statCaps: statCapsLower
        };
    }

    // seed goal-reachable-at-sphere-0 check (barcrawl needs no quest/qp, only Karamja).
    function checkGoalsNow(): string[] {
        const newlyReached: string[] = [];
        for (const g of goals) {
            if (goalSphere.has(g.id)) {
                continue;
            }
            const caps = statCaps;
            if (
                skillsSatisfied(g.skills, caps) &&
                qp >= (g.requiredQp ?? 0) &&
                questsChainSatisfied(g.quests, undefined, completed) &&
                regionsSatisfied(qr.goals[g.id]?.requiredAnchors, anchorRegions, reachableRegions)
            ) {
                goalSphere.set(g.id, sphere);
                newlyReached.push(g.id);
            }
        }
        return newlyReached;
    }

    const goalsAt0 = checkGoalsNow();

    for (;;) {
        let changed = false;
        const ctx = buildCtx();

        // 1. entrance edges (gated or not).
        for (const edge of entranceEdges) {
            if (edge.fromRegion === 0 || edge.toRegion === 0 || !reachableRegions.has(edge.fromRegion) || reachableRegions.has(edge.toRegion)) {
                continue;
            }
            if (edge.require && !requireSatisfied(edge.require, ctx)) {
                continue;
            }
            reachableRegions.add(edge.toRegion);
            changed = true;
        }

        // 2. alwaysConnected synthetic edges (Karamja boat etc - see quest-regions.json).
        for (const ac of qr.alwaysConnected) {
            const rFrom = anchorRegions.get(ac.from);
            const rTo = anchorRegions.get(ac.to);
            if (rFrom === undefined || rTo === undefined || rFrom === 0 || rTo === 0) {
                continue;
            }
            if (reachableRegions.has(rFrom) && !reachableRegions.has(rTo)) {
                reachableRegions.add(rTo);
                changed = true;
            }
            if (reachableRegions.has(rTo) && !reachableRegions.has(rFrom)) {
                reachableRegions.add(rFrom);
                changed = true;
            }
        }

        // 3. gated areas.
        for (const ra of resolvedAreas) {
            if (![...ra.outsideRegionIds].some(id => reachableRegions.has(id))) {
                continue;
            }
            if (!requireSatisfied(ra.area.require, ctx)) {
                continue;
            }
            for (const gid of ra.gatedRegionIds) {
                if (!reachableRegions.has(gid)) {
                    reachableRegions.add(gid);
                    changed = true;
                }
            }
        }

        // 4. quests.
        const newlyCompleted: QuestReq[] = [];
        for (const q of quests) {
            if (completed.has(q.id)) {
                continue;
            }
            if (
                skillsSatisfied(q.skills, statCaps) &&
                qp >= (q.requiredQp ?? 0) &&
                questsChainSatisfied(q.quests, q.questsAny, completed) &&
                regionsSatisfied(qr.quests[q.id]?.requiredAnchors, anchorRegions, reachableRegions)
            ) {
                newlyCompleted.push(q);
            }
        }
        if (newlyCompleted.length > 0) {
            changed = true;
            for (const q of newlyCompleted) {
                completed.add(q.id);
                qp += q.qp;
            }
        }

        if (!changed) {
            break;
        }
        sphere += 1;
        const goalsReached = checkGoalsNow();
        spheres.push({
            sphere,
            questsCompleted: newlyCompleted.map(q => q.id),
            regionsUnlocked: reachableRegions.size,
            goalsReached
        });
    }
    if (goalsAt0.length > 0) {
        spheres.unshift({ sphere: 0, questsCompleted: [], regionsUnlocked: reachableRegions.size, goalsReached: goalsAt0 });
    }

    const allGoalsReached = goals.every(g => goalSphere.has(g.id));

    // ---- reporting ----

    console.log('=== ValidateSeed (region-aware seed beatability) ===');
    console.log(`Config dir: ${CONFIG_DIR}`);
    console.log(`Spawn: ${spawnRaw}${spawnRegion === 0 ? ' (WARNING: unresolved to any region!)' : ` -> region ${spawnRegion}`}`);
    console.log(`Entrances table: ${entrancesPresent ? `${entranceEdges.length} edge(s)` : 'ABSENT (vanilla entrances)'}`);
    console.log(`Gated areas table: ${gated.present ? `${gated.areas.length} area(s)` : 'ABSENT (no area gates)'}`);
    console.log(`Skill caps: ${seedConfig.unlocks.present ? 'from ap-unlocks.json' : 'uncapped (vanilla - no ap-unlocks.json)'}`);
    console.log(`Region graph: ${graph.meta.regionCount} regions total, mainland id=${graph.meta.mainlandRegionId}`);
    console.log('');
    console.log(`Reachable regions: ${reachableRegions.size} / ${graph.meta.regionCount}`);
    console.log(`Quests completed: ${completed.size} / ${quests.length} (${qp} QP)`);
    console.log('');

    if (VERBOSE) {
        for (const s of spheres) {
            const bits: string[] = [];
            if (s.questsCompleted.length) bits.push(`quests: ${s.questsCompleted.join(', ')}`);
            if (s.goalsReached.length) bits.push(`GOALS: ${s.goalsReached.join(', ')}`);
            console.log(`Sphere ${s.sphere}: regions=${s.regionsUnlocked}${bits.length ? ' | ' + bits.join(' | ') : ''}`);
        }
        console.log('');
    }

    console.log('Goals:');
    for (const g of goals) {
        const reached = goalSphere.get(g.id);
        if (reached !== undefined) {
            console.log(`  [x] ${g.name} - reached at sphere ${reached}`);
        } else {
            console.log(`  [ ] ${g.name} - BLOCKED`);
            for (const line of diagnoseGoal(g)) {
                console.log(`        - ${line}`);
            }
        }
    }

    function diagnoseGoal(g: Goal): string[] {
        const lines: string[] = [];
        if (g.skills) {
            for (const [stat, level] of Object.entries(g.skills) as [StatName, number][]) {
                if (statCaps[stat] < level) {
                    lines.push(`${stat}: capped at ${statCaps[stat]} by unlocks; needs ${level}`);
                }
            }
        }
        if (g.requiredQp !== undefined && qp < g.requiredQp) {
            lines.push(`QP: has ${qp}; needs ${g.requiredQp}`);
        }
        if (g.quests) {
            for (const id of g.quests) {
                if (!completed.has(id)) {
                    const q = questsById.get(id);
                    lines.push(`quest "${q?.name ?? id}" not completed`);
                }
            }
        }
        const anchors = qr.goals[g.id]?.requiredAnchors ?? [];
        for (const name of anchors) {
            const region = anchorRegions.get(name);
            if (region === undefined || region === 0) {
                lines.push(`region anchor "${name}" never resolved to a walkable region (bad coordinate or unloaded mapsquare)`);
                continue;
            }
            if (!reachableRegions.has(region)) {
                lines.push(`region anchor "${name}" (region ${region}) unreachable: ${explainRegionUnreachable(region)}`);
            }
        }
        if (lines.length === 0) {
            lines.push('no unmet requirement found - likely blocked transitively by an unreached quest; see quest list above');
        }
        return lines;
    }

    function explainRegionUnreachable(regionId: number): string {
        const ctx = buildCtx();
        const viaEdges = entranceEdges.filter(e => e.toRegion === regionId);
        const viaAreas = resolvedAreas.filter(ra => ra.gatedRegionIds.has(regionId));
        const viaAlways = qr.alwaysConnected.filter(ac => anchorRegions.get(ac.from) === regionId || anchorRegions.get(ac.to) === regionId);
        if (viaEdges.length === 0 && viaAreas.length === 0 && viaAlways.length === 0) {
            return 'no known entrance edge, gated-area boundary, or curated alwaysConnected anchor targets this region in the current tables';
        }
        const parts: string[] = [];
        for (const e of viaEdges) {
            const fromOk = reachableRegions.has(e.fromRegion);
            const reqOk = !e.require || requireSatisfied(e.require, ctx);
            parts.push(`trigger ${e.key} (from region ${e.fromRegion}, ${fromOk ? 'reachable' : 'NOT reachable'})${e.require ? ` requires ${describeRequire(e.require)} (${reqOk ? 'satisfied' : 'NOT satisfied'})` : ''}`);
        }
        for (const ra of viaAreas) {
            const outsideOk = [...ra.outsideRegionIds].some(id => reachableRegions.has(id));
            const reqOk = requireSatisfied(ra.area.require, ctx);
            parts.push(`gated area "${ra.area.name}" (outside border ${outsideOk ? 'reachable' : 'NOT reachable'}) requires ${describeRequire(ra.area.require)} (${reqOk ? 'satisfied' : 'NOT satisfied'})`);
        }
        for (const ac of viaAlways) {
            // the OTHER end of this curated free edge - if that end is also unreached, say so and recurse one level for a same-turn hint.
            const otherName = anchorRegions.get(ac.from) === regionId ? ac.to : ac.from;
            const otherRegion = anchorRegions.get(otherName);
            const otherOk = otherRegion !== undefined && otherRegion !== 0 && reachableRegions.has(otherRegion);
            parts.push(`curated anchor edge to/from "${otherName}" (region ${otherRegion ?? '?'}, ${otherOk ? 'reachable' : 'NOT reachable'}) - ${ac.note ?? ''}`.trim());
        }
        return parts.join('; ');
    }

    // ---- lint: every gate's requirement satisfiable against the FINAL state (not a failure). ----
    const finalCtx = buildCtx();
    const lintWarnings: string[] = [];
    for (const e of entranceEdges) {
        if (e.require && !requireSatisfied(e.require, finalCtx)) {
            lintWarnings.push(`entrance gate ${e.key}${e.gateName ? ` (${e.gateName})` : ''}: ${describeRequire(e.require)} never satisfied this seed`);
        }
    }
    for (const ra of resolvedAreas) {
        if (!requireSatisfied(ra.area.require, finalCtx)) {
            lintWarnings.push(`gated area "${ra.area.name}": ${describeRequire(ra.area.require)} never satisfied this seed`);
        } else if (ra.outsideRegionIds.size === 0) {
            lintWarnings.push(`gated area "${ra.area.name}": no adjacent region found in the graph - likely reached via an entrance not modeled here (e.g. a standalone ladder outside the shuffle pool)`);
        } else if (ra.gatedRegionIds.size === 0) {
            lintWarnings.push(`gated area "${ra.area.name}": no interior region distinct from its surroundings - the gate has no effect in this graph (box may be too small/generous)`);
        }
    }
    if (lintWarnings.length > 0) {
        console.log('');
        console.log('Lint warnings (not failures):');
        for (const w of lintWarnings) {
            console.log(`  - ${w}`);
        }
    }

    console.log('');
    console.log(allGoalsReached ? 'RESULT: all goals reachable.' : 'RESULT: BLOCKED - see above.');

    if (JSON_OUT) {
        const out = {
            configDir: CONFIG_DIR,
            spawnRaw,
            spawnRegion,
            reachableRegionCount: reachableRegions.size,
            totalRegionCount: graph.meta.regionCount,
            completedQuests: [...completed],
            totalQp: qp,
            spheres,
            goals: goals.map(g => ({ id: g.id, name: g.name, reachedAtSphere: goalSphere.get(g.id) ?? null, blockers: goalSphere.has(g.id) ? [] : diagnoseGoal(g) })),
            allGoalsReached,
            lintWarnings
        };
        fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
        console.log(`Wrote ${JSON_OUT}`);
    }

    process.exitCode = allGoalsReached ? 0 : 1;
}

main();
