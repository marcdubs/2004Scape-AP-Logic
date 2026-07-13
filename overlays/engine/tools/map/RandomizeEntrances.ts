import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

import { CONTENT_ROOT, ENTRANCE_DIR, type CoordLiteral, type Entrance, parseFile } from './EntranceParser.js';

// Shuffles the ladder/stair entrances classified `cross-map` by EntranceParser.ts
// (real dungeon/area connectors - not same-building floor shifts) and rewrites the
// destination coordinates directly in content/scripts/ladders+stairs/scripts/*.rs2.
//
// Always regenerates from a vanilla backup (content/.ap-backup/), never from whatever
// currently sits in content/ - so re-running with a different --seed always starts
// from the original layout instead of compounding onto a previous shuffle. See
// ARCHIPELAGO_IDEAS.md #1 for the design rationale.
//
// Usage: npx tsx tools/map/RandomizeEntrances.ts [--seed <number>] [--dry-run]

const RELATIVE_ENTRANCE_DIR = 'scripts/ladders+stairs/scripts';
const BACKUP_DIR = path.join(CONTENT_ROOT, '.ap-backup', RELATIVE_ENTRANCE_DIR);
const SPOILER_OUTPUT = path.join(import.meta.dirname, 'entrance-seed.json');

// tiles - how close a candidate's (source, destination) pair has to be to another
// candidate's (destination, source) for the two to be treated as the up/down sides of
// the same physical staircase/ladder.
const PAIR_RADIUS = 10;

// mapsquares that must never be touched by the shuffle, regardless of classification -
// currently just Tutorial Island (48,48), so a brand-new player can never get stranded
// mid-tutorial. None of today's cross-map entries fall in these squares anyway (the
// tutorial's own stairs are same-building floor-shifts, already excluded), but this is
// cheap insurance against a future classification change quietly picking one up.
const PROTECTED_MAPSQUARES: [number, number][] = [[48, 48]];

type Indexed<T> = T & { _index: number };
type Candidate = Indexed<Entrance> & { source: { type: 'literal'; coord: CoordLiteral }; destination: CoordLiteral };

function isProtected(e: Indexed<Entrance>): boolean {
    if (e.description && /tutorial/i.test(e.description)) {
        return true;
    }
    const source = e.source;
    if (source.type === 'literal') {
        const coord = source.coord;
        if (PROTECTED_MAPSQUARES.some(([mx, mz]) => mx === coord.mapX && mz === coord.mapZ)) {
            return true;
        }
    }
    const destination = e.destination;
    if (destination?.type === 'literal') {
        if (PROTECTED_MAPSQUARES.some(([mx, mz]) => mx === destination.mapX && mz === destination.mapZ)) {
            return true;
        }
    }
    return false;
}

