import fs from 'fs';
import path from 'path';

import { printInfo } from '#/util/Logger.js';

import { TELEPORT_BACKUP_PATH, TELEPORT_DBROW_PATH, ensureTeleportBackup, parseTeleportRows, writeTeleportCoords } from './TeleportParser.js';
import { derangement, mulberry32 } from '../shared/Prng.js';

// Archipelago teleport-destination shuffle (docs/goals-and-checks.md Feature 4):
// derange the 7 standard-spellbook tele_coord values among themselves so every
// spell lands at a different city than its name says - but always at one of the
// 7 vanilla safe landmarks (never wilderness, never indoors). Quest gates on
// casting (Ardougne/Watchtower/Trollheim) stay put: they gate the spell, not
// the destination.
//
// Config-mutation class (same as drip/shops/drops): the shuffle compiles into
// the pack, so reseeding needs a pack rebuild. Run via RegenerateAll.ts, which
// restores the pristine dbrow backup first and rebuilds the pack after. Vanilla
// values are always read from the content/.ap-backup copy, so a standalone
// re-run can't compound a previous shuffle.
//
// Usage: npx tsx tools/map/RandomizeTeleports.ts [--seed <number>] [--dry-run]
// Run from Server/engine (CONTENT_ROOT resolves ../content from cwd).

const SPOILER_PATH = path.resolve('tools/map/teleport-seed.json');

function parseArgs() {
    const args = process.argv.slice(2);
    const seedIdx = args.indexOf('--seed');
    const seed = seedIdx !== -1 ? parseInt(args[seedIdx + 1], 10) : Math.floor(Math.random() * 0xffffffff);
    if (!Number.isFinite(seed)) {
        throw new Error('--seed must be a number');
    }
    return { seed: seed >>> 0, dryRun: args.includes('--dry-run') };
}

function main() {
    const { seed, dryRun } = parseArgs();

    if (!dryRun && ensureTeleportBackup()) {
        printInfo(`created vanilla backup: ${TELEPORT_BACKUP_PATH}`);
    }

    // vanilla coords come from the pristine backup when one exists - the live
    // file may already hold a previous seed's shuffle.
    const pristinePath = fs.existsSync(TELEPORT_BACKUP_PATH) ? TELEPORT_BACKUP_PATH : TELEPORT_DBROW_PATH;
    const pristine = parseTeleportRows(fs.readFileSync(pristinePath, 'utf8'));
    if (pristine.length !== 7) {
        throw new Error(`expected 7 tele_coord rows in ${pristinePath}, found ${pristine.length}`);
    }

    const perm = derangement(pristine.length, mulberry32(seed));
    const mapping: Record<string, { landsAt: string; coord: string }> = {};
    for (let i = 0; i < pristine.length; i++) {
        mapping[pristine[i].city] = { landsAt: pristine[perm[i]].city, coord: pristine[perm[i]].coord };
    }

    if (dryRun) {
        for (const [spell, dest] of Object.entries(mapping)) {
            printInfo(`${spell} teleport -> ${dest.landsAt} (${dest.coord})`);
        }
        printInfo(`dry run (seed ${seed}) - nothing written`);
        return;
    }

    // patch the LIVE file's rows (its line numbers, the pristine coords) so this
    // composes with any other tool that may someday edit the same dbrow.
    const liveSource = fs.readFileSync(TELEPORT_DBROW_PATH, 'utf8');
    const liveRows = parseTeleportRows(liveSource);
    if (liveRows.length !== pristine.length) {
        throw new Error(`live ${TELEPORT_DBROW_PATH} has ${liveRows.length} tele_coord rows, backup has ${pristine.length} - restore the backup and retry`);
    }
    const updates = liveRows.map(row => ({ line: row.line, coord: mapping[row.city].coord }));
    fs.writeFileSync(TELEPORT_DBROW_PATH, writeTeleportCoords(liveSource, updates));

    fs.writeFileSync(SPOILER_PATH, JSON.stringify({ seed, mapping }, null, 4) + '\n');
    printInfo(`teleports: deranged ${pristine.length} destinations (seed ${seed}); spoiler: ${SPOILER_PATH}`);
    printInfo('teleports: content changed - pack rebuild required (RegenerateAll.ts does this automatically)');
}

main();
