import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

import { BACKUP_ROOT, SCRIPTS_ROOT, ensureNpcBackup, findNpcFiles, readNpcSource } from '../npc/NpcDripParser.js';
import {
    BUCKETS,
    DROP_BACKUP_DIR,
    DROP_SCRIPTS_DIR,
    type DeathDropSlot,
    type DropSlot,
    ensureDropScriptBackup,
    findDropScriptFiles,
    loadQuestCriticalItems,
    loadStackableItems,
    parseDeathDropSlots,
    parseDropSlots
} from './DropTableParser.js';
import { derangement, mulberry32 } from '../shared/Prng.js';

// Drop randomization: reassigns which item sits in each weighted loot-drop slot across
// the monster drop-table corpus (content/scripts/drop tables/scripts/*.rs2), plus a
// separate derangement of the death_drop guaranteed-item npc param. Pure config/script
// mutation, same class of change as drip/shops (not the runtime-override pattern) -
// reseeding needs a content pack rebuild. See docs/archipelago-ideas.md #2 and the
// "Domain knowledge: drop randomization" section of docs/lessons-learned.md.
//
// Two swap modes, picked with --mode (the user explicitly wants this to eventually be
// an Archipelago per-slot option rather than a single fixed design choice):
// - tiered (default): every slot is bucketed by probability (weight/total, NOT the raw
//   threshold delta - see DropTableParser.ts for why cascades with different random()
//   denominators aren't comparable by raw weight) into ultra/rare/uncommon/common/
//   verycommon bands, then reassigned to a different item independently sampled from
//   everything else observed in that SAME band across the whole corpus. A monster's
//   ultra-rare slot always stays ultra-rare, but which item fills it moves - same
//   "structure stays put, content moves" philosophy as shopsanity's bundle derangement.
// - chaos: every eligible slot samples from the full corpus-wide item pool regardless
//   of band - a common slot can roll what used to be someone's 1% drop.
//
// Both universes are built from items actually observed in the corpus, not the full
// obj.pack catalog - unlike drip's model.pack widening, there's no safe structural
// naming convention here to filter obj.pack down to "plausible monster loot" (item
// names don't self-describe a category the way man_/woman_ model values do), so the
// vanilla drop tables' own item set is the only vetted pool available.
//
// Quest-critical items (found via loadQuestCriticalItems() - any item name that shows
// up anywhere in a quest script) have their ORIGINAL slot pinned: never reassigned away,
// so the item stays obtainable at least where it always was. They remain eligible as a
// SAMPLED-IN value for other slots though (can only add availability, never remove it).
//
// Usage: npx tsx tools/drops/RandomizeDrops.ts [--seed <number>] [--dry-run] [--mode tiered|chaos] [--no-death-drop] [--exclude <substr,substr,...>]

const SPOILER_OUTPUT = path.join(import.meta.dirname, 'drop-seed.json');

function parseArgs() {
    const args = process.argv.slice(2);
    const seedIdx = args.indexOf('--seed');
    const seed = seedIdx !== -1 ? parseInt(args[seedIdx + 1], 10) : Math.floor(Math.random() * 0xffffffff);
    const modeIdx = args.indexOf('--mode');
    const mode = modeIdx !== -1 ? args[modeIdx + 1] : 'tiered';
    if (mode !== 'tiered' && mode !== 'chaos') {
        printWarning(`unknown --mode "${mode}" - expected "tiered" or "chaos"`);
        process.exit(1);
    }
    const excludeIdx = args.indexOf('--exclude');
    const exclude =
        excludeIdx !== -1
            ? args[excludeIdx + 1]
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean)
            : [];
    return { seed, dryRun: args.includes('--dry-run'), mode: mode as 'tiered' | 'chaos', noDeathDrop: args.includes('--no-death-drop'), exclude };
}

// picks a value from pool that differs from avoid, resampling up to 50x - bounded so a
// pathologically small pool can't spin forever. Returns null if pool is empty.
function pickDifferent(pool: string[], avoid: string, rand: () => number): string | null {
    if (pool.length === 0) {
        return null;
    }
    let candidate = avoid;
    for (let attempt = 0; attempt < 50 && candidate === avoid; attempt++) {
        candidate = pool[Math.floor(rand() * pool.length)];
    }
    return candidate;
}

function hashKey(key: string): number {
    let h = 0;
    for (let i = 0; i < key.length; i++) {
        h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
    }
    return h >>> 0;
}

