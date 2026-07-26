import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

import { BACKUP_ROOT, findNpcFiles } from '../npc/NpcDripParser.js';
import { branchItems, planCascade } from './CapDropRarity.js';
import { type DropCascade, DROP_BACKUP_DIR, DROP_SCRIPTS_DIR, ensureDropScriptBackup, findDropScriptFiles, parseDeathDropSlots, parseDropCascades } from './DropTableParser.js';
import { MIMIC_GENERATED_FILE } from './MimicTransform.js';
import { mulberry32 } from '../shared/Prng.js';

// Rolls a monster's real loot cascade N times and prints what fell out. Exists to make
// the rarity cap (GitHub #11) checkable instead of theoretical: by default it simulates
// the SAME table twice - once with vanilla weights, once with the capped weights
// planCascade() would write - so the two columns come from one source of truth rather
// than from two hand-copied tables.
//
// It writes nothing. `--capped` is computed in memory, so this is safe to run against a
// live content tree at any time, before or after the cap has actually been applied.
//
// What it models: the weighted `if ($random < N)` cascade in the monster's death handler,
// which is the entire loot table for every monster in the corpus (see DropTableParser.ts).
// One roll per kill, one drop per roll, and rolls above the last threshold produce
// "(nothing)" - the no-drop tail the cap spends first. `death_drop` (bones/ashes, every
// kill, unconditional) is reported separately when the npc config can be resolved, since
// it isn't part of the roll.
//
// What it does NOT model, deliberately:
// - shared sub-tables behind a `~proc` call. A `~randomherb` branch is reported as the
//   single outcome "~randomherb", because that's the granularity the cap operates at -
//   the proc's own internal table is untouched by #11 and would make the columns lie
//   about what changed. So "1 in 32 ~randomjewel" means one jewel ROLL in 32, not one
//   specific gem.
// - `map_members` alternates inside one branch (two obj_add calls at one shared weight).
//   Both items are listed on the branch's row joined with " | " - they're one roll.
// - clue-scroll calls (`~trail_mediumcluedrop`) and quest-gated drops outside the
//   cascade, which have their own conditions and no weight to simulate.
//
// Usage: npx tsx tools/drops/SimulateDrops.ts <npc> [--kills 10000] [--seed <n>] [--min-rate 1/32] [--live] [--list]

type Outcome = { label: string; weight: number; total: number };

const VALUE_FLAGS = ['--kills', '--seed', '--min-rate'];

function parseArgs() {
    const args = process.argv.slice(2);
    const flagValue = (flag: string): string | undefined => {
        const i = args.indexOf(flag);
        return i !== -1 ? args[i + 1] : undefined;
    };
    // the npc is the one positional argument: any token that isn't a flag and isn't the
    // value of the flag before it
    const npc = args.find((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(args[i - 1])));

    const rateRaw = flagValue('--min-rate') ?? '1/32';
    const rm = /^(\d+)\s*\/\s*(\d+)$/.exec(rateRaw.trim());
    if (!rm) {
        printWarning(`--min-rate must look like "1/32" (got "${rateRaw}")`);
        process.exit(1);
    }

    return {
        npc,
        kills: parseInt(flagValue('--kills') ?? '10000', 10),
        seed: parseInt(flagValue('--seed') ?? '777', 10),
        minRate: { num: parseInt(rm[1], 10), den: parseInt(rm[2], 10) },
        live: args.includes('--live'),
        list: args.includes('--list')
    };
}

// every cascade in the corpus, keyed for lookup. Reads the pristine backup by default
// (so the vanilla column is genuinely vanilla even on an already-randomized tree) and
// the live tree under --live, which is how you check what is actually installed.
function loadCascades(live: boolean): DropCascade[] {
    const root = live ? DROP_SCRIPTS_DIR : DROP_BACKUP_DIR;
    const cascades: DropCascade[] = [];
    for (const file of findDropScriptFiles(root)) {
        cascades.push(...parseDropCascades(file, path.relative(root, file)));
    }
    if (live && fs.existsSync(MIMIC_GENERATED_FILE)) {
        cascades.push(...parseDropCascades(MIMIC_GENERATED_FILE, path.basename(MIMIC_GENERATED_FILE)));
    }
    return cascades;
}

