import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

import { CONTENT_ROOT, SCRIPTS_ROOT, type ModelSlot, findNpcFiles, parseSlots, readNpcSource } from './NpcDripParser.js';
import { derangement, mulberry32 } from '../shared/Prng.js';

// Shuffles NPC cosmetics (outfits/hair/etc) by permuting model# values within matching
// slot pools across every .npc config in the content tree. Pure config mutation - no
// engine or script changes, no gameplay coupling (see docs/archipelago-ideas.md #3,
// which explicitly calls this the easiest of the six ideas and recommends exactly this
// approach instead of the runtime-override pattern used for entrances). Unlike the
// entrance randomizer, reseeding here DOES require a content pack rebuild
// (npx tsx tools/pack/Build.ts) since model# is compiled into npc.dat, not read at
// runtime.
//
// Pools are keyed by gender + body-part category (e.g. "man_torso", "woman_hat"), each
// built from every occurrence of a matching model value across all NPCs, then
// deranged (a value-preserving permutation - see derangement() in ../shared/Prng.ts)
// so the same set of models still exists in the game, just redistributed. This is the
// same technique RandomizeEntrances.ts uses for gate pairs, applied here to individual
// model slots.
//
// Values that don't match the `(man|woman)_<part>_<detail>` naming convention (creature
// models, held-item models like human_weapons_*) are left untouched - see
// NpcDripParser.ts for why that convention is a safe swap boundary.
//
// Usage: npx tsx tools/npc/RandomizeDrip.ts [--seed <number>] [--dry-run] [--mixed-gender] [--exclude <substr,substr,...>]

const BACKUP_ROOT = path.join(CONTENT_ROOT, '.ap-backup', 'scripts');
const SPOILER_OUTPUT = path.join(import.meta.dirname, 'drip-seed.json');

// backs up every live .npc file the first time it's touched, so re-randomizing always
// derives from pristine vanilla instead of compounding onto a previous seed's output.
// per-file (not per-directory, unlike the entrance backup) since drip spans ~140 files
// scattered across the whole content tree - a partial/interrupted first run should
// still leave every untouched file's backup intact.
function ensureBackup(liveFiles: string[]): number {
    let created = 0;
    for (const file of liveFiles) {
        const rel = path.relative(SCRIPTS_ROOT, file);
        const backupPath = path.join(BACKUP_ROOT, rel);
        if (fs.existsSync(backupPath)) {
            continue;
        }
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(file, backupPath);
        created++;
    }
    return created;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const seedIdx = args.indexOf('--seed');
    const seed = seedIdx !== -1 ? parseInt(args[seedIdx + 1], 10) : Math.floor(Math.random() * 0xffffffff);
    const excludeIdx = args.indexOf('--exclude');
    const exclude =
        excludeIdx !== -1
            ? args[excludeIdx + 1]
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean)
            : [];
    return { seed, dryRun: args.includes('--dry-run'), mixedGender: args.includes('--mixed-gender'), exclude };
}

function main() {
    if (!fs.existsSync(SCRIPTS_ROOT)) {
        printWarning(`content scripts directory not found: ${SCRIPTS_ROOT}`);
        process.exit(1);
    }

    const { seed, dryRun, mixedGender, exclude } = parseArgs();

    const liveFiles = findNpcFiles(SCRIPTS_ROOT);
    const backedUp = ensureBackup(liveFiles);
    if (backedUp) {
        printInfo(`created vanilla content backup for ${backedUp} file(s) at ${BACKUP_ROOT}`);
    }

    // always (re)derive from the untouched vanilla backup, never the live files.
    const backupFiles = findNpcFiles(BACKUP_ROOT);
    const allSlots: ModelSlot[] = [];
    const slotsByFile = new Map<string, ModelSlot[]>();
    for (const file of backupFiles) {
        const rel = path.relative(BACKUP_ROOT, file);
        const slots = parseSlots(file, rel);
        allSlots.push(...slots);
        slotsByFile.set(rel, slots);
    }

    const excludedSet = new Set(allSlots.filter(s => exclude.some(x => s.block.includes(x) || s.file.includes(x))));
    const eligible = allSlots.filter(s => !excludedSet.has(s));

    const pools = new Map<string, ModelSlot[]>();
    for (const s of eligible) {
        const key = mixedGender ? s.category : `${s.gender}_${s.category}`;
        (pools.get(key) ?? pools.set(key, []).get(key)!).push(s);
    }

    const newValueBySlot = new Map<ModelSlot, string>();
    const poolSummaries: { pool: string; size: number; changed: number }[] = [];
    for (const [key, slots] of [...pools].sort(([a], [b]) => a.localeCompare(b))) {
        if (slots.length < 2) {
            printWarning(`pool "${key}" has only ${slots.length} value(s) - left vanilla`);
            continue;
        }
        const perm = derangement(slots.length, mulberry32(seed ^ hashKey(key)));
        let changed = 0;
        for (let i = 0; i < slots.length; i++) {
            const newValue = slots[perm[i]].value;
            newValueBySlot.set(slots[i], newValue);
            if (newValue !== slots[i].value) {
                changed++;
            }
        }
        poolSummaries.push({ pool: key, size: slots.length, changed });
    }

    let filesWritten = 0;
    let slotsChanged = 0;
    const spoilerEntries: { file: string; block: string; field: string; was: string; now: string }[] = [];

    for (const file of backupFiles) {
        const rel = path.relative(BACKUP_ROOT, file);
        const slots = slotsByFile.get(rel) ?? [];
        const edits = slots.filter(s => !excludedSet.has(s) && newValueBySlot.get(s) !== undefined && newValueBySlot.get(s) !== s.value);
        if (!edits.length) {
            continue;
        }

        const lines = readNpcSource(file).split('\n');
        for (const slot of edits) {
            const newValue = newValueBySlot.get(slot)!;
            lines[slot.line] = `${slot.field}=${newValue}`;
            spoilerEntries.push({ file: rel, block: slot.block, field: slot.field, was: slot.value, now: newValue });
        }

        filesWritten++;
        slotsChanged += edits.length;
        if (!dryRun) {
            fs.writeFileSync(path.join(SCRIPTS_ROOT, rel), lines.join('\n').replace(/\n/g, '\r\n'));
        }
    }

    printInfo(`${dryRun ? '[dry run] ' : ''}seed ${seed}: ${pools.size} pool(s), ${slotsChanged} model swap(s) across ${filesWritten} file(s) (${excludedSet.size} slot(s) excluded)`);

    fs.writeFileSync(
        SPOILER_OUTPUT,
        JSON.stringify(
            {
                seed,
                mixedGender,
                exclude,
                generatedAt: new Date().toISOString(),
                dryRun,
                pools: poolSummaries,
                swaps: spoilerEntries
            },
            null,
            2
        )
    );
    printInfo(`${dryRun ? '[dry run] ' : ''}spoiler written to ${SPOILER_OUTPUT}`);
    if (!dryRun) {
        printInfo('rebuild the pack before testing: npx tsx tools/pack/Build.ts');
    }
}

// derives a distinct per-pool sub-seed so pools don't all draw from the same PRNG
// stream in lockstep (e.g. every "size 12" pool getting an identical-shaped
// permutation) while staying fully reproducible from the one --seed value.
function hashKey(key: string): number {
    let h = 0;
    for (let i = 0; i < key.length; i++) {
        h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
    }
    return h >>> 0;
}

main();
