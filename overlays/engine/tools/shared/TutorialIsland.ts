import fs from 'fs';
import path from 'path';

// The authoritative Tutorial Island footprint, read from the game's own definition.
//
// Every AP tool that has to keep its hands off the tutorial (entrance shuffle, gated-area
// derivation) asks this module rather than carrying its own guess. The guess used to be
// "mapsquare (48,48)", which is wrong: the island spills into five more squares, so an
// entrance at 0_49_48_3_6 slipped into the shuffle pool and a fresh character could be
// stranded mid-tutorial (issue #14).
//
// The source of truth is content/scripts/tutorial/configs/tutorial_island.dbrow - the
// coord_pair table behind ~in_tutorial_island(coord), which the content itself uses to
// decide what counts as tutorial ground. Deriving from it means the two tools can neither
// drift from each other nor from the game.

const CONTENT_ROOT = path.resolve(process.cwd(), '../content');
const TUTORIAL_DBROW = path.join(CONTENT_ROOT, 'scripts/tutorial/configs/tutorial_island.dbrow');

const COORD_PAIR_RE = /^data=coord_pair,(\d+_\d+_\d+_\d+_\d+),(\d+_\d+_\d+_\d+_\d+)\s*$/;

function mapsquareKey(mapX: number, mapZ: number): string {
    return `${mapX}_${mapZ}`;
}

// coords are level_mapX_mapZ_localX_localZ; only the mapsquare part matters here.
function parseMapsquare(raw: string): [number, number] {
    const [, mapX, mapZ] = raw.split('_').map(Number);
    return [mapX, mapZ];
}

let cached: Set<string> | null = null;

function load(): Set<string> {
    if (cached) {
        return cached;
    }
    if (!fs.existsSync(TUTORIAL_DBROW)) {
        throw new Error(`Tutorial Island footprint unavailable: ${TUTORIAL_DBROW} not found (run from the engine directory, with content installed)`);
    }
    const squares = new Set<string>();
    for (const line of fs.readFileSync(TUTORIAL_DBROW, 'utf8').split('\n')) {
        const m = COORD_PAIR_RE.exec(line.trim());
        if (!m) {
            continue;
        }
        // a row is a box corner pair; take every mapsquare it touches, so a box that
        // covers only part of a square still protects the whole square (over-protecting
        // is the safe direction here).
        const [x1, z1] = parseMapsquare(m[1]);
        const [x2, z2] = parseMapsquare(m[2]);
        for (let mapX = Math.min(x1, x2); mapX <= Math.max(x1, x2); mapX++) {
            for (let mapZ = Math.min(z1, z2); mapZ <= Math.max(z1, z2); mapZ++) {
                squares.add(mapsquareKey(mapX, mapZ));
            }
        }
    }
    if (squares.size === 0) {
        throw new Error(`Tutorial Island footprint unavailable: no coord_pair rows parsed from ${TUTORIAL_DBROW}`);
    }
    cached = squares;
    return cached;
}

export function isTutorialMapsquare(mapX: number, mapZ: number): boolean {
    return load().has(mapsquareKey(mapX, mapZ));
}

// absolute world tile coordinates (level is irrelevant - the whole column is tutorial).
export function isTutorialTile(x: number, z: number): boolean {
    return isTutorialMapsquare(x >> 6, z >> 6);
}

// for tool logging, so a run can report what it actually protected.
export function tutorialMapsquares(): [number, number][] {
    return [...load()]
        .map(key => key.split('_').map(Number) as [number, number])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
