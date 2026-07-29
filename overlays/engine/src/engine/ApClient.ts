// Archipelago network client (docs/archipelago-integration.md). Connects the
// running game server to a real archipelago.gg multiworld over the AP WebSocket
// JSON protocol: reports fired checks as LocationChecks, applies ReceivedItems
// through ApUnlockOverrides.grantUnlock, announces items/rewards in-game via
// [queue,ap_remote_item], and sends StatusUpdate(30) when the slot's goal
// condition is met.
//
// Inert unless data/config/ap-archipelago.json exists with {"enabled": true} -
// the same fail-open convention as every other Ap* module. The game stays fully
// playable while disconnected: checks keep landing in ApChecks' fired ledger
// and this module's own sent-set, and every (re)connect resyncs by sending the
// full known set (LocationChecks is idempotent server-side - the documented
// resync path).
//
// IMPORT RULES (hard-won, see lessons-learned "circular import TDZ"):
// - `import type Player` ONLY - never a runtime Player/NetworkPlayer import.
// - NO static World import: this module is reached from Player.ts via ApChecks,
//   so a static ApClient -> World edge would close a cycle through Player's own
//   module init. World is dynamically imported inside the delivery timer, which
//   first runs long after every module graph is settled.
// - Ap* modules that do NOT import ApClient back (ApOptions, ApTracker,
//   ApQuestGates, ApUnlockOverrides) are safe to import statically, and should be:
//   the clearLocalRun wipe needs their cache resets to complete synchronously,
//   before sendFullResync runs. ApChecks is the one exception - it imports
//   ApClient, so it stays a dynamic import.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import WebSocket from 'ws';

import { setApOption, setApOptionInt } from '#/engine/ApOptions.js';
import * as ApQuestGates from '#/engine/ApQuestGates.js';
import * as ApTracker from '#/engine/ApTracker.js';
import * as ApUnlockOverrides from '#/engine/ApUnlockOverrides.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerQueueType } from '#/engine/entity/PlayerQueueRequest.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import { printError, printInfo, printWarning } from '#/util/Logger.js';

const CONFIG_PATH = 'data/config/ap-archipelago.json';
const DATA_PATH = 'data/config/ap-archipelago-data.json';
const SESSION_PATH = 'data/config/ap-session.json';
const FIRED_PATH = 'data/config/ap-checks-fired.json'; // ApChecks' ledger, read (never written) for resync
const PLACEMENTS_PATH = 'data/config/ap-placements.json';
const UNLOCKS_PATH = 'data/config/ap-unlocks.json'; // zeroed (never deleted) by the clearLocalRun wipe

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const PERSIST_DEBOUNCE_MS = 1000;
const DELIVER_INTERVAL_MS = 600;

// Client-supported AP protocol version, sent in Connect. Bump alongside real
// protocol testing, not speculatively.
const AP_VERSION = { major: 0, minor: 6, build: 0, class: 'Version' };

interface ApConfig {
    enabled: boolean;
    host: string;
    port: number;
    slot: string;
    password: string | null;
    /**
     * One-shot: "the local (solo) run on disk is finished - wipe it on the next
     * connect instead of refusing". Set from the tracker's Archipelago tab, consumed
     * and written back to false the moment it fires, so a mid-run reconnect (or the
     * automatic reconnect loop) can never wipe an AP run's progress.
     */
    clearLocalRun: boolean;
}

interface ExportedItem {
    id: number;
    grant?: string;
    count?: number;
    copies: number;
    filler?: boolean;
    /** Filler items only: which reward category the game server should roll
     *  (ap_rewards.rs2 ~ap_grant_named_pack). Absent = "Mystery Reward", the
     *  roll-anything filler. */
    pack?: string;
}

interface ApDataFile {
    game: string;
    locations: Record<string, { id: number; name: string }>;
    items: Record<string, ExportedItem>;
    goalChecks: Record<string, string[]>;
    /** Difficulty-ordered gated quest ids - the Nth "Progressive Quest Unlock" copy unlocks entry N-1. */
    questUnlockOrder?: string[];
}

interface PendingDelivery {
    display: string;
    filler: boolean;
    grant?: string;
    /** Filler deliveries only - see ExportedItem.pack. Undefined on entries
     *  persisted by a pre-pack build, which rs2 reads as the roll-anything case. */
    pack?: string;
}

interface SessionState {
    receivedCount: number;
    sentChecks: string[];
    goalSent: boolean;
    pending: PendingDelivery[];
}

let config: ApConfig | null = null;
let data: ApDataFile | null = null;
let checkToLocationId: Map<string, number> | null = null;
let itemsById: Map<number, { name: string; def: ExportedItem }> | null = null;

let session: SessionState = { receivedCount: 0, sentChecks: [], goalSent: false, pending: [] };
let sentChecks = new Set<string>();

