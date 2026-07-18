import fs from 'fs';

import Environment from '#/util/Environment.js';
import { printFatalError, printInfo, printWarning } from '#/util/Logger.js';

// Turns a small JSON room/corridor spec into a valid .jm2 map square, so a layout
// (hand-written or AI-generated) never has to touch the raw per-tile text format.
// See dungeon-example.json for the input shape.

type Rect = { x: number; z: number; width: number; height: number };
type Door = { x: number; z: number; id?: string | number };
type Placement = { x: number; z: number; id: string | number };
type ObjPlacement = Placement & { count?: number };

type DungeonSpec = {
    mapsquareX: number;
    mapsquareZ: number;
    level?: number;
    floor?: string | number;
    wall?: string | number;
    rooms: Rect[];
    corridors?: Rect[];
    doors?: Door[];
    monsters?: Placement[];
    objects?: ObjPlacement[];
};

const DEFAULT_FLOOR = 'darkstone';
const DEFAULT_WALL = 'stonewall';
const WALL_SHAPE = 0; // straight wall segment, see LocLayer.WALL in GameMap.ts

// angle for shape-0 walls: which edge of the tile the wall sits on.
// Convention used across RS2 server implementations; if walls render on the
// wrong side in-game, this is the table to flip.
const DIRS: { dx: number; dz: number; angle: number }[] = [
    { dx: -1, dz: 0, angle: 0 }, // west
    { dx: 0, dz: 1, angle: 1 }, // north
    { dx: 1, dz: 0, angle: 2 }, // east
    { dx: 0, dz: -1, angle: 3 } // south
];

function loadNamePack(file: string): Map<string, number> {
    const names = new Map<string, number>();
    if (!fs.existsSync(file)) {
        return names;
    }

    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq === -1) {
            continue;
        }

        const id = parseInt(line.slice(0, eq));
        const name = line.slice(eq + 1).trim();
        if (!Number.isNaN(id) && name.length) {
            names.set(name, id);
        }
    }

    return names;
}

function resolve(packs: Map<string, number>, value: string | number | undefined, fallback: string, packLabel: string): number {
    if (typeof value === 'number') {
        return value;
    }

    const name = value ?? fallback;
    const id = packs.get(name);
    if (id === undefined) {
        printFatalError(`Unknown ${packLabel} name "${name}" - check content/pack/${packLabel}.pack`);
    }

    return id!;
}

function rectTiles(rect: Rect): [number, number][] {
    const tiles: [number, number][] = [];
    for (let x = rect.x; x < rect.x + rect.width; x++) {
        for (let z = rect.z; z < rect.z + rect.height; z++) {
            tiles.push([x, z]);
        }
    }
    return tiles;
}

function key(x: number, z: number): string {
    return `${x},${z}`;
}

function generate(spec: DungeonSpec): string {
    const level = spec.level ?? 0;
    const floPack = loadNamePack(`${Environment.build.srcDir}/pack/flo.pack`);
    const locPack = loadNamePack(`${Environment.build.srcDir}/pack/loc.pack`);
    const npcPack = loadNamePack(`${Environment.build.srcDir}/pack/npc.pack`);
    const objPack = loadNamePack(`${Environment.build.srcDir}/pack/obj.pack`);

    const floorId = resolve(floPack, spec.floor, DEFAULT_FLOOR, 'flo');
    const wallId = resolve(locPack, spec.wall, DEFAULT_WALL, 'loc');

    const floor = new Set<string>();
    for (const rect of [...spec.rooms, ...(spec.corridors ?? [])]) {
        for (const [x, z] of rectTiles(rect)) {
            if (x < 0 || x > 63 || z < 0 || z > 63) {
                printFatalError(`Tile ${x},${z} is outside the 0-63 range of a single map square`);
            }
            floor.add(key(x, z));
        }
    }

    const doorTiles = new Set<string>();
    for (const door of spec.doors ?? []) {
        floor.add(key(door.x, door.z));
        doorTiles.add(key(door.x, door.z));
    }

    if (floor.size === 0) {
        printFatalError('Spec has no rooms/corridors - nothing to generate');
    }

    const mapLines: string[] = [];
    const locLines: string[] = [];

    for (const tileKey of floor) {
        const [x, z] = tileKey.split(',').map(Number);
        mapLines.push(`${level} ${x} ${z}: u${floorId}`);

        if (doorTiles.has(tileKey)) {
            const door = (spec.doors ?? []).find(d => d.x === x && d.z === z)!;
            const doorId = resolve(locPack, door.id, 'secretdoor', 'loc');
            locLines.push(`${level} ${x} ${z}: ${doorId} 10`);
            continue;
        }

        for (const dir of DIRS) {
            const neighbour = key(x + dir.dx, z + dir.dz);
            if (!floor.has(neighbour)) {
                locLines.push(`${level} ${x} ${z}: ${wallId} ${WALL_SHAPE} ${dir.angle}`);
            }
        }
    }

    const npcLines = (spec.monsters ?? []).map(m => {
        if (!floor.has(key(m.x, m.z))) {
            printWarning(`Monster at ${m.x},${m.z} is placed outside the floor area`);
        }
        return `${level} ${m.x} ${m.z}: ${resolve(npcPack, m.id, '', 'npc')}`;
    });

    const objLines = (spec.objects ?? []).map(o => {
        if (!floor.has(key(o.x, o.z))) {
            printWarning(`Object at ${o.x},${o.z} is placed outside the floor area`);
        }
        return `${level} ${o.x} ${o.z}: ${resolve(objPack, o.id, '', 'obj')} ${o.count ?? 1}`;
    });

    const sections = [['MAP', mapLines], ['LOC', locLines]] as [string, string[]][];
    if (npcLines.length) {
        sections.push(['NPC', npcLines]);
    }
    if (objLines.length) {
        sections.push(['OBJ', objLines]);
    }

    return sections.map(([name, lines]) => `==== ${name} ====\n${lines.join('\n')}`).join('\n\n') + '\n';
}

const args = process.argv.slice(2);
if (args.length !== 1) {
    printFatalError('Usage: tsx tools/map/GenerateDungeon.ts <spec.json>');
}

const spec: DungeonSpec = JSON.parse(fs.readFileSync(args[0], 'utf8'));
const output = generate(spec);

const mapsDir = `${Environment.build.srcDir}/maps`;
fs.mkdirSync(mapsDir, { recursive: true });
const outFile = `${mapsDir}/m${spec.mapsquareX}_${spec.mapsquareZ}.jm2`;
fs.writeFileSync(outFile, output);

printInfo(`Wrote ${outFile} (world coords ${spec.mapsquareX * 64},${spec.mapsquareZ * 64})`);
