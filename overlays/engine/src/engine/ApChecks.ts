// Archipelago check emitters (2004Scape-AP-Logic docs/checks-and-unlocks.md).
// Seams called from Player.setVar / Player.addXp - populated by the checks-system
// workstream (varp watch table for quest stages + barcrawl bits, first-XP checks,
// level milestone checks).
//
// Both hooks run in extremely hot paths: onVarpSet fires for every varp write
// including per-tick engine internals (the RUN toggle), onXpGain for every xp
// drop of every player - stay O(1) on the miss path and never throw.

import fs from 'fs';
import path from 'path';

import VarPlayerType from '#/cache/config/VarPlayerType.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerQueueType } from '#/engine/entity/PlayerQueueRequest.js';
import { PlayerStat, PlayerStatEnabled, PlayerStatNameMap } from '#/engine/entity/PlayerStat.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import { printInfo, printWarning } from '#/util/Logger.js';

// ---------------------------------------------------------------------------
// Varp watch table (data/config/ap-checks.json). Static per game version -
// ships with the overlay, doesn't get regenerated per seed (unlike
// ap-entrances.json / ap-drops.json).
// ---------------------------------------------------------------------------

const WATCHES_PATH = 'data/config/ap-checks.json';
const FIRED_PATH = 'data/config/ap-checks-fired.json';
const PERSIST_DEBOUNCE_MS = 2000;

type WatchMode = 'gte' | 'bit';

interface Watch {
    mode: WatchMode;
    value: number;
    check: string;
}

interface RawWatch {
    varp: string;
    mode: WatchMode;
    value: number;
    check: string;
}

let watchesByVarp: Map<number, Watch[]> | null = null;

function isRawWatch(raw: unknown): raw is RawWatch {
    if (!raw || typeof raw !== 'object') {
        return false;
    }
    const w = raw as Record<string, unknown>;
    return typeof w.varp === 'string' && (w.mode === 'gte' || w.mode === 'bit') && typeof w.value === 'number' && typeof w.check === 'string';
}

function loadWatches(): Map<number, Watch[]> {
    const table = new Map<number, Watch[]>();

    if (!fs.existsSync(WATCHES_PATH)) {
        printInfo(`AP checks: no ${path.basename(WATCHES_PATH)}, no varp-watch checks active`);
        return table;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(WATCHES_PATH, 'utf8')) as { watches?: unknown[] };
        let loaded = 0;

        for (const raw of parsed.watches ?? []) {
            if (!isRawWatch(raw)) {
                printWarning(`AP checks: skipping malformed watch entry ${JSON.stringify(raw)}`);
                continue;
            }

            const varpId = VarPlayerType.getId(raw.varp);
            if (varpId === -1) {
                printWarning(`AP checks: skipping watch for unknown varp "${raw.varp}"`);
                continue;
            }

            const list = table.get(varpId) ?? [];
            list.push({ mode: raw.mode, value: raw.value, check: raw.check });
            table.set(varpId, list);
            loaded++;
        }

        printInfo(`AP checks: loaded ${loaded} varp watch(es)`);
    } catch (err) {
        printWarning(`AP checks: failed to parse ${WATCHES_PATH}, no varp-watch checks active (${err instanceof Error ? err.message : err})`);
    }

    return table;
}

// ---------------------------------------------------------------------------
// Fired-check dedupe + persistence. Global (single-player server), once-ever
// per check id, survives restarts. Debounced async write so a burst of checks
// firing on the same tick (e.g. several barcrawl bars during testing) coalesces
// into one disk write.
// ---------------------------------------------------------------------------

let fired: Set<string> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function loadFired(): Set<string> {
    const set = new Set<string>();

    if (!fs.existsSync(FIRED_PATH)) {
        return set;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(FIRED_PATH, 'utf8')) as { fired?: unknown[] };
        for (const id of parsed.fired ?? []) {
            if (typeof id === 'string') {
                set.add(id);
            }
        }
        printInfo(`AP checks: loaded ${set.size} previously-fired check(s)`);
    } catch (err) {
        printWarning(`AP checks: failed to parse ${FIRED_PATH}, treating as no checks fired yet (${err instanceof Error ? err.message : err})`);
    }

    return set;
}

