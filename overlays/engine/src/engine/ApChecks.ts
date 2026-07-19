// Archipelago check emitters (2004Scape-AP-Logic docs/checks-and-unlocks.md,
// docs/placement-mode.md). Seams called from Player.setVar / Player.addXp -
// populated by the checks-system workstream (varp watch table for quest
// completions + barcrawl bits, first-XP checks, level milestone checks) and,
// as of placement mode, ALSO consults data/config/ap-placements.json so a
// fired check can deliver its placed progression item instead of a random
// reward.
//
// Both hooks run in extremely hot paths: onVarpSet fires for every varp write
// including per-tick engine internals (the RUN toggle), onXpGain for every xp
// drop of every player - stay O(1) on the miss path and never throw.

import fs from 'fs';
import path from 'path';

import VarBitType from '#/cache/config/VarBitType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import * as ApClient from '#/engine/ApClient.js';
import { getApOption } from '#/engine/ApOptions.js';
import * as ApUnlockOverrides from '#/engine/ApUnlockOverrides.js';
import { recordDiscovery } from '#/engine/ApTracker.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerQueueType } from '#/engine/entity/PlayerQueueRequest.js';
import { PlayerStat, PlayerStatEnabled, PlayerStatNameMap } from '#/engine/entity/PlayerStat.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import { printInfo, printWarning } from '#/util/Logger.js';

// ---------------------------------------------------------------------------
// Varp watch table (data/config/ap-checks.json). Static per game version -
// ships with the overlay, doesn't get regenerated per seed (unlike
// ap-entrances.json / ap-drops.json / ap-placements.json).
//
// Two watch shapes: a plain varp entry ("varp": "<name>") compares the raw
// value Player.setVar receives directly, same as day one. A varbit entry
// ("varbit": "<name>") exists for quest_horror (Horror from the Deep), the
// only quest whose OWN completion state is a varbit rather than a plain varp:
// %horrorquest is declared [horrorquest] basevar=deephorror startbit=0
// endbit=10 - packed into the SAME base varp as unrelated
// horrordoor/horrorbridge/etc side-flag bits (11-24). Player.setVarBit
// ultimately calls setVar(basevar, fullPackedInt) (verified in
// CoreOps.ts/Player.ts), so onVarpSet only ever sees the base varp id and the
// FULL packed integer - watching that raw value directly would false-trip the
// moment ANY sibling bit (e.g. horrordoor) is set, regardless of horrorquest's
// own progress. The startbit/endbit recorded on the Watch let onVarpSet
// extract just the sub-field before testing it.
// ---------------------------------------------------------------------------

const WATCHES_PATH = 'data/config/ap-checks.json';
const FIRED_PATH = 'data/config/ap-checks-fired.json';
const PLACEMENTS_PATH = 'data/config/ap-placements.json';
const PERSIST_DEBOUNCE_MS = 2000;

type WatchMode = 'gte' | 'bit';

interface Watch {
    mode: WatchMode;
    value: number;
    check: string;
    // present only for varbit-derived watches - extract bits [startbit,endbit]
    // (inclusive) out of the raw varp value before applying mode/value.
    startbit?: number;
    endbit?: number;
}

interface RawWatch {
    varp?: string;
    varbit?: string;
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
    const hasVarp = typeof w.varp === 'string' && w.varp.length > 0;
    const hasVarbit = typeof w.varbit === 'string' && w.varbit.length > 0;
    // exactly one of varp/varbit, never both, never neither
    if (hasVarp === hasVarbit) {
        return false;
    }
    return (w.mode === 'gte' || w.mode === 'bit') && typeof w.value === 'number' && typeof w.check === 'string';
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
        let unknown = 0;
        let optionedOut = 0;
        const musicChecks = getApOption('musicChecks');

