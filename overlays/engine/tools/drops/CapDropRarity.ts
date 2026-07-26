import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { printInfo, printWarning } from '#/util/Logger.js';

import { readNpcSource } from '../npc/NpcDripParser.js';
import { type CascadeBranch, DROP_BACKUP_DIR, DROP_SCRIPTS_DIR, type DropCascade, ensureDropScriptBackup, findDropScriptFiles, parseDropCascades } from './DropTableParser.js';
import { MIMIC_GENERATED_FILE } from './MimicTransform.js';

// GitHub #11: cap monster drop rarity - no weighted loot slot may be rarer than
// `--min-rate` (default 1/32). A rate-only pass, orthogonal to every item shuffle: it
// rewrites the `if ($random < N)` thresholds of each cascade and never touches which
// item sits in a slot, so it composes with RandomizeDrops' tiered/chaos/mimic modes in
// either order. Pure script mutation - needs a pack rebuild, no seed (fully
// deterministic, there is nothing random about it).
//
// Why a floor at all: a randomizer moves an item's only source onto whatever monster the
// shuffle picked, and vanilla rates go down to 1/512 (werewolf's ~randomjewel branch).
// A single required item behind a 1/512 roll is not a check, it's a wall.
//
// Where the probability comes from (the actual design decision - the user picked this
// after seeing the numbers, see the PR for #11):
//   1. the cascade's no-drop tail (`random(128)` rolls above the last threshold) is
//      spent first, and can be spent down to zero;
//   2. whatever is still needed comes proportionally out of the branches that are
//      already at or above the floor - never pushing any of them below it.
// This is not optional generosity: 46 of the 63 vanilla cascades need MORE than their
// entire no-drop tail to floor everything (`black_demon`, `blue_dragon`, `imp` and 6
// others have no tail at all - their cascades already cover the full denominator), so
// "take it from the remainder only" would leave most rare drops uncapped. The visible
// cost is that common slots (coins, low-tier junk) shrink by roughly 15-25% in a typical
// table. The vanilla rarity ORDER is preserved throughout: donors shrink proportionally
// to their surplus, so a 20% slot stays rarer than a 30% one.
//
// Feasibility: a cascade with n drop branches needs n * ceil(total/32) <= total, i.e. at
// most 32 branches at a 1/32 floor. The corpus maxes out at exactly 32 (imp.rs2), so no
// vanilla cascade needs its denominator widened - every edit is a threshold rewrite
// inside the original `random(total)`. planCascade() handles the general case anyway
// (scale the whole cascade by the floor's denominator), because a future content change
// or a coarser --min-rate can hit it.
//
// Scope notes:
// - The unit is the BRANCH, not the DropSlot: a branch fires as a whole, and a couple of
//   branches hold two mutually-exclusive obj_add calls behind a `map_members` check
//   (both are the same roll). Branches calling a shared proc (`~randomherb`,
//   `~randomjewel`, `~ultrarare_getitem`) are ordinary branches here and get floored
//   like any other - this pass has no opinion about what the proc returns.
// - Vanilla's one explicit "nothing dropped" branch (guard.rs2) is not a drop, so it is
//   never floored - it donates like any other above-floor branch.
// - `content/scripts/drop tables/ap_mimic.rs2` is included when it exists: in mimic mode
//   that generated file holds the loot tables that actually run, while the cascades left
//   in the handlers are the no-override fallback. Both get capped.
//
// Usage: npx tsx tools/drops/CapDropRarity.ts [--min-rate 1/32] [--dry-run] [--exclude <substr,substr,...>]

const SPOILER_OUTPUT = path.join(import.meta.dirname, 'drop-rarity-cap.json');

type MinRate = { num: number; den: number };

function parseArgs() {
    const args = process.argv.slice(2);
    const rateIdx = args.indexOf('--min-rate');
    let minRate: MinRate = { num: 1, den: 32 };
    if (rateIdx !== -1) {
        const raw = args[rateIdx + 1] ?? '';
        const m = /^(\d+)\s*\/\s*(\d+)$/.exec(raw.trim());
        if (!m || parseInt(m[1], 10) === 0 || parseInt(m[2], 10) === 0) {
            printWarning(`--min-rate must look like "1/32" (got "${raw}")`);
            process.exit(1);
        }
        minRate = { num: parseInt(m[1], 10), den: parseInt(m[2], 10) };
        if (minRate.num / minRate.den > 1) {
            printWarning(`--min-rate ${raw} is greater than 1 - impossible for any cascade`);
            process.exit(1);
        }
    }
    const excludeIdx = args.indexOf('--exclude');
    const exclude =
        excludeIdx !== -1
            ? args[excludeIdx + 1]
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
            : [];
    return { minRate, dryRun: args.includes('--dry-run'), exclude };
}

// smallest weight that clears the floor in a `random(total)` cascade
function minWeightFor(total: number, minRate: MinRate): number {
    return Math.ceil((total * minRate.num) / minRate.den);
}

