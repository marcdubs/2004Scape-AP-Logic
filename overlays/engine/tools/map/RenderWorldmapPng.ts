import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import FloType from '#/cache/config/FloType.js';
import Packet from '#/io/Packet.js';
import Environment from '#/util/Environment.js';
import { printInfo, printWarning } from '#/util/Logger.js';
import { openArtifactStore } from '#tools/pack/ArtifactCache.js';

// Renders the whole world into two flat PNGs (surface + underground) for the browser
// discovery tracker map (2004Scape-AP-Logic docs/tracker-map.md, "the map itself").
// One-time/regenerate-on-content-rebuild tool - it never needs to run per-seed
// (terrain doesn't change between randomizer seeds), only when map data changes.
//
// Rendering source: option (a) from tracker-map.md - reuses the exact
// underlay/overlay extraction loop `engine/tools/pack/map/Worldmap.ts` uses to build
// worldmap.jag, reading the same `data/pack/.cache/maps-server.zip` artifact store
// (present after any `tools/pack/Build.ts` run). Colors come straight from each
// underlay/overlay's own FloType.rgb ("flo mapcolors") - no heuristic palette needed,
// this data already carries real designed colors (grass green, water blue, path
// brown, etc). Overlay wins over underlay when both are present on a tile (overlay is
// the "drawn on top" layer - paths/water over grass), matching the client's own
// z-order. Locs (walls/buildings) are intentionally NOT rendered - this is a terrain
// map for marker overlay, not a full minimap; keeping it terrain-only means the
// browser SPA's marker/line layer stays legible on top of it.
//
// The "underground" layer is not a separate Z/plane of the SAME mapsquare - it's a
// disjoint set of mapsquares at mapZ+100 (see lessons-learned.md "Domain knowledge:
// entrances" - the +100-mapsquare convention), so splitting surface/underground is
// just bucketing whole mapsquares by mapZ, not touching plane/level.

const PX_PER_TILE = 2;
const SQUARE_TILES = 64;

// distinguishes "no map data here" (ocean gaps, unregistered squares) from any real
// terrain color - all FloType.rgb values in this content set are lighter/more
// saturated than this near-black.
const VOID_RGB = 0x0d0d10;

const OUT_DIR = 'public/ap';

interface SquareColors {
    mapX: number;
    mapZ: number;
    // 64*64*3 bytes, row-major by localZ*64+localX (RGB per tile)
    rgb: Uint8Array;
}

// Most FloType configs carry a real, designed RGB (grass green, cliff grey, ...) -
// FloType.rgb is used verbatim for those (~86 of 103 in this content set). The
// remainder are texture-painted floors (water, lava, wood, brick, marble, ...) with
// FloType.rgb === 0 (the client draws a bitmap texture there instead, which this
// terrain-only renderer doesn't have) - matched by debugname substring to a small
// hand-picked substitute so those tiles don't render solid black. This is the
// "tasteful heuristic" fallback layered on top of real flo mapcolors, not a
// replacement for them.
const TEXTURE_COLOR_FALLBACK: [RegExp, number][] = [
    [/water|fountain/i, 0x3d6d96],
    [/lava/i, 0xb5451e],
    [/marble/i, 0xc9c9c4],
    [/wood/i, 0x8a5a2b],
    [/brick/i, 0x8a4b3a],
    [/pebble/i, 0x8f8674],
    [/stone|cliff_textured/i, 0x6e6e6e],
    [/elfbrick/i, 0x6b7a4a],
    [/black/i, 0x1a1a1a]
];
const TEXTURE_COLOR_DEFAULT = 0x555555;

let floColorCache: Map<number, number> | null = null;

function resolveFloColor(id: number): number {
    if (floColorCache === null) {
        floColorCache = new Map();
    }

    const cached = floColorCache.get(id);
    if (cached !== undefined) {
        return cached;
    }

    const flo = FloType.get(id);
    let color: number;
    if (flo.debugname && /^invisible/i.test(flo.debugname)) {
        // debug/hidden floors (rgb=0xff00ff in this content set) are never actually
        // drawn by the real client - rendering them as loud magenta would invent
        // fake "content" on the map, so treat them the same as no-data.
        color = VOID_RGB;
    } else if (flo.rgb !== 0) {
        color = flo.rgb;
    } else {
        const name = flo.debugname ?? '';
        const match = TEXTURE_COLOR_FALLBACK.find(([re]) => re.test(name));
        color = match ? match[1] : TEXTURE_COLOR_DEFAULT;
    }

    floColorCache.set(id, color);
    return color;
}

