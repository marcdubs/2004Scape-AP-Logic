// Archipelago gated-area enforcement (2004Scape-AP-Logic docs/entrance-logic.md).
// The entrance shuffle can land arrivals INSIDE areas whose vanilla gate is a door
// with a requirement (Champions' Guild's 32-QP door was the first observed leak) -
// this module makes the requirement travel with the AREA, not the door: any shuffled
// arrival into a gated area is refused unless the player qualifies.
//
// Loads data/config/ap-gated-areas.json lazily (sibling-module convention: missing
// file = everything allowed/vanilla, with one printInfo). Schema (docs/entrance-
// logic.md): areas = { name, boxes: [{level,x1,z1,x2,z2}] (abs tile coords,
// inclusive), require, message }.
//
// `require` v1 forms per the shared schema: { varp, gte } and { item }, combined via
// { allOf: [...] }. ADDITIVE v1 form beyond the schema doc (needed to express the
// skill-gated guilds on the curated launch list - Crafting/Wizards'/Mining - which
// have no varp at all): { stat: <PlayerStat name, case-insensitive>, gte: <n> },
// checked against the player's BASE level (baseLevels, not the current/boostable
// level the vanilla door scripts happen to check) so a temporary stat boost can't be
// used to sneak a shuffled-entrance arrival past a gate the vanilla door would have
// stopped once the boost wears off. Flagged for workstream C (region-graph
// validator): it needs to know about this form to reason about skill-gated areas,
// not just varp/quest ones.
//
// `item` checks the player's OWN inv + worn (never the bank - a banked dramen staff
// shouldn't open Zanaris).
//
// Returns true when the player may arrive at `destCoord` (packed); on false the
// caller refuses the teleport (this module has already messaged the player, throttled
// to ~1/600ms since the same lookup fires from stair/ladder MENU-LABEL paths, not
// just real travel). Called from the AP_ENTRANCE_OVERRIDE handler on every shuffled-
// entrance use - must be cheap and must never throw (ServerOps.ts also wraps the call
// in try/catch as defense in depth, but this module doesn't rely on that).

import fs from 'fs';
import path from 'path';

import ObjType from '#/cache/config/ObjType.js';
import InvType from '#/cache/config/InvType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { questGateLabel } from '#/engine/ApUnlockOverrides.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerStatMap, PlayerStatNameMap } from '#/engine/entity/PlayerStat.js';
import { printInfo, printWarning } from '#/util/Logger.js';

const CONFIG_PATH = 'data/config/ap-gated-areas.json';
// completion-watch table, read only to name the quest behind a varp in denial messages
const WATCHES_PATH = 'data/config/ap-checks.json';

// per-player denial-message throttle: the same applyAreaGate lookup fires from
// stair/ladder MENU-LABEL previews (building the "climb up"/"climb down" options),
// not only from an actual arrival - without this a player standing near a gated
// destination would get spammed on every menu build.
const THROTTLE_MS = 600;
const lastDenialAt = new WeakMap<Player, number>();

// ---------------------------------------------------------------------------
// Config shapes
// ---------------------------------------------------------------------------

interface Box {
    level: number;
    x1: number;
    z1: number;
    x2: number;
    z2: number;
}

type ResolvedRequire =
    | { kind: 'varp'; varpId: number; gte: number }
    | { kind: 'varpBit'; varpId: number; bit: number; set: boolean } // set=true: bit must be 1 ({varp,bit}); set=false: bit must be 0 ({varp,bitClear})
    | { kind: 'stat'; statId: number; gte: number }
    | { kind: 'item'; objId: number }
    | { kind: 'allOf'; all: ResolvedRequire[] };

interface Area {
    name: string;
    boxes: Box[];
    require: ResolvedRequire;
    message: string;
}

let areas: Area[] | null = null;

// ---------------------------------------------------------------------------
// Loading + validation (fail-open per entry, never throws)
// ---------------------------------------------------------------------------

function isRawBox(raw: unknown): raw is { level: number; x1: number; z1: number; x2: number; z2: number } {
    if (!raw || typeof raw !== 'object') {
        return false;
    }
    const b = raw as Record<string, unknown>;
    return typeof b.level === 'number' && typeof b.x1 === 'number' && typeof b.z1 === 'number' && typeof b.x2 === 'number' && typeof b.z2 === 'number';
}

