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
import { applyPlacementItem, applyQuestGates, buildLocationCatalog, capsFromCounts, loadPlacements, reachableFromState } from '../sim/PlacementEngine.js';
import { Goal, QuestReq, StatName } from '../sim/types.js';

import { WorldTile, parseRawCoord } from './Coords.js';
import { GatedArea, GatedAreaRequire, RequireContext, describeRequire, loadGatedAreas, requireSatisfied } from './GatedAreas.js';
import { GeneratedIgnores, RequirementGroup, buildRequirementGroups, collectScriptEdges, loadGeneratedQuestRegions, usableWorldEdges } from './GeneratedQuestRegions.js';
import { RegionGraph, loadRegionGraph } from './RegionGraph.js';

// ---- CLI args ----

const argv = process.argv.slice(2);
function argVal(flag: string): string | undefined {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
}
const CONFIG_DIR = argVal('--config-dir') ?? 'data/config';
const JSON_OUT = argVal('--json');
const VERBOSE = argv.includes('--verbose') || argv.includes('-v');
// RandomizeEntrances's reroll loop validates BEFORE placements are (re)generated for
// the new layout - stranded progression against the stale table is expected there and
// must not fail the roll. GenerateSeed's staged validation stays strict (no flag).
const LENIENT_PLACEMENTS = argv.includes('--lenient-placements');
const REGION_GRAPH_PATH = argVal('--region-graph') ?? path.join('tools', 'logic', 'region-graph.json');
const QUEST_REGIONS_PATH = path.join('tools', 'logic', 'data', 'quest-regions.json');
const GENERATED_REGIONS_PATH = path.join('tools', 'logic', 'data', 'quest-regions.generated.json');
const QUESTS_PATH = path.join('tools', 'sim', 'data', 'quests.json');
const GOALS_PATH = path.join('tools', 'sim', 'data', 'goals.json');

// vanilla Lumbridge respawn, matches ApSpawnOverrides.ts's VANILLA_HOME literal exactly.
const VANILLA_SPAWN_RAW = '0_50_50_21_18';

// region graph loading lives in RegionGraph.ts (shared with ExtractQuestRegions.ts).

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
interface OpenAreaBox {
    levels: number[];
    x1: number;
    z1: number;
    x2: number;
    z2: number;
}
interface OpenArea {
    name: string;
    connectTo: string[]; // anchor names
    boxes: OpenAreaBox[];
    note?: string;
}

interface QuestRegionsFile {
    anchors: Record<string, AnchorDef>;
    alwaysConnected: { from: string; to: string; note?: string }[];
    /** Curated traversable areas: every region intersecting the boxes is treated as
     *  mutually connected and connected to the named anchors. For quest gauntlets
     *  whose internal transitions are bespoke handlers (agility obstacles, scripted
     *  gates, dialogue hops) - by construction NEVER in the ladders+stairs shuffle
     *  pool, so their vanilla connectivity is seed-independent; item/level needs are
     *  narrative-only per the sim's documented policy. */
    openAreas?: OpenArea[];
    quests: Record<string, { requiredAnchors: string[]; notes?: string }>;
    goals: Record<string, { requiredAnchors: string[]; notes?: string }>;
    /** Review lever over quest-regions.generated.json - see GeneratedQuestRegions.ts. */
    generated?: GeneratedIgnores;
}

// Regions larger than this are never open-area members: upper levels have
// world-spanning walkable "void/roof" megaregions (e.g. the 1.1M-tile level-3 one)
// that a box overlapping them by a tile would otherwise connect globally. The largest
// legitimate quest area (Kharazi underground) is ~40k tiles.
const OPEN_AREA_MEMBER_TILE_CAP = 100000;

