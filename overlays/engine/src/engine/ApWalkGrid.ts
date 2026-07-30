// Archipelago pathfinding helper - the walkability grid (docs/tracker-map.md
// "Pathfinding helper"). Shared format definition + runtime reader for
// data/config/ap-walk-grid.bin, the door-opened, step-validated movement grid the
// path helper floods over.
//
// ---- Why a separate grid, when the running server already has full collision ----
// GameMap.init() populates the routefinder singleton with every mapsquare's collision
// at boot, so `canTravel` is available live. But static map data places doors CLOSED
// (opening one is a runtime script action, not a map-data fact), so a live flood is
// walled into one room at a time - useless for "how do I get from here to Varrock".
// BuildRegionGraph.ts already solves exactly that with its curated door-opening
// heuristic (see its header), so this grid is emitted by that same tool, from that same
// collision state, in the same pass. Grid and region-graph.json can therefore never
// disagree about what is walkable - they are two views of one flood.
//
// ---- Encoding ----
// One byte per tile: bit d set = a player standing on this tile may step in direction
// d (target tile walkable AND the engine's own canTravel allows the step, so wall and
// door direction flags are honored exactly). Plus a 1-bit-per-tile plane recording
// whether the tile itself is stand-on-able, which edge bits alone cannot express (a
// walkable tile fully enclosed by walls has mask 0, and so would be indistinguishable
// from solid rock).
//
// Diagonals get their own bits rather than being derived from the two cardinals: RS
// corner rules live inside canTravel, and re-deriving them here would be a guess.
//
// ---- Cost model ----
// A diagonal step costs the same game tick as a cardinal one, so a uniform-cost BFS
// over these 8 edges measures *movement steps* - i.e. real travel time (one tick per
// step walking, one per two steps running) - not raw tile distance. That is the metric
// the path helper minimizes.

import fs from 'fs';

import { printInfo, printWarning } from '#/util/Logger.js';

export const WALK_GRID_PATH = 'data/config/ap-walk-grid.bin';

// "APWG"
export const WALK_GRID_MAGIC = 0x41505747;
export const WALK_GRID_VERSION = 1;

export const WALK_GRID_LEVELS = 4;
export const WALK_GRID_SQUARE_TILES = 64;

const TILES_PER_SQUARE = WALK_GRID_LEVELS * WALK_GRID_SQUARE_TILES * WALK_GRID_SQUARE_TILES; // 16384
const WALKABLE_PLANE_BYTES = TILES_PER_SQUARE / 8; // 2048
export const WALK_GRID_BLOCK_BYTES = TILES_PER_SQUARE + WALKABLE_PLANE_BYTES; // 18432
const HEADER_BYTES = 12;
const INDEX_ENTRY_BYTES = 4;

/**
 * Direction order - the bit index of each step in a tile's mask. z+ is north, matching
 * the engine's own coordinate convention. Cardinals first so a "cardinals only" caller
 * can mask with 0x0f.
 */
export const WALK_DIR_DX = [0, 1, 0, -1, 1, 1, -1, -1] as const;
export const WALK_DIR_DZ = [1, 0, -1, 0, 1, -1, -1, 1] as const;
export const WALK_DIR_NAME = ['north', 'east', 'south', 'west', 'north-east', 'south-east', 'south-west', 'north-west'] as const;
export const WALK_DIR_COUNT = 8;

/** Local tile index within a square block: level-major, then row-major (localZ*64+localX). */
export function walkGridLocalIndex(localX: number, localZ: number, level: number): number {
    return level * WALK_GRID_SQUARE_TILES * WALK_GRID_SQUARE_TILES + localZ * WALK_GRID_SQUARE_TILES + localX;
}

/** Square key used by both the writer's index and the reader's block map. */
export function walkGridSquareKey(mapX: number, mapZ: number): number {
    // mapZ reaches 161 (the +100-mapsquare underground convention), mapX 56 - 9 bits of
    // headroom each keeps this a small dense integer key rather than a string.
    return (mapX << 9) | mapZ;
}

