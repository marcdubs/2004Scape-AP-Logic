import fs from 'fs';
import path from 'path';

import { CONTENT_ROOT, type CoordLiteral, decodeCoord } from './EntranceParser.js';

// Finds every physical placement of a given set of loc types by scanning the plain-
// text map files (content/maps/m<mapX>_<mapZ>.jm2). Needed for the "any-source"
// entrance handlers (generic cellar ladders etc): their scripts encode only a relative
// rule with no coordinates, so the placements have to come from the map data.
//
// jm2 files have a `==== LOC ====` section with lines `level localX localZ: id shape
// angle`; loc ids resolve to names via content/pack/loc.pack (`id=name` lines).

export type LocPlacement = {
    locName: string;
    coord: CoordLiteral;
    shape: number;
    angle: number;
};

const MAPS_DIR = path.join(CONTENT_ROOT, 'maps');
const LOC_PACK = path.join(CONTENT_ROOT, 'pack', 'loc.pack');

function loadLocIds(names: Set<string>): Map<number, string> {
    const wanted = new Map<number, string>();
    for (const line of fs.readFileSync(LOC_PACK, 'utf8').split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq === -1) {
            continue;
        }
        const name = line.slice(eq + 1).trim();
        if (names.has(name)) {
            wanted.set(parseInt(line.slice(0, eq), 10), name);
        }
    }
    return wanted;
}

// shape and angle are optional (both default 0): `0 9 16: 1568 22` or `0 9 15: 278`
const LOC_LINE_RE = /^(\d+) (\d+) (\d+): (\d+)(?: (\d+))?(?: (\d+))?$/;

export function scanPlacements(names: string[]): LocPlacement[] {
    const wanted = loadLocIds(new Set(names));
    const placements: LocPlacement[] = [];

    for (const file of fs.readdirSync(MAPS_DIR)) {
        const nameMatch = file.match(/^m(\d+)_(\d+)\.jm2$/);
        if (!nameMatch) {
            continue;
        }
        const mapX = parseInt(nameMatch[1], 10);
        const mapZ = parseInt(nameMatch[2], 10);

        const text = fs.readFileSync(path.join(MAPS_DIR, file), 'utf8');
        const locStart = text.indexOf('==== LOC ====');
        if (locStart === -1) {
            continue;
        }

        for (const line of text.slice(locStart).split(/\r?\n/).slice(1)) {
            if (line.startsWith('====')) {
                break;
            }
            const m = line.match(LOC_LINE_RE);
            if (!m) {
                continue;
            }
            const locName = wanted.get(parseInt(m[4], 10));
            if (!locName) {
                continue;
            }
            placements.push({
                locName,
                coord: decodeCoord(`${m[1]}_${mapX}_${mapZ}_${m[2]}_${m[3]}`),
                shape: m[5] !== undefined ? parseInt(m[5], 10) : 0,
                angle: m[6] !== undefined ? parseInt(m[6], 10) : 0
            });
        }
    }

    return placements;
}