function schedulePersist(): void {
    if (persistTimer !== null) {
        return;
    }

    persistTimer = setTimeout(() => {
        persistTimer = null;
        void persistFired();
    }, PERSIST_DEBOUNCE_MS);

    // don't let this timer keep the process alive on shutdown
    if (typeof persistTimer.unref === 'function') {
        persistTimer.unref();
    }
}

async function persistFired(): Promise<void> {
    if (fired === null) {
        return;
    }

    try {
        await fs.promises.mkdir(path.dirname(FIRED_PATH), { recursive: true });
        await fs.promises.writeFile(FIRED_PATH, JSON.stringify({ fired: Array.from(fired) }), 'utf8');
    } catch (err) {
        printWarning(`AP checks: failed to persist ${FIRED_PATH} (${err instanceof Error ? err.message : err})`);
    }
}

// Enqueues the content payoff script ([queue,ap_check_fired] in
// ap_checks.rs2) on `player` with the check id as its single string arg, the
// same way Player.addXp enqueues the ADVANCESTAT trigger. Once-ever per check
// id (dedup Set), never throws.
function fireCheck(player: Player, checkId: string): void {
    try {
        if (fired === null) {
            fired = loadFired();
        }

        if (fired.has(checkId)) {
            return;
        }

        fired.add(checkId);
        schedulePersist();

        const script = ScriptProvider.getByName('[queue,ap_check_fired]');
        if (!script) {
            // content not built/deployed yet - state is still recorded above so
            // nothing is lost once the script exists on a later boot.
            return;
        }

        player.enqueueScript(script, PlayerQueueType.ENGINE, 0, [checkId]);
    } catch (err) {
        printWarning(`AP checks: fireCheck(${checkId}) failed (${err instanceof Error ? err.message : err})`);
    }
}

// ---------------------------------------------------------------------------
// Public hooks (frozen signatures - called from Player.ts)
// ---------------------------------------------------------------------------

export function onVarpSet(player: Player, id: number, value: number): void {
    try {
        if (watchesByVarp === null) {
            watchesByVarp = loadWatches();
        }

        const watches = watchesByVarp.get(id);
        if (!watches) {
            return;
        }

        for (let i = 0; i < watches.length; i++) {
            const watch = watches[i];
            const tripped = watch.mode === 'gte' ? value >= watch.value : ((value >>> watch.value) & 1) === 1;
            if (tripped) {
                fireCheck(player, watch.check);
            }
        }
    } catch (err) {
        printWarning(`AP checks: onVarpSet(${id}) failed (${err instanceof Error ? err.message : err})`);
    }
}

// Every real stat except hitpoints (which starts at level 10 / nonzero xp, so
// firstXp never fires for it - first-kill/combat-xp checks cover melee/ranged/
// magic instead) and the two disabled placeholder slots (STAT18/STAT19).
export function onXpGain(player: Player, stat: number, beforeBaseLevel: number, afterBaseLevel: number, firstXp: boolean): void {
    try {
        if (stat === PlayerStat.HITPOINTS || !PlayerStatEnabled[stat]) {
            return;
        }

        const name = PlayerStatNameMap.get(stat)?.toLowerCase();
        if (!name) {
            return;
        }

        if (firstXp) {
            fireCheck(player, `first_xp_${name}`);
        }

        for (let n = 10; n <= 90; n += 10) {
            if (beforeBaseLevel < n && afterBaseLevel >= n) {
                fireCheck(player, `level_${name}_${n}`);
            }
        }
    } catch (err) {
        printWarning(`AP checks: onXpGain(${stat}) failed (${err instanceof Error ? err.message : err})`);
    }
}
