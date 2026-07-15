// Shared coordinate helpers for the region-graph / seed-validation tools
// (docs/entrance-logic.md Workstream C). Every JSON table this tool consumes uses the
// same "level_mapX_mapZ_localX_localZ" raw string format:
//   - ap-entrances.json overrides/gates keys+values (see ApEntranceOverrides.ts)
//   - ap-spawn.json's "home" field (see RandomizeSpawn.ts / ApSpawnOverrides.ts)
//   - EntranceParser.ts's CoordLiteral.raw
// World (absolute) coordinates are mapX*64+localX / mapZ*64+localZ - the same
// mapsquare-relative packing the engine itself uses (CoordGrid.ts, GameMap.ts). The
// +100-mapsquare convention for "underground/instanced" areas (docs/lessons-learned.md
// "Domain knowledge: entrances") falls out for free: those squares just have
// mapZ >= 100, i.e. worldZ >= 6400 - no special-casing needed anywhere in this file.

export interface WorldTile {
    level: number;
    x: number;
    z: number;
}

const RAW_RE = /^(\d+)_(\d+)_(\d+)_(\d+)_(\d+)$/;

/** Parses "level_mapX_mapZ_localX_localZ" into a level+world-coord tile. Throws on malformed input. */
export function parseRawCoord(raw: string): WorldTile {
    const m = RAW_RE.exec(raw);
    if (!m) {
        throw new Error(`not a raw coord literal: ${raw}`);
    }
    const level = Number(m[1]);
    const mapX = Number(m[2]);
    const mapZ = Number(m[3]);
    const localX = Number(m[4]);
    const localZ = Number(m[5]);
    return { level, x: mapX * 64 + localX, z: mapZ * 64 + localZ };
}

/** Inverse of parseRawCoord - reproduces the canonical "level_mapX_mapZ_localX_localZ" string. */
export function toRawCoord(tile: WorldTile): string {
    const mapX = tile.x >> 6;
    const mapZ = tile.z >> 6;
    const localX = tile.x & 63;
    const localZ = tile.z & 63;
    return `${tile.level}_${mapX}_${mapZ}_${localX}_${localZ}`;
}

export function mapSquareOf(x: number, z: number): { mapX: number; mapZ: number } {
    return { mapX: x >> 6, mapZ: z >> 6 };
}

export function squareKey(mapX: number, mapZ: number): string {
    return `${mapX}_${mapZ}`;
}
