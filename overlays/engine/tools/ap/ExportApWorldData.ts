// Exports the canonical Archipelago datapackage for 2004scape
// (docs/archipelago-integration.md). One JSON file is the shared contract
// between the Python apworld (generation-side rules + id tables) and the
// engine's ApClient (runtime check-id -> location-id and item-id -> grant
// mapping):
//
//   data/config/ap-archipelago-data.json
//
// After running, copy the output into the repo so both consumers ship it:
//   2004Scape-AP-Logic/overlays/engine/data/config/ap-archipelago-data.json
//   2004Scape-AP-Logic/apworld/rs2004scape/data/rs2004_data.json
//
// IDs are APPEND-ONLY: an existing output file's ids are preserved by name and
// only new names get fresh ids (max+1), so re-running after adding a check
// surface never renumbers anything already in the wild (the obj.pack rule).
//
// Run from Server/engine: npx tsx tools/ap/ExportApWorldData.ts

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CAPPABLE_SKILLS, LocationDef, QUEST_GATE_IDS, buildLocationCatalog, questGateKey } from '../sim/PlacementEngine.js';
import { Goal, QuestReq } from '../sim/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OUTPUT_PATH = 'data/config/ap-archipelago-data.json';
const LOCATION_BASE_ID = 20040000;
const ITEM_BASE_ID = 20045000;

// AXE/PICKAXE tier counts mirror ApUnlockOverrides.ts / PlacementEngine.ts.
const GEAR_FAMILIES: { key: string; label: string }[] = [
    { key: 'progressive_melee', label: 'Melee' },
    { key: 'progressive_armour', label: 'Armour' },
    { key: 'progressive_ranged', label: 'Ranged' },
    { key: 'progressive_magic', label: 'Magic' }
];
const PICKAXE_COPIES = 5;
const AXE_COPIES = 6;
const CAP_COPIES_PER_SKILL = 4;

interface ExportedLocation {
    id: number;
    /** AP-visible location name (unique). */
    name: string;
    kind: string;
    skill?: string;
    level?: number;
    questId?: string;
    fillerOnly?: boolean;
}

interface ExportedItem {
    id: number;
    /** ap-unlocks.json key ApClient passes to grantUnlock; absent for filler. */
    grant?: string;
    /** grantUnlock count per received copy (2 for skill caps - cap = 20 + 10*count). */
    count?: number;
    /** How many copies of this item exist in the pool. */
    copies: number;
    filler?: boolean;
}

function loadQuests(): QuestReq[] {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'sim', 'data', 'quests.json'), 'utf8');
    return (JSON.parse(raw) as { quests: QuestReq[] }).quests;
}

function loadGoals(): Goal[] {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'sim', 'data', 'goals.json'), 'utf8');
    return (JSON.parse(raw) as { goals: Goal[] }).goals;
}

// ---- quest difficulty matrix (progressive quests mode) ----
//
// Hand-curated LENGTH tier (1 = a few minutes ... 5 = multi-hour master quest),
// combined below with computed stat/prereq/QP components into one difficulty
// score. The score orders the "Progressive Quest Unlock" reveal sequence:
// receiving your Nth copy unlocks the Nth quest in this order, so short/easy
// quests surface first and the long masters (Underground Pass, Regicide,
// Heroes', Legends') land last. Tiers are judgment calls - relitigate freely;
// the computed components keep the order sane even where a tier is off by one.
const QUEST_LENGTH_TIER: Record<string, number> = {
    // 1 - trivial errands
    cook: 1, sheep: 1, doric: 1, imp: 1, hetty: 1, runemysteries: 1, drunkmonk: 1,
    hazeelcult: 1, fishingcompo: 1, junglepotion: 1, totem: 1, scorpcatcher: 1,
    seaslug: 1, priest: 1, death: 1, cog: 1, gobdip: 1, romeojuliet: 1,
    // 3 - solid mid-length members quests
    eadgar: 3, mortton: 3, tbwt: 3, desertrescue: 3, zombiequeen: 3, druidspirit: 3,
    ikov: 3, waterfall: 3, zanaris: 3, grandtree: 3,
    // 4 - long quests
    viking: 4, itwatchtower: 4, crest: 4, dragon: 4, hero: 4,
    // 5 - the multi-hour masters
    upass: 5, regicide: 5, legends: 5
    // everything else defaults to tier 2 (standard short quest)
};
const DEFAULT_LENGTH_TIER = 2;