// resolves varp/stat/item name strings to engine ids up front (once, at load) so the
// hot path (applyAreaGate, called on every shuffled-entrance use) never does string
// lookups. Returns null on any unresolvable reference - the caller drops the whole
// area (fail-open: an area with a broken require is treated as ungated rather than
// silently always-blocking or always-allowing based on a guess).
function resolveRequire(raw: unknown, areaName: string): ResolvedRequire | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const r = raw as Record<string, unknown>;

    if (typeof r.varp === 'string' && (typeof r.gte === 'number' || typeof r.bit === 'number' || typeof r.bitClear === 'number')) {
        const varpId = VarPlayerType.getId(r.varp);
        if (varpId === -1) {
            printWarning(`AP area gates: area "${areaName}" references unknown varp "${r.varp}"`);
            return null;
        }
        // bitfield-varp gates (testbit(%varp, ^bitconst)): bit set / bit clear.
        if (typeof r.bit === 'number') {
            return { kind: 'varpBit', varpId, bit: r.bit, set: true };
        }
        if (typeof r.bitClear === 'number') {
            return { kind: 'varpBit', varpId, bit: r.bitClear, set: false };
        }
        return { kind: 'varp', varpId, gte: r.gte as number };
    }

    if (typeof r.stat === 'string' && typeof r.gte === 'number') {
        const statId = PlayerStatMap.get(r.stat.toUpperCase());
        if (statId === undefined) {
            printWarning(`AP area gates: area "${areaName}" references unknown stat "${r.stat}"`);
            return null;
        }
        return { kind: 'stat', statId, gte: r.gte };
    }

    if (typeof r.item === 'string') {
        const objId = ObjType.getId(r.item);
        if (objId === -1) {
            printWarning(`AP area gates: area "${areaName}" references unknown item "${r.item}"`);
            return null;
        }
        return { kind: 'item', objId };
    }

    if (Array.isArray(r.allOf)) {
        const all: ResolvedRequire[] = [];
        for (const sub of r.allOf) {
            const resolved = resolveRequire(sub, areaName);
            if (resolved === null) {
                return null;
            }
            all.push(resolved);
        }
        if (all.length === 0) {
            return null;
        }
        return { kind: 'allOf', all };
    }

    return null;
}

// ---------------------------------------------------------------------------
// Denial-message wording: say what the gate WANTS, not just where you are
// ---------------------------------------------------------------------------
//
// Only 7 of the 107 curated areas ship a message that names their requirement (the
// guilds: "requires level 60 Mining"). The other 100 were generated from the loc
// label alone - 46 read "(Door)", 3 "(Wall)" - which tells a player they are blocked
// and nothing whatsoever about by what. Under entrance randomization that is a dead
// end: the door you would have opened is not where the lock is any more, so there is
// no vanilla knowledge to fall back on.
//
// So we render the resolved requirement into the message at LOAD time (once, never on
// the hot path) and splice it into the trailing parenthetical. Messages that already
// explain themselves - detected by a ':' in that parenthetical - are left untouched.

/** varp id -> the quest it watches: { label, completion } from ap-checks.json's watch table. */
function loadQuestVarps(): Map<number, { label: string; completion: number }> {
    const map = new Map<number, { label: string; completion: number }>();
    try {
        if (!fs.existsSync(WATCHES_PATH)) {
            return map;
        }
        const watches = (JSON.parse(fs.readFileSync(WATCHES_PATH, 'utf8')) as { watches?: { varp?: string; mode?: string; value?: number; check?: string }[] }).watches ?? [];
        for (const w of watches) {
            if (typeof w.varp !== 'string' || typeof w.check !== 'string' || !w.check.startsWith('quest_') || w.mode !== 'gte' || typeof w.value !== 'number') {
                continue;
            }
            const varpId = VarPlayerType.getId(w.varp);
            if (varpId !== -1 && !map.has(varpId)) {
                map.set(varpId, { label: questGateLabel(w.check), completion: w.value });
            }
        }
    } catch (err) {
        printWarning(`AP area gates: could not read ${WATCHES_PATH} for quest names, denial messages fall back to varp names (${err instanceof Error ? err.message : err})`);
    }
    return map;
}

function statLabel(statId: number): string {
    const name = PlayerStatNameMap.get(statId);
    return name ? name.charAt(0) + name.slice(1).toLowerCase() : `stat ${statId}`;
}

function objLabel(objId: number): string {
    try {
        return ObjType.get(objId)?.name ?? `item ${objId}`;
    } catch {
        return `item ${objId}`;
    }
}

function varpLabel(varpId: number): string {
    try {
        return VarPlayerType.get(varpId)?.debugname ?? `varp ${varpId}`;
    } catch {
        return `varp ${varpId}`;
    }
}

