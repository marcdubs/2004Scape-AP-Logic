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
import { applyPlacementItem, applyQuestGates, buildLocationCatalog, capsFromCounts, loadApOptions, loadPlacements, reachableFromState } from '../sim/PlacementEngine.js';
import { Goal, QuestReq, StatName } from '../sim/types.js';

import { WorldTile, parseRawCoord } from './Coords.js';
import { GatedAreaRequire, RequireContext, describeRequire, loadGatedAreas, requireSatisfied } from './GatedAreas.js';
import { addRegionSources, applySwaps, computeObtainable, itemAvailable, loadItemSources, loadNpcSpawns, loadQuestItems, stampQuestGates } from './ItemGraph.js';
import { RequirementGroup, buildRequirementGroups, collectScriptEdges, loadGeneratedQuestRegions, usableWorldEdges } from './GeneratedQuestRegions.js';
import {
    VANILLA_SPAWN_RAW,
    collectRequiredVarps,
    gatedRegionRequires,
    loadQuestRegions,
    questsChainSatisfied,
    resolveAnchors,
    resolveGatedAreas,
    resolveOpenAreaMembers,
    resolveVarp,
    skillsSatisfied
} from './LogicModel.js';
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
// Fail unless EVERY quest completes, not just the goals - RandomizeEntrances's
// phase-1 reroll criterion ("prefer entrance tables that strand nothing"). Meant for
// a placements-free config dir: with placements present, family-D gate items can
// legitimately arrive late/stranded and would fail this for non-spatial reasons.
const STRICT_QUESTS = argv.includes('--strict-quests');
const REGION_GRAPH_PATH = argVal('--region-graph') ?? path.join('tools', 'logic', 'region-graph.json');
const QUEST_REGIONS_PATH = path.join('tools', 'logic', 'data', 'quest-regions.json');
const GENERATED_REGIONS_PATH = path.join('tools', 'logic', 'data', 'quest-regions.generated.json');
const QUESTS_PATH = path.join('tools', 'sim', 'data', 'quests.json');
const GOALS_PATH = path.join('tools', 'sim', 'data', 'goals.json');

// region graph loading lives in RegionGraph.ts (shared with ExtractQuestRegions.ts); the
// region/varp model this tool shares with the apworld exporter lives in LogicModel.ts.

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

// gated-area resolution, open-area membership, the curated quest-regions.json shape and
// the quest-doability varp model all live in LogicModel.ts now (shared with
// tools/ap/ExportLogicBundle.ts so the apworld reasons over the same objects).

// Loads the gathersanity/processsanity swap tables (ap-gather.json / ap-process.json,
// obj-id -> obj-id) and translates them to a name -> name product swap via obj.pack, so
// the item-source graph can be re-keyed to the shuffled world. Absent files (gathersanity
// off) => null => vanilla graph.
function loadGatherProcessSwaps(configDir: string): Map<string, string> | null {
    const objPack = path.resolve(process.cwd(), '../content/pack/obj.pack');
    if (!fs.existsSync(objPack)) {
        return null;
    }
    const idToName = new Map<number, string>();
    for (const line of fs.readFileSync(objPack, 'utf8').split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq !== -1) {
            idToName.set(parseInt(line.slice(0, eq), 10), line.slice(eq + 1).trim());
        }
    }
    const swap = new Map<string, string>();
    for (const fname of ['ap-gather.json', 'ap-process.json']) {
        const file = path.join(configDir, fname);
        if (!fs.existsSync(file)) {
            continue;
        }
        const map = (JSON.parse(fs.readFileSync(file, 'utf8')) as { map?: Record<string, number> }).map ?? {};
        for (const [fromId, toId] of Object.entries(map)) {
            const from = idToName.get(parseInt(fromId, 10));
            const to = idToName.get(toId);
            if (from && to) {
                swap.set(from, to);
            }
        }
    }
    return swap.size > 0 ? swap : null;
}