// Replicates Worldmap.ts's land-data decode loop (lines ~164-213), but only keeps
// enough to resolve a color per tile instead of re-packing worldmap.jag's format.
function decodeSquareColors(landData: Uint8Array, baseLevel: number): Uint8Array {
    const flags: number[][][] = [];
    const overlayIds: number[][][] = [];
    const underlayIds: number[][][] = [];
    for (let level = 0; level < 4; level++) {
        flags[level] = [];
        overlayIds[level] = [];
        underlayIds[level] = [];
        for (let x = 0; x < SQUARE_TILES; x++) {
            flags[level][x] = new Array(SQUARE_TILES).fill(0);
            overlayIds[level][x] = new Array(SQUARE_TILES).fill(-1);
            underlayIds[level][x] = new Array(SQUARE_TILES).fill(-1);
        }
    }

    const landBuf = new Packet(landData as Uint8Array);
    for (let level = 0; level < 4; level++) {
        for (let x = 0; x < SQUARE_TILES; x++) {
            for (let z = 0; z < SQUARE_TILES; z++) {
                while (true) {
                    const opcode = landBuf.g1();
                    if (opcode === 0) {
                        break;
                    } else if (opcode === 1) {
                        landBuf.g1();
                        break;
                    }

                    if (opcode <= 49) {
                        overlayIds[level][x][z] = landBuf.g1();
                    } else if (opcode <= 81) {
                        flags[level][x][z] = opcode - 49;
                    } else {
                        underlayIds[level][x][z] = opcode - 81;
                    }
                }
            }
        }
    }

    const rgb = new Uint8Array(SQUARE_TILES * SQUARE_TILES * 3);
    for (let x = 0; x < SQUARE_TILES; x++) {
        for (let z = 0; z < SQUARE_TILES; z++) {
            const bridged = (flags[1][x][z] & 0x2) === 2;
            const actualLevel = (bridged ? 1 : 0) + baseLevel;

            const overlayId = overlayIds[actualLevel]?.[x]?.[z] ?? -1;
            const underlayId = underlayIds[actualLevel]?.[x]?.[z] ?? -1;

            let color = -1;
            if (overlayId !== -1 && FloType.get(overlayId)) {
                color = resolveFloColor(overlayId);
            } else if (underlayId !== -1 && FloType.get(underlayId)) {
                color = resolveFloColor(underlayId);
            }

            const idx = (z * SQUARE_TILES + x) * 3;
            if (color === -1) {
                rgb[idx] = (VOID_RGB >> 16) & 0xff;
                rgb[idx + 1] = (VOID_RGB >> 8) & 0xff;
                rgb[idx + 2] = VOID_RGB & 0xff;
            } else {
                rgb[idx] = (color >> 16) & 0xff;
                rgb[idx + 1] = (color >> 8) & 0xff;
                rgb[idx + 2] = color & 0xff;
            }
        }
    }

    return rgb;
}

// ---- hand-rolled PNG encoding (no new npm dependency; node:zlib does the deflate) ----

let crcTable: Int32Array | null = null;
function getCrcTable(): Int32Array {
    if (crcTable !== null) {
        return crcTable;
    }
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    crcTable = table;
    return table;
}

function crc32(buf: Buffer): number {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// scanlines must already be filter-byte-prefixed (1 + width*3 bytes per row, filter
// type 0/None throughout - simplest correct encoding; leaves some compression on the
// table versus per-row Paeth/Up filtering, acceptable for a build-time asset).
function encodePng(width: number, height: number, scanlines: Buffer): Buffer {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8; // bit depth
    ihdrData[9] = 2; // color type: truecolor (RGB)
    ihdrData[10] = 0; // compression method
    ihdrData[11] = 0; // filter method
    ihdrData[12] = 0; // interlace method
    const ihdr = pngChunk('IHDR', ihdrData);

    const idatData = zlib.deflateSync(scanlines, { level: 6 });
    const idat = pngChunk('IDAT', idatData);

    const iend = pngChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdr, idat, iend]);
}

