// Exports the LOGIC BUNDLE: everything the Archipelago apworld needs to reason about
// seed beatability the way tools/logic/ValidateSeed.ts does (GitHub #3).
//
//   data/config/ap-logic-bundle.json
//
// ExportApWorldData.ts already hands the apworld the *catalog* (locations, items, ids).
// This tool hands it the *logic*: the region graph collapsed to the region ids that
// actually carry meaning, the entrance pool, the gated-area requirements resolved
// against the graph, the curated + extracted quest spatial requirements, the
// four-source item-obtainability graph, and the quest-doability varp model.
//
// The bundle is region-id based and seed-INDEPENDENT: it is the shape of the world, not
// one shuffle of it. A seed is then just an assignment of entrance-pool sides to
// arrivals - which the local randomizer produces by generate-and-test (RandomizeEntrances
// + ValidateSeed reroll) and the apworld produces construct-valid. Both read this file.
//
// Everything region-shaped comes from tools/logic/LogicModel.ts, the SAME module
// ValidateSeed imports, so the exported model and the local oracle's beliefs cannot
// drift apart by construction.
//
// Run from Server/engine:
//   npx tsx tools/ap/ExportLogicBundle.ts [--config-dir data/config]
//                                         [--out data/config/ap-logic-bundle.json]
//                                         [--copy <path>]
//
// Prerequisites: tools/logic/region-graph.json (BuildRegionGraph.ts) and an entrance
// pool dump (tools/map/RandomizeEntrances.ts --export-pool); the tool creates the pool
// itself if it is missing.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CAPPABLE_SKILLS, QUEST_GATE_IDS, questGateKey } from '../sim/PlacementEngine.js';
import { Goal, QuestReq } from '../sim/types.js';

import { parseRawCoord } from '../logic/Coords.js';
import { GatedAreaRequire, loadGatedAreas } from '../logic/GatedAreas.js';
import { RequirementGroup, buildRequirementGroups, collectScriptEdges, loadGeneratedQuestRegions } from '../logic/GeneratedQuestRegions.js';
import { addRegionSources, ItemSource, loadItemSources, loadNpcSpawns, loadQuestItems } from '../logic/ItemGraph.js';
import {
    COMPLETION_ONLY,
    GATE_VARP_ALL,
    SPLIT_VARPS,
    STAT_VARPS,
    VANILLA_SPAWN_RAW,
    VARP_TO_QUEST,
    loadQuestRegions,
    resolveAnchors,
    resolveGatedAreas,
    resolveOpenAreaMembers
} from '../logic/LogicModel.js';
import { RegionGraph, loadRegionGraph } from '../logic/RegionGraph.js';

// ---- CLI ----

const argv = process.argv.slice(2);
function argVal(flag: string, fallback: string): string {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : (argv[i + 1] ?? fallback);
}
const CONFIG_DIR = argVal('--config-dir', 'data/config');
const OUT_PATH = argVal('--out', path.join('data', 'config', 'ap-logic-bundle.json'));
const COPY_PATH = argv.includes('--copy') ? argVal('--copy', '') : '';
const REGION_GRAPH_PATH = argVal('--region-graph', path.join('tools', 'logic', 'region-graph.json'));
const POOL_PATH = argVal('--entrance-pool', path.join('data', 'config', 'ap-entrance-pool.json'));
const GATHER_POOL_PATH = argVal('--gather-pool', path.join('data', 'config', 'ap-gather-pool.json'));
const PROCESS_POOL_PATH = argVal('--process-pool', path.join('data', 'config', 'ap-process-pool.json'));
const SHOP_POOL_PATH = argVal('--shop-pool', path.join('data', 'config', 'ap-shop-pool.json'));
const SPAWN_POOL_PATH = argVal('--spawn-pool', path.join('data', 'config', 'ap-spawn-pool.json'));
const DROP_POOL_PATH = argVal('--drop-pool', path.join('data', 'config', 'ap-drop-pool.json'));
const QUEST_REGIONS_PATH = path.join('tools', 'logic', 'data', 'quest-regions.json');
const GENERATED_REGIONS_PATH = path.join('tools', 'logic', 'data', 'quest-regions.generated.json');
const QUESTS_PATH = path.join('tools', 'sim', 'data', 'quests.json');
const GOALS_PATH = path.join('tools', 'sim', 'data', 'goals.json');