// One requirement, as a noun phrase ("Heroes' Quest (stage 4+)", "level 60 Mining") so
// allOf can join them under a single leading "requires" instead of repeating it.
function requireClause(req: ResolvedRequire, questVarps: Map<number, { label: string; completion: number }>): string {
    switch (req.kind) {
        case 'varp': {
            const quest = questVarps.get(req.varpId);
            if (quest) {
                // at or above the completion threshold the gate really means "finish it";
                // below it, the gate opens partway through, so say which stage.
                return req.gte >= quest.completion ? quest.label : `${quest.label} (stage ${req.gte}+)`;
            }
            return `${varpLabel(req.varpId)} >= ${req.gte}`;
        }
        case 'varpBit': {
            const quest = questVarps.get(req.varpId);
            const what = quest ? `progress in ${quest.label}` : `${varpLabel(req.varpId)} bit ${req.bit}`;
            return req.set ? what : `${what} NOT done`;
        }
        case 'stat':
            return `level ${req.gte} ${statLabel(req.statId)}`;
        case 'item':
            return `${objLabel(req.objId)} (carried or worn)`;
        case 'allOf':
            return req.all.map(sub => requireClause(sub, questVarps)).join(', and ');
    }
}

function describeRequire(req: ResolvedRequire, questVarps: Map<number, { label: string; completion: number }>): string {
    const clause = requireClause(req, questVarps);
    return clause.length > 0 ? `requires ${clause}` : '';
}

/**
 * Splices the rendered requirement into the message's trailing "(...)" label, so
 * "(Wall)" becomes "(Wall: requires Heroes' Quest (to stage 4))" while the curated
 * "(Mining Guild: requires level 60 Mining)" is recognised as self-explanatory and
 * passed through untouched. No trailing parenthetical at all: append one.
 */
function explainMessage(message: string, req: ResolvedRequire, questVarps: Map<number, { label: string; completion: number }>): string {
    const detail = describeRequire(req, questVarps);
    if (detail.length === 0) {
        return message;
    }
    const match = message.match(/\(([^()]*)\)\s*$/);
    if (!match) {
        return `${message} (${detail})`;
    }
    if (match[1].includes(':')) {
        return message; // already spells out its own requirement
    }
    return `${message.slice(0, match.index)}(${match[1]}: ${detail})`;
}

function loadAreas(): Area[] {
    const loaded: Area[] = [];
    const questVarps = loadQuestVarps();

    if (!fs.existsSync(CONFIG_PATH)) {
        printInfo(`AP area gates: no ${path.basename(CONFIG_PATH)}, gated areas are all open (vanilla)`);
        return loaded;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { areas?: unknown[] };

        for (const raw of parsed.areas ?? []) {
            if (!raw || typeof raw !== 'object') {
                printWarning(`AP area gates: skipping malformed area entry ${JSON.stringify(raw)}`);
                continue;
            }
            const a = raw as Record<string, unknown>;

            if (typeof a.name !== 'string' || typeof a.message !== 'string' || !Array.isArray(a.boxes)) {
                printWarning(`AP area gates: skipping malformed area entry ${JSON.stringify(raw).slice(0, 200)}`);
                continue;
            }

            const boxes: Box[] = [];
            let boxesOk = a.boxes.length > 0;
            for (const rawBox of a.boxes) {
                if (!isRawBox(rawBox)) {
                    printWarning(`AP area gates: area "${a.name}" has a malformed box, skipping the whole area`);
                    boxesOk = false;
                    break;
                }
                // normalize so x1/z1 is always the min corner regardless of authoring order
                boxes.push({
                    level: rawBox.level,
                    x1: Math.min(rawBox.x1, rawBox.x2),
                    x2: Math.max(rawBox.x1, rawBox.x2),
                    z1: Math.min(rawBox.z1, rawBox.z2),
                    z2: Math.max(rawBox.z1, rawBox.z2)
                });
            }
            if (!boxesOk) {
                continue;
            }

            const require = resolveRequire(a.require, a.name);
            if (require === null) {
                printWarning(`AP area gates: area "${a.name}" has an unresolvable require, skipping (its boxes will NOT be gated)`);
                continue;
            }

            loaded.push({ name: a.name, boxes, require, message: explainMessage(a.message, require, questVarps) });
        }

        printInfo(`AP area gates: loaded ${loaded.length} gated area(s)`);
    } catch (err) {
        printWarning(`AP area gates: failed to parse ${CONFIG_PATH}, gated areas are all open (${err instanceof Error ? err.message : err})`);
        return [];
    }

    return loaded;
}

