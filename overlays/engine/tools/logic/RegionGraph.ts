// RegionGraph: shared loader/lookup for BuildRegionGraph.ts's region-graph.json
// (spatial truth for all logic tools). Extracted verbatim from ValidateSeed.ts so
// other consumers (ExtractQuestRegions.ts, and eventually GenerateSeed's
// spawn-distance weighting) share one implementation of the run-length decode and
// the neighborhood-probing tile->region resolution.

import fs from 'fs';

import { WorldTile } from './Coords.js';

export interface RegionGraphMeta {
    mainlandRegionId: number;
    levels: number;
    regionCount: number;
}
export interface RegionMetaEntry {
    id: number;
    level: number;
    tileCount: number;
    bbox: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export class RegionGraph {
    meta: RegionGraphMeta;
    regionsById: Map<number, RegionMetaEntry>;
    private squares: Map<string, Int32Array>; // "mx_mz" -> Int32Array(levels*4096)
    private levels: number;

    constructor(raw: { meta: RegionGraphMeta; regions: RegionMetaEntry[]; squares: Record<string, Record<string, number[][]>> }) {
        this.meta = raw.meta;
        this.levels = raw.meta.levels;
        this.regionsById = new Map(raw.regions.map(r => [r.id, r]));
        this.squares = new Map();
        for (const [key, perLevel] of Object.entries(raw.squares)) {
            const arr = new Int32Array(this.levels * 4096);
            for (const [levelStr, runs] of Object.entries(perLevel)) {
                const level = Number(levelStr);
                let pos = level * 4096;
                for (const [regionId, runLen] of runs) {
                    arr.fill(regionId, pos, pos + runLen);
                    pos += runLen;
                }
            }
            this.squares.set(key, arr);
        }
    }

    /** Exact region id at this tile, or 0 (not walkable / not part of any loaded mapsquare). */
    regionAt(x: number, z: number, level: number): number {
        const arr = this.squares.get(`${x >> 6}_${z >> 6}`);
        if (!arr) {
            return 0;
        }
        return arr[level * 4096 + (z & 63) * 64 + (x & 63)];
    }

    /**
     * Resolves a "gameplay-meaningful" coordinate (entrance trigger/arrival tile, quest
     * anchor, spawn point) to a region id, probing a small neighborhood if the exact
     * tile itself isn't walkable (loc footprints - ladders, doors, statues - routinely
     * occupy their own trigger tile without being the tile a player actually stands on;
     * BuildRegionGraph.ts's own Lumbridge-anchor resolution uses the same trick). Returns
     * 0 if nothing walkable is found within `radius`.
     */
    resolveRegion(tile: WorldTile, radius = 3): number {
        const direct = this.regionAt(tile.x, tile.z, tile.level);
        if (direct !== 0) {
            return direct;
        }
        for (let r = 1; r <= radius; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) {
                        continue; // only scan the new ring at this radius.
                    }
                    const found = this.regionAt(tile.x + dx, tile.z + dz, tile.level);
                    if (found !== 0) {
                        return found;
                    }
                }
            }
        }
        return 0;
    }
}

export function loadRegionGraph(filePath: string): RegionGraph {
    if (!fs.existsSync(filePath)) {
        console.error(`RegionGraph: ${filePath} not found - run BuildRegionGraph.ts first`);
        process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return new RegionGraph(raw);
}
