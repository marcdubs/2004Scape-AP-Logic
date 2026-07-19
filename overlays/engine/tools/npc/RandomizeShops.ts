import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

import { BACKUP_ROOT, SCRIPTS_ROOT, ensureNpcBackup, findNpcFiles, readNpcSource } from './NpcDripParser.js';
import { type ShopBundle, loadHardcodedShopIds, parseShopBundles } from './ShopParser.js';
import { derangement, mulberry32 } from '../shared/Prng.js';

// Shopsanity: shuffles which NPC has which shop. Pure config mutation on the .npc
// files (same class of change as RandomizeDrip.ts, not the runtime-override pattern
// used for entrances) - the original design sketch called this
// "pure data mutation... no engine or script changes required". A runtime override
// would need to intercept every code path that can open a shop (the generic
// ~openshop_activenpc proc, PLUS several bespoke per-NPC scripts), several of which
// are excluded below anyway because they don't consult the NPC's params at all - so it
// wouldn't cover meaningfully more ground than config mutation while being far more
// complex (multi-field override vs. entrance's single coord swap). Reseeding needs a
// content pack rebuild (npx tsx tools/pack/Build.ts), same as drip.
//
// Every owned_shop NPC block carries 4 companion params (shop_sell_multiplier,
// shop_buy_multiplier, shop_delta, shop_title) - see ShopParser.ts. By default the
// whole 5-field bundle moves together via one derangement, so a shop's title/pricing
// stays internally consistent, just relocated to a different NPC ("stock stays put,
// access moves" per the ideas doc). --mismatched-titles instead deranges only the
// `owned_shop` field, leaving title/pricing on the original NPC, for a chaos variant
// where a shopkeeper's personality no longer matches what they're selling.
//
// Excluded: any NPC whose current shop id is also used as a literal argument to
// ~openshop(...) somewhere in scripts (dommik, rommik in vanilla - see
// loadHardcodedShopIds() in ShopParser.ts for why their param is unsafe to move).
//
// Usage: npx tsx tools/npc/RandomizeShops.ts [--seed <number>] [--dry-run] [--mismatched-titles] [--exclude <substr,substr,...>]

const SPOILER_OUTPUT = path.join(import.meta.dirname, 'shop-seed.json');

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
    return { seed, dryRun: args.includes('--dry-run'), mismatchedTitles: args.includes('--mismatched-titles'), exclude };
}

function main() {
    if (!fs.existsSync(SCRIPTS_ROOT)) {
        printWarning(`content scripts directory not found: ${SCRIPTS_ROOT}`);
        process.exit(1);
    }

    const { seed, dryRun, mismatchedTitles, exclude } = parseArgs();

    const backedUp = ensureNpcBackup();
    if (backedUp) {
        printInfo(`created vanilla content backup for ${backedUp} file(s) at ${BACKUP_ROOT}`);
    }

    // always (re)derive from the untouched vanilla backup, never the live files.
    const backupFiles = findNpcFiles(BACKUP_ROOT);
    const allBundles: ShopBundle[] = [];
    const bundlesByFile = new Map<string, ShopBundle[]>();
    for (const file of backupFiles) {
        const rel = path.relative(BACKUP_ROOT, file);
        const bundles = parseShopBundles(file, rel);
        allBundles.push(...bundles);
        bundlesByFile.set(rel, bundles);
    }

    const hardcodedIds = loadHardcodedShopIds();
    const excludedBundles = new Set<ShopBundle>();
    let hardcodedExcluded = 0;
    for (const b of allBundles) {
        if (hardcodedIds.has(b.shop)) {
            excludedBundles.add(b);
            hardcodedExcluded++;
            continue;
        }
        if (exclude.some(x => b.block.includes(x) || b.file.includes(x))) {
            excludedBundles.add(b);
        }
    }

    const eligible = allBundles.filter(b => !excludedBundles.has(b));
    if (eligible.length < 2) {
        printWarning(`only ${eligible.length} eligible shopkeeper(s) found - nothing to shuffle`);
    }

    const rand = mulberry32(seed);
    const newSourceFor = new Map<ShopBundle, ShopBundle>();
    if (eligible.length >= 2) {
        const perm = derangement(eligible.length, rand);
        for (let i = 0; i < eligible.length; i++) {
            newSourceFor.set(eligible[i], eligible[perm[i]]);
        }
    }

    let filesWritten = 0;
    let shopsReassigned = 0;
    const spoilerEntries: { file: string; block: string; was: { shop: string; title: string }; now: { shop: string; title: string } }[] = [];

    for (const file of backupFiles) {
        const rel = path.relative(BACKUP_ROOT, file);
        const bundles = bundlesByFile.get(rel) ?? [];
        const edits: { line: number; value: string }[] = [];

        for (const bundle of bundles) {
            const source = newSourceFor.get(bundle);
            if (!source) {
                continue;
            }

            edits.push({ line: bundle.shopLine, value: `param=owned_shop,${source.shop}` });
            let newTitle = bundle.title;
            if (!mismatchedTitles) {
                edits.push({ line: bundle.sellLine, value: `param=shop_sell_multiplier,${source.sell}` });
                edits.push({ line: bundle.buyLine, value: `param=shop_buy_multiplier,${source.buy}` });
                edits.push({ line: bundle.deltaLine, value: `param=shop_delta,${source.delta}` });
                edits.push({ line: bundle.titleLine, value: `param=shop_title,${source.title}` });
                newTitle = source.title;
            }

            shopsReassigned++;
            spoilerEntries.push({
                file: rel,
                block: bundle.block,
                was: { shop: bundle.shop, title: bundle.title },
                now: { shop: source.shop, title: newTitle }
            });
        }

        if (!edits.length) {
            continue;
        }

        // base text is the CURRENT LIVE file, not the backup - see the matching
        // comment in RandomizeDrip.ts for why (this shares the same .npc files, and
        // rebuilding from a fresh backup copy here would erase drip's edits).
        const livePath = path.join(SCRIPTS_ROOT, rel);
        const lines = readNpcSource(livePath).split('\n');
        for (const edit of edits) {
            lines[edit.line] = edit.value;
        }

        filesWritten++;
        if (!dryRun) {
            fs.writeFileSync(livePath, lines.join('\n').replace(/\n/g, '\r\n'));
        }
    }

    printInfo(
        `${dryRun ? '[dry run] ' : ''}seed ${seed}: ${shopsReassigned} shop(s) reassigned across ${filesWritten} file(s) (${hardcodedExcluded} excluded - hardcoded elsewhere in scripts, ${excludedBundles.size - hardcodedExcluded} excluded via --exclude)`
    );

    fs.writeFileSync(
        SPOILER_OUTPUT,
        JSON.stringify(
            {
                seed,
                mismatchedTitles,
                exclude,
                generatedAt: new Date().toISOString(),
                dryRun,
                hardcodedShopIds: [...hardcodedIds].sort(),
                eligibleCount: eligible.length,
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

main();
