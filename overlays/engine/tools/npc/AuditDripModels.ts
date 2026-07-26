import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

import { CONTENT_ROOT, doesNotReachCategoryFloor, isCombinedHeadMesh, isLayeredAccessory, hasPlaceholderName, isNeverSwappable, modelPackNames, vanillaUsageFor } from './NpcDripParser.js';
import { boundsFor, median } from './ModelGeometry.js';

// Turns "that NPC looks wrong" into "this model is the culprit" (GitHub #8).
//
// Every drip glitch reported so far was one model that is not a general-purpose
// substitute for its category, and each one was found by a player noticing it and a
// session then reverse-engineering which slot changed. This reads the same evidence
// directly: the .ob2 geometry (does this legs model reach the ankles? does this torso
// model include a head?) and how vanilla actually wears each value (is it ever the only
// piece covering its region?).
//
// Two modes:
//   (no args)          audit the whole pool - per-category geometry, plus every value
//                      the exclusion rules drop and every value that looks unusual but
//                      is still in the pool (the review list; a flag here is a
//                      candidate, not a verdict).
//   --npc <debugname>  what a seed actually put on ONE npc, vanilla value alongside
//                      current value with each one's geometry - point it at the NPC
//                      that looked wrong.
//
// Usage: npx tsx tools/npc/AuditDripModels.ts [--npc <debugname>] [--category <man_legs>]

const MODELS_ROOT = path.join(CONTENT_ROOT, 'models');
const SWAPPABLE_RE = /^(man|woman)_([a-z]+)_.+$/;

function parseArgs() {
    const args = process.argv.slice(2);
    const npcIdx = args.indexOf('--npc');
    const catIdx = args.indexOf('--category');
    return {
        npc: npcIdx !== -1 ? args[npcIdx + 1] : null,
        category: catIdx !== -1 ? args[catIdx + 1] : null
    };
}

type Row = {
    name: string;
    category: string;
    top: number;
    bottom: number;
    points: number;
    faces: number;
    sole: number;
    layered: number;
    excludedBy: string | null;
};

function excludedBy(name: string): string | null {
    if (hasPlaceholderName(name)) {
        return 'placeholder name (_model_<id>)';
    }
    if (/^(man|woman)_[a-z]+_demon$/.test(name)) {
        return 'demon family (unused in every category)';
    }
    if (/^(man|woman)_(torso_backpack|legs_stitches)$/.test(name)) {
        return 'known layered accessory (explicit)';
    }
    if (isLayeredAccessory(name)) {
        return 'never sole of its category in vanilla (layered accessory)';
    }
    if (isCombinedHeadMesh(name)) {
        return 'torso mesh that includes a head';
    }
    if (doesNotReachCategoryFloor(name)) {
        return 'does not reach its category\'s ground line (partial coverage)';
    }
    return null;
}

function collect(): Row[] {
    const rows: Row[] = [];
    for (const name of modelPackNames()) {
        const match = name.match(SWAPPABLE_RE);
        if (!match) {
            continue;
        }
        const bounds = boundsFor(MODELS_ROOT, name);
        const usage = vanillaUsageFor(name);
        if (!bounds) {
            // no .ob2 anywhere: the pack build resolves the name but the client can't
            // compose the NPC at all (the original "invisible Betty"). Already gated out
            // of the pool; listed so a regression here is visible.
            rows.push({ name, category: `${match[1]}_${match[2]}`, top: NaN, bottom: NaN, points: 0, faces: 0, sole: usage.sole, layered: usage.layered, excludedBy: 'no model data (.ob2 missing)' });
            continue;
        }
        rows.push({
            name,
            category: `${match[1]}_${match[2]}`,
            top: bounds.top,
            bottom: bounds.bottom,
            points: bounds.numPoints,
            faces: bounds.numFaces,
            sole: usage.sole,
            layered: usage.layered,
            excludedBy: excludedBy(name)
        });
    }
    return rows;
}

// categories that have to cover a body region alone - only there does "this mesh is
// small/short/tall for its category" mean anything. A necklace, a jaw or an *extra
// piece is SUPPOSED to be a scrap of geometry hanging off something else.
const COVERAGE_CATEGORIES = new Set(['torso', 'legs', 'arms', 'head', 'feet', 'hands']);

// vanilla wearing something alone this many times settles the question - the piece
// works standalone whatever its geometry looks like next to its siblings (man_feet_
// viking_boots is nearly twice as tall as any other boot and 28 npcs wear it).
const WELL_ATTESTED_SOLE = 3;

// a value still in the pool that doesn't look like its category's other members. NOT a
// rule - the point is to put it in front of a human before it shows up as a bug report.
// Deliberately silent about values no vanilla npc wears: that pool is most of the
// variety this tool exists to surface, and never having been worn is not evidence of
// anything.
function reviewFlags(row: Row, categoryTop: number, categoryBottom: number): string[] {
    const flags: string[] = [];
    const part = row.category.slice(row.category.indexOf('_') + 1);
    if (Number.isNaN(row.top) || !COVERAGE_CATEGORIES.has(part) || row.sole >= WELL_ATTESTED_SOLE) {
        return flags;
    }
    if (row.top > categoryTop * 1.15) {
        flags.push(`reaches ${row.top} vs category norm ${categoryTop}`);
    }
    if (row.bottom > categoryBottom + 30) {
        flags.push(`stops at ${row.bottom}, ${row.bottom - categoryBottom} above the category's normal floor`);
    }
    if (row.faces < 12) {
        flags.push(`only ${row.faces} faces (near-empty mesh)`);
    }
    return flags;
}

