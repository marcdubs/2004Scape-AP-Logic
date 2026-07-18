// Archipelago "NPC Teleport" addon (problems.txt 2026-07-17, reworked
// 2026-07-18): the registry of NPCs the player has spoken to WHILE CARRYING
// the ap_npc_teleport writ, exposed to rs2 as a RECENCY-ORDERED list (index 0
// = most recently talked to) behind the writ's Teleport/Last ops
// (ap_addons.rs2). The old ::apnpctp fuzzy-search command is gone - the cheat
// parser can't carry multi-word names and the UX was disliked.
//
// Hooked from Player.tryInteract (both the op and ap execution branches) when
// targetOp is APNPC1 (Talk-to) and the target is an Npc - the single generic
// chokepoint for talk interactions; per-NPC rs2 edits are not viable since
// nearly every talkable NPC has its own dedicated opnpc1 script.
//
// Location semantics: the npc's startX/startZ/startLevel spawn-home is
// recorded, not its live wander position - stable across restarts because map
// spawns are deterministic. Accessibility filter is record-time by
// construction (the player was standing there talking), which is exactly the
// user's stated rule ("only allows access to NPCs the player has previously
// been able to access").
//
// Global (single-player server), persisted like ApChecks' fired set: debounced
// async write to data/config/ap-npc-teleport.json, survives restarts, NOT
// per-seed (reseeding doesn't erase who you've met - deliberate).

import fs from 'fs';
import path from 'path';

import InvType from '#/cache/config/InvType.js';
import NpcType from '#/cache/config/NpcType.js';
import ObjType from '#/cache/config/ObjType.js';
import { getApOption } from '#/engine/ApOptions.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import type Npc from '#/engine/entity/Npc.js';
import type Player from '#/engine/entity/Player.js';
import { printWarning } from '#/util/Logger.js';

const STORE_PATH = 'data/config/ap-npc-teleport.json';
const PERSIST_DEBOUNCE_MS = 2000;
const WRIT_OBJ_NAME = 'ap_npc_teleport';

interface KnownNpc {
    name: string;
    x: number;
    z: number;
    level: number;
}

// Map insertion order IS the recency order (oldest first, most recent last);
// re-talking to a known NPC re-inserts it at the end. Persisted as an ordered
// array for the same reason - a JSON object would iterate integer-like keys
// numerically and lose the order.

let known: Map<number, KnownNpc> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let writObjId: number | -2 | null = null; // -2 = lookup failed, treat as "never held"

function load(): Map<number, KnownNpc> {
    const map = new Map<number, KnownNpc>();

    if (!fs.existsSync(STORE_PATH)) {
        return map;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as { npcs?: unknown };
        // current format: ordered array of {id, name, x, z, level} (oldest
        // first); also accepts the short-lived 2026-07-17 object format
        // (order lost - acceptable, recency rebuilds as the player talks).
        const entries: [unknown, unknown][] = Array.isArray(parsed.npcs)
            ? parsed.npcs.map((n): [unknown, unknown] => [(n as Record<string, unknown>)?.id, n])
            : Object.entries((parsed.npcs as Record<string, unknown>) ?? {});
        for (const [typeId, raw] of entries) {
            const id = Number(typeId);
            if (!Number.isInteger(id) || !raw || typeof raw !== 'object') {
                continue;
            }
            const n = raw as Record<string, unknown>;
            if (typeof n.name === 'string' && typeof n.x === 'number' && typeof n.z === 'number' && typeof n.level === 'number') {
                map.set(id, { name: n.name, x: n.x, z: n.z, level: n.level });
            }
        }
    } catch (err) {
        printWarning(`AP npc-teleport: failed to parse ${STORE_PATH}, starting empty (${err instanceof Error ? err.message : err})`);
    }

    return map;
}

function schedulePersist(): void {
    if (persistTimer !== null) {
        return;
    }
    persistTimer = setTimeout(() => {
        persistTimer = null;
        void persist();
    }, PERSIST_DEBOUNCE_MS);
    if (typeof persistTimer.unref === 'function') {
        persistTimer.unref();
    }
}

async function persist(): Promise<void> {
    if (known === null) {
        return;
    }
    try {
        const npcs: (KnownNpc & { id: number })[] = [];
        for (const [id, entry] of known) {
            npcs.push({ id, ...entry });
        }
        await fs.promises.mkdir(path.dirname(STORE_PATH), { recursive: true });
        await fs.promises.writeFile(STORE_PATH, JSON.stringify({ npcs }, null, 4), 'utf8');
    } catch (err) {
        printWarning(`AP npc-teleport: failed to persist ${STORE_PATH} (${err instanceof Error ? err.message : err})`);
    }
}

function holdingWrit(player: Player): boolean {
    if (writObjId === null) {
        const id = ObjType.getId(WRIT_OBJ_NAME);
        writObjId = id === -1 ? -2 : id;
        if (writObjId === -2) {
            printWarning(`AP npc-teleport: obj "${WRIT_OBJ_NAME}" not found in pack - talked-to recording disabled`);
        }
    }
    if (writObjId === -2) {
        return false;
    }
    const inv = player.getInventory(InvType.INV);
    return inv !== null && inv.getItemCount(writObjId) > 0;
}

/**
 * Called from Player.tryInteract when a Talk-to (apnpc1/opnpc1) script is
 * about to execute against `npc`. Hot-path adjacent: O(1) on the common miss
 * (option off, writ not held, or npc already recorded). Never throws.
 */
export function onNpcTalk(player: Player, npc: Npc): void {
    try {
        if (!getApOption('addonNpcTeleport')) {
            return;
        }

        if (known === null) {
            known = load();
        }

        if (!holdingWrit(player)) {
            return;
        }

        const existing = known.get(npc.type);
        if (existing) {
            // re-talk: bump to most-recent (Map insertion order = recency)
            known.delete(npc.type);
            known.set(npc.type, existing);
            schedulePersist();
            return;
        }

        const type = NpcType.get(npc.type);
        if (!type || !type.name) {
            return;
        }

        known.set(npc.type, { name: type.name, x: npc.startX, z: npc.startZ, level: npc.startLevel });
        schedulePersist();
    } catch (err) {
        printWarning(`AP npc-teleport: onNpcTalk failed (${err instanceof Error ? err.message : err})`);
    }
}

// Recency-ordered view: index 0 = most recently talked to. The Map stores
// oldest-first, so reverse on read; registry sizes are tiny (talked-to NPC
// types), no need to cache the reversed array.
function byRecency(): KnownNpc[] {
    if (known === null) {
        known = load();
    }
    return [...known.values()].reverse();
}

/** Recency entry #index's display name, or '' past the end. */
export function nameAt(index: number): string {
    try {
        const m = byRecency();
        return index >= 0 && index < m.length ? m[index].name : '';
    } catch {
        return '';
    }
}

/** Recency entry #index's packed home coord, or -1 (script null) past the end. */
export function coordAt(index: number): number {
    try {
        const m = byRecency();
        if (index < 0 || index >= m.length) {
            return -1;
        }
        const entry = m[index];
        return CoordGrid.packCoord(entry.level, entry.x, entry.z);
    } catch {
        return -1;
    }
}