/**
 * Serializes a set of per-mapsquare blocks into the on-disk grid. `blocks` maps
 * "mapX_mapZ" to a WALK_GRID_BLOCK_BYTES-long buffer laid out as [masks..., walkable
 * bitset...]. Used by BuildRegionGraph.ts; kept here so writer and reader can never
 * drift apart.
 */
export function encodeWalkGrid(blocks: Map<string, Uint8Array>): Uint8Array {
    const keys = [...blocks.keys()].sort();
    const total = HEADER_BYTES + keys.length * INDEX_ENTRY_BYTES + keys.length * WALK_GRID_BLOCK_BYTES;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);

    view.setUint32(0, WALK_GRID_MAGIC, false);
    out[4] = WALK_GRID_VERSION;
    out[5] = WALK_GRID_LEVELS;
    out[6] = WALK_GRID_SQUARE_TILES;
    out[7] = 0;
    view.setUint32(8, keys.length, false);

    let indexPos = HEADER_BYTES;
    let dataPos = HEADER_BYTES + keys.length * INDEX_ENTRY_BYTES;
    for (const key of keys) {
        const [mapX, mapZ] = key.split('_').map(Number);
        const block = blocks.get(key)!;
        if (block.length !== WALK_GRID_BLOCK_BYTES) {
            throw new Error(`walk grid block ${key} is ${block.length} bytes, expected ${WALK_GRID_BLOCK_BYTES}`);
        }
        view.setUint16(indexPos, mapX, false);
        view.setUint16(indexPos + 2, mapZ, false);
        indexPos += INDEX_ENTRY_BYTES;

        out.set(block, dataPos);
        dataPos += WALK_GRID_BLOCK_BYTES;
    }

    return out;
}

export interface WalkGridStats {
    squareCount: number;
    walkableTiles: number;
}

/**
 * Random-access reader over the grid. Holds one Uint8Array per loaded mapsquare (~18 KiB
 * each, ~8.9 MiB for the whole world) and answers per-tile questions with pure index
 * arithmetic - no decode step, so load is a file read and nothing more.
 */
export class WalkGrid {
    private readonly blocks = new Map<number, Uint8Array>();
    readonly stats: WalkGridStats;

    constructor(raw: Uint8Array) {
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        if (raw.byteLength < HEADER_BYTES) {
            throw new Error('walk grid is truncated (shorter than its header)');
        }
        const magic = view.getUint32(0, false);
        if (magic !== WALK_GRID_MAGIC) {
            throw new Error(`walk grid magic is 0x${magic.toString(16)}, expected 0x${WALK_GRID_MAGIC.toString(16)}`);
        }
        const version = raw[4];
        if (version !== WALK_GRID_VERSION) {
            throw new Error(`walk grid version is ${version}, expected ${WALK_GRID_VERSION} - re-run BuildRegionGraph.ts`);
        }
        if (raw[5] !== WALK_GRID_LEVELS || raw[6] !== WALK_GRID_SQUARE_TILES) {
            throw new Error(`walk grid geometry is ${raw[5]} level(s) of ${raw[6]} tiles, expected ${WALK_GRID_LEVELS}x${WALK_GRID_SQUARE_TILES}`);
        }

        const squareCount = view.getUint32(8, false);
        const expected = HEADER_BYTES + squareCount * INDEX_ENTRY_BYTES + squareCount * WALK_GRID_BLOCK_BYTES;
        if (raw.byteLength !== expected) {
            throw new Error(`walk grid is ${raw.byteLength} bytes, expected ${expected} for ${squareCount} mapsquare(s)`);
        }

        let indexPos = HEADER_BYTES;
        let dataPos = HEADER_BYTES + squareCount * INDEX_ENTRY_BYTES;
        let walkableTiles = 0;
        for (let i = 0; i < squareCount; i++) {
            const mapX = view.getUint16(indexPos, false);
            const mapZ = view.getUint16(indexPos + 2, false);
            indexPos += INDEX_ENTRY_BYTES;

            const block = raw.subarray(dataPos, dataPos + WALK_GRID_BLOCK_BYTES);
            dataPos += WALK_GRID_BLOCK_BYTES;
            this.blocks.set(walkGridSquareKey(mapX, mapZ), block);

            for (let b = 0; b < WALKABLE_PLANE_BYTES; b++) {
                const byte = block[TILES_PER_SQUARE + b];
                // popcount of a byte, cheap enough at 2048 bytes x ~483 squares.
                let v = byte;
                while (v !== 0) {
                    walkableTiles += v & 1;
                    v >>= 1;
                }
            }
        }

        this.stats = { squareCount, walkableTiles };
    }

