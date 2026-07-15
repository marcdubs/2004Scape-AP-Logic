import fs from 'fs';
import path from 'path';

// Pre-AP / manual test CLI for the runtime unlock table
// (data/config/ap-unlocks.json, read by ApUnlockOverrides.ts). Plain fs + JSON, no
// deps - this is meant to be run against a LIVE server (the loader reloads on its own,
// throttled to ~2s, so no restart is needed after this writes the file).
//
// Usage (run from Server/engine, like the other tools/*.ts scripts):
//   npx tsx tools/ap/SetUnlock.ts <name> <count>   - upsert one unlock's count
//   npx tsx tools/ap/SetUnlock.ts --clear          - delete the file (back to vanilla)
//   npx tsx tools/ap/SetUnlock.ts                  - print usage + the current table

const CFG_DIR = 'data/config';
const CFG_PATH = path.join(CFG_DIR, 'ap-unlocks.json');

type Table = { unlocks: Record<string, number> };

function readTable(): Table {
    if (!fs.existsSync(CFG_PATH)) {
        return { unlocks: {} };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
        return { unlocks: (parsed && typeof parsed === 'object' && parsed.unlocks && typeof parsed.unlocks === 'object') ? parsed.unlocks : {} };
    } catch (err) {
        console.warn(`warning: failed to parse existing ${CFG_PATH}, treating as empty (${err instanceof Error ? err.message : err})`);
        return { unlocks: {} };
    }
}

function writeTable(table: Table): void {
    fs.mkdirSync(CFG_DIR, { recursive: true });
    fs.writeFileSync(CFG_PATH, JSON.stringify(table, null, 4) + '\n');
}

function printUsage(): void {
    console.log('Usage:');
    console.log('  npx tsx tools/ap/SetUnlock.ts <name> <count>   - upsert one unlock');
    console.log('  npx tsx tools/ap/SetUnlock.ts --clear          - delete the table (back to vanilla)');
    console.log('  npx tsx tools/ap/SetUnlock.ts                  - print this + current table');
    console.log();
    const table = readTable();
    const entries = Object.entries(table.unlocks);
    if (!fs.existsSync(CFG_PATH)) {
        console.log(`${CFG_PATH} does not exist - server is running vanilla (everything unlocked).`);
    } else if (entries.length === 0) {
        console.log(`${CFG_PATH} exists but is empty.`);
    } else {
        console.log(`Current ${CFG_PATH}:`);
        for (const [name, count] of entries.sort(([a], [b]) => a.localeCompare(b))) {
            console.log(`  ${name}: ${count}`);
        }
    }
}

function main(): void {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        printUsage();
        return;
    }

    if (args[0] === '--clear') {
        if (fs.existsSync(CFG_PATH)) {
            fs.unlinkSync(CFG_PATH);
            console.log(`deleted ${CFG_PATH} - unlocks are vanilla again.`);
        } else {
            console.log(`${CFG_PATH} did not exist - nothing to clear.`);
        }
        return;
    }

    const [name, countRaw] = args;
    const count = Number(countRaw);
    if (!name || name.startsWith('--') || countRaw === undefined || !Number.isInteger(count) || count < 0) {
        console.error('error: expected <name> <count> (count must be a non-negative integer)');
        printUsage();
        process.exitCode = 1;
        return;
    }

    const table = readTable();
    table.unlocks[name] = count;
    writeTable(table);
    console.log(`set ${name} = ${count} in ${CFG_PATH}`);
}

main();