// ---- entrance pool (tools/map/RandomizeEntrances.ts --export-pool) ----

interface PoolSide {
    trigger: string;
    op: number;
    arrival: string;
    description: string | null;
}
interface PoolFile {
    gates: { pool: string; scanned: boolean; a: PoolSide; b: PoolSide }[];
    oneWays: PoolSide[];
    requires: Record<string, { require: GatedAreaRequire; name: string }>;
}

/** Reads a `--export-pool` dump, generating it from its tool if it isn't there yet. */
function loadPool<T>(file: string, tool: string): T {
    if (!fs.existsSync(file)) {
        console.log(`pool missing - generating ${file}`);
        execFileSync('npx', ['tsx', tool, '--export-pool', file], { stdio: 'inherit' });
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function loadEntrancePool(): PoolFile {
    return loadPool<PoolFile>(POOL_PATH, path.join('tools', 'map', 'RandomizeEntrances.ts'));
}

// ---- the other randomizers' pools (GitHub #3) ----
//
// Every one of these is a deterministic shuffle over an ordered candidate list, so
// exporting the LIST is enough for the apworld to replay the exact same table with the
// same seed - which is what lets AP reason about item obtainability (gather/process
// re-key which action yields what; shopsanity moves where an item can be bought) and
// about where the player starts (spawn) while its fill is still running.

interface SkillProductPool {
    skills: string[];
    products: { item: string; skill: string; objId: number }[];
    hardExcluded: Record<string, string>;
    questCritical: string[];
}
interface ShopPool {
    eligible: { npc: string; shop: string }[];
    excluded: { npc: string; shop: string }[];
    hardcodedShopIds: string[];
}
interface SpawnPool {
    vanilla: string;
    city: { coord: string; label: string }[];
    chunk: { coord: string; label: string }[];
}
interface DropPool {
    slots: { npc: string; item: string; bucket: string }[];
    questCritical: string[];
    stackable: string[];
    tiered: { buckets: { name: string; universe: string[]; slots: number[] }[] };
    chaos: { universe: string[]; slots: number[] };
    mimic: {
        units: { index: number; key: string; name: string; handlers: string[]; items: string[] }[];
        slots: { index: number; handler: string; unitIndex: number; unitKey: string }[];
        pinned: { handler: string; unitIndex: number; reason: string }[];
    };
    deathDrops: { npc: string; item: string }[];
}

// ---- item providers (same reading ValidateSeed does) ----

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

function buildItemSources(graph: RegionGraph): Map<string, ItemSource[]> {
    // vanilla graph: gathersanity/processsanity swaps are per-seed and are applied by
    // whichever consumer holds the swap table (the apworld re-keys the graph itself once
    // it has rolled its gather/process tables). Exporting vanilla keeps the bundle
    // seed-independent - see the file header.
    const sources = loadItemSources();
    const npcSpawns = loadNpcSpawns();
    const resolveNpcRegion = (coord: string): number => {
        const [level, mapX, mapZ, localX, localZ] = coord.split('_').map(Number);
        return graph.resolveRegion({ level, x: mapX * 64 + localX, z: mapZ * 64 + localZ });
    };
    addRegionSources(sources, loadItemProviders('shop-sources.json'), npcSpawns, resolveNpcRegion, 'buy');
    addRegionSources(sources, loadItemProviders('drop-sources.json'), npcSpawns, resolveNpcRegion, 'drop');
    return sources;
}

// ---- main ----

function main(): void {
    const graph = loadRegionGraph(REGION_GRAPH_PATH);
    const qr = loadQuestRegions(QUEST_REGIONS_PATH);
    const anchorRegions = resolveAnchors(qr, graph);
    const quests: QuestReq[] = JSON.parse(fs.readFileSync(QUESTS_PATH, 'utf8')).quests;
    const goals: Goal[] = JSON.parse(fs.readFileSync(GOALS_PATH, 'utf8')).goals;

    // --- gated areas, resolved to interior/outside region ids ---
    const gated = loadGatedAreas(CONFIG_DIR);
    const resolvedAreas = resolveGatedAreas(gated.areas, graph);
    const gatedAreas = resolvedAreas.map(ra => ({
        name: ra.area.name,
        require: ra.area.require,
        gated: [...ra.gatedRegionIds].sort((a, b) => a - b),
        outside: [...ra.outsideRegionIds].sort((a, b) => a - b)
    }));

    // --- curated connectivity ---
    const alwaysConnected: { from: number; to: number; note?: string }[] = [];
    for (const ac of qr.alwaysConnected) {
        const from = anchorRegions.get(ac.from);
        const to = anchorRegions.get(ac.to);
        if (from !== undefined && to !== undefined && from !== 0 && to !== 0) {
            alwaysConnected.push({ from, to, note: ac.note });
        }
    }
    const openAreas = (qr.openAreas ?? []).map(area => ({
        name: area.name,
        connectTo: area.connectTo.map(name => anchorRegions.get(name) ?? 0).filter(r => r !== 0),
        members: [...resolveOpenAreaMembers(area, graph)].sort((a, b) => a - b)
    }));

    // --- extracted spatial requirements + edges ---
    const generated = loadGeneratedQuestRegions(GENERATED_REGIONS_PATH);
    const groups: Map<string, RequirementGroup[]> = generated ? buildRequirementGroups(generated, qr.generated) : new Map();
    const requirementGroups: Record<string, { key: string; label: string; regions: number[] }[]> = {};
    for (const [id, list] of groups) {
        if (list.length > 0) {
            requirementGroups[id] = list.map(g => ({ key: g.key, label: g.label, regions: g.regions }));
        }
    }
    // quest script-teleport edges are seed-independent; world edges carry their trigger
    // coords so the consumer can drop the ones a seed's overrides replace (exactly what
    // GeneratedQuestRegions.usableWorldEdges does for ValidateSeed).
    const questScriptEdges = generated
        ? collectScriptEdges(generated).map(e => ({ from: e.fromRegions, to: e.toRegion }))
        : [];
    const worldEdges = (generated?.worldEdges ?? [])
        .filter(e => e.dest.region !== 0 && e.from.some(t => t.region !== 0))
        .map(e => ({
            from: e.from.filter(t => t.region !== 0).map(t => ({ raw: t.raw, region: t.region })),
            to: e.dest.region,
            viaCase: e.viaCase
        }));

    // --- entrance pool, resolved to regions ---
    const pool = loadEntrancePool();
    const resolveRaw = (raw: string): number => {
        try {
            return graph.resolveRegion(parseRawCoord(raw));
        } catch {
            return 0;
        }
    };
    const side = (s: PoolSide) => ({
        trigger: s.trigger,
        op: s.op,
        arrival: s.arrival,
        triggerRegion: resolveRaw(s.trigger),
        arrivalRegion: resolveRaw(s.arrival),
        description: s.description ?? undefined
    });
    const entrancePool = {
        gates: pool.gates.map(g => ({ pool: g.pool, a: side(g.a), b: side(g.b) })),
        oneWays: pool.oneWays.map(side),
        requires: pool.requires
    };

    // --- item graph ---
    const itemSources: Record<string, ItemSource[]> = {};
    for (const [item, srcs] of buildItemSources(graph)) {
        itemSources[item] = srcs;
    }
    const questItems: Record<string, { item: string; obtained: string }[]> = {};
    for (const [quest, needs] of loadQuestItems()) {
        // only gather/process needs are ever gated (ValidateSeed's questItemsSatisfied) -
        // exporting just those keeps the bundle honest about what it actually checks.
        const gatedNeeds = needs.filter(n => n.obtained === 'gather' || n.obtained === 'process');
        if (gatedNeeds.length > 0) {
            questItems[quest] = gatedNeeds.map(n => ({ item: n.item, obtained: n.obtained }));
        }
    }

    const spawnRegion = graph.resolveRegion(parseRawCoord(VANILLA_SPAWN_RAW));

    // --- the remaining randomizers, as replayable pools (GitHub #3) ---
    const gatherPool = loadPool<SkillProductPool>(GATHER_POOL_PATH, path.join('tools', 'gather', 'RandomizeGathering.ts'));
    const processPool = loadPool<SkillProductPool>(PROCESS_POOL_PATH, path.join('tools', 'process', 'RandomizeProcessing.ts'));
    const shopPool = loadPool<ShopPool>(SHOP_POOL_PATH, path.join('tools', 'npc', 'RandomizeShops.ts'));
    const spawnPoolRaw = loadPool<SpawnPool>(SPAWN_POOL_PATH, path.join('tools', 'spawn', 'RandomizeSpawn.ts'));
    const dropPool = loadPool<DropPool>(DROP_POOL_PATH, path.join('tools', 'drops', 'RandomizeDrops.ts'));

    const withRegion = (entries: { coord: string; label: string }[]) =>
        entries.map(e => ({ ...e, region: resolveRaw(e.coord) }));
    const spawnPool = {
        vanilla: { coord: spawnPoolRaw.vanilla, label: 'Lumbridge (vanilla)', region: resolveRaw(spawnPoolRaw.vanilla) },
        city: withRegion(spawnPoolRaw.city),
        chunk: withRegion(spawnPoolRaw.chunk)
    };

    // Shopsanity relocation inputs. `itemSources` above keeps its VANILLA resolved buy
    // regions (that is what ValidateSeed sees, so parity is by construction); these three
    // tables let a consumer that rolled a shop shuffle re-point them: item -> its vanilla
    // owner npcs -> those npcs' shops -> whoever owns those shops now -> their regions.
    // Under identity ownership it reproduces the vanilla regions exactly.
    const shopOfNpc: Record<string, string> = {};
    for (const bundle of [...shopPool.eligible, ...shopPool.excluded]) {
        shopOfNpc[bundle.npc] = bundle.shop;
    }
    const buyOwners: Record<string, string[]> = {};
    for (const [item, npcs] of loadItemProviders('shop-sources.json')) {
        buyOwners[item] = npcs;
    }
    const npcSpawns = loadNpcSpawns();
    const npcRegion = (npc: string): number => {
        const coord = npcSpawns.get(npc);
        if (!coord) {
            return 0;
        }
        const [level, mapX, mapZ, localX, localZ] = coord.split('_').map(Number);
        return graph.resolveRegion({ level, x: mapX * 64 + localX, z: mapZ * 64 + localZ });
    };
    const regionsFor = (npcs: Iterable<string>): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const npc of npcs) {
            const region = npcRegion(npc);
            if (region !== 0) {
                out[npc] = region;
            }
        }
        return out;
    };
    // every npc either owning a shop bundle OR named as an item's vanilla seller - the
    // relocation walks both directions, and a missing region silently drops a source.
    const npcRegions = regionsFor(new Set([...Object.keys(shopOfNpc), ...Object.values(buyOwners).flat()]));

    // Drop relocation inputs, same shape of contract as shops: the vanilla `via: drop`
    // regions stay in `itemSources` (parity with ValidateSeed), and these tables let a
    // consumer that rolled a drop shuffle recompute them. `dropOwners` is what
    // drop-sources.json says today, so the consumer can tell which of an item's vanilla
    // drop regions the slot corpus explains (and may move) from the ones it doesn't
    // (death_drop params, bespoke handlers - those stay put).
    const dropOwners: Record<string, string[]> = {};
    for (const [item, npcs] of loadItemProviders('drop-sources.json')) {
        dropOwners[item] = npcs;
    }
    const dropNpcRegions = regionsFor(new Set([
        ...Object.values(dropOwners).flat(),
        ...dropPool.slots.map(s => s.npc),
        ...dropPool.mimic.units.flatMap(u => u.handlers),
        ...dropPool.mimic.slots.map(s => s.handler),
        ...dropPool.deathDrops.map(s => s.npc)
    ]));

    const randomizerPools = {
        gather: gatherPool,
        process: processPool,
        shops: { ...shopPool, shopOfNpc, buyOwners, npcRegions },
        spawn: spawnPool,
        drops: { ...dropPool, dropOwners, npcRegions: dropNpcRegions }
    };

    const bundle = {
        _generated: `tools/ap/ExportLogicBundle.ts (${new Date().toISOString().slice(0, 10)}) - the logic half of the apworld contract; regenerate after any region-graph / gated-area / quest-region change`,
        game: '2004Scape',
        meta: {
            mainlandRegionId: graph.meta.mainlandRegionId,
            regionCount: graph.meta.regionCount,
            vanillaSpawnRaw: VANILLA_SPAWN_RAW,
            vanillaSpawnRegion: spawnRegion,
            capsFormula: { base: 20, perCount: 10, max: 99 },
            cappableSkills: CAPPABLE_SKILLS,
            questGateIds: QUEST_GATE_IDS,
            questGateKeyPrefix: questGateKey('')
        },
        varpModel: {
            gateVarpAll: GATE_VARP_ALL,
            varpToQuest: VARP_TO_QUEST,
            splitVarps: SPLIT_VARPS,
            completionOnly: COMPLETION_ONLY,
            statVarps: STAT_VARPS
        },
        anchors: Object.fromEntries(anchorRegions),
        questAnchors: Object.fromEntries(Object.entries(qr.quests).map(([id, e]) => [id, e.requiredAnchors])),
        goalAnchors: Object.fromEntries(Object.entries(qr.goals).map(([id, e]) => [id, e.requiredAnchors])),
        alwaysConnected,
        openAreas,
        gatedAreas,
        questScriptEdges,
        worldEdges,
        requirementGroups,
        entrancePool,
        randomizerPools,
        itemSources,
        questItems,
        quests,
        goals
    };

    fs.mkdirSync(path.dirname(path.resolve(OUT_PATH)), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(bundle) + '\n', 'utf8');
    const kb = Math.round(fs.statSync(OUT_PATH).size / 1024);
    console.log(`wrote ${OUT_PATH} (${kb} KB)`);
    console.log(`  ${gatedAreas.length} gated area(s), ${alwaysConnected.length} always-connected edge(s), ${openAreas.length} open area(s)`);
    console.log(`  ${questScriptEdges.length} quest script edge(s), ${worldEdges.length} world edge(s), ${Object.keys(requirementGroups).length} quest/goal(s) with extracted region groups`);
    console.log(`  ${entrancePool.gates.length} entrance gate(s) + ${entrancePool.oneWays.length} one-way(s), ${Object.keys(itemSources).length} sourced item(s)`);
    console.log(`  replayable pools: ${gatherPool.products.length} gather product(s), ${processPool.products.length} process product(s), ${shopPool.eligible.length} shopkeeper(s), ${spawnPool.city.length} city + ${spawnPool.chunk.length} chunk home(s)`);
    console.log(`                    ${dropPool.slots.length} drop slot(s), ${dropPool.mimic.units.length} loot table(s), ${dropPool.mimic.slots.length} mimic slot(s), ${dropPool.deathDrops.length} death drop(s)`);

    if (COPY_PATH) {
        fs.mkdirSync(path.dirname(path.resolve(COPY_PATH)), { recursive: true });
        fs.copyFileSync(OUT_PATH, COPY_PATH);
        console.log(`copied to ${COPY_PATH}`);
    } else {
        console.log('remember: copy into 2004Scape-AP-Logic/apworld/rs2004scape/data/rs2004_logic.json (--copy <path> does it for you)');
    }
}

main();