// block names aren't npc names: the same table is `_black_demon` in one file and
// `goblin_village_drop_table` in another. Match in decreasing order of confidence and
// report what was picked rather than guessing silently.
function resolve(cascades: DropCascade[], npc: string): DropCascade | null {
    const want = npc.toLowerCase();
    const stem = (c: DropCascade) => path.basename(c.file, '.rs2').toLowerCase();
    const rules: ((c: DropCascade) => boolean)[] = [
        c => c.block.toLowerCase() === want,
        c => c.block.toLowerCase().replace(/^_/, '') === want,
        c => stem(c) === want,
        c => c.block.toLowerCase().includes(want),
        c => stem(c).includes(want)
    ];
    for (const rule of rules) {
        const hits = cascades.filter(rule);
        if (hits.length === 1) {
            return hits[0];
        }
        if (hits.length > 1) {
            printWarning(`"${npc}" matches ${hits.length} tables - pick one: ${hits.map(h => h.block).join(', ')}`);
            process.exit(1);
        }
    }
    return null;
}

// bones/ashes: guaranteed on every kill, outside the cascade. Block names only line up
// with .npc names some of the time (the handler for "bandit" is `brawling_bandit`), so
// this is best-effort and simply stays quiet when it can't resolve one.
function deathDropFor(block: string): string | null {
    const candidates = [block, block.replace(/^_/, '')];
    for (const file of findNpcFiles(BACKUP_ROOT)) {
        for (const slot of parseDeathDropSlots(file, path.relative(BACKUP_ROOT, file))) {
            if (candidates.includes(slot.block)) {
                return slot.value;
            }
        }
    }
    return null;
}

function outcomesFor(cascade: DropCascade, weights: number[], total: number): Outcome[] {
    return cascade.branches.map((b, i) => {
        const items = branchItems(b);
        return {
            label: items.length ? items.join(' | ') : '(nothing)',
            weight: weights[i],
            total
        };
    });
}

