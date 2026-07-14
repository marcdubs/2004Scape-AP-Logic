import { execFileSync } from 'child_process';

import { printInfo } from '#/util/Logger.js';

import { BACKUP_ROOT, SCRIPTS_ROOT, ensureNpcBackup, restoreNpcBackup } from './npc/NpcDripParser.js';
import { DROP_BACKUP_DIR, DROP_SCRIPTS_DIR, ensureDropScriptBackup, restoreDropScriptBackup } from './drops/DropTableParser.js';
import { removeMimicArtifacts } from './drops/MimicTransform.js';

// Single entry point for "start completely fresh and regenerate every content
// randomizer together" - restores the .npc/drop-table tree to pristine vanilla ONCE,
// then runs drip, shops, and drops in sequence, then rebuilds the pack.
//
// Why this exists instead of each tool restoring pristine on its own: drip and
// shopsanity deliberately share one backup and write onto the CURRENT LIVE file (never
// a fresh copy of the backup) specifically so reseeding one tool doesn't erase the
// other's edits (see NpcDripParser.ts's restoreNpcBackup() comment, and the shopsanity
// domain-knowledge section in docs/lessons-learned.md for the original cross-tool
// data-loss bug this convention was built to fix). If every tool restored to pristine
// before running, running drip after shops would wipe shops' owned_shop reassignments,
// and vice versa. Restoring is only safe as a step in a pipeline that then re-runs
// EVERY tool that's supposed to be part of the seed, atomically - that's what this
// script is.
//
// It's also the fix for a DIFFERENT class of problem than cross-tool collision: when a
// tool's OWN logic changes (e.g. a new exclusion rule, a bug fix), any live file left
// untouched by the new logic keeps whatever an OLDER, possibly-buggy version of that
// same tool wrote. "Skip this slot" in the current code means "leave current content
// alone," not "restore to vanilla" - so old mistakes persist across reseeds until
// something restores pristine and reruns everything. Found via a real case: drip's
// armor-set fix correctly declined to touch a mourner NPC's plaguesuit-family torso
// slot (the "plaguesuit" torso family only has 1 valid value, so there's nothing
// different to reassign to) - but the live file was ALREADY holding a wrong value
// (`man_torso_backpack`) from BEFORE the armor-set fix existed, and skip-not-restore
// meant it stayed wrong indefinitely.
//
// Usage: npx tsx tools/RegenerateAll.ts [--seed <number>] [--drip-seed <n>] [--shops-seed <n>] [--drops-seed <n>] [--mode tiered|chaos|mimic] [--skip-drip] [--skip-shops] [--skip-drops] [--no-rebuild]

function parseArgs() {
    const args = process.argv.slice(2);
    const sharedSeedIdx = args.indexOf('--seed');
    const sharedSeed = sharedSeedIdx !== -1 ? args[sharedSeedIdx + 1] : String(Math.floor(Math.random() * 0xffffffff));

    const namedSeed = (flag: string) => {
        const i = args.indexOf(flag);
        return i !== -1 ? args[i + 1] : sharedSeed;
    };

    const modeIdx = args.indexOf('--mode');
    const mode = modeIdx !== -1 ? args[modeIdx + 1] : null;

    return {
        dripSeed: namedSeed('--drip-seed'),
        shopsSeed: namedSeed('--shops-seed'),
        dropsSeed: namedSeed('--drops-seed'),
        mode,
        skipDrip: args.includes('--skip-drip'),
        skipShops: args.includes('--skip-shops'),
        skipDrops: args.includes('--skip-drops'),
        rebuild: !args.includes('--no-rebuild')
    };
}

function run(scriptPath: string, args: string[]): void {
    printInfo(`running: npx tsx ${scriptPath} ${args.join(' ')}`);
    execFileSync('npx', ['tsx', scriptPath, ...args], { stdio: 'inherit' });
}

function main() {
    const { dripSeed, shopsSeed, dropsSeed, mode, skipDrip, skipShops, skipDrops, rebuild } = parseArgs();

    // ensure backups exist (no-op if this isn't the first-ever run), then restore
    // every backed-up file onto its live path - this is the "start completely fresh"
    // step, see file header for why it's only safe to do here, not inside each tool.
    const npcBackedUp = ensureNpcBackup();
    if (npcBackedUp) {
        printInfo(`created vanilla content backup for ${npcBackedUp} .npc file(s) at ${BACKUP_ROOT}`);
    }
    const dropBackedUp = ensureDropScriptBackup();
    if (dropBackedUp) {
        printInfo(`created vanilla content backup for ${dropBackedUp} drop-table script file(s) at ${DROP_BACKUP_DIR}`);
    }

    const npcRestored = restoreNpcBackup();
    const dropRestored = restoreDropScriptBackup();
    printInfo(`restored ${npcRestored} .npc file(s) (${SCRIPTS_ROOT}) and ${dropRestored} drop-table script(s) (${DROP_SCRIPTS_DIR}) to pristine vanilla`);

    // the mimic dispatch file/JSON live OUTSIDE the backed-up subtrees (deliberately -
    // see MimicTransform.ts), so the restore above doesn't touch them. If this pipeline
    // isn't about to re-run drops in mimic mode, they'd be stale leftovers.
    if (skipDrops || mode !== 'mimic') {
        const removed = removeMimicArtifacts();
        if (removed.length) {
            printInfo(`removed ${removed.length} stale mimic artifact(s): ${removed.join(', ')}`);
        }
    }

    if (!skipDrip) {
        run('tools/npc/RandomizeDrip.ts', ['--seed', dripSeed]);
    } else {
        printInfo('drip: skipped (--skip-drip)');
    }

    if (!skipShops) {
        run('tools/npc/RandomizeShops.ts', ['--seed', shopsSeed]);
    } else {
        printInfo('shops: skipped (--skip-shops)');
    }

    if (!skipDrops) {
        const dropsArgs = ['--seed', dropsSeed];
        if (mode) {
            dropsArgs.push('--mode', mode);
        }
        run('tools/drops/RandomizeDrops.ts', dropsArgs);
    } else {
        printInfo('drops: skipped (--skip-drops)');
    }

    if (rebuild) {
        run('tools/pack/Build.ts', []);
    } else {
        printInfo('pack rebuild: skipped (--no-rebuild) - run npx tsx tools/pack/Build.ts before testing');
    }
}

main();
