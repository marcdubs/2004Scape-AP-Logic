import fs from 'fs';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'http';
import path from 'path';
import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';

import ejs from 'ejs';
import { register } from 'prom-client';
import { WebSocketServer } from 'ws';

import { CrcBuffer } from '#/cache/CrcTable.js';
import World from '#/engine/World.js';
import { LoggerEventType } from '#/server/logger/LoggerEventType.js';
import NullClientSocket from '#/server/NullClientSocket.js';
import WSClientSocket from '#/server/ws/WSClientSocket.js';
import Environment from '#/util/Environment.js';
import { createDefaultWorldConfig, loadWorldConfig, normalizeWorldConfig, saveWorldConfig } from '#/util/WorldConfig.js';
import OnDemand from '#/engine/OnDemand.js';
import { tryParseInt } from '#/util/TryParse.js';
import ObjType from '#/cache/config/ObjType.js';
import { getDropOverrideCount } from '#/engine/ApDropOverrides.js';
import { getEntranceOverrideCount } from '#/engine/ApEntranceOverrides.js';
import { getGatherOverrideCount } from '#/engine/ApGatherOverrides.js';
import { getProcessOverrideCount } from '#/engine/ApProcessOverrides.js';
import { getTrackerState } from '#/engine/ApTracker.js';

type NodeRequestInit = RequestInit & {
    duplex?: 'half';
};

const MIME_TYPES = new Map<string, string>();
MIME_TYPES.set('.js', 'application/javascript');
MIME_TYPES.set('.mjs', 'application/javascript');
MIME_TYPES.set('.css', 'text/css');
MIME_TYPES.set('.html', 'text/html');
MIME_TYPES.set('.wasm', 'application/wasm');
MIME_TYPES.set('.sf2', 'application/octet-stream');

function getHeader(headers: Headers | IncomingHttpHeaders, name: string): string | null {
    if (headers instanceof Headers) {
        return headers.get(name);
    }

    const value = headers[name.toLowerCase()];
    if (Array.isArray(value)) {
        return value[0] ?? null;
    }

    return value ?? null;
}

function resolveContentPath(name: string): string | null {
    let decodedName: string;
    try {
        decodedName = decodeURIComponent(name);
    } catch {
        return null;
    }

    const contentRoot = path.resolve(Environment.build.srcDir);
    const targetPath = path.resolve(contentRoot, decodedName);
    const relativePath = path.relative(contentRoot, targetPath);

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return null;
    }

    return targetPath;
}

function streamFile(filePath: string, contentType?: string): Response {
    return new Response(Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream, {
        headers: {
            'Content-Type': contentType ?? MIME_TYPES.get(path.extname(filePath)) ?? 'text/plain'
        }
    });
}