function prereqIdsOf(q: QuestReq): string[] {
    const ids = [...(q.quests ?? [])];
    for (const group of q.questsAny ?? []) {
        ids.push(...group);
    }
    return ids;
}

function prereqDepth(id: string, byId: Map<string, QuestReq>, memo: Map<string, number>): number {
    const known = memo.get(id);
    if (known !== undefined) {
        return known;
    }
    memo.set(id, 0); // cycle guard
    const q = byId.get(id);
    const depth = q === undefined ? 0 : Math.max(0, ...prereqIdsOf(q).map(p => 1 + prereqDepth(p, byId, memo)));
    memo.set(id, depth);
    return depth;
}

function difficultyScore(q: QuestReq, byId: Map<string, QuestReq>, depthMemo: Map<string, number>): number {
    const levels = Object.values(q.skills ?? {});
    const maxSkill = Math.max(0, ...levels);
    const skillSum = levels.reduce((a, b) => a + b, 0);
    const tier = QUEST_LENGTH_TIER[q.id] ?? DEFAULT_LENGTH_TIER;
    const depth = prereqDepth(q.id, byId, depthMemo);
    return Math.round((tier * 25 + maxSkill * 1.5 + skillSum * 0.15 + (q.requiredQp ?? 0) * 0.5 + depth * 15 + (q.qp ?? 0) * 3) * 10) / 10;
}

