// The shared logic MODEL: the pieces of seed-beatability reasoning that both consumers
// of this project's logic need to agree on, byte for byte.
//
//   - tools/logic/ValidateSeed.ts   - the local/solo oracle (generate-and-test; the
//     reroll loop in RandomizeEntrances.ts calls it until a seed is beatable).
//   - tools/ap/ExportLogicBundle.ts - the exporter that hands the same model to the
//     Python apworld (construct-valid; Archipelago's fill owns beatability there).
//
// Both modes stay first-class (GitHub #3): this file exists so "what the local oracle
// believes" and "what the apworld is told" are the SAME objects, not two hand-synced
// reimplementations. Anything region-shaped that ValidateSeed used to define privately
// lives here now; ValidateSeed imports it and behaves exactly as before.
//
// Nothing in here reads the per-seed config dir - callers pass what they loaded. The
// region graph IS an input (it is a build artifact of BuildRegionGraph.ts).

import fs from 'fs';

import { QuestReq, StatName } from '../sim/types.js';

import { GatedArea, GatedAreaRequire, POCKET_TILE_CAP, areaDoorTiles } from './GatedAreas.js';
import { GeneratedIgnores } from './GeneratedQuestRegions.js';
import { RegionGraph } from './RegionGraph.js';

// vanilla Lumbridge respawn, matches ApSpawnOverrides.ts's VANILLA_HOME literal exactly.
export const VANILLA_SPAWN_RAW = '0_50_50_21_18';

// ---- quest-regions.json (this project's curated spatial data) ----

export interface AnchorDef {
    level: number;
    x: number;
    z: number;
    note?: string;
}

export interface OpenAreaBox {
    levels: number[];
    x1: number;
    z1: number;
    x2: number;
    z2: number;
}

export interface OpenArea {
    name: string;
    connectTo: string[]; // anchor names
    boxes: OpenAreaBox[];
    note?: string;
}

export interface QuestRegionsFile {
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

export function loadQuestRegions(filePath: string): QuestRegionsFile {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Regions larger than this are never open-area members: upper levels have
// world-spanning walkable "void/roof" megaregions (e.g. the 1.1M-tile level-3 one)
// that a box overlapping them by a tile would otherwise connect globally. The largest
// legitimate quest area (Kharazi underground) is ~40k tiles.
export const OPEN_AREA_MEMBER_TILE_CAP = 100000;

/** Region ids intersecting an open area's boxes. */
export function resolveOpenAreaMembers(area: OpenArea, graph: RegionGraph): Set<number> {
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

/** Anchor name -> region id (0 = the coordinate resolved to no walkable region). */
export function resolveAnchors(qr: QuestRegionsFile, graph: RegionGraph): Map<string, number> {
    const out = new Map<string, number>();
    for (const [name, def] of Object.entries(qr.anchors)) {
        out.set(name, graph.resolveRegion({ level: def.level, x: def.x, z: def.z }));
    }
    return out;
}

// ---- gated areas: compute each area's isolated ("gated") region ids and the outside
// region ids immediately bordering its box(es), per docs/entrance-logic.md's pragmatic
// simplification ("area regions are reachable iff require satisfied AND an
// edge/adjacency reaches them"). See BuildRegionGraph.ts's file header for why doors
// near these boxes were kept closed in the first place - this is where that pays off:
// a well-enclosed curated area reliably shows up as its own region id(s), distinct from
// whatever borders it. ----

export interface ResolvedGatedArea {
    area: GatedArea;
    gatedRegionIds: Set<number>;
    outsideRegionIds: Set<number>;
}

// Region-membership resolution (GitHub #16, Option 3): for an area carrying a `doors`
// list, the gated interior is the actual pocket(s) BEHIND those door tiles, not every
// region that happens to fall inside a bounding rectangle. We probe each door tile's
// neighborhood on both sides and classify each adjacent region:
//   - INSIDE pocket: a small (<= POCKET_TILE_CAP) non-mainland region - the isolated
//     interior the gate protects. This is exactly how DeriveGatedAreas picked the pocket
//     to box, so it re-derives the same interior against the CURRENT graph - and, crucially,
//     never sweeps in a disconnected island that merely sits inside the rectangle (the druid
//     cauldron caught by the Black Knights' spy-grill box was such an island).
//   - OUTSIDE: the mainland or an open/large region on the other side of the door.
// A door is symmetric: once the requirement is met, crossing it works in EITHER direction,
// so the reconnection trigger is "any adjacent region (inside OR outside) already reachable".
// This matters for deep dungeon gates (Elvarg's lair, Golrie's cell) where BOTH sides are
// small pockets and there is no mainland neighbor at all - the approach pocket is reached
// via a script-teleport/ladder, and meeting the requirement then opens the lair. Multi-floor
// interiors reconnect for free: the plane-0 pocket is gated here, and the internal stair up
// (a script edge) carries the requirement and fires once that pocket is reachable (see
// ValidateSeed's gatedRegionRequire).
function resolveDoorGatedArea(area: GatedArea, graph: RegionGraph): { gatedRegionIds: Set<number>; outsideRegionIds: Set<number> } {
    const mainland = graph.meta.mainlandRegionId;
    const inside = new Set<number>();
    const adjacent = new Set<number>(); // every region touching a door tile, both sides
    for (const door of areaDoorTiles(area)) {
        // scan the door's immediate neighborhood on its own level (the tile itself is the
        // blocked door loc, so it never resolves to a region).
        for (let r = 1; r <= 2; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) {
                        continue; // only the new ring at this radius
                    }
                    const id = graph.regionAt(door.x + dx, door.z + dz, door.level);
                    if (id === 0) {
                        continue;
                    }
                    adjacent.add(id);
                    if (id !== mainland && (graph.regionsById.get(id)?.tileCount ?? 0) <= POCKET_TILE_CAP) {
                        inside.add(id);
                    }
                }
            }
        }
    }
    // gatedRegionIds = the interior pockets we (re)connect and attach the requirement to.
    // outsideRegionIds = the trigger set: ALL adjacent regions, so reaching either side of
    // the door (including a sibling pocket reached via a teleport) opens the crossing.
    return { gatedRegionIds: inside, outsideRegionIds: adjacent };
}