function fileExists(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function jsonResponse(value: unknown, status: number = 200): Response {
    return new Response(JSON.stringify(value, null, 2), {
        status,
        headers: {
            'Content-Type': 'application/json'
        }
    });
}

// GET /ap/tracker.json helpers (docs/tracker-map.md). Everything below is additive -
// the rest of this file is byte-identical to vanilla web.ts.

function readJsonFile<T>(filePath: string): T | null {
    try {
        if (!fs.statSync(filePath).isFile()) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

// "N: label" -> Map<N, label>, the format ap-drops.json's spoiler "slots"/"units"
// arrays use (index into the monster/loot-table lists RandomizeDrops.ts --mode mimic
// generated).
function parseIndexedLabels(entries: string[] | undefined): Map<number, string> {
    const map = new Map<number, string>();
    for (const entry of entries ?? []) {
        const sep = entry.indexOf(':');
        if (sep === -1) {
            continue;
        }
        const index = Number(entry.slice(0, sep));
        if (!Number.isInteger(index)) {
            continue;
        }
        map.set(index, entry.slice(sep + 1).trim());
    }
    return map;
}

let dropNameCache: { slots: Map<number, string>; units: Map<number, string> } | null = null;

// lazily cached: ap-drops.json is static for the lifetime of the process (a reseed
// needs a restart anyway, same as every other Ap*Overrides.ts table).
function loadDropNames(): { slots: Map<number, string>; units: Map<number, string> } {
    if (dropNameCache === null) {
        const parsed = readJsonFile<{ slots?: string[]; units?: string[] }>('data/config/ap-drops.json');
        dropNameCache = {
            slots: parseIndexedLabels(parsed?.slots),
            units: parseIndexedLabels(parsed?.units)
        };
    }
    return dropNameCache;
}

type ApSpoilerTables = { entrances: Record<string, string>; gather: Record<string, string>; process: Record<string, string>; drops: Record<string, string> };

let spoilerTablesCache: ApSpoilerTables | null = null;

// full override tables read straight from the seed config files, as if every entry
// had been discovered - used only behind ?spoiler=1 (UI-development mode, see
// docs/tracker-map.md "Seed lifecycle & testing"). Never merged into the response
// unless spoiler mode is explicitly requested, so normal-mode polling stays
// spoiler-free.
function loadSpoilerTables(): ApSpoilerTables {
    if (spoilerTablesCache === null) {
        const entrances = readJsonFile<{ overrides?: Record<string, string> }>('data/config/ap-entrances.json')?.overrides ?? {};
        const gatherMap = readJsonFile<{ map?: Record<string, number> }>('data/config/ap-gather.json')?.map ?? {};
        const processMap = readJsonFile<{ map?: Record<string, number> }>('data/config/ap-process.json')?.map ?? {};
        const dropsMap = readJsonFile<{ map?: Record<string, number> }>('data/config/ap-drops.json')?.map ?? {};

        spoilerTablesCache = {
            entrances,
            gather: Object.fromEntries(Object.entries(gatherMap).map(([k, v]) => [k, String(v)])),
            process: Object.fromEntries(Object.entries(processMap).map(([k, v]) => [k, String(v)])),
            drops: Object.fromEntries(Object.entries(dropsMap).map(([k, v]) => [k, String(v)]))
        };
    }
    return spoilerTablesCache;
}

function resolveItemName(id: number): string {
    try {
        const name = ObjType.get(id)?.name;
        return name && name.length > 0 ? name : `item_${id}`;
    } catch {
        return `item_${id}`;
    }
}

function collectIds(map: Record<string, string> | undefined, itemIds: Set<number>): void {
    if (!map) {
        return;
    }
    for (const [key, value] of Object.entries(map)) {
        const k = Number(key);
        const v = Number(value);
        if (Number.isInteger(k)) {
            itemIds.add(k);
        }
        if (Number.isInteger(v)) {
            itemIds.add(v);
        }
    }
}

function collectDropIds(map: Record<string, string> | undefined, slotIds: Set<number>, unitIds: Set<number>): void {
    if (!map) {
        return;
    }
    for (const [key, value] of Object.entries(map)) {
        const slot = Number(key);
        const unit = Number(value);
        if (Number.isInteger(slot)) {
            slotIds.add(slot);
        }
        if (Number.isInteger(unit)) {
            unitIds.add(unit);
        }
    }
}

// GET /ap/tracker.json - the browser discovery tracker's only data route (the SPA
// itself is served with zero engine changes by the public/ fallthrough below). See
// docs/tracker-map.md for the full design. Normal mode returns only what's actually
// been discovered plus per-category totals (not a spoiler, just table sizes);
// ?spoiler=1 additionally merges the full override tables as if everything had been
// discovered, for UI development without playing.
function buildApTrackerResponse(spoilerMode: boolean): unknown {
    const discoveries = getTrackerState();
    const dropNames = loadDropNames();

    const itemIds = new Set<number>();
    const dropSlotIds = new Set<number>();
    const dropUnitIds = new Set<number>();

    collectIds(discoveries.gather, itemIds);
    collectIds(discoveries.process, itemIds);
    collectDropIds(discoveries.drops, dropSlotIds, dropUnitIds);

    let spoiler: ApSpoilerTables | null = null;
    if (spoilerMode) {
        spoiler = loadSpoilerTables();
        collectIds(spoiler.gather, itemIds);
        collectIds(spoiler.process, itemIds);
        collectDropIds(spoiler.drops, dropSlotIds, dropUnitIds);
    }

    const items: Record<string, string> = {};
    for (const id of itemIds) {
        items[String(id)] = resolveItemName(id);
    }

    const dropSlots: Record<string, string> = {};
    for (const id of dropSlotIds) {
        dropSlots[String(id)] = dropNames.slots.get(id) ?? `slot_${id}`;
    }

    const dropUnits: Record<string, string> = {};
    for (const id of dropUnitIds) {
        dropUnits[String(id)] = dropNames.units.get(id) ?? `unit_${id}`;
    }

    return {
        discoveries,
        names: { items, dropSlots, dropUnits },
        totals: {
            entrances: getEntranceOverrideCount(),
            gather: getGatherOverrideCount(),
            process: getProcessOverrideCount(),
            drops: getDropOverrideCount(),
            // stable code fact, not a spoiler - exactly 7 spellbook teleport spells
            // are wired to ap_track in teleport.rs2 (Varrock/Lumbridge/Falador/
            // Camelot/Ardougne/Watchtower/Trollheim); there's no JSON override table
            // to size this from the way the other three categories have.
            teleports: 7
        },
        spoiler
    };
}

async function handleWebRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'GET') {
        if (url.pathname.startsWith('/crc')) {
            return new Response(Buffer.from(CrcBuffer.data));
        } else if (url.pathname.startsWith('/title')) {
            return new Response(Buffer.from(OnDemand.cache.read(0, 1)!));
        } else if (url.pathname.startsWith('/config')) {
            return new Response(Buffer.from(OnDemand.cache.read(0, 2)!));
        } else if (url.pathname.startsWith('/interface')) {
            return new Response(Buffer.from(OnDemand.cache.read(0, 3)!));
        } else if (url.pathname.startsWith('/media')) {
            return new Response(Buffer.from(OnDemand.cache.read(0, 4)!));
        } else if (url.pathname.startsWith('/versionlist')) {
            return new Response(Buffer.from(OnDemand.cache.read(0, 5)!));
        } else if (url.pathname.startsWith('/textures')) {
            return new Response(Buffer.from(OnDemand.cache.read(0, 6)!));
        } else if (url.pathname.startsWith('/wordenc')) {
            return new Response(Buffer.from(OnDemand.cache.read(0, 7)!));
        } else if (url.pathname.startsWith('/sounds')) {
            return new Response(Buffer.from(OnDemand.cache.read(0, 8)!));
        } else if (url.pathname === '/rs2.cgi') {
            const plugin = tryParseInt(url.searchParams.get('plugin'), 0);
            const lowmem = tryParseInt(url.searchParams.get('lowmem'), 0);

            if (Environment.node.debug && plugin === 1) {
                return new Response(
                    await ejs.renderFile('view/java.ejs', {
                        nodeid: Environment.node.id,
                        lowmem,
                        members: Environment.node.members,
                        portoff: Environment.node.port - 43594
                    }),
                    {
                        headers: {
                            'Content-Type': 'text/html'
                        }
                    }
                );
            }

            return new Response(
                await ejs.renderFile('view/client.ejs', {
                    nodeid: Environment.node.id,
                    lowmem,
                    members: Environment.node.members
                }),
                {
                    headers: {
                        'Content-Type': 'text/html'
                    }
                }
            );
        } else if (url.pathname === '/worldmap.jag') {
            if (fileExists('data/pack/mapview/worldmap.jag')) {
                return streamFile('data/pack/mapview/worldmap.jag', 'application/octet-stream');
            }
        } else if (url.pathname === '/ap/tracker.json') {
            return jsonResponse(buildApTrackerResponse(url.searchParams.get('spoiler') === '1'));
        } else if (Environment.node.debug) {
            if (url.pathname === '/maped') {
                return new Response(await ejs.renderFile('view/maped.ejs'), {
                    headers: {
                        'Content-Type': 'text/html'
                    }
                });
            } else if (url.pathname.startsWith('/content/')) {
                const name = url.pathname.replace('/content/', '');
                const filePath = resolveContentPath(name);
                if (!filePath || !fileExists(filePath)) {
                    return new Response(null, { status: 404 });
                }

                return streamFile(filePath, MIME_TYPES.get(path.extname(url.pathname ?? '')) ?? 'text/plain');
            } else if (url.pathname.startsWith('/data/')) {
                const name = url.pathname.replace('/data/', '');
                const filePath = `data/${name}`;
                if (!fileExists(filePath)) {
                    return new Response(null, { status: 404 });
                }

                return streamFile(filePath, MIME_TYPES.get(path.extname(url.pathname ?? '')) ?? 'text/plain');
            }
        }

        const publicPath = `public${url.pathname}`;
        if (fileExists(publicPath)) {
            return streamFile(publicPath, MIME_TYPES.get(path.extname(url.pathname ?? '')) ?? 'text/plain');
        }
    } else if (req.method === 'PUT') {
        if (Environment.node.debug) {
            if (url.pathname.startsWith('/content/')) {
                const name = url.pathname.replace('/content/', '');
                const filePath = resolveContentPath(name);
                if (!filePath) {
                    return new Response(null, { status: 400 });
                }

                const body = new Uint8Array(await req.arrayBuffer());
                await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
                await fs.promises.writeFile(filePath, body);
                return new Response(null, { status: 200 });
            }
        }
    }

    return new Response(null, { status: 404 });
}

async function handleManagementRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/setup') {
        return new Response(await ejs.renderFile('view/setup.ejs'), {
            headers: {
                'Content-Type': 'text/html'
            }
        });
    }

    if (url.pathname === '/setup/config') {
        if (method === 'GET') {
            return jsonResponse({
                config: loadWorldConfig(),
                defaults: createDefaultWorldConfig(),
                path: 'data/config/world.json'
            });
        }

        if (method === 'PUT') {
            let payload: unknown;
            try {
                payload = await req.json();
            } catch {
                return jsonResponse({ error: 'Invalid JSON payload' }, 400);
            }

            const config = normalizeWorldConfig(payload);
            saveWorldConfig(config);

            return jsonResponse({
                config,
                restartRequired: true
            });
        }

        return new Response(null, {
            status: 405,
            headers: {
                Allow: 'GET, PUT'
            }
        });
    }

    if (url.pathname === '/prometheus') {
        return new Response(await register.metrics(), {
            headers: {
                'Content-Type': register.contentType
            }
        });
    }

    return new Response(null, { status: 404 });
}