let ws: WebSocket | null = null;
let connected = false; // Connected packet received
// Check ids this slot actually HAS in the multiworld, from the Connected packet's
// missing_locations + checked_locations (together, every location the generator
// created for us). The apworld drops locations its region model can't justify this
// seed (RS2004World.create_regions' feasibility exclusion) and all 230 music
// locations when music_checks is off - so a catalog id missing from this set can
// never be checked in this run. Null until the first Connected (unknown, not empty).
let slotCheckIds: Set<string> | null = null;
let goals: string[] = ['dragon']; // victory requires EVERY listed goal's checks
let lastError: string | null = null; // most recent connection problem, for the tracker's setup page
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let deliverTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// config / data / session loading
// ---------------------------------------------------------------------------

function loadConfig(): ApConfig | null {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            return null;
        }
        const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
        if (parsed.enabled !== true) {
            return null;
        }
        return {
            enabled: true,
            host: typeof parsed.host === 'string' && parsed.host.length > 0 ? parsed.host : 'localhost',
            port: typeof parsed.port === 'number' && Number.isInteger(parsed.port) ? parsed.port : 38281,
            slot: typeof parsed.slot === 'string' && parsed.slot.length > 0 ? parsed.slot : 'Player',
            password: typeof parsed.password === 'string' ? parsed.password : null,
            clearLocalRun: parsed.clearLocalRun === true
        };
    } catch (err) {
        printWarning(`AP client: failed to parse ${CONFIG_PATH}, staying offline (${err instanceof Error ? err.message : err})`);
        return null;
    }
}

function loadData(): ApDataFile | null {
    try {
        if (!fs.existsSync(DATA_PATH)) {
            printWarning(`AP client: ${DATA_PATH} missing - run tools/ap/ExportApWorldData.ts (staying offline)`);
            return null;
        }
        const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) as ApDataFile;
        if (!parsed.locations || !parsed.items) {
            printWarning(`AP client: ${DATA_PATH} malformed (staying offline)`);
            return null;
        }
        return parsed;
    } catch (err) {
        printWarning(`AP client: failed to parse ${DATA_PATH}, staying offline (${err instanceof Error ? err.message : err})`);
        return null;
    }
}

function loadSession(): SessionState {
    try {
        if (!fs.existsSync(SESSION_PATH)) {
            return { receivedCount: 0, sentChecks: [], goalSent: false, pending: [] };
        }
        const parsed = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8')) as Partial<SessionState>;
        return {
            receivedCount: typeof parsed.receivedCount === 'number' ? parsed.receivedCount : 0,
            sentChecks: Array.isArray(parsed.sentChecks) ? parsed.sentChecks.filter((s): s is string => typeof s === 'string') : [],
            goalSent: parsed.goalSent === true,
            pending: Array.isArray(parsed.pending) ? (parsed.pending as PendingDelivery[]) : []
        };
    } catch {
        return { receivedCount: 0, sentChecks: [], goalSent: false, pending: [] };
    }
}