function randomizeDropSlots(seed: number, mode: 'tiered' | 'chaos', exclude: string[], dryRun: boolean) {
    const backedUp = ensureDropScriptBackup();
    if (backedUp) {
        printInfo(`created vanilla content backup for ${backedUp} drop-table script file(s) at ${DROP_BACKUP_DIR}`);
    }

    const backupFiles = findDropScriptFiles(DROP_BACKUP_DIR);
    const allSlots: DropSlot[] = [];
    const slotsByFile = new Map<string, DropSlot[]>();
    for (const file of backupFiles) {
        const rel = path.relative(DROP_BACKUP_DIR, file);
        const slots = parseDropSlots(file, rel);
        allSlots.push(...slots);
        slotsByFile.set(rel, slots);
    }

    const allItems = new Set(allSlots.map(s => s.item));
    const questCriticalItems = loadQuestCriticalItems(allItems);
    const stackableItems = loadStackableItems();

    const pinned = new Set<DropSlot>();
    for (const s of allSlots) {
        if (questCriticalItems.has(s.item) || exclude.some(x => s.block.includes(x) || s.file.includes(x))) {
            pinned.add(s);
        }
    }
    const eligible = allSlots.filter(s => !pinned.has(s));

    // universes are built from EVERY observed slot (pinned included) - a quest-critical
    // item can still be sampled INTO other slots, it just can't be reassigned away from
    // its own.
    const flatUniverse = [...allItems].sort();
    const bucketUniverse = new Map<string, string[]>();
    for (const b of BUCKETS) {
        const items = new Set(allSlots.filter(s => s.bucket === b.name).map(s => s.item));
        bucketUniverse.set(b.name, [...items].sort());
    }

    const newItemBySlot = new Map<DropSlot, string>();
    const newQtyBySlot = new Map<DropSlot, number>();
    const bucketSummaries: { bucket: string; universeSize: number; occurrences: number; changed: number }[] = [];

    if (mode === 'chaos') {
        const rand = mulberry32(seed ^ hashKey('chaos'));
        let changed = 0;
        for (const slot of [...eligible].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
            const candidate = pickDifferent(flatUniverse, slot.item, rand);
            if (candidate === null) {
                continue;
            }
            newItemBySlot.set(slot, candidate);
            if (candidate !== slot.item) {
                changed++;
            }
        }
        bucketSummaries.push({ bucket: 'chaos (all)', universeSize: flatUniverse.length, occurrences: eligible.length, changed });
    } else {
        for (const b of BUCKETS) {
            const slots = eligible.filter(s => s.bucket === b.name).sort((a, c) => a.file.localeCompare(c.file) || a.line - c.line);
            const universe = bucketUniverse.get(b.name) ?? [];
            if (universe.length < 2) {
                if (slots.length) {
                    printWarning(`bucket "${b.name}" has only ${universe.length} distinct item(s) - left vanilla`);
                }
                continue;
            }
            const rand = mulberry32(seed ^ hashKey(b.name));
            let changed = 0;
            for (const slot of slots) {
                const candidate = pickDifferent(universe, slot.item, rand)!;
                newItemBySlot.set(slot, candidate);
                if (candidate !== slot.item) {
                    changed++;
                }
            }
            bucketSummaries.push({ bucket: b.name, universeSize: universe.length, occurrences: slots.length, changed });
        }
    }

    // quantity: stackable new item keeps the slot's original (already-tuned-for-this-
    // probability-band) quantity; non-stackable is forced to 1 so a slot that used to
    // read "1 iron_dagger" can't land on "35 abyssal_whip".
    for (const [slot, newItem] of newItemBySlot) {
        newQtyBySlot.set(slot, stackableItems.has(newItem) ? slot.qty : 1);
    }

    let filesWritten = 0;
    let slotsChanged = 0;
    const spoilerEntries: { file: string; block: string; wasItem: string; wasQty: number; nowItem: string; nowQty: number; bucket: string; probability: number }[] = [];

    for (const file of backupFiles) {
        const rel = path.relative(DROP_BACKUP_DIR, file);
        const slots = slotsByFile.get(rel) ?? [];
        const edits = slots.filter(s => newItemBySlot.has(s) && (newItemBySlot.get(s) !== s.item || newQtyBySlot.get(s) !== s.qty));
        if (!edits.length) {
            continue;
        }

        // base text is the CURRENT LIVE file, not the backup - same reasoning as
        // RandomizeDrip.ts/RandomizeShops.ts: another tool run could have already
        // touched this file (unlikely here since nothing else edits these .rs2 files
        // today, but keeping the convention costs nothing and future-proofs it).
        const livePath = path.join(DROP_SCRIPTS_DIR, rel);
        const lines = readNpcSource(livePath).split('\n');
        for (const slot of edits) {
            const newItem = newItemBySlot.get(slot)!;
            const newQty = newQtyBySlot.get(slot)!;
            const newRaw = `obj_add(npc_coord, ${newItem}, ${newQty}, ^lootdrop_duration)`;
            lines[slot.line] = lines[slot.line].replace(slot.raw, newRaw);
            spoilerEntries.push({ file: rel, block: slot.block, wasItem: slot.item, wasQty: slot.qty, nowItem: newItem, nowQty: newQty, bucket: slot.bucket, probability: slot.probability });
        }

        filesWritten++;
        slotsChanged += edits.length;
        if (!dryRun) {
            fs.writeFileSync(livePath, lines.join('\n').replace(/\n/g, '\r\n'));
        }
    }

    return { pinnedCount: pinned.size, questCriticalCount: questCriticalItems.size, bucketSummaries, filesWritten, slotsChanged, totalSlots: allSlots.length, spoilerEntries };
}