// hands out `need` units across donors in proportion to their capacity, largest-remainder
// style so the integer result sums to exactly `need` and is deterministic (ties broken by
// donor order, never by float comparison luck). Callers guarantee sum(capacity) >= need.
function allocate(need: number, capacities: number[]): number[] {
    const supply = capacities.reduce((a, b) => a + b, 0);
    if (supply < need) {
        throw new Error(`allocate: need ${need} but donors only hold ${supply}`);
    }
    const given = capacities.map(c => Math.floor((need * c) / supply));
    let residue = need - given.reduce((a, b) => a + b, 0);
    // rank by fractional part descending; index order breaks ties
    const order = capacities
        .map((c, i) => ({ i, frac: (need * c) % supply }))
        .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; residue > 0 && k < order.length * 2; k++) {
        const { i } = order[k % order.length];
        if (given[i] < capacities[i]) {
            given[i]++;
            residue--;
        }
    }
    return given;
}

export type CascadePlan = {
    total: number;
    newTotal: number;
    scale: number; // 1 unless the cascade had to be widened to fit the floor
    weights: number[]; // per branch, in the widened denominator
    raised: number[]; // branch indices floored up
    donated: Map<number, number>; // branch index -> units given up
    tailSpent: number;
};

// null = nothing to do (already at or above the floor everywhere) - which also makes the
// pass idempotent: a second run over its own output plans no edits at all.
export function planCascade(cascade: DropCascade, minRate: MinRate): CascadePlan | null {
    const branches = cascade.branches;
    if (!branches.length) {
        return null;
    }

    let total = cascade.total;
    let weights = branches.map(b => b.weight);
    let min = minWeightFor(total, minRate);
    let scale = 1;

    const dropCount = branches.filter(b => b.isDrop).length;
    if (branches.some((b, i) => b.isDrop && weights[i] < min)) {
        if (dropCount * min > total) {
            // widening multiplies both sides by the floor's denominator, after which the
            // floor is exactly num*total and the condition becomes
            // dropCount * num <= den - a property of the cascade's shape alone.
            scale = minRate.den;
            total *= scale;
            weights = weights.map(w => w * scale);
            min = minWeightFor(total, minRate);
            if (dropCount * min > total) {
                printWarning(`${cascade.file}:${cascade.block} has ${dropCount} drop branches - impossible to give each ${minRate.num}/${minRate.den}, left vanilla`);
                return null;
            }
        }
    }

    const deficits = branches.map((b, i) => (b.isDrop ? Math.max(0, min - weights[i]) : 0));
    let need = deficits.reduce((a, b) => a + b, 0);
    if (need === 0) {
        return null;
    }

    // 1. the no-drop tail, spent first and spendable to zero
    const tail = total - weights.reduce((a, b) => a + b, 0);
    const tailSpent = Math.min(need, tail);
    need -= tailSpent;

    // 2. the rest, proportionally out of surplus above the floor (a non-drop branch has
    //    no floor, so all of its weight is surplus)
    const donated = new Map<number, number>();
    if (need > 0) {
        const capacities = branches.map((b, i) => (b.isDrop ? Math.max(0, weights[i] - min) : weights[i]));
        const donorIdx = capacities.map((c, i) => (c > 0 ? i : -1)).filter(i => i !== -1);
        const given = allocate(
            need,
            donorIdx.map(i => capacities[i])
        );
        donorIdx.forEach((i, k) => {
            if (given[k] > 0) {
                donated.set(i, given[k]);
            }
        });
    }

    const newWeights = weights.map((w, i) => w + deficits[i] - (donated.get(i) ?? 0));
    return {
        total: cascade.total,
        newTotal: total,
        scale,
        weights: newWeights,
        raised: deficits.map((d, i) => (d > 0 ? i : -1)).filter(i => i !== -1),
        donated,
        tailSpent
    };
}