        for (const raw of parsed.watches ?? []) {
            if (!isRawWatch(raw)) {
                printWarning(`AP checks: skipping malformed watch entry ${JSON.stringify(raw)}`);
                continue;
            }

            // Option gate (ap-options.json): music-track checks can be turned off
            // wholesale - the id prefix is the contract (every music watch is
            // "music_<track>", nothing else uses that prefix).
            if (!musicChecks && raw.check.startsWith('music_')) {
                optionedOut++;
                continue;
            }

            let varId = -1;
            let startbit: number | undefined;
            let endbit: number | undefined;

            if (raw.varp) {
                varId = VarPlayerType.getId(raw.varp);
                if (varId === -1) {
                    printWarning(`AP checks: skipping watch for unknown varp "${raw.varp}"`);
                    unknown++;
                    continue;
                }
            } else if (raw.varbit) {
                const varbitId = VarBitType.getId(raw.varbit);
                if (varbitId === -1) {
                    printWarning(`AP checks: skipping watch for unknown varbit "${raw.varbit}"`);
                    unknown++;
                    continue;
                }
                const varbit = VarBitType.get(varbitId);
                varId = varbit.basevar;
                startbit = varbit.startbit;
                endbit = varbit.endbit;
            }

            const list = table.get(varId) ?? [];
            list.push({ mode: raw.mode, value: raw.value, check: raw.check, startbit, endbit });
            table.set(varId, list);
            loaded++;
        }

        printInfo(`AP checks: loaded ${loaded} varp watch(es)${unknown > 0 ? ` (${unknown} unresolved)` : ''}${optionedOut > 0 ? ` (${optionedOut} disabled by ap-options.json)` : ''}`);
    } catch (err) {
        printWarning(`AP checks: failed to parse ${WATCHES_PATH}, no varp-watch checks active (${err instanceof Error ? err.message : err})`);
    }

    return table;
}

// ---------------------------------------------------------------------------
// Placement consult (data/config/ap-placements.json, docs/placement-mode.md).
// Loaded lazily, once, and cached for the process lifetime - the generator
// writes this file before a placement-mode server boot, it never changes
// mid-session (unlike ap-unlocks.json, which DOES change as checks fire).
// No file = every check is filler, i.e. exactly today's non-placement
// behavior. Malformed entries fail open to filler for that check id only.
// ---------------------------------------------------------------------------

interface PlacementEntry {
    item: string;
    count?: number;
    display?: string;
}

interface PlacementOutcome {
    isUnlock: boolean;
    display: string; // empty string for filler
}

let placements: Map<string, PlacementEntry> | null = null;

function isRawPlacementEntry(raw: unknown): raw is PlacementEntry {
    if (!raw || typeof raw !== 'object') {
        return false;
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.item !== 'string' || p.item.length === 0) {
        return false;
    }
    if (p.count !== undefined && (typeof p.count !== 'number' || !Number.isInteger(p.count) || p.count <= 0)) {
        return false;
    }
    if (p.display !== undefined && typeof p.display !== 'string') {
        return false;
    }
    return true;
}

function loadPlacements(): Map<string, PlacementEntry> {
    const table = new Map<string, PlacementEntry>();

    if (!fs.existsSync(PLACEMENTS_PATH)) {
        printInfo(`AP checks: no ${path.basename(PLACEMENTS_PATH)}, placement mode inactive (checks roll filler)`);
        return table;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(PLACEMENTS_PATH, 'utf8')) as { placements?: Record<string, unknown> };
        let loaded = 0;

        for (const [checkId, raw] of Object.entries(parsed.placements ?? {})) {
            if (!isRawPlacementEntry(raw)) {
                printWarning(`AP checks: skipping malformed placement entry for "${checkId}": ${JSON.stringify(raw)}`);
                continue;
            }
            table.set(checkId, raw);
            loaded++;
        }

        printInfo(`AP checks: loaded ${loaded} placement(s) - placement mode active`);
    } catch (err) {
        printWarning(`AP checks: failed to parse ${PLACEMENTS_PATH}, placement mode inactive (${err instanceof Error ? err.message : err})`);
    }

    return table;
}