function randomizeDeathDrops(seed: number, exclude: string[], dryRun: boolean) {
    const backupFiles = findNpcFiles(BACKUP_ROOT);
    const allSlots: DeathDropSlot[] = [];
    const slotsByFile = new Map<string, DeathDropSlot[]>();
    for (const file of backupFiles) {
        const rel = path.relative(BACKUP_ROOT, file);
        const slots = parseDeathDropSlots(file, rel);
        allSlots.push(...slots);
        slotsByFile.set(rel, slots);
    }

    const excludedSlots = new Set(allSlots.filter(s => exclude.some(x => s.block.includes(x) || s.file.includes(x))));
    const eligible = allSlots.filter(s => !excludedSlots.has(s));

    const rand = mulberry32(seed ^ hashKey('death_drop'));
    const newSourceFor = new Map<DeathDropSlot, DeathDropSlot>();
    if (eligible.length >= 2) {
        const perm = derangement(eligible.length, rand);
        for (let i = 0; i < eligible.length; i++) {
            newSourceFor.set(eligible[i], eligible[perm[i]]);
        }
    }

    let filesWritten = 0;
    let reassigned = 0;
    const spoilerEntries: { file: string; block: string; was: string; now: string }[] = [];

    for (const file of backupFiles) {
        const rel = path.relative(BACKUP_ROOT, file);
        const slots = slotsByFile.get(rel) ?? [];
        const edits = slots.filter(s => newSourceFor.has(s));
        if (!edits.length) {
            continue;
        }

        const livePath = path.join(SCRIPTS_ROOT, rel);
        const lines = readNpcSource(livePath).split('\n');
        for (const slot of edits) {
            const source = newSourceFor.get(slot)!;
            lines[slot.line] = `param=death_drop,${source.value}`;
            spoilerEntries.push({ file: rel, block: slot.block, was: slot.value, now: source.value });
        }

        filesWritten++;
        reassigned += edits.length;
        if (!dryRun) {
            fs.writeFileSync(livePath, lines.join('\n').replace(/\n/g, '\r\n'));
        }
    }

    return { eligibleCount: eligible.length, excludedCount: excludedSlots.size, filesWritten, reassigned, spoilerEntries };
}

function main() {
    if (!fs.existsSync(DROP_SCRIPTS_DIR)) {
        printWarning(`drop table scripts directory not found: ${DROP_SCRIPTS_DIR}`);
        process.exit(1);
    }

    const { seed, dryRun, mode, noDeathDrop, exclude } = parseArgs();

    const npcBackedUp = ensureNpcBackup();
    if (npcBackedUp) {
        printInfo(`created vanilla content backup for ${npcBackedUp} .npc file(s) at ${BACKUP_ROOT}`);
    }

    const dropResult = randomizeDropSlots(seed, mode, exclude, dryRun);
    printInfo(
        `${dryRun ? '[dry run] ' : ''}seed ${seed} (${mode}): ${dropResult.slotsChanged} slot(s) reassigned across ${dropResult.filesWritten} file(s) of ${dropResult.totalSlots} total (${dropResult.pinnedCount} pinned - ${dropResult.questCriticalCount} quest-critical item(s), rest via --exclude)`
    );

    let deathResult: ReturnType<typeof randomizeDeathDrops> | null = null;
    if (!noDeathDrop) {
        deathResult = randomizeDeathDrops(seed, exclude, dryRun);
        printInfo(`${dryRun ? '[dry run] ' : ''}seed ${seed}: ${deathResult.reassigned} death_drop(s) reassigned across ${deathResult.filesWritten} file(s) (${deathResult.excludedCount} excluded via --exclude, quests/tutorial always excluded)`);
    } else {
        printInfo('death_drop: disabled (--no-death-drop)');
    }

    fs.writeFileSync(
        SPOILER_OUTPUT,
        JSON.stringify(
            {
                seed,
                mode,
                noDeathDrop,
                exclude,
                generatedAt: new Date().toISOString(),
                buckets: dropResult.bucketSummaries,
                dropSwaps: dropResult.spoilerEntries,
                deathDropSwaps: deathResult?.spoilerEntries ?? []
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

main();
