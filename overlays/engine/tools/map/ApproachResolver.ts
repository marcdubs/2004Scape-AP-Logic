import fs from 'fs';
import path from 'path';

import { type CoordLiteral, decodeCoord, type Entrance, SCRIPTS_ROOT } from './EntranceParser.js';
import { type LocPlacement, scanPlacements } from './LocPlacementScanner.js';

// Resolves player-relative floor-shift destinations - `movecoord(coord, dx, dy, dz)`,
// where the bare `coord` is the OPERATING PLAYER's live tile (ScriptOpcode.COORD reads
// state.activePlayer) - into literal landing tiles, so those entrances can join the
// shuffle pool. The player's tile isn't arbitrary: every loc this applies to carries
// `forceapproach=<side>` in its .loc config, so the pathfinder parks the player on one
// specific edge of the placed footprint before the script runs. That edge is fully
// determined by the loc's width/length + forceapproach (config) and the placement's
// angle (map data), and edge_tile + offset is a genuine vanilla landing.
//
// Geometry conventions (verified against every affected placement, and independently
// confirmed by script-author literals - e.g. the Yanille West Gate level-1 down cases
// in stairs.rs2 land on exactly the tiles this computes for the level-0 approach
// edges):
//   - placement coord is the footprint's SW corner; width runs along X, length along Z
//   - odd angles swap width/length
//   - the forceapproach side rotates clockwise with angle (N->E->S->W)
//
// Safety gate: a resolution is only accepted if it reciprocally validates against a
// counterpart entrance one plane over - the computed landing must sit on the
// counterpart loc's own approach edge, and the counterpart's landing (literal or
// computed the same way) must sit on ours. A geometry-model error, an odd placement,
// or a missing far side all fail the check and leave the entrance excluded/vanilla
// exactly as before - the failure mode is "stays vanilla", never "lands in a wall".

type Side = 'north' | 'east' | 'south' | 'west';
type LocGeometry = { width: number; length: number; forceapproach: Side | null };
type Tile = { x: number; z: number };

// clockwise compass order - rotating a placement by one angle step moves its
// forceapproach side one step through this list.
const SIDES: Side[] = ['north', 'east', 'south', 'west'];

// counterpart triggers sit within a couple of tiles of the trigger (the far end of the
// same physical staircase); generous bound to keep the search cheap but local.
const COUNTERPART_TRIGGER_RADIUS = 10;

function isSide(value: string): value is Side {
    return (SIDES as string[]).includes(value);
}

// pulls width/length/forceapproach for the named locs out of the plain-text .loc
// config blocks under content/scripts. Files are CRLF; blocks start at `[name]` and
// run to the next header.
function loadLocGeometry(names: Set<string>): Map<string, LocGeometry> {
    const out = new Map<string, LocGeometry>();
    const stack: string[] = [SCRIPTS_ROOT];
    while (stack.length) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!entry.name.endsWith('.loc')) {
                continue;
            }
            const text = fs.readFileSync(full, 'utf8');
            for (const block of text.matchAll(/^\[([^\]\r\n]+)\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)) {
                const name = block[1];
                if (!names.has(name) || out.has(name)) {
                    continue;
                }
                const body = block[2];
                const geom: LocGeometry = { width: 1, length: 1, forceapproach: null };
                const width = body.match(/^width=(\d+)/m);
                if (width) {
                    geom.width = parseInt(width[1], 10);
                }
                const length = body.match(/^length=(\d+)/m);
                if (length) {
                    geom.length = parseInt(length[1], 10);
                }
                const approach = body.match(/^forceapproach=(\w+)/m);
                if (approach && isSide(approach[1])) {
                    geom.forceapproach = approach[1];
                }
                out.set(name, geom);
            }
        }
    }
    return out;
}

// the row of tiles the pathfinder can park a player on when operating this placement -
// the footprint edge selected by forceapproach, rotated by the placement angle.
function approachTiles(placement: LocPlacement, geom: LocGeometry): Tile[] | null {
    if (!geom.forceapproach) {
        return null;
    }
    const swap = placement.angle % 2 === 1;
    const w = swap ? geom.length : geom.width;
    const l = swap ? geom.width : geom.length;
    const side = SIDES[(SIDES.indexOf(geom.forceapproach) + placement.angle) % 4];
    const x0 = placement.coord.worldX;
    const z0 = placement.coord.worldZ;

    const tiles: Tile[] = [];
    if (side === 'north' || side === 'south') {
        const z = side === 'north' ? z0 + l : z0 - 1;
        for (let x = x0; x < x0 + w; x++) {
            tiles.push({ x, z });
        }
    } else {
        const x = side === 'east' ? x0 + w : x0 - 1;
        for (let z = z0; z < z0 + l; z++) {
            tiles.push({ x, z });
        }
    }
    return tiles;
}

function toLiteral(plane: number, tile: Tile): CoordLiteral {
    const mapX = Math.floor(tile.x / 64);
    const mapZ = Math.floor(tile.z / 64);
    return decodeCoord(`${plane}_${mapX}_${mapZ}_${tile.x - mapX * 64}_${tile.z - mapZ * 64}`);
}

type Offsets = { dx: number; dy: number; dz: number };