// loads tools/logic/data/<fname> as item -> [provider npc debugnames] (shop owners for
// buy-sources.json, monsters for drop-sources.json). Absent => empty.
function loadItemProviders(fname: string): Map<string, string[]> {
    const file = path.join('tools', 'logic', 'data', fname);
    const map = new Map<string, string[]>();
    if (!fs.existsSync(file)) {
        return map;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [item, npcs] of Object.entries(raw)) {
        if (!item.startsWith('_') && Array.isArray(npcs)) {
            map.set(item, npcs.map(String));
        }
    }
    return map;
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

    // Item-acquisition graph (problems.txt #16): item -> how it's gathered/processed, so a
    // quest that needs a gathered/processed item gates on the required skill instead of the
    // sim assuming every item is free. Static game data (tools/logic/data/), absent =>
    // empty => every item assumed obtainable (exact prior behaviour). itemSources applies
    // any gathersanity/processsanity swap so obtainability reflects the shuffled world.
    const itemSources = applySwaps(stampQuestGates(loadItemSources()), loadGatherProcessSwaps(CONFIG_DIR));
    // add the BUY (shop-owner region) and DROP (monster region) sources - the four-source
    // OR model. item->provider-npc data is static (tools/logic/data/), resolved to a region
    // via the npc spawn map + region graph. Absent files => gather/process only.
    {
        const npcSpawns = loadNpcSpawns();
        const resolveNpcRegion = (coord: string): number => {
            const [level, mapX, mapZ, localX, localZ] = coord.split('_').map(Number);
            return graph.resolveRegion({ level, x: mapX * 64 + localX, z: mapZ * 64 + localZ });
        };
        addRegionSources(itemSources, loadItemProviders('shop-sources.json'), npcSpawns, resolveNpcRegion, 'buy');
        addRegionSources(itemSources, loadItemProviders('drop-sources.json'), npcSpawns, resolveNpcRegion, 'drop');
    }
    const questItems = loadQuestItems();
    let obtainable = new Set<string>(); // recomputed each sphere from current statCaps
    // only GATHER/PROCESS-sourced quest needs are gated (buy/drop/given/quest items are
    // assumed available - we never invent a gate we can't prove). itemAvailable's
    // "unmodelled => true" rule is the second guard.
    const questItemsSatisfied = (id: string): boolean =>
        (questItems.get(id) ?? [])
            .filter(n => (n.obtained === 'gather' || n.obtained === 'process'))
            .every(n => itemAvailable(n.item, itemSources, obtainable));

    const qr = loadQuestRegions(QUEST_REGIONS_PATH);
    const anchorRegions = resolveAnchors(qr, graph);
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
    // Extracted edges into a gated area's interior must not BYPASS the gate - but they
    // must not be DROPPED either (dropping them severs a room's own internal connectivity,
    // e.g. the stair from the Black Arm hideout up to its weapon cupboard, which strands
    // multi-floor quest interiors under the expanded gated-area set - see GitHub #16).
    // Instead we ATTACH the area's requirement to the edge: the internal stair works once
    // the gate is met, so the whole room (all floors) reconnects, and the gate is still
    // enforced. region id -> its gated area's require.
    const gatedRegionRequire = gatedRegionRequires(resolvedAreas);
    const scriptEdges: { fromRegions: number[]; toRegion: number; require?: GatedAreaRequire }[] =
        (generated ? [...collectScriptEdges(generated), ...usableWorldEdges(generated, overriddenTriggers)] : [])
            .map(se => gatedRegionRequire.has(se.toRegion) ? { ...se, require: gatedRegionRequire.get(se.toRegion) } : se);

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

    const placementLocations = placementsFile.present ? buildLocationCatalog(quests, loadApOptions(CONFIG_DIR)) : [];
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
        // Item obtainability now MODELLED (problems.txt #16): an item is available iff it's
        // not a gathered/processed item (assumed obtainable - shop/drop/given/misc) OR its
        // gather/process chain is reachable under the current skill caps. `obtainable` is
        // the current-sphere fixpoint. Absent item-sources.json => every item unmodelled =>
        // always true (exact prior narrative-only behaviour).
        return { has: (item: string) => itemAvailable(item, itemSources, obtainable) };
    }

    // every varp any gated-area OR entrance-edge require references - resolved fresh each
    // sphere from the current quest/qp/skill state. Data-driven so new gates in the config
    // need no code change here (only VARP_TO_QUEST needs the varp->quest line if it's new).
    const neededVarps = collectRequiredVarps([
        ...resolvedAreas.map(ra => ra.area.require),
        ...entranceEdges.flatMap(e => (e.require ? [e.require] : []))
    ]);

    function buildCtx(): RequireContext {
        return {
            varps: new Map(
                [...neededVarps]
                    .map(name => [name, resolveVarp(name, qp, completed, statCaps, statCapsLower, questsById)] as const)
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
        // recompute item obtainability from the current (growing) skill caps AND reachable
        // regions before this sphere's gates/quests consult it (buy/drop sources gate on
        // region reachability, so obtainability grows as the map opens up).
        obtainable = computeObtainable(itemSources, statCaps, reachableRegions, completed);
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
            if (se.require && !requireSatisfied(se.require, ctx)) {
                continue; // edge enters a gated interior - gate must be met (matches the runtime bounce)
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
                questItemsSatisfied(q.id) &&
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

    const seedOk = allGoalsReached && (LENIENT_PLACEMENTS || strandedProgression.length === 0) && (!STRICT_QUESTS || blockedQuests.length === 0);
    const failReasons: string[] = [];
    if (!allGoalsReached) {
        failReasons.push('goal(s) unreachable');
    }
    if (!LENIENT_PLACEMENTS && strandedProgression.length > 0) {
        failReasons.push(`${strandedProgression.length} stranded progression item(s)`);
    }
    if (STRICT_QUESTS && blockedQuests.length > 0) {
        failReasons.push(`${blockedQuests.length} quest(s) blocked (--strict-quests)`);
    }
    console.log('');
    console.log(seedOk ? 'RESULT: all goals reachable, all progression collectable.' : `RESULT: BLOCKED - ${failReasons.join(' + ')} - see above.`);

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
