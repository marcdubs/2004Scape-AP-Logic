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

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import WebSocket from 'ws';

import { setApOption } from '#/engine/ApOptions.js';
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
}

interface ExportedItem {
    id: number;
    grant?: string;
    count?: number;
    copies: number;
    filler?: boolean;
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
            password: typeof parsed.password === 'string' ? parsed.password : null
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

// Writes slot_data's questGates into ap-placements.json (placements empty) so
// ApQuestGates + the quest-tab hiding work unchanged in AP mode. Never
// overwrites a file that already has real placements (solo placement mode) -
// that's a misconfiguration worth screaming about instead.
function applySlotData(slotData: Record<string, unknown> | undefined): void {
    if (!slotData) {
        return;
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
            printWarning('AP client: ap-placements.json holds a SOLO placement seed while AP mode is on - refusing to touch it. Clear local run state before connecting to Archipelago.');
            return;
        }
        const current = JSON.stringify(existing.questGates ?? []);
        if (current !== JSON.stringify(gates)) {
            fs.writeFileSync(PLACEMENTS_PATH, JSON.stringify({ placements: {}, questGates: gates }, null, 2), 'utf8');
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
        queueDelivery({ display: entry.name, filler: true });
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
            player.enqueueScript(script, PlayerQueueType.ENGINE, 0, [delivery.display, delivery.filler ? 1 : 0]);
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