// ---- layer assembly ----

interface LayerBounds {
    minMapX: number;
    maxMapX: number;
    minMapZ: number;
    maxMapZ: number;
    minAbsX: number;
    maxAbsX: number;
    minAbsZ: number;
    maxAbsZ: number;
    widthPx: number;
    heightPx: number;
}

function computeBounds(squares: SquareColors[]): LayerBounds {
    let minMapX = Infinity;
    let maxMapX = -Infinity;
    let minMapZ = Infinity;
    let maxMapZ = -Infinity;
    for (const sq of squares) {
        minMapX = Math.min(minMapX, sq.mapX);
        maxMapX = Math.max(maxMapX, sq.mapX);
        minMapZ = Math.min(minMapZ, sq.mapZ);
        maxMapZ = Math.max(maxMapZ, sq.mapZ);
    }

    const minAbsX = minMapX * SQUARE_TILES;
    const maxAbsX = (maxMapX + 1) * SQUARE_TILES - 1;
    const minAbsZ = minMapZ * SQUARE_TILES;
    const maxAbsZ = (maxMapZ + 1) * SQUARE_TILES - 1;

    return {
        minMapX,
        maxMapX,
        minMapZ,
        maxMapZ,
        minAbsX,
        maxAbsX,
        minAbsZ,
        maxAbsZ,
        widthPx: (maxAbsX - minAbsX + 1) * PX_PER_TILE,
        heightPx: (maxAbsZ - minAbsZ + 1) * PX_PER_TILE
    };
}

// pixelX = (absX - minAbsX) * PX_PER_TILE
// pixelY = (maxAbsZ - absZ) * PX_PER_TILE   -- flipped so north (high Z) renders at the top
function renderLayer(squares: SquareColors[], bounds: LayerBounds): Buffer {
    const stride = 1 + bounds.widthPx * 3;
    const raw = Buffer.alloc(stride * bounds.heightPx);

    // fill background with the void color (filter byte for every row stays 0/None,
    // which is already what Buffer.alloc's zero-fill gives us).
    for (let y = 0; y < bounds.heightPx; y++) {
        const rowStart = y * stride;
        for (let x = 0; x < bounds.widthPx; x++) {
            const off = rowStart + 1 + x * 3;
            raw[off] = (VOID_RGB >> 16) & 0xff;
            raw[off + 1] = (VOID_RGB >> 8) & 0xff;
            raw[off + 2] = VOID_RGB & 0xff;
        }
    }

    for (const sq of squares) {
        for (let lz = 0; lz < SQUARE_TILES; lz++) {
            const absZ = sq.mapZ * SQUARE_TILES + lz;
            const tileRow = bounds.maxAbsZ - absZ;
            const pixelY0 = tileRow * PX_PER_TILE;

            for (let lx = 0; lx < SQUARE_TILES; lx++) {
                const absX = sq.mapX * SQUARE_TILES + lx;
                const tileCol = absX - bounds.minAbsX;
                const pixelX0 = tileCol * PX_PER_TILE;

                const cidx = (lz * SQUARE_TILES + lx) * 3;
                const r = sq.rgb[cidx];
                const g = sq.rgb[cidx + 1];
                const b = sq.rgb[cidx + 2];

                for (let dy = 0; dy < PX_PER_TILE; dy++) {
                    const rowStart = (pixelY0 + dy) * stride;
                    for (let dx = 0; dx < PX_PER_TILE; dx++) {
                        const off = rowStart + 1 + (pixelX0 + dx) * 3;
                        raw[off] = r;
                        raw[off + 1] = g;
                        raw[off + 2] = b;
                    }
                }
            }
        }
    }

    return raw;
}