function isCandidate(e: Indexed<Entrance>): e is Candidate {
    return e.kind === 'cross-map' && e.source.type === 'literal' && e.destination?.type === 'literal' && !isProtected(e);
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
// destination sits near B's source, and B's destination sits near A's source).
// unpaired candidates are one-way connections (secret shortcuts, dungeon entrances with
// a generic "any" return path we can't safely rewrite, etc).
function findGatePairs(candidates: Candidate[]): { pairs: [Candidate, Candidate][]; oneWay: Candidate[] } {
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
            const d1 = worldDist(other.source.coord, e.destination);
            const d2 = worldDist(other.destination, e.source.coord);
            if (d1 <= PAIR_RADIUS && d2 <= PAIR_RADIUS) {
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

    return { pairs, oneWay: candidates.filter(e => !used.has(e)) };
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
    // once (stairs.rs2 genuinely has one duplicate case) resolves to the matching
    // occurrence rather than always the first.
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

function parseArgs() {
    const args = process.argv.slice(2);
    const seedIdx = args.indexOf('--seed');
    const seed = seedIdx !== -1 ? parseInt(args[seedIdx + 1], 10) : Math.floor(Math.random() * 0xffffffff);
    return { seed, dryRun: args.includes('--dry-run') };
}

function main() {
    if (!fs.existsSync(ENTRANCE_DIR)) {
        printWarning(`entrance script directory not found: ${ENTRANCE_DIR}`);
        process.exit(1);
    }

    const { seed, dryRun } = parseArgs();

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

    const candidates = allEntrances.filter(isCandidate);
    const { pairs, oneWay } = findGatePairs(candidates);
    const excludedCount = allEntrances.filter(e => e.kind === 'cross-map').length - candidates.length;

    printInfo(`seed ${seed}: ${pairs.length} bidirectional gate(s), ${oneWay.length} one-way entrance(s), ${excludedCount} excluded (protected regions, or generic/relative fallback that can't be safely rewritten)`);

    const edits: Edit[] = [];
    const spoilerGates: unknown[] = [];
    const spoilerOneWay: unknown[] = [];

    if (pairs.length >= 2) {
        const perm = derangement(pairs.length, rand);
        for (let i = 0; i < pairs.length; i++) {
            const j = perm[i];
            const [aTrigger] = pairs[i];
            const [, bTrigger] = pairs[j];

            edits.push({ file: path.basename(aTrigger.file), oldRaw: aTrigger.destination.raw, newRaw: bTrigger.source.coord.raw, originalIndex: aTrigger._index });
            edits.push({ file: path.basename(bTrigger.file), oldRaw: bTrigger.destination.raw, newRaw: pairs[i][0].source.coord.raw, originalIndex: bTrigger._index });

            spoilerGates.push({
                locA: describe(pairs[i][0].source.coord, pairs[i][0].description),
                locB: describe(pairs[i][1].source.coord, pairs[i][1].description),
                nowLeadsTo: describe(pairs[j][1].source.coord, pairs[j][1].description)
            });
        }
    } else {
        printWarning(`only ${pairs.length} bidirectional gate(s) found - nothing to shuffle there`);
    }

    if (oneWay.length >= 2) {
        const perm = derangement(oneWay.length, rand);
        for (let i = 0; i < oneWay.length; i++) {
            const entry = oneWay[i];
            const target = oneWay[perm[i]];
            edits.push({ file: path.basename(entry.file), oldRaw: entry.destination.raw, newRaw: target.destination.raw, originalIndex: entry._index });
            spoilerOneWay.push({
                from: describe(entry.source.coord, entry.description),
                originallyLedTo: describe(entry.destination, null),
                nowLeadsTo: describe(target.destination, target.description)
            });
        }
    } else {
        printWarning(`only ${oneWay.length} one-way entrance(s) found - nothing to shuffle there`);
    }

    for (const [file, text] of textByFile) {
        const fileEdits = edits.filter(e => e.file === file);
        const newText = applyEdits(text, fileEdits);
        textByFile.set(file, newText);
        if (!dryRun) {
            // source files use CRLF (see readSource in EntranceParser.ts) - restore it
            // so the diff against vanilla is just the actual coordinate edits, not a
            // whole-file line-ending rewrite.
            fs.writeFileSync(path.join(ENTRANCE_DIR, file), newText.replace(/\n/g, '\r\n'));
        }
    }

    const excluded = allEntrances
        .filter(e => e.kind === 'cross-map' && !isCandidate(e))
        .map(e => ({
            category: e.category,
            op: e.op,
            description: e.description,
            reason: isProtected(e) ? 'protected region (tutorial)' : e.source.type !== 'literal' ? 'non-literal source' : 'non-literal destination'
        }));

    fs.writeFileSync(
        SPOILER_OUTPUT,
        JSON.stringify(
            {
                seed,
                generatedAt: new Date().toISOString(),
                dryRun,
                gates: spoilerGates,
                oneWay: spoilerOneWay,
                excluded
            },
            null,
            2
        )
    );

    const changedCount = edits.filter(e => e.oldRaw !== e.newRaw).length;
    printInfo(`${dryRun ? '[dry run] ' : ''}applied ${changedCount} edit(s) across ${files.length} file(s); spoiler written to ${SPOILER_OUTPUT}`);
    if (!dryRun) {
        printInfo('these edits only affect content/scripts/*.rs2 - the running server loads compiled scripts');
        printInfo('from engine/data/pack/server/script.dat, so rebuild before testing: npx tsx tools/pack/Build.ts');
        printInfo('re-run ExportEntrances.ts if you need an updated entrances.json for the new layout');
    }
}

main();
