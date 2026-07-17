// Archipelago "NPC Teleport" addon (problems.txt 2026-07-17): the registry of
// NPCs the player has spoken to WHILE CARRYING the ap_npc_teleport writ, plus
// the fuzzy lookup behind the ::apnpctp command (ap_addons.rs2).
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

let known: Map<number, KnownNpc> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let writObjId: number | -2 | null = null; // -2 = lookup failed, treat as "never held"

function load(): Map<number, KnownNpc> {
    const map = new Map<number, KnownNpc>();

    if (!fs.existsSync(STORE_PATH)) {
        return map;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as { npcs?: Record<string, unknown> };
        for (const [typeId, raw] of Object.entries(parsed.npcs ?? {})) {
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
        const npcs: Record<string, KnownNpc> = {};
        for (const [id, entry] of known) {
            npcs[String(id)] = entry;
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
        if (known.has(npc.type)) {
            return;
        }

        if (!holdingWrit(player)) {
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

// Fuzzy match: exact name beats prefix beats substring; ties alphabetical.
// Query arrives lowercased (the cheat handler lowercases the whole line).
function matches(query: string): KnownNpc[] {
    if (known === null) {
        known = load();
    }

    const q = query.toLowerCase();
    const scored: { score: number; entry: KnownNpc }[] = [];
    for (const entry of known.values()) {
        const name = entry.name.toLowerCase();
        if (name === q) {
            scored.push({ score: 0, entry });
        } else if (name.startsWith(q)) {
            scored.push({ score: 1, entry });
        } else if (name.includes(q)) {
            scored.push({ score: 2, entry });
        }
    }
    scored.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name));
    return scored.map(s => s.entry);
}

/** Ranked match #index's display name, or '' past the end. */
export function matchName(query: string, index: number): string {
    try {
        const m = matches(query);
        return index >= 0 && index < m.length ? m[index].name : '';
    } catch {
        return '';
    }
}

/** Ranked match #index's packed home coord, or -1 (script null) past the end. */
export function matchCoord(query: string, index: number): number {
    try {
        const m = matches(query);
        if (index < 0 || index >= m.length) {
            return -1;
        }
        const entry = m[index];
        return CoordGrid.packCoord(entry.level, entry.x, entry.z);
    } catch {
        return -1;
    }
}