async function main(): Promise<void> {
    const zipPath = 'data/pack/.cache/maps-server.zip';
    if (!fs.existsSync(zipPath)) {
        printWarning(`RenderWorldmapPng: ${zipPath} is missing - run tools/pack/Build.ts (or at least a map pack pass) first`);
        process.exitCode = 1;
        return;
    }

    FloType.load('data/pack');
    if (FloType.configs.length === 0) {
        printWarning('RenderWorldmapPng: FloType loaded zero configs - flo mapcolors will be unavailable, output will be all-void');
    }

    const serverStore = openArtifactStore('maps-server');

    // Enumerate candidate mapsquares by listing content/maps/*.jm2 directly instead of
    // going through tools/pack/PackFile.ts's MapPack: MapPack's validateFilesPack
    // validator only populates correctly on a SECOND .reload() in a standalone tsx
    // run (some import-order interaction leaves Environment.build.srcDir/PackFile's
    // revalidation resolving empty on the first pass) - reproducible outside this
    // tool too, so it's a pack-loader quirk, not specific to this file. Reading the
    // filenames directly sidesteps it entirely; the actual map DATA still comes from
    // the maps-server.zip artifact store (serverStore below), same as Worldmap.ts.
    const mapsDir = path.join(Environment.build.srcDir, 'maps');
    const mapFiles = fs.readdirSync(mapsDir).filter(name => /^m\d+_\d+\.jm2$/.test(name));

    const surfaceSquares: SquareColors[] = [];
    const undergroundSquares: SquareColors[] = [];

    for (const file of mapFiles) {
        const mapName = file.slice(0, -'.jm2'.length);
        if (!serverStore.has(mapName)) {
            continue;
        }

        const [mapX, mapZ] = mapName
            .substring(1)
            .split('_')
            .map(x => parseInt(x, 10));
        if (!Number.isInteger(mapX) || !Number.isInteger(mapZ)) {
            continue;
        }

        const landData = serverStore.read(mapName);
        if (!landData) {
            continue;
        }

        // same one-off exception Worldmap.ts carries for the underground pass square.
        const baseLevel = mapX === 33 && mapZ >= 71 && mapZ <= 73 ? 1 : 0;

        const rgb = decodeSquareColors(landData, baseLevel);
        const entry: SquareColors = { mapX, mapZ, rgb };

        // +100-mapsquare convention: mapZ >= 100 is the underground layer.
        if (mapZ >= 100) {
            undergroundSquares.push(entry);
        } else {
            surfaceSquares.push(entry);
        }
    }

    printInfo(`RenderWorldmapPng: decoded ${surfaceSquares.length} surface square(s), ${undergroundSquares.length} underground square(s)`);

    if (surfaceSquares.length === 0 && undergroundSquares.length === 0) {
        printWarning('RenderWorldmapPng: no mapsquares found in the artifact store - nothing to render');
        process.exitCode = 1;
        return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const meta: Record<string, unknown> = { pxPerTile: PX_PER_TILE };

    if (surfaceSquares.length > 0) {
        const bounds = computeBounds(surfaceSquares);
        const raw = renderLayer(surfaceSquares, bounds);
        const png = encodePng(bounds.widthPx, bounds.heightPx, raw);
        fs.writeFileSync(path.join(OUT_DIR, 'worldmap-surface.png'), png);
        meta.surface = bounds;
        printInfo(`RenderWorldmapPng: wrote worldmap-surface.png (${bounds.widthPx}x${bounds.heightPx}, ${png.length} bytes)`);
    }

    if (undergroundSquares.length > 0) {
        const bounds = computeBounds(undergroundSquares);
        const raw = renderLayer(undergroundSquares, bounds);
        const png = encodePng(bounds.widthPx, bounds.heightPx, raw);
        fs.writeFileSync(path.join(OUT_DIR, 'worldmap-underground.png'), png);
        meta.underground = bounds;
        printInfo(`RenderWorldmapPng: wrote worldmap-underground.png (${bounds.widthPx}x${bounds.heightPx}, ${png.length} bytes)`);
    }

    fs.writeFileSync(path.join(OUT_DIR, 'worldmap-meta.json'), JSON.stringify(meta, null, 2));
    printInfo(`RenderWorldmapPng: wrote ${path.join(OUT_DIR, 'worldmap-meta.json')}`);
}

main().catch(err => {
    printWarning(`RenderWorldmapPng: fatal error (${err instanceof Error ? err.stack ?? err.message : err})`);
    process.exitCode = 1;
});