function schedulePersist(): void {
    if (persistTimer !== null) {
        return;
    }
    persistTimer = setTimeout(() => {
        persistTimer = null;
        try {
            session.sentChecks = Array.from(sentChecks);
            fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
            const tmp = `${SESSION_PATH}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
            fs.renameSync(tmp, SESSION_PATH);
        } catch (err) {
            printWarning(`AP client: failed to persist ${SESSION_PATH} (${err instanceof Error ? err.message : err})`);
        }
    }, PERSIST_DEBOUNCE_MS);
    if (typeof persistTimer.unref === 'function') {
        persistTimer.unref();
    }
}

// ApChecks' persisted fired ledger - unioned with our own sent-set for resync
// (ApChecks debounces its write, so the freshest ids live in sentChecks; the
// file covers everything fired before this module existed).
function loadFiredLedger(): string[] {
    try {
        if (!fs.existsSync(FIRED_PATH)) {
            return [];
        }
        const parsed = JSON.parse(fs.readFileSync(FIRED_PATH, 'utf8')) as { fired?: unknown[] };
        return (parsed.fired ?? []).filter((id): id is string => typeof id === 'string');
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// protocol plumbing
// ---------------------------------------------------------------------------

function send(packets: Record<string, unknown>[]): void {
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
        return;
    }
    try {
        ws.send(JSON.stringify(packets));
    } catch (err) {
        printWarning(`AP client: send failed (${err instanceof Error ? err.message : err})`);
    }
}

function locationIdsFor(checkIds: Iterable<string>): number[] {
    const ids: number[] = [];
    for (const checkId of checkIds) {
        const locId = checkToLocationId?.get(checkId);
        if (locId !== undefined) {
            ids.push(locId);
        }
        // unknown ids are fine: goal-only checks (kbd_slain) and checks newer
        // than the apworld build have no AP location - they still count toward
        // goals below.
    }
    return ids;
}

// Inverse of locationIdsFor for the two location-id arrays the Connected packet
// carries: builds the set of check ids this slot actually holds (see slotCheckIds).
// Ids belonging to OTHER games in the room never map back through
// checkToLocationId, so a shared-id collision can't widen our set.
function rememberSlotLocations(missing: unknown, checked: unknown): void {
    if (!Array.isArray(missing) && !Array.isArray(checked)) {
        return; // pre-0.6 server or a trimmed Connected - leave "unknown" rather than claiming everything is excluded
    }
    const byLocationId = new Map<number, string>();
    for (const [checkId, locId] of checkToLocationId ?? []) {
        byLocationId.set(locId, checkId);
    }
    const ids = new Set<string>();
    for (const raw of [...(Array.isArray(missing) ? missing : []), ...(Array.isArray(checked) ? checked : [])]) {
        const checkId = typeof raw === 'number' ? byLocationId.get(raw) : undefined;
        if (checkId !== undefined) {
            ids.add(checkId);
        }
    }
    slotCheckIds = ids;
    printInfo(`AP client: slot holds ${ids.size} of ${byLocationId.size} known check location(s)`);
}

function sendFullResync(): void {
    for (const id of loadFiredLedger()) {
        sentChecks.add(id);
    }
    const ids = locationIdsFor(sentChecks);
    if (ids.length > 0) {
        send([{ cmd: 'LocationChecks', locations: ids }]);
    }
    printInfo(`AP client: resynced ${ids.length} location check(s)`);
    schedulePersist();
    checkGoal();
}

function checkGoal(): void {
    if (session.goalSent || !connected) {
        return;
    }
    const requiredSets = goals.map(g => data?.goalChecks?.[g]);
    if (requiredSets.length === 0 || requiredSets.some(set => !set || set.length === 0)) {
        return;
    }
    if (requiredSets.every(set => set!.every(id => sentChecks.has(id)))) {
        send([{ cmd: 'StatusUpdate', status: 30 }]);
        session.goalSent = true;
        schedulePersist();
        printInfo(`AP client: GOAL COMPLETE (${goals.join(' + ')}) - sent StatusUpdate`);
        queueDelivery({ display: 'Goal complete! Victory reported to Archipelago.', filler: false });
    }
}

// ---------------------------------------------------------------------------
// one-shot local-run wipe (tracker checkbox -> ap-archipelago.json clearLocalRun)
// ---------------------------------------------------------------------------

/**
 * Clears everything a SOLO run left on disk so this connect can own the slot:
 * the local fill, the progress it produced, and our own session bookkeeping.
 * Mirrors tools/ap/GenerateSeed.ts's clearRunState (a placement seed IS a new
 * run) with one difference - ap-unlocks.json is ZEROED rather than deleted,
 * because grantUnlock refuses to work without a table on disk and would drop
 * every item the room sends us.
 *
 * Runs from applySlotData, i.e. after Connected and before sendFullResync, so
 * the wiped session is what the resync and the room's item replay see.
 */
function clearLocalRunState(): string[] {
    const cleared: string[] = [];

    if (fs.existsSync(PLACEMENTS_PATH)) {
        fs.rmSync(PLACEMENTS_PATH);
        cleared.push('ap-placements.json (local fill)');
    }
    if (fs.existsSync(SESSION_PATH)) {
        fs.rmSync(SESSION_PATH);
        cleared.push('ap-session.json');
    }

    // zero, don't delete - see the doc comment above
    if (fs.existsSync(UNLOCKS_PATH)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(UNLOCKS_PATH, 'utf8')) as { unlocks?: Record<string, unknown> };
            const zeroed: Record<string, number> = {};
            for (const key of Object.keys(parsed.unlocks ?? {})) {
                zeroed[key] = 0;
            }
            if (Object.keys(zeroed).length > 0) {
                fs.writeFileSync(UNLOCKS_PATH, JSON.stringify({ unlocks: zeroed }, null, 4) + '\n', 'utf8');
                cleared.push(`ap-unlocks.json (${Object.keys(zeroed).length} unlock(s) zeroed)`);
            }
        } catch (err) {
            printWarning(`AP client: could not zero ap-unlocks.json (${err instanceof Error ? err.message : err}) - clear it by hand`);
        }
    }

    // Zeroing the FILE is not enough: ApUnlockOverrides serves reads from a cached
    // table it only revalidates every RELOAD_THROTTLE_MS, and grantUnlock writes that
    // whole cached table back out. The room's ReceivedItems replay lands well inside
    // that window, so without this the first item of the new run re-persists the
    // finished run's counts and the wipe silently undoes itself.
    ApUnlockOverrides.invalidateUnlockCache();

    // The fired ledger has to be gone from DISK before this function returns, not
    // "soon after": our caller (applySlotData) is followed synchronously by
    // sendFullResync, whose loadFiredLedger() re-reads this exact file. Deferring the
    // delete to a promise - as this did until 2026-07-27 - meant the resync still saw
    // the finished run's ledger and reported every one of its checks into the brand
    // new room the moment we connected, which is the opposite of a wipe.
    if (fs.existsSync(FIRED_PATH)) {
        fs.rmSync(FIRED_PATH);
        cleared.push('ap-checks-fired.json');
    }

    // ApTracker is a leaf module (fs/path/Logger only), so importing it statically
    // closes no cycle and its reset is plain synchronous.
    ApTracker.resetTrackerState();
    cleared.push('ap-tracker.json');

    // ApChecks' in-memory `fired` Set is authoritative over the file we just deleted,
    // so it needs its own reset or the next debounced persist writes the old ids back.
    // This one must stay a dynamic import (ApChecks imports ApClient - a static
    // back-edge would be a cycle), but the deferral is harmless here: ApChecks is
    // already resident in the module graph (Player.ts imports it), so the .then runs
    // on the microtask drain at the end of this WebSocket message - ahead of the next
    // game tick, and therefore ahead of anything that could fire a check.
    void import('#/engine/ApChecks.js')
        .then(m => m.resetFiredLedger())
        .catch(err => printWarning(`AP client: failed to reset the fired ledger (${err instanceof Error ? err.message : err})`));

    // in-memory state has to go with the files, or the next persist writes it back
    session = { receivedCount: 0, sentChecks: [], goalSent: false, pending: [] };
    sentChecks = new Set<string>();

    return cleared;
}

/** Consumes the one-shot flag so the next (re)connect cannot wipe an AP run. */
function disarmClearLocalRun(): void {
    if (config !== null) {
        config.clearLocalRun = false;
    }
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            return;
        }
        const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
        if (parsed.clearLocalRun !== true) {
            return;
        }
        parsed.clearLocalRun = false;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    } catch (err) {
        printWarning(`AP client: failed to disarm clearLocalRun in ${CONFIG_PATH} (${err instanceof Error ? err.message : err})`);
    }
}

// Writes slot_data's questGates into ap-placements.json (placements empty) so
// ApQuestGates + the quest-tab hiding work unchanged in AP mode. Never
// overwrites a file that already has real placements (solo placement mode) -
// that's a misconfiguration worth screaming about instead, unless the tracker's
// "clear local run state on connect" box armed the one-shot wipe below.
function applySlotData(slotData: Record<string, unknown> | undefined): void {
    if (!slotData) {
        return;
    }

    // One-shot wipe, armed from the tracker's Archipelago tab. Runs before anything
    // below reads or writes run state, and disarms itself immediately so the
    // reconnect loop can never repeat it.
    if (config?.clearLocalRun === true) {
        try {
            const cleared = clearLocalRunState();
            printInfo(`AP client: cleared local run state on connect (${cleared.join(', ')})`);
        } catch (err) {
            printWarning(`AP client: clearLocalRun failed (${err instanceof Error ? err.message : err}) - clear data/config/ap-placements.json by hand`);
        }
        disarmClearLocalRun();
    }

    // "goals" (array, all must be completed) is preferred; single "goal" is the
    // pre-multi-goal fallback for older apworld builds.
    if (Array.isArray(slotData.goals)) {
        const known = slotData.goals.filter((g): g is string => typeof g === 'string' && !!data?.goalChecks?.[g]);
        if (known.length > 0) {
            goals = known;
        }
    } else if (typeof slotData.goal === 'string' && data?.goalChecks?.[slotData.goal]) {
        goals = [slotData.goal];
    }

    // Option toggles configured on the AP YAML/website side are authoritative in
    // AP mode - adopt them here so the server needs no hand-edited ap-options.json.
    // The watch table may already have been built (lazily, on the first varp write -
    // players can log in before the socket connects), so drop it for a rebuild; the
    // dynamic import avoids an ApClient -> ApChecks static cycle.
    if (typeof slotData.musicChecks === 'boolean') {
        setApOption('musicChecks', slotData.musicChecks);
        void import('#/engine/ApChecks.js')
            .then(m => m.resetWatchCache())
            .catch(err => printWarning(`AP client: failed to reset watch cache (${err instanceof Error ? err.message : err})`));
    }

    // item-category toggles: false = family not in the pool, system unrestricted
    // (ApUnlockOverrides.getUnlockCount reports 99 for the family's keys)
    for (const key of ['gearProgression', 'toolProgression', 'skillCaps'] as const) {
        if (typeof slotData[key] === 'boolean') {
            setApOption(key, slotData[key]);
        }
    }

    // infinite run applies live (Player.updateEnergy consults ApOptions each tick)
    if (typeof slotData.infiniteRun === 'boolean') {
        setApOption('infiniteRun', slotData.infiniteRun);
    }

    // progressive XP rate applies live too (Player.addXp consults ApOptions per gain)
    if (typeof slotData.progressiveXpRate === 'boolean') {
        setApOption('progressiveXpRate', slotData.progressiveXpRate);
    }

    // gathering speed applies live as well (AP_GATHER_RANDOM consults ApOptions on
    // every mining/woodcutting/fishing roll). Numeric percentage, 100 = vanilla;
    // out-of-range values are clamped by ApOptions on the next read.
    if (typeof slotData.gatherSpeed === 'number') {
        setApOptionInt('gatherSpeed', slotData.gatherSpeed);
    }

    // rock respawn likewise - ~ap_rock_respawn reads ApOptions when a rock is
    // depleted, so a changed value takes effect on the next swing.
    if (typeof slotData.rockRespawnSpeed === 'number') {
        setApOptionInt('rockRespawnSpeed', slotData.rockRespawnSpeed);
    }

    // seed knobs (entrances/drip/shops/drops/gathering/processing/spawn):
    // persisted for scripts/new-run to adopt on the NEXT seed roll - they can't
    // apply live (several need a content pack rebuild).
    if (slotData.seedOptions && typeof slotData.seedOptions === 'object' && !Array.isArray(slotData.seedOptions)) {
        try {
            fs.writeFileSync('data/config/ap-seed-options.json', JSON.stringify(slotData.seedOptions, null, 2) + '\n', 'utf8');
            printInfo('AP client: wrote ap-seed-options.json (applied on the next seed roll via scripts/new-run)');
        } catch (err) {
            printWarning(`AP client: failed to write ap-seed-options.json (${err instanceof Error ? err.message : err})`);
        }
    }

    // The apworld's own entrance layout (GitHub #3). With region_logic on, Archipelago
    // builds the trigger -> arrival table itself, reachability-preserving, and the
    // multiworld's fill was computed against THAT map - so it is authoritative and must
    // land in ap-entrances.json before the player moves. Written live; the engine's
    // ApEntranceOverrides reloads it, no pack rebuild needed. slot_data also pins
    // seedOptions.entrances to "off" so the next scripts/new-run cannot reshuffle it.
    if (slotData.entranceOverrides && typeof slotData.entranceOverrides === 'object' && !Array.isArray(slotData.entranceOverrides)) {
        const overrides = slotData.entranceOverrides as Record<string, unknown>;
        const clean: Record<string, string> = {};
        for (const [key, value] of Object.entries(overrides)) {
            if (/^\d+_\d+_\d+_\d+_\d+:\d+$/.test(key) && typeof value === 'string' && /^\d+_\d+_\d+_\d+_\d+$/.test(value)) {
                clean[key] = value;
            }
        }
        if (Object.keys(clean).length > 0) {
            try {
                const file = 'data/config/ap-entrances.json';
                // keep any gate requirements the local table already carried: the gate
                // stays with the physical location, not the destination (workstream B).
                let gates: unknown = {};
                if (fs.existsSync(file)) {
                    gates = (JSON.parse(fs.readFileSync(file, 'utf8')) as { gates?: unknown }).gates ?? {};
                }
                fs.writeFileSync(file, JSON.stringify({
                    source: 'archipelago slot_data',
                    generatedAt: new Date().toISOString(),
                    overrides: clean,
                    gates
                }, null, 2), 'utf8');
                void import('#/engine/ApEntranceOverrides.js')
                    .then(m => m.reloadEntranceOverrides?.())
                    .catch(() => { /* module may not expose a reload hook - restart picks it up */ });
                printInfo(`AP client: adopted ${Object.keys(clean).length} entrance override(s) from slot_data`);
            } catch (err) {
                printWarning(`AP client: failed to write ap-entrances.json (${err instanceof Error ? err.message : err})`);
            }
        }
    }

    // relics: which addon reward items may roll from Mystery Reward filler.
    // Absence from the list disables the roll; already-delivered items keep
    // working (ap_addons.rs2 usage is deliberately not option-gated).
    if (Array.isArray(slotData.relics)) {
        const relics = new Set(slotData.relics.filter((r): r is string => typeof r === 'string'));
        const relicOptionKeys: Record<string, string> = {
            bank_box: 'addonBankBox',
            tree_compass: 'addonTreeCompass',
            teleporting_focus: 'addonTeleportingFocus',
            npc_teleport: 'addonNpcTeleport'
        };
        for (const [relic, optionKey] of Object.entries(relicOptionKeys)) {
            setApOption(optionKey, relics.has(relic));
        }
    }

    const gates = Array.isArray(slotData.questGates) ? slotData.questGates.filter((g): g is string => typeof g === 'string') : null;
    if (!gates) {
        return;
    }

    try {
        let existing: { placements?: Record<string, unknown>; questGates?: string[] } = {};
        if (fs.existsSync(PLACEMENTS_PATH)) {
            existing = JSON.parse(fs.readFileSync(PLACEMENTS_PATH, 'utf8')) as typeof existing;
        }
        if (existing.placements && Object.keys(existing.placements).length > 0) {
            printWarning(
                'AP client: ap-placements.json holds a SOLO placement seed while AP mode is on - refusing to touch it. Tick "Clear local run state on connect" in the tracker\'s Archipelago tab and reconnect (or delete data/config/ap-placements.json by hand).'
            );
            return;
        }
        const current = JSON.stringify(existing.questGates ?? []);
        if (current !== JSON.stringify(gates)) {
            fs.writeFileSync(PLACEMENTS_PATH, JSON.stringify({ placements: {}, questGates: gates }, null, 2), 'utf8');
            // ApQuestGates caches this file once per process, which normally assumes a
            // restart follows a reseed - but the wipe above is a live reseed, so drop
            // the cache or a player who is already logged in keeps the OLD run's gates.
            ApQuestGates.resetQuestGateCache();
            printInfo(`AP client: wrote ${gates.length} quest gate(s) from slot_data`);
        }
    } catch (err) {
        printWarning(`AP client: failed to apply slot_data quest gates (${err instanceof Error ? err.message : err})`);
    }
}

// ---------------------------------------------------------------------------
// receiving items
// ---------------------------------------------------------------------------

function queueDelivery(delivery: PendingDelivery): void {
    session.pending.push(delivery);
    schedulePersist();
}

function applyReceivedItem(networkItem: { item?: number }): void {
    const entry = typeof networkItem.item === 'number' ? itemsById?.get(networkItem.item) : undefined;
    if (!entry) {
        printWarning(`AP client: received unknown item id ${networkItem.item} - skipped`);
        return;
    }

    if (entry.def.filler || !entry.def.grant) {
        queueDelivery({ display: entry.name, filler: true, pack: entry.def.pack });
        return;
    }

    // Progressive quest unlock: the item's own counter picks WHICH quest from the
    // difficulty-ordered list, then the real quest_<id> gate key gets the grant so
    // every downstream consumer (gates, tracker, quest tab) works unchanged.
    if (entry.def.grant === 'progressive_quest') {
        const order = data?.questUnlockOrder ?? [];
        const progressCount = ApUnlockOverrides.grantUnlock('progressive_quest', 1);
        const questId = progressCount > 0 ? order[progressCount - 1] : undefined;
        if (questId === undefined) {
            printWarning(`AP client: Progressive Quest Unlock #${progressCount} has no quest in questUnlockOrder (${order.length} entries) - announced only`);
            queueDelivery({ display: entry.name, filler: false });
            return;
        }
        const gateKey = `quest_${questId}`;
        const gateCount = ApUnlockOverrides.grantUnlock(gateKey, 1);
        const display = gateCount > 0 ? ApUnlockOverrides.describeUnlock(gateKey, gateCount) : entry.name;
        queueDelivery({ display, filler: false, grant: gateKey });
        return;
    }

    const newCount = ApUnlockOverrides.grantUnlock(entry.def.grant, entry.def.count ?? 1);
    const display = newCount > 0 ? ApUnlockOverrides.describeUnlock(entry.def.grant, newCount) : entry.name;
    queueDelivery({ display, filler: false, grant: entry.def.grant });
}

function handleReceivedItems(index: number, items: { item?: number }[]): void {
    // AP semantics: `index` is the position of items[0] in the all-time received
    // sequence. index 0 = full replay. Anything already processed is skipped via
    // receivedCount bookkeeping; a gap means we missed items - Sync + resend.
    if (index > session.receivedCount) {
        printWarning(`AP client: ReceivedItems gap (index ${index}, have ${session.receivedCount}) - requesting Sync`);
        send([{ cmd: 'Sync' }]);
        sendFullResync();
        return;
    }

    const skip = session.receivedCount - index;
    const fresh = items.slice(skip);
    for (const item of fresh) {
        applyReceivedItem(item);
    }
    session.receivedCount = index + items.length;
    if (fresh.length > 0) {
        printInfo(`AP client: received ${fresh.length} item(s) (total ${session.receivedCount})`);
    }
    schedulePersist();
}

// ---------------------------------------------------------------------------
// in-game delivery (queue drained to the first online player)
// ---------------------------------------------------------------------------

function startDeliveryTimer(): void {
    if (deliverTimer !== null) {
        return;
    }
    deliverTimer = setInterval(() => {
        void drainDeliveries();
    }, DELIVER_INTERVAL_MS);
    if (typeof deliverTimer.unref === 'function') {
        deliverTimer.unref();
    }
}

async function drainDeliveries(): Promise<void> {
    if (session.pending.length === 0) {
        return;
    }

    try {
        // dynamic import: see the module-header IMPORT RULES comment.
        const World = (await import('#/engine/World.js')).default;
        let player: Player | null = null;
        for (const p of World.players) {
            if (p) {
                player = p as Player;
                break;
            }
        }
        if (!player) {
            return; // keep queued until someone logs in
        }

        const script = ScriptProvider.getByName('[queue,ap_remote_item]');
        if (!script) {
            // content not deployed/rebuilt yet - deliver the mechanical part
            // (grants already applied), drop only the announcements.
            printWarning('AP client: [queue,ap_remote_item] missing (pack not rebuilt?) - dropping pending announcements');
            session.pending = [];
            schedulePersist();
            return;
        }

        const pending = session.pending;
        session.pending = [];
        for (const delivery of pending) {
            player.enqueueScript(script, PlayerQueueType.ENGINE, 0, [delivery.display, delivery.filler ? 1 : 0, delivery.pack ?? '']);
            if (delivery.grant) {
                // the grant may have raised a cap that has banked xp waiting
                ApUnlockOverrides.applyBankedXpForUnlock(player, delivery.grant);
            }
        }
        schedulePersist();
    } catch (err) {
        printWarning(`AP client: delivery drain failed (${err instanceof Error ? err.message : err})`);
    }
}

// ---------------------------------------------------------------------------
// connection lifecycle
// ---------------------------------------------------------------------------

function scheduleReconnect(): void {
    if (reconnectTimer !== null || config === null) {
        return;
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt));
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
    if (typeof reconnectTimer.unref === 'function') {
        reconnectTimer.unref();
    }
}