// ---------------------------------------------------------------------------
// Lookup + requirement evaluation
// ---------------------------------------------------------------------------

function boxContains(box: Box, level: number, x: number, z: number): boolean {
    return box.level === level && x >= box.x1 && x <= box.x2 && z >= box.z1 && z <= box.z2;
}

// linear scan is fine at the expected scale (<30 areas, a handful of boxes each);
// early-outs on level first since that's the cheapest mismatch to detect.
function findArea(candidates: Area[], level: number, x: number, z: number): Area | null {
    for (const area of candidates) {
        for (const box of area.boxes) {
            if (box.level !== level) {
                continue;
            }
            if (boxContains(box, level, x, z)) {
                return area;
            }
        }
    }
    return null;
}

function hasItem(player: Player, objId: number): boolean {
    const inv = player.getInventory(InvType.INV);
    if (inv && inv.getItemCount(objId) > 0) {
        return true;
    }
    const worn = player.getInventory(InvType.WORN);
    if (worn && worn.getItemCount(objId) > 0) {
        return true;
    }
    return false;
}

function evalRequire(player: Player, req: ResolvedRequire): boolean {
    switch (req.kind) {
        case 'varp':
            return player.vars[req.varpId] >= req.gte;
        case 'varpBit':
            return (((player.vars[req.varpId] >> req.bit) & 1) === 1) === req.set;
        case 'stat':
            return player.baseLevels[req.statId] >= req.gte;
        case 'item':
            return hasItem(player, req.objId);
        case 'allOf':
            return req.all.every(sub => evalRequire(player, sub));
    }
}

function shouldMessage(player: Player): boolean {
    const now = Date.now();
    const last = lastDenialAt.get(player) ?? 0;
    if (now - last < THROTTLE_MS) {
        return false;
    }
    lastDenialAt.set(player, now);
    return true;
}

// ---------------------------------------------------------------------------
// Public API (frozen signatures)
// ---------------------------------------------------------------------------

export function applyAreaGate(player: Player, destCoord: number): boolean {
    try {
        if (areas === null) {
            areas = loadAreas();
        }
        if (areas.length === 0) {
            return true;
        }

        const dest = CoordGrid.unpackCoord(destCoord);
        const area = findArea(areas, dest.level, dest.x, dest.z);
        if (!area) {
            return true;
        }

        if (evalRequire(player, area.require)) {
            return true;
        }

        // a player already standing inside this SAME area's own boxes (e.g. taking an
        // interior staircase to another floor of a guild they legitimately entered)
        // must never be blocked - the gate only guards the crossing INTO the area, not
        // movement within it.
        if (findArea([area], player.level, player.x, player.z) !== null) {
            return true;
        }

        if (shouldMessage(player)) {
            player.messageGame(area.message);
        }
        return false;
    } catch (err) {
        printWarning(`AP area gates: applyAreaGate failed, failing open (${err instanceof Error ? err.message : err})`);
        return true;
    }
}

// Engine-testable lookup for agent C / unit tests: which gated area (if any) covers
// a coord, by name. Does not evaluate the requirement or touch a player.
export function describeGateAt(coord: number): string | null {
    try {
        if (areas === null) {
            areas = loadAreas();
        }
        if (areas.length === 0) {
            return null;
        }

        const pos = CoordGrid.unpackCoord(coord);
        const area = findArea(areas, pos.level, pos.x, pos.z);
        return area ? area.name : null;
    } catch (err) {
        printWarning(`AP area gates: describeGateAt failed (${err instanceof Error ? err.message : err})`);
        return null;
    }
}

/**
 * The exact denial message a player would get for arriving at `coord` - i.e. the
 * curated text with the rendered requirement spliced in. Null when no gate covers
 * the coord. Companion to describeGateAt for tooling and for verifying the wording
 * without a live server (tools/logic/ExplainGates.ts).
 */
export function gateMessageAt(coord: number): string | null {
    try {
        if (areas === null) {
            areas = loadAreas();
        }
        const pos = CoordGrid.unpackCoord(coord);
        const area = findArea(areas, pos.level, pos.x, pos.z);
        return area ? area.message : null;
    } catch (err) {
        printWarning(`AP area gates: gateMessageAt failed (${err instanceof Error ? err.message : err})`);
        return null;
    }
}

/** Every gated area's name + the message it would show, in load order. Tooling only. */
export function allGateMessages(): { name: string; message: string }[] {
    if (areas === null) {
        areas = loadAreas();
    }
    return areas.map(a => ({ name: a.name, message: a.message }));
}