function auditPool(categoryFilter: string | null): void {
    const rows = collect();
    const byCategory = new Map<string, Row[]>();
    for (const row of rows) {
        (byCategory.get(row.category) ?? byCategory.set(row.category, []).get(row.category)!).push(row);
    }

    const excluded = rows.filter(r => r.excludedBy);
    printInfo(`${rows.length} (man|woman)_* model(s) in model.pack; ${excluded.length} excluded from the swap pools`);
    for (const row of excluded.sort((a, b) => a.name.localeCompare(b.name))) {
        printInfo(`  EXCLUDED ${row.name.padEnd(38)} ${row.excludedBy}`);
    }

    for (const [category, list] of [...byCategory].sort(([a], [b]) => a.localeCompare(b))) {
        if (categoryFilter && category !== categoryFilter) {
            continue;
        }
        const inPool = list.filter(r => !r.excludedBy && !Number.isNaN(r.top));
        if (!inPool.length) {
            continue;
        }
        const categoryTop = median(inPool.map(r => r.top));
        const categoryBottom = median(inPool.map(r => r.bottom));
        printInfo('');
        printInfo(`${category}: ${inPool.length} in pool, norm reaches ${categoryTop} down to ${categoryBottom}`);
        for (const row of inPool.sort((a, b) => b.top - a.top)) {
            const flags = reviewFlags(row, categoryTop, categoryBottom);
            const usage = `${row.sole} sole / ${row.layered} layered`;
            const line = `  ${row.name.padEnd(38)} ${String(row.top).padStart(4)}..${String(row.bottom).padStart(4)}  ${String(row.faces).padStart(4)} faces  ${usage}`;
            if (flags.length) {
                printWarning(`${line}  <-- ${flags.join('; ')}`);
            } else if (categoryFilter) {
                printInfo(line);
            }
        }
    }

    if (!categoryFilter) {
        printInfo('');
        printInfo('only flagged rows are shown - pass --category <man_legs> to list a whole category');
    }
}

// walks the .npc files under `root` for one block and returns its model# values.
function modelsForBlock(root: string, debugname: string): { file: string; models: string[] } | null {
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop()!;
        if (!fs.existsSync(dir)) {
            continue;
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!entry.name.endsWith('.npc')) {
                continue;
            }
            const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
            const marker = `[${debugname}]\n`;
            const idx = text.indexOf(marker);
            if (idx === -1) {
                continue;
            }
            const rest = text.slice(idx + marker.length);
            const end = rest.indexOf('\n[');
            const body = end === -1 ? rest : rest.slice(0, end);
            const models: string[] = [];
            for (const line of body.split('\n')) {
                const m = line.match(/^model\d+=(.+)$/);
                if (m) {
                    models.push(m[1].trim());
                }
            }
            return { file: path.relative(CONTENT_ROOT, full), models };
        }
    }
    return null;
}

function describe(name: string): string {
    const bounds = boundsFor(MODELS_ROOT, name);
    if (!name.match(SWAPPABLE_RE)) {
        return 'not a swappable body part (left vanilla)';
    }
    if (!bounds) {
        return 'NO MODEL DATA - the client cannot compose this npc at all';
    }
    const usage = vanillaUsageFor(name);
    const gate = isNeverSwappable(name) ? ' [excluded from the pool]' : '';
    return `reaches ${bounds.top}..${bounds.bottom}, ${bounds.numFaces} faces, vanilla ${usage.sole} sole / ${usage.layered} layered${gate}`;
}

function auditNpc(debugname: string): void {
    const live = modelsForBlock(path.join(CONTENT_ROOT, 'scripts'), debugname);
    if (!live) {
        printWarning(`no [${debugname}] block found under content/scripts`);
        return;
    }
    const vanilla = modelsForBlock(path.join(CONTENT_ROOT, '.ap-backup', 'scripts'), debugname);

    printInfo(`[${debugname}] in ${live.file}`);
    const count = Math.max(live.models.length, vanilla?.models.length ?? 0);
    for (let i = 0; i < count; i++) {
        const now = live.models[i];
        const was = vanilla?.models[i];
        if (was && now && was !== now) {
            printInfo(`  model${i + 1}: ${was}  ->  ${now}`);
            printInfo(`            now: ${describe(now)}`);
        } else if (now) {
            printInfo(`  model${i + 1}: ${now} (unchanged)`);
        }
    }
    if (!vanilla) {
        printWarning('no vanilla backup for this block - run RandomizeDrip.ts once to create content/.ap-backup, or this npc is unrandomized');
    }
}

function main() {
    const { npc, category } = parseArgs();
    if (npc) {
        auditNpc(npc);
        return;
    }
    auditPool(category);
}

main();
