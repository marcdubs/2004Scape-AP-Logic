import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

import { CONTENT_ROOT, ENTRANCE_DIR, type CoordLiteral, type Entrance, parseFile } from './EntranceParser.js';
import { scanPlacements } from './LocPlacementScanner.js';

// Shuffles game entrances and writes a runtime override table
// (data/config/ap-entrances.json) that the engine's ap_entrance_override command
// consults - no content changes, no pack rebuild; reseed by re-running and restarting
// the server. Requires the patched handlers + ap.rs2 from 2004Scape-AP-Logic to be
// installed and built into the pack once.
//
// Three candidate sources:
//   - parsed cross-map entrances (dungeon/area connectors from ladders.rs2/stairs.rs2)
//   - parsed floor-shift entrances (same-building stairs with literal coords)
//   - map-scanned placements of the generic "any-source" cellar locs (trapdoors,
//     cellar ladders), whose scripts have no coordinates to parse
//
// Cross-map + scanned gates shuffle in one pool, floor-shift gates in another, so
// building stairs lead to other buildings and dungeon entrances to other dungeons.
// --mixed merges both pools into full chaos. Reciprocity is always preserved: the
// far side of wherever you land leads back next to where you entered.
//
// Legacy --rewrite mode bakes the (cross-map only) shuffle into the .rs2 source
// instead and needs a full pack rebuild per seed; kept as a fallback.
//
// Usage: npx tsx tools/map/RandomizeEntrances.ts [--seed <number>] [--dry-run] [--mixed] [--rewrite]

const RELATIVE_ENTRANCE_DIR = 'scripts/ladders+stairs/scripts';
const BACKUP_DIR = path.join(CONTENT_ROOT, '.ap-backup', RELATIVE_ENTRANCE_DIR);
const SPOILER_OUTPUT = path.join(import.meta.dirname, 'entrance-seed.json');
// runtime override table read by the engine (ApEntranceOverrides.ts); relative to the
// engine working directory, same convention as the engine's own loader.
const OVERRIDES_OUTPUT = path.resolve('data/config/ap-entrances.json');

// how close a candidate's (source, destination) pair has to be to another candidate's
// (destination, source) for the two to be treated as the up/down sides of the same
// physical staircase/ladder. Floor-shift pairing is tighter because town staircases
// are packed much closer together than dungeon entrances.
const CROSS_PAIR_RADIUS = 10;
const FLOOR_PAIR_RADIUS = 6;
const SCAN_PAIR_RADIUS = 6;

// the "underground layer" convention: cellars/dungeons live at the overworld
// coordinate +6400 tiles on Z (mapZ +100).
const UNDERGROUND_DZ = 6400;

// any-source locs whose descend/ascend rule is the fixed underground offset.
const SCAN_DOWN_LOCS = ['trapdoor', 'trapdoor_open', 'ladder_cellar', 'ladder_cellar_inside_down'];
const SCAN_UP_LOCS = ['ladder_from_cellar', 'ladder_from_cellar_directional'];

// mapsquares that must never be touched by the shuffle, regardless of classification -
// currently just Tutorial Island (48,48), so a brand-new player can never get stranded
// mid-tutorial.
const PROTECTED_MAPSQUARES: [number, number][] = [[48, 48]];

type Indexed<T> = T & { _index: number };
type Candidate = Indexed<Entrance> & { source: { type: 'literal'; coord: CoordLiteral }; destination: CoordLiteral };

// one side of a physical two-way connection: the tile that triggers the transition,
// and the (walkable) tile the transition delivers you to - which is next to the far
// side's trigger.
type GateSide = { trigger: CoordLiteral; arrival: CoordLiteral; description: string | null };
type Gate = { a: GateSide; b: GateSide; pool: 'connector' | 'floor-shift'; scanned?: boolean };
type OneWayEntry = { trigger: CoordLiteral; arrival: CoordLiteral; description: string | null };

function inProtectedMapsquare(coord: CoordLiteral): boolean {
    return PROTECTED_MAPSQUARES.some(([mx, mz]) => mx === coord.mapX && mz === coord.mapZ);
}

function isProtected(e: Indexed<Entrance>): boolean {
    if (e.description && /tutorial/i.test(e.description)) {
        return true;
    }
    const source = e.source;
    if (source.type === 'literal' && inProtectedMapsquare(source.coord)) {
        return true;
    }
    const destination = e.destination;
    if (destination?.type === 'literal' && inProtectedMapsquare(destination)) {
        return true;
    }
    return false;
}

