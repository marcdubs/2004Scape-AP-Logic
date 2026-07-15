// Builds region-graph.json: a flood-fill of every walkable tile in the packed map data
// into connected-component "regions", per level (0-3), for the Archipelago seed
// validator (docs/entrance-logic.md Workstream C). Offline tool - run with tsx from
// Server/engine, never boots the game server.
//
// ---- Data source (and why) ----
// Collision comes from the SAME code path the running server uses
// (src/engine/routefinder/index.ts's `routefinder` singleton + CollisionEngine), fed by
// replaying content/scripts land+loc data exactly the way src/engine/GameMap.ts's
// init() does (loadGround/loadLocations, copied here rather than imported so this tool
// never pulls in World.ts/Zone.ts/NpcType/ObjType - GameMap.ts's own exported
// changeLocCollision free function IS reused verbatim, see `applyLocCollision` below).
// The routefinder module is pure TS (no wasm, no native addon - verified by reading
// index.ts/CollisionEngine.ts/StepValidator.ts), so it runs standalone under tsx exactly
// like RenderWorldmapPng.ts's FloType-only read does for terrain colors. Land+loc bytes
// are read from data/pack/.cache/maps-server.zip (the same artifact RenderWorldmapPng.ts
// and GameMap.ts itself consume), not the human-editable content/maps/*.jm2 text files -
// jm2's plain-text MAP section only carries height/underlay/overlay for the map editor,
// not the settings byte tile-block flag or verified loc angle/shape encoding, so it is
// NOT a reliable collision source. The zip is the real compiled data; picking it
// over jm2 avoids re-deriving collision semantics that GameMap.ts already gets exactly
// right.
//
// Once collision is populated, movement between adjacent tiles is checked with the
// engine's own `canTravel` (src/engine/routefinder/StepValidator.ts) rather than a
// hand-rolled "is this tile blocked" mask - that function already encodes the full
// wall-direction rules (BLOCK_NORTH/SOUTH/EAST/WEST composite masks), so edges in this
// graph match real player pathing exactly, not an approximation of it.
//
// ---- Door handling (the "IMPORTANT SUBTLETY" from the design brief) ----
// Static map data places doors CLOSED (their collision is baked in as blocked - opening
// is a runtime script action, not a map-data fact), so a naive flood-fill fragments the
// world into one region per room, which is useless for reachability logic. Distinguishing
// "gated" doors (Champions' Guild) from ordinary ones is NOT possible from loc config
// data alone - verified directly: championdoor's .loc entry (`name=Door`, `op1=Open`) is
// structurally identical to a completely vanilla, ungated door; the QP check lives only
// in the door's .rs2 script, invisible to map/config data. So the heuristic here is
// deliberately two-tier:
//   1. Any blockwalk loc that LOOKS openable (op menu entry matching /open|enter|climb-?
//      over|pick-?lock|unlock/i, OR debugname/display-name matching /door|gate|trapdoor|
//      hatch|portcullis/i) has its collision SKIPPED ENTIRELY (never blocks) - this is
//      the overwhelming majority of doors in the game and treating them as open is the
//      only way to get a game-shaped graph (a few thousand tiny per-room regions instead
//      of "Varrock" would defeat the entire purpose of this tool).
//   2. EXCEPT: if that same tile falls within `margin` (2) tiles of an
//      ap-gated-areas.json box (Workstream A's curated, authoritative gate list), the
//      override is suppressed and the door's real (closed) collision is applied instead.
//      Since a curated gated area is normally enclosed with exactly this one opening,
//      this reliably carves it into its own isolated region - which ValidateSeed then
//      re-joins to its surroundings only once the area's `require` is satisfied. Missing
//      ap-gated-areas.json (Workstream A hasn't landed yet, or this is a scratch run) =
//      every door opens, matching the fail-open convention used everywhere else in this
//      project; the graph just has no gated micro-regions to re-join in that case.
// This is a heuristic, not a script-level truth, and is documented as such: an
// uncurated quest-gated door (not yet in ap-gated-areas.json) will be silently treated
// as open. That is a conservative failure mode for THIS tool's purpose (proving a seed
// beatable) - it can only produce false "reachable", never false "blocked" - and the
// fix is adding the area to ap-gated-areas.json (Workstream A's file), not this tool.
//
// Non-door blockwalk locs (trees, rocks, walls, statues, large buildings) are left
// exactly as the real collision data says - they are genuine obstacles, not entrances.

