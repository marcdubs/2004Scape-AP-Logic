import fs from 'fs';
import path from 'path';

// Scans the map NPC sections to produce npc-spawns.json: npc debugname -> a representative
// spawn coord (level_mapX_mapZ_localX_localZ). Needed by the item-acquisition graph's BUY
// and DROP sources (problems.txt #16 four-source model): a shop's owner NPC and a monster
// both resolve to a region via their spawn coord + region-graph.json, so obtainability can
// gate "can I buy/kill-for this item" on region reachability (shopsanity- and
// drop-rando-aware since the .npc/.drop data those read is the current shuffled state).
//
// jm2 files have an `==== NPC ====` section with lines `level localX localZ: npcId`; ids
// resolve to names via content/pack/npc.pack (id=name). Same shape as LocPlacementScanner.
// Run from the engine dir: `npx tsx tools/logic/BuildNpcSpawns.ts`.

const CONTENT = path.resolve(process.cwd(), '../content');
const MAPS_DIR = path.join(CONTENT, 'maps');
const NPC_PACK = path.join(CONTENT, 'pack', 'npc.pack');
const OUT = path.join('tools', 'logic', 'data', 'npc-spawns.json');

const NPC_LINE_RE = /^(\d+) (\d+) (\d+): (\d+)/;

function main(): void {
    const idToName = new Map<number, string>();
    for (const line of fs.readFileSync(NPC_PACK, 'utf8').split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq !== -1) {
            idToName.set(parseInt(line.slice(0, eq), 10), line.slice(eq + 1).trim());
        }
    }

    // npc name -> first (representative) spawn coord found. First is fine: for region
    // resolution any placement of the NPC suffices; wandering NPCs stay in one region.
    const spawns = new Map<string, string>();
    for (const file of fs.readdirSync(MAPS_DIR)) {
        const m = file.match(/^[nm](\d+)_(\d+)\.jm2$/);
        if (!m) {
            continue;
        }
        const mapX = parseInt(m[1], 10);
        const mapZ = parseInt(m[2], 10);
        const text = fs.readFileSync(path.join(MAPS_DIR, file), 'latin1');
        const start = text.indexOf('==== NPC ====');
        if (start === -1) {
            continue;
        }
        for (const line of text.slice(start).split(/\r?\n/).slice(1)) {
            if (line.startsWith('====')) {
                break;
            }
            const lm = line.match(NPC_LINE_RE);
            if (!lm) {
                continue;
            }
            const name = idToName.get(parseInt(lm[4], 10));
            if (name && !spawns.has(name)) {
                spawns.set(name, `${lm[1]}_${mapX}_${mapZ}_${lm[2]}_${lm[3]}`);
            }
        }
    }

    const obj: Record<string, string> = { _note: 'npc debugname -> representative spawn coord (level_mapX_mapZ_localX_localZ), scanned from map NPC sections. Used to resolve shop-owner/monster -> region for item obtainability (ItemGraph buy/drop sources).' } as Record<string, string>;
    for (const [name, coord] of [...spawns].sort((a, b) => a[0].localeCompare(b[0]))) {
        obj[name] = coord;
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(obj, null, 1));
    console.log(`BuildNpcSpawns: wrote ${OUT} - ${spawns.size} npc spawn(s)`);
}

main();