function isLiteral(e: Indexed<Entrance>): e is Candidate {
    return e.source.type === 'literal' && e.destination?.type === 'literal' && !isProtected(e);
}

// mulberry32 - small, fast, seedable PRNG (Math.random() isn't seedable).
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// a permutation of [0..n) with no fixed points, so every gate/entrance actually moves.
// falls back to a manual neighbor-swap fixup if rejection sampling runs out of luck.
function derangement(n: number, rand: () => number): number[] {
    const identity = Array.from({ length: n }, (_, i) => i);
    if (n < 2) {
        return identity;
    }

    let perm = identity;
    for (let attempt = 0; attempt < 200; attempt++) {
        perm = shuffle(identity, rand);
        if (perm.every((v, i) => v !== i)) {
            return perm;
        }
    }

    perm = perm.slice();
    for (let i = 0; i < n; i++) {
        if (perm[i] === i) {
            const swapWith = (i + 1) % n;
            [perm[i], perm[swapWith]] = [perm[swapWith], perm[i]];
        }
    }
    return perm;
}

function worldDist(a: CoordLiteral, b: CoordLiteral): number {
    return Math.hypot(a.worldX - b.worldX, a.worldZ - b.worldZ);
}

// pairs up candidates that are the two ends of the same physical staircase/ladder (A's
// destination sits near B's source on the same plane, and B's destination sits near
// A's source). unpaired candidates are one-way connections or halves whose other side
// isn't in the candidate set.
function findGatePairs(candidates: Candidate[], radius: number): { pairs: [Candidate, Candidate][]; unpaired: Candidate[] } {
    const used = new Set<Candidate>();
    const pairs: [Candidate, Candidate][] = [];

    for (const e of candidates) {
        if (used.has(e)) {
            continue;
        }
        let best: Candidate | null = null;
        let bestScore = Infinity;
        for (const other of candidates) {
            if (other === e || used.has(other)) {
                continue;
            }
            if (other.source.coord.plane !== e.destination.plane || e.source.coord.plane !== other.destination.plane) {
                continue;
            }
            const d1 = worldDist(other.source.coord, e.destination);
            const d2 = worldDist(other.destination, e.source.coord);
            if (d1 <= radius && d2 <= radius) {
                const score = d1 + d2;
                if (score < bestScore) {
                    bestScore = score;
                    best = other;
                }
            }
        }
        if (best) {
            pairs.push([e, best]);
            used.add(e);
            used.add(best);
        }
    }

    return { pairs, unpaired: candidates.filter(e => !used.has(e)) };
}

function toGate([a, b]: [Candidate, Candidate], pool: Gate['pool']): Gate {
    return {
        a: { trigger: a.source.coord, arrival: a.destination, description: a.description },
        b: { trigger: b.source.coord, arrival: b.destination, description: b.description },
        pool
    };
}

function describe(coord: CoordLiteral, description: string | null) {
    return { raw: coord.raw, worldX: coord.worldX, worldZ: coord.worldZ, plane: coord.plane, description };
}

type Edit = { file: string; oldRaw: string; newRaw: string; originalIndex: number };

// finds the destination coordinate's literal text (as opposed to some other, unrelated
// occurrence of the same digits, like a case label) - destinations only ever appear as
// call arguments, so they're always immediately followed by `)` or `,`.
function findDestinationOccurrence(text: string, raw: string, searchFrom: number): number {
    let idx = searchFrom;
    for (;;) {
        idx = text.indexOf(raw, idx);
        if (idx === -1) {
            return -1;
        }
        const after = text.slice(idx + raw.length, idx + raw.length + 4);
        if (/^\s*[),]/.test(after)) {
            return idx;
        }
        idx += raw.length;
    }
}

function applyEdits(text: string, edits: Edit[]): string {
    // process in original file order so a destination literal that appears more than
    // once resolves to the matching occurrence rather than always the first.
    const ordered = edits.filter(e => e.oldRaw !== e.newRaw).sort((a, b) => a.originalIndex - b.originalIndex);
    const cursors = new Map<string, number>();
    const located: { idx: number; oldLen: number; newRaw: string }[] = [];

    for (const edit of ordered) {
        const from = cursors.get(edit.oldRaw) ?? 0;
        const idx = findDestinationOccurrence(text, edit.oldRaw, from);
        if (idx === -1) {
            throw new Error(`could not locate destination "${edit.oldRaw}" in source text - refusing to write a partial edit`);
        }
        cursors.set(edit.oldRaw, idx + edit.oldRaw.length);
        located.push({ idx, oldLen: edit.oldRaw.length, newRaw: edit.newRaw });
    }

    located.sort((a, b) => b.idx - a.idx);
    let out = text;
    for (const { idx, oldLen, newRaw } of located) {
        out = out.slice(0, idx) + newRaw + out.slice(idx + oldLen);
    }
    return out;
}