import fs from 'fs';
import path from 'path';

import { unzipSync } from 'fflate';

import LocType from '#/cache/config/LocType.js';
import Packet from '#/io/Packet.js';
import { CollisionFlag, CollisionType, LocAngle, LocLayer, allocateIfAbsent, canTravel, changeFloor, changeLoc, changeWall, isFlagged, locShapeLayer } from '#/engine/routefinder/index.js';

import { GatedAreaBox, loadGatedAreas, tileNearBox } from './GatedAreas.js';

const PACK_DIR = 'data/pack';
const ZIP_PATH = path.join(PACK_DIR, '.cache', 'maps-server.zip');
const CONFIG_DIR = process.argv.includes('--config-dir') ? process.argv[process.argv.indexOf('--config-dir') + 1] : 'data/config';
const OUT_PATH = path.join('tools', 'logic', 'region-graph.json');
const GATED_DOOR_MARGIN = 2; // tiles - see the door-handling comment above.

const LEVELS = 4;
const SQUARE_TILES = 64;

// ---- loc "is this an openable door/gate" heuristic ----

const OPENABLE_OP_RE = /^(open|enter|climb-?over|pick-?lock|unlock|pass|walk-?through)/i;
const OPENABLE_NAME_RE = /door|gate|trapdoor|hatch|portcullis/i;

function isOpenableDoorLoc(type: LocType): boolean {
    if (!type.blockwalk) {
        return false; // already walkable, nothing to override.
    }
    if (type.op && type.op.some(o => o !== null && OPENABLE_OP_RE.test(o.trim()))) {
        return true;
    }
    if (type.name && OPENABLE_NAME_RE.test(type.name)) {
        return true;
    }
    if (type.debugname && OPENABLE_NAME_RE.test(type.debugname)) {
        return true;
    }
    return false;
}

// ---- verbatim port of GameMap.ts's exported changeLocCollision (see file header for
// why this is copied rather than imported: importing GameMap.ts pulls in World.ts,
// Zone.ts, NpcType/ObjType and their side effects, none of which this tool needs). ----
function applyLocCollision(shape: number, angle: number, blockrange: boolean, length: number, width: number, active: number, x: number, z: number, level: number): void {
    const layer = locShapeLayer(shape);
    if (layer === LocLayer.WALL) {
        changeWall(x, z, level, angle, shape, blockrange, false, true);
    } else if (layer === LocLayer.GROUND) {
        if (angle === LocAngle.NORTH || angle === LocAngle.SOUTH) {
            changeLoc(x, z, level, length, width, blockrange, false, true);
        } else {
            changeLoc(x, z, level, width, length, blockrange, false, true);
        }
    } else if (layer === LocLayer.GROUND_DECOR) {
        if (active === 1) {
            changeFloor(x, z, level, true);
        }
    }
}

function packCoord(x: number, z: number, level: number): number {
    return (z & 0x3f) | ((x & 0x3f) << 6) | ((level & 0x3) << 12);
}
function unpackCoord(packed: number): { x: number; z: number; level: number } {
    return { z: packed & 0x3f, x: (packed >> 6) & 0x3f, level: (packed >> 12) & 0x3 };
}

// ---- ground (land) loading - port of GameMap.loadGround, F2P filtering removed
// (world.json has members:true, so vanilla GameMap never skips a tile either). ----

const GameMapFlags = { OPEN: 0x0, BLOCK_MAP_SQUARE: 0x1, LINK_BELOW: 0x2, REMOVE_ROOFS: 0x4 };

