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
    addItem('Mystery Reward', { copies: 0, filler: true }); // copies computed at generation (locations - progression)

    // ---- goal conditions (check ids the client tests for StatusUpdate 30) ----
    const goalChecks: Record<string, string[]> = {
        barcrawl: Array.from({ length: 10 }, (_, i) => `barcrawl_bar_${i + 1}`),
        dragon: ['quest_dragon'],
        kbd: ['kbd_slain']
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
        questGates: QUEST_GATE_IDS
    };

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`wrote ${OUTPUT_PATH}: ${Object.keys(locations).length} locations, ${Object.keys(items).length} items`);
    console.log('remember: copy into 2004Scape-AP-Logic overlays/engine/data/config/ and apworld/rs2004scape/data/rs2004_data.json');
}

main();