/** Region ids intersecting an open area's boxes. */
function resolveOpenAreaMembers(area: OpenArea, graph: RegionGraph): Set<number> {
    const members = new Set<number>();
    for (const box of area.boxes) {
        for (const level of box.levels) {
            for (let x = box.x1; x <= box.x2; x++) {
                for (let z = box.z1; z <= box.z2; z++) {
                    const id = graph.regionAt(x, z, level);
                    if (id !== 0 && (graph.regionsById.get(id)?.tileCount ?? 0) <= OPEN_AREA_MEMBER_TILE_CAP) {
                        members.add(id);
                    }
                }
            }
        }
    }
    return members;
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

    // Placement-mode extension (docs/placement-mode.md "Simulator & validator"). Absent
    // ap-placements.json = every line touching these stays inert and statCaps/statCapsLower
    // stay EXACTLY the static one-shot computation the pre-placement-mode code always did -
    // the no-placements path is byte-compatible with prior behavior. (placementLocations/
    // recomputeCapsFromPlacements are finished wiring up once `quests` loads below.)
    const placementsFile = loadPlacements(CONFIG_DIR);
    const placementCounts = new Map<string, number>(placementsFile.present && seedConfig.unlocks.present ? seedConfig.unlocks.unlocks : []);
    const placementVisited = new Set<string>();
    const placementFindsLog: { sphere: number; location: string; item: string; display: string }[] = [];

    let statCaps: Record<StatName, number> = allSkillCaps(seedConfig.unlocks) as Record<StatName, number>;
    let statCapsLower = new Map<string, number>(Object.entries(statCaps).map(([k, v]) => [k.toLowerCase(), v]));

    const { edges: entranceEdges, present: entrancesPresent } = loadEntranceEdges(CONFIG_DIR, graph);
    const gated = loadGatedAreas(CONFIG_DIR);
    const resolvedAreas = resolveGatedAreas(gated.areas, graph);

    const qr = loadQuestRegions();
    const anchorRegions = new Map<string, number>();
    for (const [name, def] of Object.entries(qr.anchors)) {
        anchorRegions.set(name, graph.resolveRegion({ level: def.level, x: def.x, z: def.z }));
    }
    const openAreas = (qr.openAreas ?? []).map(area => ({ area, members: resolveOpenAreaMembers(area, graph) }));

    // Extracted quest spatial requirements (quest-regions.generated.json) - every
    // evidence group needs >=1 reachable region before the quest/goal counts as
    // completable, and script-teleport edges join the region fixpoint. Absent file =
    // curated-anchors-only behavior (pre-extractor semantics).
    const generated = loadGeneratedQuestRegions(GENERATED_REGIONS_PATH);
    const generatedGroups = generated ? buildRequirementGroups(generated, qr.generated) : new Map<string, RequirementGroup[]>();
    // quest script edges + quest-agnostic world edges, minus vanilla transitions the
    // seed's overrides replaced (their trigger runs the override, not the case body).
    const overriddenTriggers = new Set(entranceEdges.map(e => e.key.split(':')[0]));
    // Optimistic extracted edges must never bypass the curated area-gate model: any
    // edge INTO a gated area's interior regions is dropped (step 3 of the fixpoint is
    // the sole authority on entering those; leaving them stays fine).
    const gatedInterior = new Set<number>();
    for (const ra of resolvedAreas) {
        for (const id of ra.gatedRegionIds) {
            gatedInterior.add(id);
        }
    }
    const scriptEdges = (generated ? [...collectScriptEdges(generated), ...usableWorldEdges(generated, overriddenTriggers)] : []).filter(se => !gatedInterior.has(se.toRegion));

    function unsatisfiedGroups(id: string, reachable: Set<number>): RequirementGroup[] {
        const groups = generatedGroups.get(id);
        if (!groups) {
            return [];
        }
        return groups.filter(g => !g.regions.some(r => reachable.has(r)));
    }

    const rawQuests: QuestReq[] = JSON.parse(fs.readFileSync(QUESTS_PATH, 'utf8')).quests;
    // Family D: the active seed's questGates lock those quests behind `quest_<id>`
    // placement items (tracked in placementCounts like every other unlock key).
    const quests: QuestReq[] = placementsFile.present ? applyQuestGates(rawQuests, placementsFile.questGates) : rawQuests;
    const goals: Goal[] = JSON.parse(fs.readFileSync(GOALS_PATH, 'utf8')).goals;
    const questsById = new Map(quests.map(q => [q.id, q]));

    const placementLocations = placementsFile.present ? buildLocationCatalog(quests) : [];
    function recomputeCapsFromPlacements(): void {
        statCaps = capsFromCounts(placementCounts);
        statCapsLower = new Map(Object.entries(statCaps).map(([k, v]) => [k.toLowerCase(), v]));
    }
    if (placementsFile.present) {
        recomputeCapsFromPlacements(); // caps start from ap-unlocks.json's placement-mode starting state (usually all-zero -> 20 floor), not "uncapped".
    }

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
                regionsSatisfied(qr.goals[g.id]?.requiredAnchors, anchorRegions, reachableRegions) &&
                // generated entries can match goal ids too (the barcrawl folder is a
                // goal, not a sim quest - its extracted bars gate the goal directly).
                unsatisfiedGroups(g.id, reachableRegions).length === 0
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

        // 2b. script-teleport edges from the extracted draft (quest p_teleports -
        // fisher realm, Crandor, instances). Ungated/optimistic, see
        // GeneratedQuestRegions.ts's collectScriptEdges for the judgment call.
        for (const se of scriptEdges) {
            if (reachableRegions.has(se.toRegion) || !se.fromRegions.some(r => reachableRegions.has(r))) {
                continue;
            }
            reachableRegions.add(se.toRegion);
            changed = true;
        }

        // 2c. curated open areas: reachable via a connectTo anchor or any member.
        for (const { area, members } of openAreas) {
            const anchorIn = area.connectTo.some(name => {
                const r = anchorRegions.get(name);
                return r !== undefined && r !== 0 && reachableRegions.has(r);
            });
            if (!anchorIn && ![...members].some(id => reachableRegions.has(id))) {
                continue;
            }
            for (const id of members) {
                if (!reachableRegions.has(id)) {
                    reachableRegions.add(id);
                    changed = true;
                }
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
                (q.gateKey === undefined || (placementCounts.get(q.gateKey) ?? 0) >= 1) &&
                regionsSatisfied(qr.quests[q.id]?.requiredAnchors, anchorRegions, reachableRegions) &&
                unsatisfiedGroups(q.id, reachableRegions).length === 0
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

        // 5. placement-mode check locations (docs/placement-mode.md "Simulator &
        // validator"): any check reachable under the CURRENT completed/qp/statCaps that
        // holds a real (non-filler) item grants it immediately, which can grow statCaps
        // for the NEXT pass - this is the "sphere loop = compute reachable checks -> collect
        // their items -> recompute" the design brief asks for. Region/gate logic (steps
        // 1-3) stays exactly as-is; placement locations are travel-agnostic here (same
        // simplification tools/sim/Engine.ts documents), so this only ever adds reachable
        // checks, never removes region-gated ones.
        if (placementsFile.present) {
            const reachableChecks = reachableFromState(placementLocations, quests, completed, qp, statCaps);
            let grew = false;
            for (const locId of reachableChecks) {
                if (placementVisited.has(locId)) {
                    continue;
                }
                placementVisited.add(locId);
                changed = true;
                const rec = placementsFile.placements.get(locId);
                if (rec && rec.item !== 'filler') {
                    applyPlacementItem(rec, placementCounts);
                    grew = true;
                    placementFindsLog.push({ sphere: sphere + 1, location: locId, item: rec.item, display: rec.display });
                }
            }
            if (grew) {
                recomputeCapsFromPlacements();
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

    // Placement-mode strictness: every non-filler (progression) placement must have
    // been collected by the fixpoint. A region-stranded check holding a progression
    // item is a broken seed even when the goals happen to be reachable without it -
    // this is exactly the failure class the extracted quest regions exist to catch.
    const strandedProgression: { location: string; display: string }[] = [];
    if (placementsFile.present) {
        for (const [locId, rec] of placementsFile.placements) {
            if (rec.item !== 'filler' && !placementVisited.has(locId)) {
                strandedProgression.push({ location: locId, display: rec.display ?? rec.item });
            }
        }
    }

    // ---- reporting ----

    console.log('=== ValidateSeed (region-aware seed beatability) ===');
    console.log(`Config dir: ${CONFIG_DIR}`);
    console.log(`Spawn: ${spawnRaw}${spawnRegion === 0 ? ' (WARNING: unresolved to any region!)' : ` -> region ${spawnRegion}`}`);
    console.log(`Entrances table: ${entrancesPresent ? `${entranceEdges.length} edge(s)` : 'ABSENT (vanilla entrances)'}`);
    console.log(`Gated areas table: ${gated.present ? `${gated.areas.length} area(s)` : 'ABSENT (no area gates)'}`);
    console.log(`Skill caps: ${placementsFile.present ? `from ap-placements.json (growing - ${placementFindsLog.length} progression item(s) collected this run)` : seedConfig.unlocks.present ? 'from ap-unlocks.json' : 'uncapped (vanilla - no ap-unlocks.json)'}`);
    console.log(`Placements table: ${placementsFile.present ? `${placementsFile.placements.size} location(s), pool ${placementsFile.pool}` : 'ABSENT (vanilla check rewards, no unlock gating from checks)'}`);
    console.log(`Region graph: ${graph.meta.regionCount} regions total, mainland id=${graph.meta.mainlandRegionId}`);
    const groupCount = [...generatedGroups.values()].reduce((a, g) => a + g.length, 0);
    console.log(`Extracted quest regions: ${generated ? `${generatedGroups.size} quest(s), ${groupCount} requirement group(s), ${scriptEdges.length} script edge(s)` : 'ABSENT (curated anchors only)'}`);
    console.log('');
    console.log(`Reachable regions: ${reachableRegions.size} / ${graph.meta.regionCount}`);
    console.log(`Quests completed: ${completed.size} / ${quests.length} (${qp} QP)`);
    const blockedQuests = quests.filter(q => !completed.has(q.id));
    if (blockedQuests.length > 0) {
        console.log('');
        console.log('Blocked quests:');
        for (const q of blockedQuests) {
            const reasons: string[] = [];
            if (!skillsSatisfied(q.skills, statCaps)) {
                reasons.push('skill caps');
            }
            if (qp < (q.requiredQp ?? 0)) {
                reasons.push(`QP ${qp}/${q.requiredQp}`);
            }
            if (!questsChainSatisfied(q.quests, q.questsAny, completed)) {
                reasons.push('prerequisite quest(s)');
            }
            if (q.gateKey !== undefined && (placementCounts.get(q.gateKey) ?? 0) < 1) {
                reasons.push(`quest-gate item ${q.gateKey} never collected`);
            }
            if (!regionsSatisfied(qr.quests[q.id]?.requiredAnchors, anchorRegions, reachableRegions)) {
                reasons.push('curated region anchor(s) unreachable');
            }
            const unsat = unsatisfiedGroups(q.id, reachableRegions);
            console.log(`  ${q.id}: ${reasons.length ? reasons.join(', ') : ''}${unsat.length ? `${reasons.length ? ', ' : ''}${unsat.length} extracted region group(s) unreachable` : ''}`);
            for (const g of unsat.slice(0, VERBOSE ? unsat.length : 4)) {
                console.log(`      - ${g.label} [${g.key}] region(s) ${g.regions.slice(0, 4).join(',')} @ ${g.tiles[0].raw} (${g.provenance[0]})`);
            }
            if (!VERBOSE && unsat.length > 4) {
                console.log(`      ... ${unsat.length - 4} more (use --verbose)`);
            }
        }
    }
    if (strandedProgression.length > 0) {
        console.log('');
        console.log(`Stranded progression item(s) - placement location never reachable (${strandedProgression.length}):`);
        for (const s of strandedProgression) {
            console.log(`  ${s.location} -> ${s.display}`);
        }
    }
    console.log('');

    if (VERBOSE) {
        for (const s of spheres) {
            const bits: string[] = [];
            if (s.questsCompleted.length) bits.push(`quests: ${s.questsCompleted.join(', ')}`);
            if (s.goalsReached.length) bits.push(`GOALS: ${s.goalsReached.join(', ')}`);
            console.log(`Sphere ${s.sphere}: regions=${s.regionsUnlocked}${bits.length ? ' | ' + bits.join(' | ') : ''}`);
            if (placementsFile.present) {
                for (const find of placementFindsLog.filter(f => f.sphere === s.sphere)) {
                    console.log(`    found: ${find.location} -> ${find.display}`);
                }
            }
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
        for (const grp of unsatisfiedGroups(g.id, reachableRegions).slice(0, 6)) {
            lines.push(`extracted requirement "${grp.label}" [${grp.key}] unreachable (region(s) ${grp.regions.slice(0, 4).join(',')} @ ${grp.tiles[0].raw}, ${grp.provenance[0]})`);
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

    const seedOk = allGoalsReached && (LENIENT_PLACEMENTS || strandedProgression.length === 0);
    console.log('');
    console.log(seedOk ? 'RESULT: all goals reachable, all progression collectable.' : `RESULT: BLOCKED - ${allGoalsReached ? '' : 'goal(s) unreachable'}${!allGoalsReached && strandedProgression.length > 0 ? ' + ' : ''}${strandedProgression.length > 0 ? `${strandedProgression.length} stranded progression item(s)` : ''} - see above.`);

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
            strandedProgression,
            blockedQuests: blockedQuests.map(q => ({
                id: q.id,
                unsatisfiedGroups: unsatisfiedGroups(q.id, reachableRegions).map(g => ({ key: g.key, label: g.label, regions: g.regions, tiles: g.tiles.map(t => t.raw), provenance: g.provenance }))
            })),
            lintWarnings,
            placements: placementsFile.present ? { pool: placementsFile.pool, locationCount: placementsFile.placements.size, finds: placementFindsLog } : null
        };
        fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
        console.log(`Wrote ${JSON_OUT}`);
    }

    process.exitCode = seedOk ? 0 : 1;
}

main();
