import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

import { CONTENT_ROOT, SCRIPTS_ROOT, type ModelSlot, findNpcFiles, loadModelUniverse, parseSlots, readNpcSource } from './NpcDripParser.js';
import { mulberry32 } from '../shared/Prng.js';

// Shuffles NPC cosmetics (outfits/hair/etc) by reassigning model# values within matching
// slot pools across every .npc config in the content tree. Pure config mutation - no
// engine or script changes, no gameplay coupling (see docs/archipelago-ideas.md #3,
// which explicitly calls this the easiest of the six ideas and recommends exactly this
// approach instead of the runtime-override pattern used for entrances). Unlike the
// entrance randomizer, reseeding here DOES require a content pack rebuild
// (npx tsx tools/pack/Build.ts) since model# is compiled into npc.dat, not read at
// runtime.
//
// Pools are keyed by gender + body-part category (e.g. "man_torso", "woman_hat"). Each
// model# slot gets an independently-sampled replacement drawn from every valid model in
// that category across the WHOLE cache (content/pack/model.pack via
// loadModelUniverse()), not just the values some NPC already happens to be wearing -
// that pool is meaningfully bigger (e.g. woman_hat: 23 valid models vs only 8 ever worn
// by a vanilla NPC), so this surfaces combinations vanilla never used. Every slot is
// guaranteed to actually change (resampled until it differs from its own original
// value, unless the category has fewer than 2 valid models total).
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

    const modelUniverse = loadModelUniverse();
    // in --mixed-gender mode a pool key is just the category ("torso") - merge both
    // genders' cache universes so a man_ NPC can end up in woman_ gear and vice versa.
    function universeFor(key: string): string[] {
        if (!mixedGender) {
            return modelUniverse.get(key) ?? [];
        }
        const man = modelUniverse.get(`man_${key}`) ?? [];
        const woman = modelUniverse.get(`woman_${key}`) ?? [];
        return [...new Set([...man, ...woman])];
    }

    const newValueBySlot = new Map<ModelSlot, string>();
    const poolSummaries: { pool: string; universeSize: number; occurrences: number; changed: number }[] = [];
    for (const [key, slots] of [...pools].sort(([a], [b]) => a.localeCompare(b))) {
        const universe = universeFor(key);
        if (universe.length < 2) {
            printWarning(`pool "${key}" has only ${universe.length} model(s) in model.pack - left vanilla`);
            continue;
        }

        const rand = mulberry32(seed ^ hashKey(key));
        let changed = 0;
        for (const slot of slots) {
            let candidate = slot.value;
            // resample until it actually differs from the slot's own original value -
            // bounded so a pathological universe can't spin forever.
            for (let attempt = 0; attempt < 50 && candidate === slot.value; attempt++) {
                candidate = universe[Math.floor(rand() * universe.length)];
            }
            newValueBySlot.set(slot, candidate);
            if (candidate !== slot.value) {
                changed++;
            }
        }
        poolSummaries.push({ pool: key, universeSize: universe.length, occurrences: slots.length, changed });
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
// stream in lockstep while staying fully reproducible from the one --seed value.
function hashKey(key: string): number {
    let h = 0;
    for (let i = 0; i < key.length; i++) {
        h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
    }
    return h >>> 0;
}

main();
