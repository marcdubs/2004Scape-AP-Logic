import fs from 'fs';
import path from 'path';

import { StatName } from '../sim/types.js';

// Item-acquisition graph for the seed validator (problems.txt #16). Answers "can the
// player actually OBTAIN item X given their current skill caps?" so quest item
// requirements stop being treated as always-satisfiable (the old narrative-only
// heldItems shortcut). This is what makes gathersanity / processsanity genuine LOGIC
// inputs: if a swap moves Clay behind Fishing 40, a quest that needs Clay now correctly
// waits for the fishing cap instead of being assumed doable.
//
// TWO DATA FILES (tools/logic/data/, built from game config by a subagent extraction
// pass - see the batch prompts in the session that added this):
//   - item-sources.json : item -> [{skill, level, inputs}]  (how each gathered/processed
//     item is obtained + what it consumes; raw gathers have inputs=[]).
//   - quest-items.json  : quest_id -> { items: [{item, qty, obtained}] }  (concrete items
//     a quest requires the player to SUPPLY, with a vanilla-acquisition hint).
//
// SAFETY DIRECTION (never false-block): an item is only ever reported UNOBTAINABLE when
// it has a KNOWN gather/process source AND none of those sources is currently reachable.
// Anything NOT in the graph (shop/drop/quest-given/misc) is assumed obtainable - we only
// ADD a gate where we can prove a skill wall, never invent one. Absent data files =>
// everything obtainable => exact current (vanilla) behaviour.

// A source is EITHER skill-gated (gather/process: needs skill cap >= level and inputs
// obtainable) OR region-gated (buy: shop owner's region reachable; drop: monster's region
// reachable). `region` set => region-gated; else skill-gated. This is the four-source OR
// model (problems.txt #16): an item is obtainable if ANY source is satisfiable, so a
// gather wall is rescued by a reachable shop, a shopsanity-relocated shop by a drop, etc.
export interface ItemSource {
    skill?: StatName;
    level?: number;
    inputs?: string[];
    region?: number; // set for buy/drop sources; the region that must be reachable
    via?: 'buy' | 'drop'; // provenance for spoiler/debug (region sources only)
}

export interface QuestItemNeed {
    item: string;
    qty: number;
    obtained: string; // gather | process | buy | drop | quest | given | unknown
}

const DATA_DIR = path.join('tools', 'logic', 'data');

export function loadItemSources(dir: string = DATA_DIR): Map<string, ItemSource[]> {
    const file = path.join(dir, 'item-sources.json');
    const map = new Map<string, ItemSource[]>();
    if (!fs.existsSync(file)) {
        return map;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [item, sources] of Object.entries(raw)) {
        if (item.startsWith('_') || !Array.isArray(sources)) {
            continue; // skip _notes etc.
        }
        const parsed: ItemSource[] = [];
        for (const s of sources as Record<string, unknown>[]) {
            if (typeof s.skill === 'string' && typeof s.level === 'number') {
                parsed.push({ skill: s.skill.toLowerCase() as StatName, level: s.level, inputs: Array.isArray(s.inputs) ? s.inputs.map(String) : [] });
            } else if (typeof s.region === 'number') {
                parsed.push({ region: s.region, via: s.via === 'buy' || s.via === 'drop' ? s.via : undefined });
            }
        }
        if (parsed.length > 0) {
            map.set(item, parsed);
        }
    }
    return map;
}