// Resolves what a fired check should deliver. Unlock placements apply the
// unlock (via ApUnlockOverrides.grantUnlock) BEFORE returning, so by the time
// the content script's announce runs the unlock is already live. Filler (an
// explicit {item:"filler"}, a missing entry, or no placements file at all)
// returns an empty display and leaves the existing random-reward roll to the
// content script, unchanged.
//
// Bug fix (2026-07-16): the announcement text used to come straight from
// entry.display, a string GenerateSeed/PlacementEngine baked in at seed-generation
// time based on this copy's ASSUMED position in the fill order (e.g. "Progressive
// Melee (tier 5)"). That assumption only holds if copies are collected in the
// generator's own 1..N order - a real player can hit any copy of a progressive
// item first, so the baked label routinely overstated (or understated) the tier
// actually reached, even though the underlying grant was always a correct +1/+2
// step. Now the display is rebuilt from grantUnlock's real post-grant count via
// ApUnlockOverrides.describeUnlock, so the message always matches what
// ap_gear_locked/getSkillCap will actually enforce. entry.display survives only as
// a fallback if the grant itself failed (sentinel 0 - see grantUnlock).
function resolvePlacement(player: Player, checkId: string): PlacementOutcome {
    if (placements === null) {
        placements = loadPlacements();
    }

    const entry = placements.get(checkId);
    if (!entry || entry.item === 'filler') {
        return { isUnlock: false, display: '' };
    }

    const count = entry.count ?? 1;
    const newCount = ApUnlockOverrides.grantUnlock(entry.item, count);
    const display = newCount > 0 ? ApUnlockOverrides.describeUnlock(entry.item, newCount) : (entry.display ?? entry.item);

    // Struck-with-inspiration cap fix: this grant may have just raised the cap on
    // a stat that's been quietly banking overflow xp (ApUnlockOverrides.
    // clampStatXp) - drain it immediately rather than waiting for the player's
    // next xp gain or next login.
    if (newCount > 0) {
        ApUnlockOverrides.applyBankedXpForUnlock(player, entry.item);
    }

    return { isUnlock: true, display };
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
// ap_checks.rs2) on `player` with the check id, the placement display string
// (empty for filler), and an is-unlock flag - the same way Player.addXp
// enqueues the ADVANCESTAT trigger. Once-ever per check id (dedup Set), never
// throws. Consults placements AFTER dedupe so a check that has already fired
// this run/restart never re-grants its unlock or re-rolls filler.
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

        // Real-Archipelago mode (docs/archipelago-integration.md): the check is
        // reported to the AP server, which owns what item lives there - the local
        // placement table is never consulted and no local reward rolls. is_unlock=2
        // tells [queue,ap_check_fired] to announce "sent to Archipelago" only.
        // Items for US come back asynchronously via ApClient's ReceivedItems path.
        if (ApClient.isApModeActive()) {
            ApClient.onCheckFired(checkId);
            recordDiscovery('checks', checkId, 'sent to Archipelago');
            if (script) {
                player.enqueueScript(script, PlayerQueueType.ENGINE, 0, [checkId, '', 2]);
            }
            return;
        }

        const outcome = resolvePlacement(player, checkId);
        recordDiscovery('checks', checkId, outcome.isUnlock ? outcome.display : 'filler');

        if (!script) {
            // content not built/deployed yet - state is still recorded above so
            // nothing is lost once the script exists on a later boot.
            return;
        }

        player.enqueueScript(script, PlayerQueueType.ENGINE, 0, [checkId, outcome.display, outcome.isUnlock ? 1 : 0]);
    } catch (err) {
        printWarning(`AP checks: fireCheck(${checkId}) failed (${err instanceof Error ? err.message : err})`);
    }
}

// Drops the lazily-built watch table so the next onVarpSet rebuilds it with the
// CURRENT ap-options.json state. Called (via dynamic import - ApChecks imports
// ApClient, so a static back-edge would be a cycle) by ApClient after slot_data
// changes an option like musicChecks: the AP YAML is authoritative for option
// state in AP mode, and the watch set must follow without a restart.
export function resetWatchCache(): void {
    watchesByVarp = null;
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

            let effective = value;
            if (watch.startbit !== undefined && watch.endbit !== undefined) {
                const width = watch.endbit - watch.startbit + 1;
                const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
                effective = (value >>> watch.startbit) & mask;
            }

            const tripped = watch.mode === 'gte' ? effective >= watch.value : ((effective >>> watch.value) & 1) === 1;
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