export function resolveGatedAreas(areas: GatedArea[], graph: RegionGraph): ResolvedGatedArea[] {
    return areas.map(area => {
        if (area.doors && area.doors.length > 0) {
            const { gatedRegionIds, outsideRegionIds } = resolveDoorGatedArea(area, graph);
            return { area, gatedRegionIds, outsideRegionIds };
        }
        const insideIds = new Set<number>();
        const outsideIds = new Set<number>();
        // The ring test is per AREA, not per box: an irregular room (the Mining Guild
        // cave, Ardougne's locked wings) is covered by SEVERAL rectangles tiling it, and
        // each rectangle's ring lands on its neighbour's tiles - the same region. Testing
        // the ring against the current box alone would then push every such interior into
        // outsideIds and leave gatedRegionIds empty, i.e. silently drop the gate from the
        // logic model while the runtime still enforces it (ValidateSeed's "no interior
        // region distinct from its surroundings" lint is exactly this).
        const inAnyBox = (level: number, x: number, z: number): boolean =>
            area.boxes.some(b => b.level === level && x >= b.x1 && x <= b.x2 && z >= b.z1 && z <= b.z2);
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
                    if (inAnyBox(box.level, x, z)) {
                        continue; // inside the area, not the ring.
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

/** region id -> the require of the first gated area whose interior contains it. */
export function gatedRegionRequires(resolved: ResolvedGatedArea[]): Map<number, GatedAreaRequire> {
    const out = new Map<number, GatedAreaRequire>();
    for (const ra of resolved) {
        for (const id of ra.gatedRegionIds) {
            if (!out.has(id)) {
                out.set(id, ra.area.require);
            }
        }
    }
    return out;
}

// ---- the quest-doability varp model ----
//
// Every gate in ap-gated-areas.json references a quest-progress varp; this simulation is
// quest-ATOMIC (tracks completion + doability, not per-stage), so the model maps each gate
// varp to the state its quest is in. The 47 gate varps in the shipped gated-areas file all
// belong to one of the sim's quests (DeriveGatedAreas + the subagent require pass - see
// problems.txt #9).
//
// KEY MODELLING CHOICE: a quest-progress gate is satisfiable when its quest is DOABLE (its
// non-region prerequisites - skills + prereq quests + QP - are met), NOT when it is
// complete. This is essential and correct:
//   - It breaks CIRCULARITY: a quest's own interior door (e.g. Phoenix Gang hideout, gating
//     %phoenixgang, needed to DO Shield of Arrav) would deadlock if it required the quest
//     complete. "Doable" lets the fixpoint flow: prereqs met -> door opens -> quest-region
//     reachable -> quest completes.
//   - It can't cause a FALSE PASS on quest-internal items: a "quest X complete" gate can't
//     legitimately hide an item that quest X itself needs (vanilla contradiction), so
//     opening at "doable" never makes an unbeatable seed look beatable.
// resolveVarp returns an all-low-bits value (0x7FFFFFFF) when doable, so both `gte`
// thresholds and any `testbit` (bits 0-30) pass; 0 otherwise -> requireSatisfied treats the
// gate as closed.
export const GATE_VARP_ALL = 0x7FFFFFFF;

/** varp -> sim quest id (quests.json). Unmapped varps fall through to 0 (fail-closed). */
export const VARP_TO_QUEST: Record<string, string> = {
    arenaquest: 'arena', ballquest: 'ball', biohazard: 'biohazard', cogquest: 'cog',
    death_equiproom: 'death', desertrescue_map_mechanisms: 'desertrescue',
    dragon_oracle: 'dragon', dragon_wall: 'dragon', dragonquest: 'dragon',
    druidspirit: 'druid', eadgar_quest: 'eadgar', grail: 'grail', grandtree: 'grandtree',
    handelmort_traps_disabled: 'totem', hazeelcult_side: 'hazeelcult', hazeelcultquest: 'hazeelcult',
    horrorair: 'horror', horrorarrow: 'horror', horrorearth: 'horror', horrorfire: 'horror',
    horrorquest: 'horror', horrorsword: 'horror', horrorwater: 'horror',
    hunt_store_employed: 'hunt', ibanmulti: 'upass', ikov: 'ikov', itwatchtower_bits: 'itwatchtower',
    junglepotion: 'junglepotion', legends_bits: 'legends', mcannon: 'mcannon', murderquest: 'murder',
    priestperil: 'priest', regicide_quest: 'regicide', scorpcatcher: 'scorpcatcher', tbwt_main: 'tbwt',
    treequest: 'tree', troll_entered_stronghold: 'troll', troll_freed_eadgar: 'troll',
    troll_quest: 'troll', viking: 'viking'
};

/**
 * varps used by BOTH a post-quest COMPLETION gate (guild / gang-complete) AND a mid-quest
 * gate on the same varp. Modelled as completed?ALL : (doable?mid:0) so the completion gate
 * stays completion-SAFE (never opens early - avoids a false pass on post-quest reward areas)
 * while mid-quest doors on the same varp still open at "doable". `mid` sits above every
 * mid-quest threshold on that varp and below its completion threshold.
 */
export const SPLIT_VARPS: Record<string, { quest: string; mid: number }> = {
    heroquest: { quest: 'hero', mid: 14 },            // guild needs >=15 (complete); mansion/HQ doors need 10/8
    blackarmgang: { quest: 'blackarmgang', mid: 3 },  // hideout door needs >=3 (joined); Heroes doors need 4 (complete)
    phoenixgang: { quest: 'blackarmgang', mid: 9 },   // hideout door needs >=9 (joined); Heroes kitchen needs 10 (complete)
    legendsquest: { quest: 'legends', mid: 74 }       // guild needs >=75 (complete); interior force-barrier needs >=18 (mid-quest)
};

/** varps that only ever open on quest COMPLETION (none today; kept as the escape hatch). */
export const COMPLETION_ONLY: Record<string, string> = {};

/** Non-quest varps the model resolves from skill caps instead of quest state. */
export const STAT_VARPS: Record<string, { stat: string; gte: number }> = {
    // not a quest - permanent once base Prayer >= 31 (Abbot Langley).
    prayer_guild: { stat: 'prayer', gte: 31 }
};

export function skillsSatisfied(skills: Partial<Record<StatName, number>> | undefined, caps: Record<StatName, number>): boolean {
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

export function questsChainSatisfied(quests: string[] | undefined, questsAny: string[][] | undefined, completed: Set<string>): boolean {
    if (quests && !quests.every(id => completed.has(id))) {
        return false;
    }
    if (questsAny && !questsAny.every(group => group.some(id => completed.has(id)))) {
        return false;
    }
    return true;
}

export function questDoable(q: QuestReq | undefined, qp: number, completed: Set<string>, statCaps: Record<StatName, number>): boolean {
    if (!q) {
        return false; // varp maps to a quest this sim doesn't model -> fail-closed
    }
    return skillsSatisfied(q.skills, statCaps) && qp >= (q.requiredQp ?? 0) && questsChainSatisfied(q.quests, q.questsAny, completed);
}

export function resolveVarp(
    name: string,
    qp: number,
    completed: Set<string>,
    statCaps: Record<StatName, number>,
    statCapsLower: Map<string, number>,
    questsById: Map<string, QuestReq>
): number | undefined {
    if (name === 'qp') {
        return qp;
    }
    const statVarp = STAT_VARPS[name];
    if (statVarp) {
        return (statCapsLower.get(statVarp.stat) ?? 99) >= statVarp.gte ? 1 : 0;
    }
    const split = SPLIT_VARPS[name];
    if (split) {
        return completed.has(split.quest) ? GATE_VARP_ALL : (questDoable(questsById.get(split.quest), qp, completed, statCaps) ? split.mid : 0);
    }
    const co = COMPLETION_ONLY[name];
    if (co) {
        return completed.has(co) ? GATE_VARP_ALL : 0;
    }
    const quest = VARP_TO_QUEST[name];
    if (quest) {
        return questDoable(questsById.get(quest), qp, completed, statCaps) ? GATE_VARP_ALL : 0;
    }
    return undefined; // unknown varp -> requireSatisfied treats as 0 (fail-closed).
}

/** Every varp name a set of requires mentions (plus the two always-resolved ones). */
export function collectRequiredVarps(requires: Iterable<GatedAreaRequire>): Set<string> {
    const out = new Set<string>(['qp', ...Object.keys(STAT_VARPS)]);
    const walk = (r: GatedAreaRequire): void => {
        if ('allOf' in r) {
            r.allOf.forEach(walk);
        } else if ('varp' in r) {
            out.add(r.varp);
        }
    };
    for (const r of requires) {
        walk(r);
    }
    return out;
}