function loadGround(lands: Int8Array, packet: Packet, mapsquareX: number, mapsquareZ: number): void {
    for (let level = 0; level < LEVELS; level++) {
        for (let x = 0; x < SQUARE_TILES; x++) {
            for (let z = 0; z < SQUARE_TILES; z++) {
                for (;;) {
                    const opcode = packet.g1();
                    if (opcode === 0) {
                        break;
                    } else if (opcode === 1) {
                        packet.pos++;
                        break;
                    }
                    if (opcode <= 49) {
                        packet.pos++;
                    } else if (opcode <= 81) {
                        lands[packCoord(x, z, level)] = opcode - 49;
                    }
                }
            }
        }
    }
    for (let level = 0; level < LEVELS; level++) {
        for (let x = 0; x < SQUARE_TILES; x++) {
            const absoluteX = x + mapsquareX;
            for (let z = 0; z < SQUARE_TILES; z++) {
                const absoluteZ = z + mapsquareZ;
                const land = lands[packCoord(x, z, level)];
                if ((land & GameMapFlags.BLOCK_MAP_SQUARE) !== GameMapFlags.BLOCK_MAP_SQUARE) {
                    continue;
                }
                const bridged = (level === 1 ? land & GameMapFlags.LINK_BELOW : lands[packCoord(x, z, 1)] & GameMapFlags.LINK_BELOW) === GameMapFlags.LINK_BELOW;
                const actualLevel = bridged ? level - 1 : level;
                if (actualLevel < 0) {
                    continue;
                }
                changeFloor(absoluteX, absoluteZ, actualLevel, true);
            }
        }
    }
}

// ---- loc loading - port of GameMap.loadLocations, with the door-open heuristic
// inserted before applyLocCollision. ----

function loadLocations(lands: Int8Array, packet: Packet, mapsquareX: number, mapsquareZ: number, gatedBoxes: GatedAreaBox[], stats: { doorsOpened: number; doorsGated: number }): void {
    let locId = -1;
    let locIdOffset = packet.gsmarts();
    while (locIdOffset !== 0) {
        locId += locIdOffset;

        let coord = 0;
        let coordOffset = packet.gsmarts();

        while (coordOffset !== 0) {
            const { x, z, level } = unpackCoord((coord += coordOffset - 1));
            const info = packet.g1();
            coordOffset = packet.gsmarts();

            const absoluteX = x + mapsquareX;
            const absoluteZ = z + mapsquareZ;

            const bridged = (level === 1 ? lands[coord] & GameMapFlags.LINK_BELOW : lands[packCoord(x, z, 1)] & GameMapFlags.LINK_BELOW) === GameMapFlags.LINK_BELOW;
            const actualLevel = bridged ? level - 1 : level;
            if (actualLevel < 0) {
                continue;
            }

            const type = LocType.get(locId);
            if (!type) {
                continue; // parity with GameMap.ts's printFatalError path - shouldn't happen against a matching pack.
            }

            const shape = info >> 2;
            const angle = info & 0x3;

            if (type.blockwalk) {
                const openable = isOpenableDoorLoc(type);
                const nearGate = openable && gatedBoxes.some(box => tileNearBox(actualLevel, absoluteX, absoluteZ, box, GATED_DOOR_MARGIN));
                if (openable && !nearGate) {
                    stats.doorsOpened++;
                    // deliberately skip applyLocCollision - see file header "Door handling".
                } else {
                    if (nearGate) {
                        stats.doorsGated++;
                    }
                    applyLocCollision(shape, angle, type.blockrange, type.length, type.width, type.active, absoluteX, absoluteZ, actualLevel);
                }
            }
        }
        locIdOffset = packet.gsmarts();
    }
}

// ---- flood fill ----

interface RegionInfo {
    id: number;
    level: number;
    tileCount: number;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    sampleX: number;
    sampleZ: number;
}