function handlePacket(packet: { cmd?: string } & Record<string, unknown>): void {
    switch (packet.cmd) {
        case 'RoomInfo':
            send([
                {
                    cmd: 'Connect',
                    game: data?.game ?? '2004Scape',
                    name: config?.slot ?? 'Player',
                    password: config?.password ?? null,
                    uuid: randomUUID(),
                    version: AP_VERSION,
                    items_handling: 0b111,
                    tags: [],
                    slot_data: true
                }
            ]);
            break;
        case 'Connected':
            connected = true;
            reconnectAttempt = 0;
            lastError = null;
            printInfo(`AP client: connected to ${config?.host}:${config?.port} as "${config?.slot}"`);
            rememberSlotLocations(packet.missing_locations, packet.checked_locations);
            applySlotData(packet.slot_data as Record<string, unknown> | undefined);
            sendFullResync();
            break;
        case 'ConnectionRefused':
            lastError = `refused: ${JSON.stringify(packet.errors ?? packet)}`;
            printError(`AP client: connection refused: ${JSON.stringify(packet.errors ?? packet)}`);
            break;
        case 'ReceivedItems':
            handleReceivedItems(typeof packet.index === 'number' ? packet.index : 0, Array.isArray(packet.items) ? (packet.items as { item?: number }[]) : []);
            break;
        case 'PrintJSON':
        case 'RoomUpdate':
        case 'Bounced':
        default:
            break; // v1: log-free ignore (PrintJSON forwarding is on the roadmap)
    }
}