function createRequest(req: IncomingMessage, fallbackPort: number): Request {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${fallbackPort}`}`);
    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'undefined') {
            continue;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(key, item);
            }
        } else {
            headers.set(key, value);
        }
    }

    if (method === 'GET' || method === 'HEAD') {
        return new Request(url, { method, headers });
    }

    const init: NodeRequestInit = {
        method,
        headers,
        body: Readable.toWeb(req) as ReadableStream,
        duplex: 'half'
    };

    return new Request(url, init);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
        res.setHeader(key, value);
    });

    if (!response.body) {
        res.end();
        return;
    }

    await new Promise<void>((resolve, reject) => {
        Readable.fromWeb(response.body as unknown as NodeReadableStream).pipe(res);
        res.on('finish', resolve);
        res.on('error', reject);
    });
}

export async function startWeb(): Promise<void> {
    const server = http.createServer(async (req, res) => {
        try {
            const response = await handleWebRequest(createRequest(req, Environment.web.port));
            await writeResponse(res, response);
        } catch (err) {
            console.error(err);
            res.statusCode = 500;
            res.end();
        }
    });

    const websocket = new WebSocketServer({
        noServer: true,
        maxPayload: 2000
    });

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${Environment.web.port}`}`);
        if (url.pathname !== '/') {
            socket.destroy();
            return;
        }

        const origin = getHeader(req.headers, 'origin');
        if (Environment.web.allowedOrigin && origin !== Environment.web.allowedOrigin) {
            socket.destroy();
            return;
        }

        websocket.handleUpgrade(req, socket, head, ws => {
            const client = new WSClientSocket();
            client.init(
                {
                    send(data: Uint8Array) {
                        ws.send(data);
                    },
                    close() {
                        ws.close();
                    },
                    terminate() {
                        ws.terminate();
                    }
                },
                req.socket.remoteAddress ?? 'unknown'
            );

            ws.on('message', (message: Buffer<ArrayBufferLike>) => {
                try {
                    if (client.state === -1 || client.remaining <= 0) {
                        client.terminate();
                        return;
                    }

                    client.buffer(message);

                    if (client.state === 0) {
                        World.onClientData(client);
                    } else if (client.state === 2) {
                        OnDemand.onClientData(client);
                    }
                } catch (_) {
                    ws.terminate();
                }
            });

            ws.on('close', () => {
                client.state = -1;

                if (client.player) {
                    client.player.addSessionLog(LoggerEventType.ENGINE, 'WS socket closed');
                    client.player.client = new NullClientSocket();
                }
            });

            ws.on('error', () => {
                ws.terminate();
            });
        });
    });

    await new Promise<void>(resolve => {
        server.listen(Environment.web.port, '0.0.0.0', () => resolve());
    });
}

export async function startManagementWeb(): Promise<void> {
    const server = http.createServer(async (req, res) => {
        try {
            const response = await handleManagementRequest(createRequest(req, Environment.web.managementPort));
            await writeResponse(res, response);
        } catch (err) {
            console.error(err);
            res.statusCode = 500;
            res.end();
        }
    });

    await new Promise<void>(resolve => {
        server.listen(Environment.web.managementPort, '0.0.0.0', () => resolve());
    });
}