const OBJ_ADD_ITEM_RE = /obj_add\(\s*npc_coord\s*,\s*([a-zA-Z0-9_~]+)/g;
const ASSIGN_ITEM_RE = /\$[a-zA-Z0-9_]+\s*=\s*([a-z][a-zA-Z0-9_]*)\s*;/g;

// what a branch drops, for the spoiler only - literal obj_add items plus the
// `$drop = <item>;` form megararetable uses. Never used to decide anything.
function branchItems(branch: CascadeBranch): string[] {
    const items = new Set<string>();
    for (const m of branch.bodyText.matchAll(OBJ_ADD_ITEM_RE)) {
        if (m[1] !== 'npc_param') {
            items.add(m[1]);
        }
    }
    for (const m of branch.bodyText.matchAll(ASSIGN_ITEM_RE)) {
        items.add(m[1]);
    }
    return [...items];
}

type SpoilerBranch = { items: string[]; wasWeight: number; nowWeight: number; wasRate: string; nowRate: string };
type SpoilerCascade = {
    file: string;
    block: string;
    denominator: number;
    newDenominator: number;
    tailWas: number;
    tailNow: number;
    raised: SpoilerBranch[];
    shrunk: SpoilerBranch[];
};

// exported so the offline checks can run the whole pass against a throwaway COPY of the
// corpus instead of the live content tree (docs/testing-checklist.md).
export function capFile(filePath: string, relFile: string, minRate: MinRate, exclude: string[], dryRun: boolean) {
    const text = readNpcSource(filePath);
    const cascades = parseDropCascades(filePath, relFile);

    const edits: { offset: number; length: number; text: string }[] = [];
    const spoiler: SpoilerCascade[] = [];
    let branchesRaised = 0;

    for (const cascade of cascades) {
        if (exclude.some(x => cascade.block.includes(x) || relFile.includes(x))) {
            continue;
        }
        const plan = planCascade(cascade, minRate);
        if (!plan) {
            continue;
        }

        // thresholds are cumulative, so every branch from the first changed one onwards
        // gets rewritten even when its own weight is untouched
        let running = 0;
        for (let i = 0; i < cascade.branches.length; i++) {
            running += plan.weights[i];
            if (running !== cascade.branches[i].threshold) {
                edits.push({ offset: cascade.branches[i].thresholdOffset, length: cascade.branches[i].thresholdLength, text: String(running) });
            }
        }
        if (plan.scale !== 1) {
            edits.push({ offset: cascade.totalOffset, length: cascade.totalLength, text: String(plan.newTotal) });
        }

        const rate = (w: number, t: number) => `${((w / t) * 100).toFixed(2)}%`;
        const entry = (i: number): SpoilerBranch => ({
            items: branchItems(cascade.branches[i]),
            wasWeight: cascade.branches[i].weight,
            nowWeight: plan.weights[i],
            wasRate: rate(cascade.branches[i].weight, cascade.total),
            nowRate: rate(plan.weights[i], plan.newTotal)
        });
        spoiler.push({
            file: relFile,
            block: cascade.block,
            denominator: cascade.total,
            newDenominator: plan.newTotal,
            tailWas: cascade.total - cascade.branches.reduce((a, b) => a + b.weight, 0),
            tailNow: plan.newTotal - plan.weights.reduce((a, b) => a + b, 0),
            raised: plan.raised.map(entry),
            shrunk: [...plan.donated.keys()].sort((a, b) => a - b).map(entry)
        });
        branchesRaised += plan.raised.length;
    }

    if (!edits.length) {
        return { changed: false, branchesRaised: 0, spoiler };
    }

    // right-to-left so earlier offsets stay valid as the text length changes
    let out = text;
    for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) {
        out = out.slice(0, edit.offset) + edit.text + out.slice(edit.offset + edit.length);
    }
    if (!dryRun) {
        fs.writeFileSync(filePath, out.replace(/\n/g, '\r\n'));
    }
    return { changed: true, branchesRaised, spoiler };
}

function main() {
    if (!fs.existsSync(DROP_SCRIPTS_DIR)) {
        printWarning(`drop table scripts directory not found: ${DROP_SCRIPTS_DIR}`);
        process.exit(1);
    }

    const { minRate, dryRun, exclude } = parseArgs();

    // the pass edits live files in place; the backup is what makes that recoverable
    // (RegenerateAll.ts restores from it before every full reseed).
    const backedUp = ensureDropScriptBackup();
    if (backedUp) {
        printInfo(`created vanilla content backup for ${backedUp} drop-table script file(s) at ${DROP_BACKUP_DIR}`);
    }

    const files = findDropScriptFiles(DROP_SCRIPTS_DIR).map(f => ({ full: f, rel: path.relative(DROP_SCRIPTS_DIR, f) }));
    if (fs.existsSync(MIMIC_GENERATED_FILE)) {
        files.push({ full: MIMIC_GENERATED_FILE, rel: path.basename(MIMIC_GENERATED_FILE) });
    }

    let filesChanged = 0;
    let branchesRaised = 0;
    const spoiler: SpoilerCascade[] = [];
    for (const file of files) {
        const result = capFile(file.full, file.rel, minRate, exclude, dryRun);
        spoiler.push(...result.spoiler);
        if (result.changed) {
            filesChanged++;
            branchesRaised += result.branchesRaised;
        }
    }

    printInfo(
        `${dryRun ? '[dry run] ' : ''}min rate ${minRate.num}/${minRate.den}: ${branchesRaised} drop branch(es) raised across ${spoiler.length} cascade(s) in ${filesChanged} file(s)` +
            ` (${spoiler.reduce((n, c) => n + c.shrunk.length, 0)} branch(es) shrunk to pay for it)`
    );

    fs.writeFileSync(
        SPOILER_OUTPUT,
        JSON.stringify(
            {
                minRate: `${minRate.num}/${minRate.den}`,
                exclude,
                generatedAt: new Date().toISOString(),
                cascades: spoiler
            },
            null,
            2
        )
    );
    printInfo(`${dryRun ? '[dry run] ' : ''}spoiler written to ${SPOILER_OUTPUT}`);
    if (!dryRun && filesChanged) {
        printInfo('rebuild the pack before testing: npx tsx tools/pack/Build.ts');
    }
}

// only when run as a CLI - planCascade() is imported directly by the verification
// checks in docs/testing-checklist.md, which must not trigger a corpus rewrite.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    main();
}