function connect(): void {
    if (config === null || data === null) {
        return;
    }

    const url = `ws://${config.host}:${config.port}`;
    printInfo(`AP client: connecting to ${url}...`);

    try {
        ws = new WebSocket(url);
    } catch (err) {
        printWarning(`AP client: failed to open socket (${err instanceof Error ? err.message : err})`);
        scheduleReconnect();
        return;
    }

    ws.on('message', (raw: Buffer) => {
        try {
            const packets = JSON.parse(raw.toString()) as ({ cmd?: string } & Record<string, unknown>)[];
            if (Array.isArray(packets)) {
                for (const packet of packets) {
                    handlePacket(packet);
                }
            }
        } catch (err) {
            printWarning(`AP client: bad packet (${err instanceof Error ? err.message : err})`);
        }
    });

    ws.on('close', () => {
        if (connected) {
            printWarning('AP client: disconnected - will keep retrying in the background');
        }
        connected = false;
        ws = null;
        scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
        // 'close' follows and handles the retry; just log once per attempt.
        lastError = err.message;
        if (reconnectAttempt === 0) {
            printWarning(`AP client: socket error (${err.message})`);
        }
    });
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** True when AP mode is configured + datapackage loaded - ApChecks consults this to route fired checks here instead of the local placement table. */
export function isApModeActive(): boolean {
    return config !== null && data !== null;
}

/** Called by ApChecks.fireCheck (after its own dedupe). Safe to call when offline - the id lands in the persisted sent-set and goes out on the next resync. */
export function onCheckFired(checkId: string): void {
    if (!isApModeActive() || sentChecks.has(checkId)) {
        return;
    }
    sentChecks.add(checkId);
    schedulePersist();

    const ids = locationIdsFor([checkId]);
    if (ids.length > 0 && connected) {
        send([{ cmd: 'LocationChecks', locations: ids }]);
    }
    checkGoal();
}

/** Boot entry point, called once from startWeb() (web.ts overlay - main thread only). No-op without config. */
export function initApClient(): void {
    reconfigure();
}

/**
 * (Re)loads ap-archipelago.json and (re)connects - the tracker's Archipelago
 * setup page calls this after writing new credentials, so config changes apply
 * live without a server restart. Also the shared init path (initApClient
 * delegates here). Safe to call in any state: tears down an existing socket
 * and pending reconnect first, and cleanly disables the client when the config
 * is absent/disabled.
 */
export function reconfigure(): void {
    if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    reconnectAttempt = 0;
    lastError = null;
    if (ws !== null) {
        try {
            ws.removeAllListeners();
            ws.terminate();
        } catch {
            // already dead
        }
        ws = null;
    }
    connected = false;
    slotCheckIds = null; // re-learned from the next Connected packet

    const wasActive = config !== null;
    config = loadConfig();
    if (config === null) {
        data = null;
        if (wasActive) {
            printInfo('AP client: disabled (config removed or enabled=false)');
        }
        return;
    }

    data = loadData();
    if (data === null) {
        config = null;
        lastError = 'datapackage (ap-archipelago-data.json) missing - run tools/ap/ExportApWorldData.ts';
        return;
    }

    checkToLocationId = new Map(Object.entries(data.locations).map(([checkId, loc]) => [checkId, loc.id]));
    itemsById = new Map(Object.entries(data.items).map(([name, def]) => [def.id, { name, def }]));

    session = loadSession();
    sentChecks = new Set(session.sentChecks);

    printInfo(`AP client: enabled (${checkToLocationId.size} locations, ${itemsById.size} items mapped)`);
    startDeliveryTimer();
    connect();
}

/**
 * Check ids this slot holds in the multiworld, or null when that isn't known
 * (not in AP mode, or connected but the Connected packet carried no location
 * arrays). The tracker's Checks tab uses it to render locations the multiworld
 * never generated as "not in this seed" instead of "not done yet".
 */
export function getSlotCheckIds(): Set<string> | null {
    return isApModeActive() ? slotCheckIds : null;
}

/** Live client state for the tracker's Archipelago setup page. */
export function getApStatus(): Record<string, unknown> {
    return {
        active: isApModeActive(),
        connected,
        host: config?.host ?? null,
        port: config?.port ?? null,
        slot: config?.slot ?? null,
        goal: isApModeActive() ? goals.join(' + ') : null,
        sentChecks: sentChecks.size,
        receivedItems: session.receivedCount,
        pendingDeliveries: session.pending.length,
        goalSent: session.goalSent,
        lastError
    };
}

export interface ProbeResult {
    ok: boolean;
    error?: string;
    version?: string;
    seedName?: string;
    passwordRequired?: boolean;
    games?: string[];
    hasOurGame?: boolean;
}

/**
 * One-shot connectivity probe for the setup page's "Test connection" button:
 * opens a fresh socket, waits for the server's RoomInfo greeting, and reports
 * what's hosted there. Independent of the live client - never touches its
 * state, so testing other hosts while connected is safe.
 */
export function probeServer(host: string, port: number, timeoutMs: number = 5000): Promise<ProbeResult> {
    return new Promise(resolve => {
        let socket: WebSocket;
        try {
            socket = new WebSocket(`ws://${host}:${port}`);
        } catch (err) {
            resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
            return;
        }

        let done = false;
        const finish = (result: ProbeResult) => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            try {
                socket.removeAllListeners();
                socket.terminate();
            } catch {
                // already closed
            }
            resolve(result);
        };

        const timer = setTimeout(() => finish({ ok: false, error: `no RoomInfo within ${timeoutMs}ms` }), timeoutMs);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }

        socket.on('message', (raw: Buffer) => {
            try {
                const packets = JSON.parse(raw.toString()) as ({ cmd?: string } & Record<string, unknown>)[];
                for (const packet of packets) {
                    if (packet.cmd === 'RoomInfo') {
                        const version = packet.version as { major?: number; minor?: number; build?: number } | undefined;
                        const games = Array.isArray(packet.games) ? (packet.games as string[]) : [];
                        finish({
                            ok: true,
                            version: version ? `${version.major}.${version.minor}.${version.build}` : undefined,
                            seedName: typeof packet.seed_name === 'string' ? packet.seed_name : undefined,
                            passwordRequired: packet.password === true,
                            games,
                            hasOurGame: games.includes(data?.game ?? '2004Scape')
                        });
                        return;
                    }
                }
            } catch (err) {
                finish({ ok: false, error: `bad packet: ${err instanceof Error ? err.message : err}` });
            }
        });
        socket.on('error', (err: Error) => finish({ ok: false, error: err.message }));
        socket.on('close', () => finish({ ok: false, error: 'connection closed before RoomInfo' }));
    });
}