    private blockAt(x: number, z: number): Uint8Array | undefined {
        return this.blocks.get(walkGridSquareKey(x >> 6, z >> 6));
    }

    /** True if a player can stand on this tile at all. False outside the loaded world. */
    isWalkable(x: number, z: number, level: number): boolean {
        const block = this.blockAt(x, z);
        if (!block) {
            return false;
        }
        const idx = walkGridLocalIndex(x & 63, z & 63, level);
        return (block[TILES_PER_SQUARE + (idx >> 3)] & (1 << (idx & 7))) !== 0;
    }

    /** Step mask for this tile: bit d set = direction d is a legal step. 0 outside the world. */
    maskAt(x: number, z: number, level: number): number {
        const block = this.blockAt(x, z);
        if (!block) {
            return 0;
        }
        return block[walkGridLocalIndex(x & 63, z & 63, level)];
    }

    /**
     * Resolves a "gameplay-meaningful" coordinate (entrance trigger tile, quest anchor,
     * map label) to a tile a player can actually stand on, probing outward ring by ring.
     * Mirrors RegionGraph.resolveRegion's rationale: loc footprints - ladders, doors,
     * statues, signposts - routinely occupy their own trigger tile without being the
     * tile the player stands on. Returns null if nothing walkable is within `radius`.
     */
    resolveStandTile(x: number, z: number, level: number, radius = 3): { x: number; z: number; level: number } | null {
        if (this.isWalkable(x, z, level)) {
            return { x, z, level };
        }
        for (let r = 1; r <= radius; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) {
                        continue; // only the new ring at this radius.
                    }
                    if (this.isWalkable(x + dx, z + dz, level)) {
                        return { x: x + dx, z: z + dz, level };
                    }
                }
            }
        }
        return null;
    }

    get squareCount(): number {
        return this.blocks.size;
    }
}

let cached: WalkGrid | null = null;
let loadFailed = false;

/**
 * Loads (and caches) the grid. Returns null - never throws - when the file is missing or
 * unreadable: the path helper is a convenience, and a world without a built grid should
 * lose the helper, not fail to boot. Warns once, then stays quiet.
 */
export function getWalkGrid(): WalkGrid | null {
    if (cached !== null) {
        return cached;
    }
    if (loadFailed) {
        return null;
    }

    try {
        if (!fs.existsSync(WALK_GRID_PATH)) {
            loadFailed = true;
            printInfo(`AP path helper: no ${WALK_GRID_PATH}, ::appath is unavailable (run BuildRegionGraph.ts to build it)`);
            return null;
        }
        const grid = new WalkGrid(fs.readFileSync(WALK_GRID_PATH));
        cached = grid;
        printInfo(`AP path helper: loaded walk grid, ${grid.stats.squareCount} mapsquare(s), ${grid.stats.walkableTiles} walkable tile(s)`);
        return grid;
    } catch (err) {
        loadFailed = true;
        printWarning(`AP path helper: failed to load ${WALK_GRID_PATH}, ::appath is unavailable (${err instanceof Error ? err.message : err})`);
        return null;
    }
}

/** Drops the cached grid so the next lookup re-reads the file (post-rebuild live swap). */
export function reloadWalkGrid(): void {
    cached = null;
    loadFailed = false;
}