function ensureBackup(): void {
    if (fs.existsSync(BACKUP_DIR)) {
        return;
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    for (const file of fs.readdirSync(ENTRANCE_DIR).filter(f => f.endsWith('.rs2'))) {
        fs.copyFileSync(path.join(ENTRANCE_DIR, file), path.join(BACKUP_DIR, file));
    }
    printInfo(`created vanilla content backup at ${BACKUP_DIR}`);
}

// builds gates from the map-scanned any-source cellar locs: a "down" placement (trapdoor
// or cellar ladder) pairs with an "up" placement at the mirrored underground coordinate.
// arrival tiles are the far placement's own tile - the engine nudges to a walkable
// neighbor at teleport time (see AP_ENTRANCE_OVERRIDE in ServerOps.ts).
function buildScannedGates(knownTriggers: Set<string>): { gates: Gate[]; skipped: number } {
    const placements = scanPlacements([...SCAN_DOWN_LOCS, ...SCAN_UP_LOCS]).filter(p => !inProtectedMapsquare(p.coord) && !knownTriggers.has(p.coord.raw));

    // a closed trapdoor and its open variant occupy the same tile - dedupe.
    const seen = new Set<string>();
    const downs = placements.filter(p => SCAN_DOWN_LOCS.includes(p.locName) && !seen.has(p.coord.raw) && seen.add(p.coord.raw) !== undefined);
    const ups = placements.filter(p => SCAN_UP_LOCS.includes(p.locName));

    const gates: Gate[] = [];
    const usedUps = new Set<(typeof ups)[number]>();

    for (const down of downs) {
        const expected = { ...down.coord, worldZ: down.coord.worldZ + UNDERGROUND_DZ };
        let best: (typeof ups)[number] | null = null;
        let bestDist = Infinity;
        for (const up of ups) {
            if (usedUps.has(up) || up.coord.plane !== down.coord.plane) {
                continue;
            }
            const d = Math.hypot(up.coord.worldX - expected.worldX, up.coord.worldZ - expected.worldZ);
            if (d <= SCAN_PAIR_RADIUS && d < bestDist) {
                bestDist = d;
                best = up;
            }
        }
        if (!best) {
            continue;
        }
        usedUps.add(best);
        gates.push({
            a: { trigger: down.coord, arrival: best.coord, description: `${down.locName} at ${down.coord.raw}` },
            b: { trigger: best.coord, arrival: down.coord, description: `${best.locName} at ${best.coord.raw}` },
            pool: 'connector',
            scanned: true
        });
    }

    return { gates, skipped: downs.length + ups.length - gates.length * 2 };
}

function parseArgs() {
    const args = process.argv.slice(2);
    const seedIdx = args.indexOf('--seed');
    const seed = seedIdx !== -1 ? parseInt(args[seedIdx + 1], 10) : Math.floor(Math.random() * 0xffffffff);
    return { seed, dryRun: args.includes('--dry-run'), rewrite: args.includes('--rewrite'), mixed: args.includes('--mixed') };
}

function main() {
    if (!fs.existsSync(ENTRANCE_DIR)) {
        printWarning(`entrance script directory not found: ${ENTRANCE_DIR}`);
        process.exit(1);
    }

    const { seed, dryRun, rewrite, mixed } = parseArgs();

    // always (re)derive from the untouched vanilla backup, creating it on first run,
    // so re-randomizing never compounds onto a previous shuffle's output.
    ensureBackup();

    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.rs2'));
    const rand = mulberry32(seed);

    let nextIndex = 0;
    const allEntrances: Indexed<Entrance>[] = [];
    const textByFile = new Map<string, string>();

    for (const file of files) {
        const backupPath = path.join(BACKUP_DIR, file);
        const relLabel = `${RELATIVE_ENTRANCE_DIR}/${file}`;
        for (const e of parseFile(backupPath, relLabel)) {
            allEntrances.push({ ...e, _index: nextIndex++ });
        }
        textByFile.set(file, fs.readFileSync(backupPath, 'utf8').replace(/\r\n/g, '\n'));
    }

    // the override table is keyed by trigger coord alone, so a coord that triggers
    // multiple distinct transitions (e.g. spiralstairsmiddle: one coord with climb-up,
    // climb-down and a choice menu) cannot be shuffled - exclude it entirely. plain
    // duplicated script entries (same coord, same destination) collapse to one.
    const literalCandidates = allEntrances.filter(isLiteral);
    const destsBySource = new Map<string, Set<string>>();
    for (const e of literalCandidates) {
        (destsBySource.get(e.source.coord.raw) ?? destsBySource.set(e.source.coord.raw, new Set()).get(e.source.coord.raw)!).add(e.destination.raw);
    }
    const multiDest = new Set([...destsBySource.entries()].filter(([, dests]) => dests.size > 1).map(([src]) => src));
    const seenSources = new Set<string>();
    const usable = literalCandidates.filter(e => {
        if (multiDest.has(e.source.coord.raw) || seenSources.has(e.source.coord.raw)) {
            return false;
        }
        seenSources.add(e.source.coord.raw);
        return true;
    });

    const crossCands = usable.filter(e => e.kind === 'cross-map');
    const floorCands = usable.filter(e => e.kind === 'floor-shift');

    const cross = findGatePairs(crossCands, CROSS_PAIR_RADIUS);
    const floor = findGatePairs(floorCands, FLOOR_PAIR_RADIUS);

    const knownTriggers = new Set(usable.map(e => e.source.coord.raw));
    const scanned = buildScannedGates(knownTriggers);

    const connectorGates = [...cross.pairs.map(p => toGate(p, 'connector')), ...scanned.gates];
    const floorGates = floor.pairs.map(p => toGate(p, 'floor-shift'));

    // genuine one-ways (KBD entrance etc) plus connector halves whose far side isn't a
    // candidate. floor-shift unpaired halves stay vanilla instead - a one-way redirect
    // on a building staircase breaks the "come back the way you came" guarantee for no
    // real payoff.
    const oneWays: OneWayEntry[] = cross.unpaired.map(e => ({ trigger: e.source.coord, arrival: e.destination, description: e.description }));

    printInfo(`seed ${seed}: ${connectorGates.length} connector gate(s) (${scanned.gates.length} map-scanned), ${floorGates.length} floor-shift gate(s), ${oneWays.length} one-way(s)`);
    printInfo(`left vanilla: ${floor.unpaired.length} unpaired floor-shift(s), ${scanned.skipped} unpaired scanned placement(s), ${multiDest.size} multi-destination coord(s)`);

    const excluded = allEntrances
        .filter(e => e.kind === 'cross-map' && !isLiteral(e))
        .map(e => ({
            category: e.category,
            op: e.op,
            description: e.description,
            reason: isProtected(e) ? 'protected region (tutorial)' : e.source.type !== 'literal' ? 'non-literal source' : 'non-literal destination'
        }));

    if (rewrite) {
        // legacy mode: bake the (cross-map only) shuffle into the .rs2 source text.
        // branches before the pool shuffle so the seed drives these derangements
        // directly (seeds are not comparable between modes).
        printWarning('--rewrite is legacy: floor-shift and map-scanned entrances are NOT included in this mode');

        const edits: Edit[] = [];
        const legacyGates: unknown[] = [];
        const legacyOneWay: unknown[] = [];

        if (cross.pairs.length >= 2) {
            const perm = derangement(cross.pairs.length, rand);
            for (let i = 0; i < cross.pairs.length; i++) {
                const [aTrigger] = cross.pairs[i];
                const [, bTrigger] = cross.pairs[perm[i]];
                edits.push({ file: path.basename(aTrigger.file), oldRaw: aTrigger.destination.raw, newRaw: bTrigger.source.coord.raw, originalIndex: aTrigger._index });
                edits.push({ file: path.basename(bTrigger.file), oldRaw: bTrigger.destination.raw, newRaw: cross.pairs[i][0].source.coord.raw, originalIndex: bTrigger._index });
                legacyGates.push({
                    locA: describe(cross.pairs[i][0].source.coord, cross.pairs[i][0].description),
                    locB: describe(cross.pairs[i][1].source.coord, cross.pairs[i][1].description),
                    nowLeadsTo: describe(cross.pairs[perm[i]][1].source.coord, cross.pairs[perm[i]][1].description)
                });
            }
        }
        if (cross.unpaired.length >= 2) {
            const perm = derangement(cross.unpaired.length, rand);
            for (let i = 0; i < cross.unpaired.length; i++) {
                const entry = cross.unpaired[i];
                const target = cross.unpaired[perm[i]];
                edits.push({ file: path.basename(entry.file), oldRaw: entry.destination.raw, newRaw: target.destination.raw, originalIndex: entry._index });
                legacyOneWay.push({
                    from: describe(entry.source.coord, entry.description),
                    originallyLedTo: describe(entry.destination, null),
                    nowLeadsTo: describe(target.destination, target.description)
                });
            }
        }

        for (const [file, text] of textByFile) {
            const fileEdits = edits.filter(e => e.file === file);
            const newText = applyEdits(text, fileEdits);
            if (!dryRun) {
                // source files use CRLF (see readSource in EntranceParser.ts) - restore
                // it so the diff against vanilla is just the coordinate edits.
                fs.writeFileSync(path.join(ENTRANCE_DIR, file), newText.replace(/\n/g, '\r\n'));
            }
        }

        fs.writeFileSync(SPOILER_OUTPUT, JSON.stringify({ seed, generatedAt: new Date().toISOString(), dryRun, gates: legacyGates, oneWay: legacyOneWay, excluded }, null, 2));

        const changedCount = edits.filter(e => e.oldRaw !== e.newRaw).length;
        printInfo(`${dryRun ? '[dry run] ' : ''}applied ${changedCount} edit(s) across ${files.length} file(s); spoiler written to ${SPOILER_OUTPUT}`);
        if (!dryRun) {
            printInfo('rebuild the pack before testing: npx tsx tools/pack/Build.ts');
        }
        return;
    }

    const overrides: Record<string, string> = {};
    const addOverride = (from: string, to: string) => {
        if (overrides[from] !== undefined) {
            printWarning(`override collision on ${from} - keeping first assignment`);
            return;
        }
        overrides[from] = to;
    };

    const spoilerGates: unknown[] = [];
    const spoilerOneWay: unknown[] = [];

    const gatePools: Gate[][] = mixed ? [[...connectorGates, ...floorGates]] : [connectorGates, floorGates];
    for (const pool of gatePools) {
        if (pool.length < 2) {
            if (pool.length) {
                printWarning(`pool of ${pool.length} gate(s) too small to shuffle`);
            }
            continue;
        }
        const perm = derangement(pool.length, rand);
        for (let i = 0; i < pool.length; i++) {
            const j = perm[i];
            // entering gate i's A side lands where gate j's A side used to deliver
            // (next to j's B trigger); using j's B side returns you to where gate i's
            // B side used to deliver (next to i's A trigger).
            addOverride(pool[i].a.trigger.raw, pool[j].a.arrival.raw);
            addOverride(pool[j].b.trigger.raw, pool[i].b.arrival.raw);
            spoilerGates.push({
                pool: pool[i].pool,
                locA: describe(pool[i].a.trigger, pool[i].a.description),
                locB: describe(pool[i].b.trigger, pool[i].b.description),
                nowLeadsTo: describe(pool[j].b.trigger, pool[j].b.description)
            });
        }
    }

    if (oneWays.length >= 2) {
        const perm = derangement(oneWays.length, rand);
        for (let i = 0; i < oneWays.length; i++) {
            const entry = oneWays[i];
            const target = oneWays[perm[i]];
            addOverride(entry.trigger.raw, target.arrival.raw);
            spoilerOneWay.push({
                from: describe(entry.trigger, entry.description),
                originallyLedTo: describe(entry.arrival, null),
                nowLeadsTo: describe(target.arrival, target.description)
            });
        }
    } else if (oneWays.length) {
        printWarning(`only ${oneWays.length} one-way entrance(s) found - left vanilla`);
    }

    // default mode: emit the runtime override table consumed by the engine's
    // ap_entrance_override command (see ApEntranceOverrides.ts). No content changes,
    // no pack rebuild - swap the file and restart the server.
    const output = {
        seed,
        mixed,
        generatedAt: new Date().toISOString(),
        spoiler: {
            gates: spoilerGates,
            oneWay: spoilerOneWay,
            vanillaUnpairedFloorShifts: floor.unpaired.length,
            vanillaUnpairedScanned: scanned.skipped,
            excluded
        },
        overrides
    };
    if (!dryRun) {
        fs.writeFileSync(OVERRIDES_OUTPUT, JSON.stringify(output, null, 2));
    }
    printInfo(`${dryRun ? '[dry run] ' : ''}wrote ${Object.keys(overrides).length} override(s) to ${OVERRIDES_OUTPUT}`);
    if (!dryRun) {
        printInfo('restart the server to load the new entrance layout (no content rebuild needed)');
    }
}

main();