export function loadQuestItems(dir: string = DATA_DIR): Map<string, QuestItemNeed[]> {
    const file = path.join(dir, 'quest-items.json');
    const map = new Map<string, QuestItemNeed[]>();
    if (!fs.existsSync(file)) {
        return map;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { items?: unknown[] }>;
    for (const [quest, entry] of Object.entries(raw)) {
        if (quest.startsWith('_')) {
            continue;
        }
        const items: QuestItemNeed[] = [];
        for (const it of entry.items ?? []) {
            const o = it as Record<string, unknown>;
            if (typeof o.item === 'string') {
                items.push({ item: o.item, qty: typeof o.qty === 'number' ? o.qty : 1, obtained: typeof o.obtained === 'string' ? o.obtained : 'unknown' });
            }
        }
        map.set(quest, items);
    }
    return map;
}

// Applies gathersanity/processsanity swaps to the source graph so obtainability reflects
// the ACTUAL post-shuffle world. A swap table maps vanilla-product -> delivered-product:
// after the swap, the gathering/processing action that used to yield P now yields
// swap(P). So the item that inherits P's {skill,level,inputs} source is swap(P); i.e. we
// re-key each source under swap(itsProduct). Missing/empty swap map => vanilla graph.
export function applySwaps(vanilla: Map<string, ItemSource[]>, swap: Map<string, string> | null): Map<string, ItemSource[]> {
    if (!swap || swap.size === 0) {
        return vanilla;
    }
    const out = new Map<string, ItemSource[]>();
    for (const [product, sources] of vanilla) {
        const delivered = swap.get(product) ?? product;
        const arr = out.get(delivered) ?? [];
        arr.push(...sources);
        out.set(delivered, arr);
    }
    return out;
}

// Fixpoint: which items are obtainable given current skill caps. An item is obtainable if
// ANY of its sources has skill cap >= level AND every input is itself obtainable (inputs
// not in the graph are assumed obtainable - buy/drop/given/misc). Raw gathers (inputs=[])
// gate on the cap alone. Recomputed per sphere as caps grow (cheap - a few hundred items).
export function computeObtainable(sources: Map<string, ItemSource[]>, statCaps: Record<StatName, number>, reachableRegions: ReadonlySet<number>): Set<string> {
    const obtainable = new Set<string>();
    const inputObtainable = (item: string): boolean => !sources.has(item) || obtainable.has(item);
    const satisfiable = (s: ItemSource): boolean =>
        s.region !== undefined
            ? reachableRegions.has(s.region)                                        // buy/drop: shop-owner / monster region reachable
            : (statCaps[s.skill!] ?? 99) >= (s.level ?? 0) && (s.inputs ?? []).every(inputObtainable); // gather/process
    let changed = true;
    while (changed) {
        changed = false;
        for (const [item, srcs] of sources) {
            if (obtainable.has(item)) {
                continue;
            }
            if (srcs.some(satisfiable)) {
                obtainable.add(item);
                changed = true;
            }
        }
    }
    return obtainable;
}

// Merges region-gated (buy/drop) sources into the graph. `itemToNpcs` maps item -> the NPC
// debugnames that provide it (shop OWNER for buy, MONSTER for drop); `resolveRegion` turns
// an npc spawn coord into a region id (0 if unresolved). Shopsanity/drop-rando awareness is
// free: the shop-ownership / drop-table data those NPCs come from is read from the current
// (shuffled) content, so the owner/monster already reflects the seed.
export function addRegionSources(
    graph: Map<string, ItemSource[]>,
    itemToNpcs: Map<string, string[]>,
    npcSpawns: Map<string, string>,
    resolveRegion: (coord: string) => number,
    via: 'buy' | 'drop'
): void {
    for (const [item, npcs] of itemToNpcs) {
        const regions = new Set<number>();
        for (const npc of npcs) {
            const coord = npcSpawns.get(npc);
            if (coord) {
                const r = resolveRegion(coord);
                if (r !== 0) {
                    regions.add(r);
                }
            }
        }
        if (regions.size === 0) {
            continue;
        }
        const arr = graph.get(item) ?? [];
        for (const region of regions) {
            arr.push({ region, via });
        }
        graph.set(item, arr);
    }
}

export function loadNpcSpawns(dir: string = DATA_DIR): Map<string, string> {
    const file = path.join(dir, 'npc-spawns.json');
    const map = new Map<string, string>();
    if (!fs.existsSync(file)) {
        return map;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    for (const [npc, coord] of Object.entries(raw)) {
        if (!npc.startsWith('_')) {
            map.set(npc, coord);
        }
    }
    return map;
}

// The single query the validator uses. `obtainable` is the current-sphere fixpoint set.
// An item is available if it's not modelled by a gather/process source (assumed
// obtainable) OR it's in the reachable set. This is the never-false-block rule above.
export function itemAvailable(item: string, sources: Map<string, ItemSource[]>, obtainable: Set<string>): boolean {
    return !sources.has(item) || obtainable.has(item);
}
