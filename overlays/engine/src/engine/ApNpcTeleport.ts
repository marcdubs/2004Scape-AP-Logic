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
// Location semantics (problems.txt 2026-07-19): the PLAYER's own tile at
// talk time is recorded, never the npc's position - the npc's spawn-home is
// frequently inside its own furniture (bankers stand behind the impassable
// bank counter), so teleporting to it strands the player. The player's talk
// tile is walkable by construction (they were standing on it), which also
// makes the accessibility filter record-time by construction ("only allows
// access to NPCs the player has previously been able to access").
//
// The registry is keyed by NPC display name, not type id: talking to another
// NPC with the same name (the world has many "Banker"s) overrides the earlier
// entry instead of piling up duplicate identical menu rows - latest wins.
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
// every talk re-inserts the name at the end. Persisted as an ordered array for
// the same reason - a JSON object would iterate integer-like keys numerically
// and lose the order.

let known: Map<string, KnownNpc> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let writObjId: number | -2 | null = null; // -2 = lookup failed, treat as "never held"

function load(): Map<string, KnownNpc> {
    const map = new Map<string, KnownNpc>();

    if (!fs.existsSync(STORE_PATH)) {
        return map;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as { npcs?: unknown };
        // current format: ordered array of {name, x, z, level} (oldest first);
        // also accepts the older array-with-id and 2026-07-17 object formats
        // (their coords were the npc's spawn-home, possibly unwalkable - kept
        // anyway, self-heals to the player's tile on the next talk). Same-name
        // duplicates from the old id-keyed format collapse to the latest.
        const entries: unknown[] = Array.isArray(parsed.npcs) ? parsed.npcs : Object.values((parsed.npcs as Record<string, unknown>) ?? {});
        for (const raw of entries) {
            if (!raw || typeof raw !== 'object') {
                continue;
            }
            const n = raw as Record<string, unknown>;
            if (typeof n.name === 'string' && typeof n.x === 'number' && typeof n.z === 'number' && typeof n.level === 'number') {
                map.delete(n.name);
                map.set(n.name, { name: n.name, x: n.x, z: n.z, level: n.level });
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
        const npcs: KnownNpc[] = [...known.values()];
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

        const type = NpcType.get(npc.type);
        if (!type || !type.name) {
            return;
        }

        // latest talk wins: delete+set bumps the name to most-recent (Map
        // insertion order = recency) AND overrides any same-name NPC recorded
        // elsewhere; the PLAYER's tile is stored, never the npc's (see header).
        known.delete(type.name);
        known.set(type.name, { name: type.name, x: player.x, z: player.z, level: player.level });
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