async function main(): Promise<void> {
    const t0 = Date.now();

    if (!fs.existsSync(ZIP_PATH)) {
        console.error(`BuildRegionGraph: ${ZIP_PATH} missing - run tools/pack/Build.ts (or at least a map pack pass) first`);
        process.exitCode = 1;
        return;
    }

    LocType.load(PACK_DIR);
    if (LocType.count === 0) {
        console.error('BuildRegionGraph: LocType loaded zero configs - cannot determine door/blockwalk data, aborting');
        process.exitCode = 1;
        return;
    }

    const gated = loadGatedAreas(CONFIG_DIR);
    console.log(`BuildRegionGraph: ap-gated-areas.json ${gated.present ? `present (${gated.areas.length} area(s))` : 'ABSENT (fail-open: no gated doors will be closed)'}`);

    const zipEntries = unzipSync(fs.readFileSync(ZIP_PATH));
    const mapKeys = Object.keys(zipEntries).filter(k => k[0] === 'm');

    const gatedBoxes = gated.areas.flatMap(a => a.boxes);

    // squareKey "mx_mz" -> present. Used to bound the flood-fill so unloaded/void
    // mapsquares never act as connective tissue between regions (CollisionEngine.isFlagged
    // defaults an unallocated zone to "open", which would be wrong for tiles that were
    // never part of the game world at all).
    const loadedSquares = new Set<string>();

    let doorsOpened = 0;
    let doorsGated = 0;

    for (const key of mapKeys) {
        const [mxStr, mzStr] = key.slice(1).split('_');
        const mx = Number(mxStr);
        const mz = Number(mzStr);
        if (!Number.isInteger(mx) || !Number.isInteger(mz)) {
            continue;
        }
        const locEntry = zipEntries[`l${mx}_${mz}`];
        if (!locEntry) {
            continue; // land data with no loc data would be unusual - skip defensively.
        }

        loadedSquares.add(`${mx}_${mz}`);

        const mapsquareX = mx << 6;
        const mapsquareZ = mz << 6;

        // Pre-allocate every 8x8-tile collision zone in this mapsquare, all 4 levels,
        // BEFORE loading any collision data. This matters: CollisionEngine.get() (which
        // canTravel/StepValidator read) returns CollisionFlag.NULL - all bits set, i.e.
        // "blocked in every direction" - for a zone that was never allocated, as a
        // safety sentinel for "outside the loaded world" (see CollisionEngine.ts). A
        // zone only gets auto-allocated as a side effect of add()/remove() being called
        // on it, so a totally open field with zero walls/blocked tiles would otherwise
        // NEVER get allocated and every canTravel() check crossing it would read NULL and
        // report blocked - which is exactly what happened before this fix was added
        // (verified: first run produced ~5.8M regions off ~7M walkable tiles, i.e.
        // essentially no connectivity at all). GameMap.ts does the equivalent allocation
        // with an x%7==0/z%7==0 stride hack tied to its own loop structure; this does the
        // same job directly at the real zone granularity (8-tile stride covers all 8
        // zone columns/rows in a 64-tile mapsquare exactly).
        for (let level = 0; level < LEVELS; level++) {
            for (let lx = 0; lx < SQUARE_TILES; lx += 8) {
                for (let lz = 0; lz < SQUARE_TILES; lz += 8) {
                    allocateIfAbsent(mapsquareX + lx, mapsquareZ + lz, level);
                }
            }
        }

        const lands = new Int8Array(LEVELS * SQUARE_TILES * SQUARE_TILES);
        loadGround(lands, new Packet(zipEntries[key]), mapsquareX, mapsquareZ);

        const stats = { doorsOpened: 0, doorsGated: 0 };
        loadLocations(lands, new Packet(locEntry), mapsquareX, mapsquareZ, gatedBoxes, stats);
        doorsOpened += stats.doorsOpened;
        doorsGated += stats.doorsGated;
    }

    console.log(`BuildRegionGraph: loaded ${loadedSquares.size} mapsquare(s) in ${Date.now() - t0}ms; doors opened=${doorsOpened}, doors kept gated (near a curated area)=${doorsGated}`);

    // ---- flood fill ----
    // regionOf: squareKey -> Int32Array(LEVELS*4096), 0 = unassigned (blocked or void),
    // region ids start at 1. Indexed by level*4096 + localZ*64 + localX.
    const regionOf = new Map<string, Int32Array>();
    for (const key of loadedSquares) {
        regionOf.set(key, new Int32Array(LEVELS * SQUARE_TILES * SQUARE_TILES));
    }

    function localIndex(localX: number, localZ: number, level: number): number {
        return level * SQUARE_TILES * SQUARE_TILES + localZ * SQUARE_TILES + localX;
    }

    function getRegionCell(worldX: number, worldZ: number, level: number): { arr: Int32Array; idx: number } | null {
        const mx = worldX >> 6;
        const mz = worldZ >> 6;
        const arr = regionOf.get(`${mx}_${mz}`);
        if (!arr) {
            return null;
        }
        return { arr, idx: localIndex(worldX & 63, worldZ & 63, level) };
    }

    function walkable(worldX: number, worldZ: number, level: number): boolean {
        return !isFlagged(worldX, worldZ, level, CollisionFlag.WALK_BLOCKED);
    }

    const regions: RegionInfo[] = [];
    let nextRegionId = 1;

    // BFS queue as flat arrays (avoid Array.shift() O(n) cost at multi-million-tile scale).
    const queueX = new Int32Array(1 << 20);
    const queueZ = new Int32Array(1 << 20);
    let queueCap = queueX.length;
    let qx = queueX;
    let qz = queueZ;

    const DX = [0, 0, -1, 1];
    const DZ = [-1, 1, 0, 0];

    for (const [key, arr] of regionOf) {
        const [mxStr, mzStr] = key.split('_');
        const mx = Number(mxStr);
        const mz = Number(mzStr);
        const baseX = mx << 6;
        const baseZ = mz << 6;

        for (let level = 0; level < LEVELS; level++) {
            for (let lz = 0; lz < SQUARE_TILES; lz++) {
                for (let lx = 0; lx < SQUARE_TILES; lx++) {
                    const idx = localIndex(lx, lz, level);
                    if (arr[idx] !== 0) {
                        continue; // already assigned by an earlier BFS.
                    }
                    const worldX = baseX + lx;
                    const worldZ = baseZ + lz;
                    if (!walkable(worldX, worldZ, level)) {
                        continue; // stays 0 (not walkable / no region).
                    }

                    // new region - BFS from here.
                    const regionId = nextRegionId++;
                    let head = 0;
                    let tail = 0;
                    qx[tail] = worldX;
                    qz[tail] = worldZ;
                    tail++;
                    arr[idx] = regionId;

                    let tileCount = 0;
                    let minX = worldX;
                    let maxX = worldX;
                    let minZ = worldZ;
                    let maxZ = worldZ;
                    const sampleX = worldX;
                    const sampleZ = worldZ;

                    while (head < tail) {
                        const cx = qx[head];
                        const cz = qz[head];
                        head++;
                        tileCount++;
                        if (cx < minX) minX = cx;
                        if (cx > maxX) maxX = cx;
                        if (cz < minZ) minZ = cz;
                        if (cz > maxZ) maxZ = cz;

                        for (let d = 0; d < 4; d++) {
                            const nx = cx + DX[d];
                            const nz = cz + DZ[d];
                            const cell = getRegionCell(nx, nz, level);
                            if (!cell || cell.arr[cell.idx] !== 0) {
                                continue; // out of loaded bounds, or already visited.
                            }
                            if (!walkable(nx, nz, level)) {
                                continue;
                            }
                            if (!canTravel(level, cx, cz, DX[d], DZ[d], 1, 0, CollisionType.NORMAL)) {
                                continue; // real step-validator check - honors wall/door direction flags.
                            }
                            cell.arr[cell.idx] = regionId;
                            if (tail >= queueCap) {
                                // grow: reallocate and copy (rare at 1M initial capacity for this world size).
                                const newCap = queueCap * 2;
                                const nqx = new Int32Array(newCap);
                                const nqz = new Int32Array(newCap);
                                nqx.set(qx);
                                nqz.set(qz);
                                qx = nqx;
                                qz = nqz;
                                queueCap = newCap;
                            }
                            qx[tail] = nx;
                            qz[tail] = nz;
                            tail++;
                        }
                    }

                    regions.push({ id: regionId, level, tileCount, minX, maxX, minZ, maxZ, sampleX, sampleZ });
                }
            }
        }
    }

    console.log(`BuildRegionGraph: flood fill produced ${regions.length} region(s), ${regions.reduce((a, r) => a + r.tileCount, 0)} walkable tile(s), in ${Date.now() - t0}ms total`);

    // ---- mainland detection: largest surface (level 0, mapZ<100) region containing Lumbridge (3222,3218). ----
    const lumbridgeCell = getRegionCell(3222, 3218, 0);
    let mainlandRegionId = lumbridgeCell ? lumbridgeCell.arr[lumbridgeCell.idx] : 0;
    if (!mainlandRegionId) {
        // Lumbridge tile itself might be a loc footprint (e.g. standing on a rug) - probe a
        // small neighborhood before giving up.
        outer: for (let dz = -2; dz <= 2; dz++) {
            for (let dx = -2; dx <= 2; dx++) {
                const cell = getRegionCell(3222 + dx, 3218 + dz, 0);
                if (cell && cell.arr[cell.idx] !== 0) {
                    mainlandRegionId = cell.arr[cell.idx];
                    break outer;
                }
            }
        }
    }

    // ---- write region-graph.json ----
    // Per-square, per-level RLE (row-major localZ*64+localX iteration order) of region
    // ids - this is small (regions are large & contiguous) and reconstructs to O(1)
    // point lookups cheaply in ValidateSeed (decode once at load, keep as typed arrays).
    const squaresOut: Record<string, Record<string, number[][]>> = {};
    for (const [key, arr] of regionOf) {
        const perLevel: Record<string, number[][]> = {};
        for (let level = 0; level < LEVELS; level++) {
            const runs: number[][] = [];
            let runVal = arr[localIndex(0, 0, level)];
            let runLen = 0;
            for (let i = 0; i < SQUARE_TILES * SQUARE_TILES; i++) {
                const v = arr[level * SQUARE_TILES * SQUARE_TILES + i];
                if (v === runVal) {
                    runLen++;
                } else {
                    runs.push([runVal, runLen]);
                    runVal = v;
                    runLen = 1;
                }
            }
            runs.push([runVal, runLen]);
            if (!(runs.length === 1 && runs[0][0] === 0)) {
                perLevel[String(level)] = runs;
            }
        }
        if (Object.keys(perLevel).length > 0) {
            squaresOut[key] = perLevel;
        }
    }

    const sortedByTileCount = [...regions].sort((a, b) => b.tileCount - a.tileCount);

    const output = {
        meta: {
            generatedAt: new Date().toISOString(),
            levels: LEVELS,
            squareTiles: SQUARE_TILES,
            mapsquaresLoaded: loadedSquares.size,
            regionCount: regions.length,
            walkableTileCount: regions.reduce((a, r) => a + r.tileCount, 0),
            doorsOpened,
            doorsKeptGated: doorsGated,
            gatedAreasFilePresent: gated.present,
            gatedAreaMarginTiles: GATED_DOOR_MARGIN,
            mainlandRegionId,
            encoding:
                'squares["mapX_mapZ"]["level"] is a run-length-encoded array of [regionId, runLength] pairs, ' +
                'row-major over local tiles in localZ*64+localX order (0..4095). regionId 0 = not walkable / no region. ' +
                'World coord -> region: mapX=worldX>>6, mapZ=worldZ>>6, localX=worldX&63, localZ=worldZ&63, index=localZ*64+localX, ' +
                'then find the run containing that index.',
            buildMs: Date.now() - t0
        },
        regions: sortedByTileCount.map(r => ({
            id: r.id,
            level: r.level,
            tileCount: r.tileCount,
            bbox: { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ },
            sampleTile: { level: r.level, x: r.sampleX, z: r.sampleZ }
        })),
        squares: squaresOut
    };

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(output));
    const stat = fs.statSync(OUT_PATH);
    console.log(`BuildRegionGraph: wrote ${OUT_PATH} (${(stat.size / 1024 / 1024).toFixed(2)} MiB)`);
    console.log(`BuildRegionGraph: mainland region id = ${mainlandRegionId} (${sortedByTileCount.findIndex(r => r.id === mainlandRegionId) + 1} of ${regions.length} by size)`);

    console.log('BuildRegionGraph: top 10 regions by tile count:');
    for (const r of sortedByTileCount.slice(0, 10)) {
        console.log(`  id=${r.id} level=${r.level} tiles=${r.tileCount} bbox=(${r.minX},${r.minZ})-(${r.maxX},${r.maxZ}) sample=(${r.sampleX},${r.sampleZ})`);
    }
}

main().catch(err => {
    console.error(`BuildRegionGraph: fatal error (${err instanceof Error ? (err.stack ?? err.message) : err})`);
    process.exitCode = 1;
});