// Difficulty-ordered gated-quest list. Sorted by score (id tiebreak for
// determinism), then a fix-up pass guarantees every gated prereq precedes its
// dependents - not needed for AP logic correctness (rules count copies), but it
// keeps the reveal order from handing out an unlock that's unusable until a
// later copy arrives.
function buildQuestUnlockOrder(quests: QuestReq[]): string[] {
    const byId = new Map(quests.map(q => [q.id, q]));
    const depthMemo = new Map<string, number>();
    const gated = new Set(QUEST_GATE_IDS);
    const order = [...QUEST_GATE_IDS].sort((a, b) => {
        const scoreA = difficultyScore(byId.get(a)!, byId, depthMemo);
        const scoreB = difficultyScore(byId.get(b)!, byId, depthMemo);
        return scoreA !== scoreB ? scoreA - scoreB : a.localeCompare(b);
    });
    for (let pass = 0; pass < order.length; pass++) {
        let moved = false;
        for (let i = 0; i < order.length; i++) {
            const prereqs = prereqIdsOf(byId.get(order[i])!).filter(p => gated.has(p));
            const latest = Math.max(-1, ...prereqs.map(p => order.indexOf(p)));
            if (latest > i) {
                const [q] = order.splice(i, 1);
                order.splice(latest, 0, q); // latest shifted left by the removal
                moved = true;
            }
        }
        if (!moved) {
            break;
        }
    }
    return order;
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function prettify(id: string): string {
    return id
        .split('_')
        .map(part => capitalize(part))
        .join(' ');
}

// Human AP name for a location - unique across the catalog (check ids already
// are; this is a cosmetic transform of them, so uniqueness carries over except
// where we join quest names, which are unique too).
function locationName(loc: LocationDef, questNames: Map<string, string>): string {
    switch (loc.kind) {
        case 'quest':
            return `Quest: ${questNames.get(loc.questId ?? '') ?? prettify(loc.questId ?? loc.id)}`;
        case 'level':
            return `Level ${loc.level} ${capitalize(loc.skill ?? '')}`;
        case 'first_xp':
            return `First ${capitalize(loc.skill ?? loc.id.replace('first_xp_', ''))} XP`;
        case 'ds':
            return `Dragon Slayer: ${prettify(loc.id.replace('ds_', ''))}`;
        case 'barcrawl':
            return `Barcrawl: ${prettify(loc.id)}`;
        case 'music':
            return `Music: ${prettify(loc.id.replace('music_', ''))}`;
        default:
            return prettify(loc.id);
    }
}

function main(): void {
    const quests = loadQuests();
    const goals = loadGoals();
    const questNames = new Map(quests.map(q => [q.id, q.name]));

    // full catalog: every option ON - option toggles must never renumber ids.
    const catalog = buildLocationCatalog(quests, { musicChecks: true });

    // ---- preserve existing ids ----
    let oldLocations: Record<string, ExportedLocation> = {};
    let oldItems: Record<string, ExportedItem> = {};
    if (fs.existsSync(OUTPUT_PATH)) {
        try {
            const old = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')) as { locations?: Record<string, ExportedLocation>; items?: Record<string, ExportedItem> };
            oldLocations = old.locations ?? {};
            oldItems = old.items ?? {};
            console.log(`preserving ids from existing ${OUTPUT_PATH} (${Object.keys(oldLocations).length} locations, ${Object.keys(oldItems).length} items)`);
        } catch {
            console.warn(`existing ${OUTPUT_PATH} unreadable - assigning all ids fresh`);
        }
    }

    let nextLocationId = Math.max(LOCATION_BASE_ID - 1, ...Object.values(oldLocations).map(l => l.id)) + 1;
    let nextItemId = Math.max(ITEM_BASE_ID - 1, ...Object.values(oldItems).map(i => i.id)) + 1;

    // ---- locations (keyed by engine check id) ----
    const locations: Record<string, ExportedLocation> = {};
    const usedNames = new Set<string>();
    for (const loc of catalog) {
        const name = locationName(loc, questNames);
        if (usedNames.has(name)) {
            throw new Error(`duplicate AP location name "${name}" (check id ${loc.id})`);
        }
        usedNames.add(name);
        locations[loc.id] = {
            id: oldLocations[loc.id]?.id ?? nextLocationId++,
            name,
            kind: loc.kind,
            skill: loc.skill,
            level: loc.level,
            questId: loc.questId,
            fillerOnly: loc.fillerOnly || undefined
        };
    }

    // ---- items (keyed by AP item name) ----
    const items: Record<string, ExportedItem> = {};
    const addItem = (name: string, def: Omit<ExportedItem, 'id'>) => {
        items[name] = { id: oldItems[name]?.id ?? nextItemId++, ...def };
    };

    for (const family of GEAR_FAMILIES) {
        addItem(`Progressive ${family.label}`, { grant: family.key, count: 1, copies: 7 });
    }
    addItem('Progressive Pickaxe', { grant: 'progressive_pickaxe', count: 1, copies: PICKAXE_COPIES });
    addItem('Progressive Axe', { grant: 'progressive_axe', count: 1, copies: AXE_COPIES });
    for (const skill of CAPPABLE_SKILLS) {
        // count 2 per copy: engine cap formula is 20 + 10*count, one copy = +20 levels.
        addItem(`Progressive ${capitalize(skill)} Cap`, { grant: `progressive_${skill}`, count: 2, copies: CAP_COPIES_PER_SKILL });
    }
    for (const questId of QUEST_GATE_IDS) {
        addItem(`Quest Unlock: ${questNames.get(questId) ?? prettify(questId)}`, { grant: questGateKey(questId), count: 1, copies: 1 });
    }
    // progressive_quests mode: replaces the per-quest unlocks 1:1 (same total
    // copies); the Nth copy unlocks questUnlockOrder[N-1]. ApClient resolves the
    // indirection at grant time; the apworld's rules count copies.
    addItem('Progressive Quest Unlock', { grant: 'progressive_quest', count: 1, copies: QUEST_GATE_IDS.length });
    addItem('Mystery Reward', { copies: 0, filler: true }); // copies computed at generation (locations - progression)

    const questUnlockOrder = buildQuestUnlockOrder(quests);

    // ---- goal conditions (check ids the client tests for StatusUpdate 30) ----
    const goalChecks: Record<string, string[]> = {
        barcrawl: Array.from({ length: 10 }, (_, i) => `barcrawl_bar_${i + 1}`),
        dragon: ['quest_dragon'],
        kbd: ['kbd_slain'],
        heroes: ['quest_hero'],
        legends: ['quest_legends']
    };

    const out = {
        _generated: `tools/ap/ExportApWorldData.ts (${new Date().toISOString().slice(0, 10)}) - ids are append-only, do not hand-edit`,
        game: '2004Scape',
        locationBaseId: LOCATION_BASE_ID,
        itemBaseId: ITEM_BASE_ID,
        capsFormula: { base: 20, perCount: 10 },
        locations,
        items,
        goalChecks,
        goals,
        quests,
        questGates: QUEST_GATE_IDS,
        questUnlockOrder
    };

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`wrote ${OUTPUT_PATH}: ${Object.keys(locations).length} locations, ${Object.keys(items).length} items`);
    console.log('remember: copy into 2004Scape-AP-Logic overlays/engine/data/config/ and apworld/rs2004scape/data/rs2004_data.json');
}

main();