// one roll per kill, walking the cascade exactly as the server does
function roll(outcomes: Outcome[], total: number, kills: number, seed: number): Map<string, number> {
    const rand = mulberry32(seed);
    const counts = new Map<string, number>();
    const thresholds: number[] = [];
    let running = 0;
    for (const o of outcomes) {
        running += o.weight;
        thresholds.push(running);
    }
    for (let k = 0; k < kills; k++) {
        const r = Math.floor(rand() * total);
        const idx = thresholds.findIndex(t => r < t);
        const label = idx === -1 ? '(nothing)' : outcomes[idx].label;
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
}

// merges the branch rows that share a label (a table can list `coins` at several
// weights) so the printed table reads like a drop-rate wiki page
function tableRates(outcomes: Outcome[], total: number): Map<string, number> {
    const rates = new Map<string, number>();
    let covered = 0;
    for (const o of outcomes) {
        rates.set(o.label, (rates.get(o.label) ?? 0) + o.weight / total);
        covered += o.weight;
    }
    if (covered < total) {
        rates.set('(nothing)', (rates.get('(nothing)') ?? 0) + (total - covered) / total);
    }
    return rates;
}

const pct = (p: number) => `${(p * 100).toFixed(2)}%`;
const oneIn = (p: number) => {
    if (p <= 0) {
        return '-';
    }
    const n = 1 / p;
    // whole-number odds are the common case (1/32, 1/128) - only show a decimal when the
    // merged rate genuinely isn't one (several coins branches summed together)
    return `1/${Math.abs(n - Math.round(n)) < 0.05 ? Math.round(n) : n.toFixed(1)}`;
};

function main() {
    const { npc, kills, seed, minRate, live, list } = parseArgs();

    if (!fs.existsSync(DROP_SCRIPTS_DIR)) {
        printWarning(`drop table scripts directory not found: ${DROP_SCRIPTS_DIR}`);
        process.exit(1);
    }
    ensureDropScriptBackup();

    const cascades = loadCascades(live);
    if (list || !npc) {
        printInfo(`${cascades.length} loot table(s) available:`);
        for (const c of cascades) {
            console.log(`  ${c.block.padEnd(34)} ${c.file} (${c.branches.length} branches, random(${c.total}))`);
        }
        if (!npc) {
            printWarning('usage: npx tsx tools/drops/SimulateDrops.ts <npc> [--kills 10000] [--seed <n>] [--min-rate 1/32] [--live]');
        }
        return;
    }

    const cascade = resolve(cascades, npc);
    if (!cascade) {
        printWarning(`no loot table matches "${npc}" - run with --list to see them all`);
        process.exit(1);
    }

    const vanillaWeights = cascade.branches.map(b => b.weight);
    const plan = planCascade(cascade, minRate);
    const cappedWeights = plan?.weights ?? vanillaWeights;
    const cappedTotal = plan?.newTotal ?? cascade.total;

    const vanillaOutcomes = outcomesFor(cascade, vanillaWeights, cascade.total);
    const cappedOutcomes = outcomesFor(cascade, cappedWeights, cappedTotal);
    // same seed for both columns: the difference you read is the table changing, not the
    // dice changing
    const vanillaRolls = roll(vanillaOutcomes, cascade.total, kills, seed);
    const cappedRolls = roll(cappedOutcomes, cappedTotal, kills, seed);
    const vanillaRates = tableRates(vanillaOutcomes, cascade.total);
    const cappedRates = tableRates(cappedOutcomes, cappedTotal);

    const source = live ? 'live content' : 'vanilla backup';
    printInfo(`${cascade.block} (${cascade.file}, ${source}) - ${kills.toLocaleString()} kills, seed ${seed}, floor ${minRate.num}/${minRate.den}`);
    if (!plan) {
        printInfo(`this table is already at or above ${minRate.num}/${minRate.den} everywhere - the "capped" columns are identical by design`);
    }
    const death = deathDropFor(cascade.block);
    if (death) {
        printInfo(`guaranteed every kill (death_drop, outside the roll): ${death}`);
    }

    const labels = [...new Set([...vanillaRates.keys(), ...cappedRates.keys()])].sort((a, b) => (vanillaRates.get(a) ?? 0) - (vanillaRates.get(b) ?? 0) || a.localeCompare(b));
    const width = Math.max(24, ...labels.map(l => l.length));

    console.log();
    // under --live the left column is whatever is installed right now (possibly already
    // capped, possibly item-shuffled), not vanilla - don't label it as such
    console.log(`${'drop'.padEnd(width)}  ${(live ? 'AS INSTALLED' : 'VANILLA').padStart(24)}   ${'CAPPED'.padStart(24)}`);
    console.log(`${''.padEnd(width)}  ${'rate'.padStart(8)}${'sim'.padStart(8)}${'count'.padStart(8)}   ${'rate'.padStart(8)}${'sim'.padStart(8)}${'count'.padStart(8)}`);
    console.log('-'.repeat(width + 54));

    let belowVanilla = 0;
    let belowCapped = 0;
    const floor = minRate.num / minRate.den;
    for (const label of labels) {
        const vr = vanillaRates.get(label) ?? 0;
        const cr = cappedRates.get(label) ?? 0;
        if (label !== '(nothing)') {
            if (vr > 0 && vr < floor) belowVanilla++;
            if (cr > 0 && cr < floor) belowCapped++;
        }
        const cells = (rate: number, got: number) => `${oneIn(rate).padStart(8)}${pct(got / kills).padStart(8)}${String(got).padStart(8)}`;
        console.log(`${label.padEnd(width)}  ${cells(vr, vanillaRolls.get(label) ?? 0)}   ${cells(cr, cappedRolls.get(label) ?? 0)}`);
    }
    console.log('-'.repeat(width + 54));

    // the headline claim, restated as a count over this one table
    const rarest = (rates: Map<string, number>) => Math.min(...[...rates].filter(([l, p]) => l !== '(nothing)' && p > 0).map(([, p]) => p));
    console.log();
    printInfo(`rarest drop: ${oneIn(rarest(vanillaRates))} -> ${oneIn(rarest(cappedRates))}`);
    printInfo(`drops rarer than ${minRate.num}/${minRate.den}: ${belowVanilla} -> ${belowCapped}`);
    printInfo(`nothing at all: ${pct((vanillaRates.get('(nothing)') ?? 0))} -> ${pct(cappedRates.get('(nothing)') ?? 0)} of kills`);
    printInfo('"rate" is the table\'s exact odds; "sim"/"count" are what actually fell out of the rolls - they should agree closely, which is the sim checking itself');
}

main();
