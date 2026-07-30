// Prints the route the in-game ::appath command / the tracker's route panel would give,
// without booting a server. Run it after reseeding to see what the shuffle did to travel:
//
//   npx tsx tools/logic/ExplainPath.ts varrock                 # from Lumbridge by default
//   npx tsx tools/logic/ExplainPath.ts falador --from varrock
//   npx tsx tools/logic/ExplainPath.ts falador --explored      # only entrances used so far
//   npx tsx tools/logic/ExplainPath.ts --list                  # routable place names
//   npx tsx tools/logic/ExplainPath.ts --compare               # biggest shuffle shortcuts
//
// Needs data/config/ap-walk-graph.json + ap-walk-grid.bin (BuildRegionGraph.ts emits the
// grid, BuildWalkGraph.ts the graph) and this seed's ap-entrances.json.
//
// Default is the full-knowledge route, the opposite of the in-game default: this is a
// developer tool for inspecting a seed, not something a player reads mid-run.

import { findPath, listPlaces } from '#/engine/ApPathfinder.js';

const argv = process.argv.slice(2);

function flagValue(name: string, fallback: string): string {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : (argv[i + 1] ?? fallback);
}

const exploredOnly = argv.includes('--explored');
const originKey = flagValue('--from', 'lumbridge');
const targets = argv.filter(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--from');

const places = listPlaces();
if (places.length === 0) {
    console.error('ExplainPath: no routable places - build the walk graph first (BuildRegionGraph.ts then BuildWalkGraph.ts)');
    process.exit(1);
}

if (argv.includes('--list')) {
    console.log(`${places.length} routable place(s):\n`);
    for (const place of places) {
        console.log(`  ${place.key.padEnd(28)} ${place.name}  (${place.x},${place.z} L${place.level})`);
    }
    process.exit(0);
}

function placeByKey(key: string): (typeof places)[number] | undefined {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return places.find(p => p.key === normalized);
}

const origin = placeByKey(originKey);
if (!origin) {
    console.error(`ExplainPath: unknown origin '${originKey}' - try --list`);
    process.exit(1);
}

function describe(toKey: string): void {
    const result = findPath({ level: origin!.level, x: origin!.x, z: origin!.z }, toKey, { discoveredOnly: exploredOnly });
    if (!result.ok) {
        console.log(`\n${origin!.name} -> ${toKey}: ${result.reason}`);
        return;
    }

    const runSeconds = Math.max(1, Math.round((result.totalSteps / 2) * 0.6));
    console.log(`\n${origin!.name} -> ${result.destination}: ${result.totalSteps} steps, ${result.hops} hop(s), ~${runSeconds}s running`);
    result.legs.forEach((leg, i) => {
        const where = leg.near ? (leg.nearVia ? ` [via ${leg.near}]` : ` [near ${leg.near}]`) : '';
        const notes = [leg.requirement ? `needs ${leg.requirement}` : '', leg.undiscovered ? 'unexplored' : ''].filter(Boolean);
        const verb = leg.kind === 'entrance' ? 'USE ' : 'WALK';
        console.log(`  ${String(i + 1).padStart(2)}. ${verb} ${String(leg.steps).padStart(4)}  ${leg.name}${where}${notes.length > 0 ? `  (${notes.join(', ')})` : ''}`);
    });
}

// --compare: where has the shuffle actually changed how you get around? Ranks destinations
// by how much the entrance layout beats walking, which is the interesting question about a
// seed - a randomizer that only ever made travel worse would be a different kind of bug.
if (argv.includes('--compare')) {
    const rows: { name: string; walk: number; best: number; hops: number }[] = [];
    for (const place of places) {
        if (place.key === origin.key) {
            continue;
        }
        const from = { level: origin.level, x: origin.x, z: origin.z };
        const shuffled = findPath(from, place.key, { discoveredOnly: false });
        const walking = findPath(from, place.key, { discoveredOnly: true });
        if (!shuffled.ok || !walking.ok) {
            continue;
        }
        rows.push({ name: place.name, walk: walking.totalSteps, best: shuffled.totalSteps, hops: shuffled.hops });
    }

    rows.sort((a, b) => b.walk - b.best - (a.walk - a.best));
    console.log(`Travel from ${origin.name}, ranked by how much this seed's entrances beat walking:\n`);
    console.log('  saved  walk  best  hops  destination');
    for (const row of rows.slice(0, 25)) {
        const saved = row.walk - row.best;
        console.log(`  ${String(saved).padStart(5)} ${String(row.walk).padStart(5)} ${String(row.best).padStart(5)} ${String(row.hops).padStart(5)}  ${row.name}`);
    }
    const helped = rows.filter(r => r.walk > r.best).length;
    console.log(`\n${helped} of ${rows.length} destination(s) are faster via a shuffled entrance than on foot.`);
    process.exit(0);
}

if (targets.length === 0) {
    console.error('ExplainPath: give a destination (or --list / --compare)');
    process.exit(1);
}

for (const target of targets) {
    describe(target);
}
