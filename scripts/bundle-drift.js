#!/usr/bin/env node
//
// Compares two ExportLogicBundle.ts outputs and reports what moved.
//
//   node scripts/bundle-drift.js <committed.json> <fresh.json>
//
// Exit 0 = the two describe the same world, exit 1 = they drifted, exit 2 = setup problem.
//
// Why not `cmp`: the bundle is a byte-stable export on one machine, but a CI runner and a
// Windows dev box can disagree on line endings without a single fact about the world
// changing. This compares the parsed structure with keys canonicalized, so only real
// content differences fail - and prints WHICH part moved, because "the bundle changed" is
// useless on a 750 KB file.
//
// The drift this exists to catch: ExportLogicBundle reuses an on-disk --export-pool dump
// whenever one is present, so a pool that grew (a new entrance handler reaching the
// shuffle) silently never makes it into the apworld. See docs/lessons-learned.md.

const fs = require('fs');

// Provenance stamps, not world facts. Every --export-pool dump carries its own, so they
// appear NESTED inside randomizerPools as well as at the top level - strip them at any
// depth or two identical exports a minute apart look like a changed world (and CI commits
// on every single run).
const PROVENANCE_KEYS = new Set(['_generated', 'generatedAt']);

function canonical(value) {
    if (Array.isArray(value)) {
        return value.map(canonical);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            if (PROVENANCE_KEYS.has(key)) {
                continue;
            }
            out[key] = canonical(value[key]);
        }
        return out;
    }
    return value;
}

// A handful of shapes worth naming in the report: everything else falls back to
// "<key> differs". Keyed by bundle key -> how to describe its size.
const SIZES = {
    entrancePool: p => `${p.gates.length} gate(s) + ${p.oneWays.length} one-way(s)`,
    gatedAreas: a => `${a.length} area(s)`,
    openAreas: a => `${a.length} area(s)`,
    worldEdges: a => `${a.length} edge(s)`,
    questScriptEdges: a => `${a.length} edge(s)`,
    quests: a => `${a.length} quest(s)`,
    itemSources: o => `${Object.keys(o).length} sourced item(s)`,
    randomizerPools: o => Object.entries(o)
        .map(([name, pool]) => `${name}=${Array.isArray(pool) ? pool.length : Object.keys(pool).length}`)
        .join(' ')
};

function describe(key, value) {
    try {
        return SIZES[key] ? SIZES[key](value) : null;
    } catch {
        return null;
    }
}

function main() {
    const [a, b] = process.argv.slice(2);
    if (!a || !b) {
        console.error('usage: node scripts/bundle-drift.js <committed.json> <fresh.json>');
        return 2;
    }
    for (const file of [a, b]) {
        if (!fs.existsSync(file)) {
            console.error(`no bundle at ${file}`);
            return 2;
        }
    }

    const left = JSON.parse(fs.readFileSync(a, 'utf8'));
    const right = JSON.parse(fs.readFileSync(b, 'utf8'));

    // `_generated` is a timestamp/provenance stamp - it differs on every export by design.
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
        .filter(key => key !== '_generated')
        .sort();

    const drifted = [];
    for (const key of keys) {
        const l = JSON.stringify(canonical(left[key]));
        const r = JSON.stringify(canonical(right[key]));
        if (l === r) {
            continue;
        }
        const was = key in left ? (describe(key, left[key]) ?? 'present') : 'absent';
        const now = key in right ? (describe(key, right[key]) ?? 'present') : 'absent';
        drifted.push(was === now ? `${key}: contents differ (${now})` : `${key}: ${was} -> ${now}`);
    }

    if (drifted.length === 0) {
        console.log('bundle is current - a fresh export matches the committed one.');
        return 0;
    }

    console.log('BUNDLE DRIFT - the committed bundle does not match a fresh export:');
    for (const line of drifted) {
        console.log(`  - ${line}`);
    }
    console.log('\nRefresh it with:');
    console.log('  cd ../Server/engine && npx tsx tools/ap/ExportLogicBundle.ts \\');
    console.log('      --copy ../../2004Scape-AP-Logic/apworld/rs2004scape/data/rs2004_logic.json');
    console.log('(delete data/config/ap-*-pool.json first, or the stale dumps get reused)');
    return 1;
}

process.exitCode = main();