// a player-relative movecoord this resolver is willing to reason about: the base is
// the player's tile and the offsets are integer constants.
function playerRelativeOffsets(e: Entrance): Offsets | null {
    if (e.destination?.type !== 'relative') {
        return null;
    }
    const base = e.destination.base.trim();
    if (base !== 'coord' && base !== 'coord()') {
        return null;
    }
    const dx = parseInt(e.destination.dx, 10);
    const dy = parseInt(e.destination.dy, 10);
    const dz = parseInt(e.destination.dz, 10);
    if (!Number.isInteger(dx) || !Number.isInteger(dy) || !Number.isInteger(dz)) {
        return null;
    }
    return { dx, dy, dz };
}

function isResolvable(e: Entrance): boolean {
    // gated transitions (quest checks etc.) must stay vanilla regardless of geometry -
    // an override would bypass the gate. climb_ladder relatives are excluded too: the
    // only literal-source ones (dwarf guard tower, black knights) carry side effects,
    // and the generic ones are already covered by the map-scanned ladder gates.
    return e.source.type === 'literal' && e.kind === 'floor-shift' && !e.gated && (e.method === 'p_telejump' || e.method === 'p_teleport') && playerRelativeOffsets(e) !== null;
}

function tileKey(t: Tile): string {
    return `${t.x},${t.z}`;
}

export type ApproachResolution = { resolved: number; failed: number };

// Mutates matching entrances in place: on success the relative destination is replaced
// with a validated CoordLiteral and `approachResolved` is set; on failure
// `approachFail` records why (surfaced by the randomizer's excluded diagnostics).
export function resolveApproachDestinations(entrances: Entrance[]): ApproachResolution {
    const targets = entrances.filter(isResolvable);
    if (!targets.length) {
        return { resolved: 0, failed: 0 };
    }

    // counterpart pool: any literal-source transition could be the far side of a
    // target's staircase (its own destination may be literal or player-relative).
    const literalSources = entrances.filter(e => e.source.type === 'literal' && (e.method === 'p_telejump' || e.method === 'p_teleport'));

    const names = new Set<string>([...targets, ...literalSources].map(e => e.category));
    const geometry = loadLocGeometry(names);
    const placements = new Map<string, LocPlacement>();
    for (const p of scanPlacements([...names])) {
        placements.set(`${p.coord.raw}:${p.locName}`, p);
    }

    const edgeOf = (e: Entrance): Tile[] | null => {
        const coord = (e.source as { coord: CoordLiteral }).coord;
        const geom = geometry.get(e.category);
        const placement = placements.get(`${coord.raw}:${e.category}`);
        if (!geom || !placement) {
            return null;
        }
        return approachTiles(placement, geom);
    };

    let resolved = 0;
    let failed = 0;

    for (const e of targets) {
        const trigger = (e.source as { coord: CoordLiteral }).coord;
        const offsets = playerRelativeOffsets(e)!;

        const eApproach = edgeOf(e);
        if (!eApproach) {
            e.approachFail = `relative destination: no forceapproach geometry/placement found for ${e.category} at ${trigger.raw}`;
            failed++;
            continue;
        }
        const landingPlane = trigger.plane + offsets.dy;
        const eLandings = eApproach.map(t => ({ x: t.x + offsets.dx, z: t.z + offsets.dz }));
        const eApproachKeys = new Set(eApproach.map(tileKey));

        let choice: Tile | null = null;
        for (const c of literalSources) {
            if (c === e) {
                continue;
            }
            const cTrigger = (c.source as { coord: CoordLiteral }).coord;
            if (cTrigger.plane !== landingPlane || Math.hypot(cTrigger.worldX - trigger.worldX, cTrigger.worldZ - trigger.worldZ) > COUNTERPART_TRIGGER_RADIUS) {
                continue;
            }
            const cApproach = edgeOf(c);
            if (!cApproach) {
                continue;
            }
            const cApproachKeys = new Set(cApproach.map(tileKey));
            const landings = eLandings.filter(t => cApproachKeys.has(tileKey(t)));
            if (!landings.length) {
                continue;
            }

            // reverse direction: the counterpart must deliver players onto OUR
            // approach edge, whether its destination is a literal or another
            // player-relative movecoord.
            if (c.destination?.type === 'literal') {
                if (c.destination.plane !== trigger.plane || !eApproachKeys.has(tileKey({ x: c.destination.worldX, z: c.destination.worldZ }))) {
                    continue;
                }
            } else {
                const cOffsets = playerRelativeOffsets(c);
                if (!cOffsets || cTrigger.plane + cOffsets.dy !== trigger.plane) {
                    continue;
                }
                if (!cApproach.some(t => eApproachKeys.has(tileKey({ x: t.x + cOffsets.dx, z: t.z + cOffsets.dz })))) {
                    continue;
                }
            }

            landings.sort((a, b) => a.x - b.x || a.z - b.z);
            choice = landings[0];
            break;
        }

        if (!choice) {
            e.approachFail = 'relative destination: computed landing did not reciprocally validate against any counterpart - left vanilla';
            failed++;
            continue;
        }

        e.destination = toLiteral(landingPlane, choice);
        e.approachResolved = true;
        resolved++;
    }

    return { resolved, failed };
}
