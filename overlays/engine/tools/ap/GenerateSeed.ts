#!/usr/bin/env -S npx tsx
// Placement-mode seed generator (2004Scape-AP-Logic docs/placement-mode.md). Runs the
// standard Archipelago "assumed fill" algorithm over the check-location catalog and
// progression-item pool defined in tools/sim/PlacementEngine.ts, writes the shared
// ap-placements.json contract + a zeroed starting ap-unlocks.json, clears the two pieces
// of run state that are stale under a new seed, and end-to-end guards the result by
// running the placement-aware tools/logic/ValidateSeed.ts before ever touching the real
// data/config directory.
//
// Usage (run from Server/engine):
//   npx tsx tools/ap/GenerateSeed.ts [--seed N] [--pool per-skill|groups] [--dry-run] [--spoiler]
//       [--max-progression-level N] [--retry-budget N] [--config-dir data/config]
//
// Deterministic per --seed: the same seed + pool always produces byte-identical
// ap-placements.json (verified in the session's verification pass - see the session
// report). Retries (on a ValidateSeed failure) advance the seed deterministically
// (seed+1, seed+2, ...) up to --retry-budget, same convergence pattern
// RandomizeEntrances.ts uses for its own reroll-until-valid loop.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { RegionModel, buildRegionModel, feasibleQuestSet, questDistanceScore, questRegionFeasible } from '../logic/RegionFeasibility.js';
import { execNpxTsx } from '../shared/Npx.js';
import { mulberry32, shuffle } from '../shared/Prng.js';
import {
    LocationDef,
    PlacementSimResult,
    PoolMode,
    ProgressionCopy,
    QUEST_GATE_IDS,
    applyQuestGates,
    buildItemPool,
    buildLocationCatalog,
    loadApOptions,
    buildQuestGateCopies,
    computeReachability,
    realUnlockKeys,
    simulatePlacementSpheres
} from '../sim/PlacementEngine.js';
import { Goal, QuestReq } from '../sim/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIM_DATA_DIR = path.join(__dirname, '..', 'sim', 'data');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface Args {
    seed: number;
    pool: PoolMode;
    dryRun: boolean;
    spoiler: boolean;
    maxProgressionLevel: number;
    retryBudget: number;
    configDir: string;
}

function parseArgs(argv: string[]): Args {
    let seed = Math.floor(Math.random() * 0xffffffff);
    let pool: PoolMode = 'per-skill';
    let dryRun = false;
    let spoiler = false;
    let maxProgressionLevel = 60;
    let retryBudget = 20;
    let configDir = path.join('data', 'config');

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--seed') {
            seed = Number(argv[++i]);
            if (!Number.isFinite(seed)) {
                throw new Error('--seed must be a number');
            }
        } else if (arg === '--pool') {
            const v = argv[++i];
            if (v !== 'per-skill' && v !== 'groups') {
                throw new Error(`--pool must be "per-skill" or "groups" (got "${v}")`);
            }
            pool = v;
        } else if (arg === '--dry-run') {
            dryRun = true;
        } else if (arg === '--spoiler') {
            spoiler = true;
        } else if (arg === '--max-progression-level') {
            maxProgressionLevel = Number(argv[++i]);
        } else if (arg === '--retry-budget') {
            retryBudget = Number(argv[++i]);
        } else if (arg === '--config-dir') {
            configDir = argv[++i];
        } else if (arg === '--help' || arg === '-h') {
            console.log('Usage: npx tsx tools/ap/GenerateSeed.ts [--seed N] [--pool per-skill|groups] [--dry-run] [--spoiler] [--max-progression-level N] [--retry-budget N] [--config-dir data/config]');
            process.exit(0);
        } else {
            throw new Error(`Unrecognized argument: ${arg}`);
        }
    }

    return { seed, pool, dryRun, spoiler, maxProgressionLevel, retryBudget, configDir };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadQuests(): QuestReq[] {
    const raw = fs.readFileSync(path.join(SIM_DATA_DIR, 'quests.json'), 'utf8');
    return (JSON.parse(raw) as { quests: QuestReq[] }).quests;
}

function loadGoals(): Goal[] {
    const raw = fs.readFileSync(path.join(SIM_DATA_DIR, 'goals.json'), 'utf8');
    return (JSON.parse(raw) as { goals: Goal[] }).goals;
}

// ---------------------------------------------------------------------------
// Assumed fill
// ---------------------------------------------------------------------------

interface PlacementRecord {
    item: string;
    count: number;
    display: string;
    copy?: ProgressionCopy; // undefined for filler
}

interface FillResult {
    placements: Map<string, PlacementRecord>;
    /** Every progression copy, in the shuffled processing order actually used - kept for diagnostics. */
    processingOrder: string[];
}

// ---------------------------------------------------------------------------
// Spatial context: region feasibility + spawn-distance weighting
// (tools/logic/RegionFeasibility.ts - "progressive checks by accessibility").
// ---------------------------------------------------------------------------

interface SpatialContext {
    /** Location ids whose quest the strict region validator can never complete -
     *  excluded from progression (filler only), or the seed would always fail its
     *  own staged validation with stranded items. */
    infeasibleLocationIds: Set<string>;
    /** Per-location distance score (lower = closer to this seed's spawn); null =
     *  region model unavailable, fill stays uniform. */
    scores: Map<string, number> | null;
    note: string;
}

function buildSpatialContext(configDir: string, quests: QuestReq[], locations: LocationDef[]): SpatialContext {
    let model: RegionModel | null = null;
    try {
        model = buildRegionModel(configDir);
    } catch (err) {
        console.warn(`GenerateSeed: region model failed to load (${(err as Error).message}) - spatial weighting disabled`);
    }
    if (!model) {
        return { infeasibleLocationIds: new Set(), scores: null, note: 'region model absent (region-graph.json / quest-regions.generated.json missing) - uniform fill, no feasibility exclusion' };
    }
    const feasible = feasibleQuestSet(model, quests);

    const questScore = new Map<string, number>();
    const finiteScores: number[] = [];
    for (const q of quests) {
        const s = questDistanceScore(model, q.id);
        if (!Number.isNaN(s) && Number.isFinite(s)) {
            questScore.set(q.id, s);
            finiteScores.push(s);
        }
    }
    finiteScores.sort((a, b) => a - b);
    const median = finiteScores.length > 0 ? finiteScores[finiteScores.length >> 1] : 0;
    const barcrawlScore = questRegionFeasible(model, 'barcrawl') ? questDistanceScore(model, 'barcrawl') : median;

    const infeasibleLocationIds = new Set<string>();
    const scores = new Map<string, number>();
    for (const loc of locations) {
        switch (loc.kind) {
            case 'quest':
                if (loc.questId !== undefined && !feasible.has(loc.questId)) {
                    infeasibleLocationIds.add(loc.id);
                }
                scores.set(loc.id, questScore.get(loc.questId ?? '') ?? median);
                break;
            case 'ds': // stage checks collapse to Dragon Slayer's own reachability rule.
                scores.set(loc.id, questScore.get('dragon') ?? median);
                break;
            case 'barcrawl':
                scores.set(loc.id, Number.isFinite(barcrawlScore) && !Number.isNaN(barcrawlScore) ? barcrawlScore : median);
                break;
            default: // first_xp / first_kill / level - non-spatial, interleave mid-pack.
                scores.set(loc.id, median);
                break;
        }
    }
    return {
        infeasibleLocationIds,
        scores,
        note: `spawn region ${model.spawnRegion}, ${feasible.size}/${quests.length} quests region-feasible, ${infeasibleLocationIds.size} quest check(s) filler-only, spawn-distance weighting ON`
    };
}

/**
 * Rank-geometric weighted pick: candidates sorted by distance score (near-spawn
 * first, id tiebreak for determinism), rank i weighted GEO^i. One rand() call per
 * pick, same as the uniform path it replaces.
 */
const GEO = 0.93;
function pickSpatial(candidates: LocationDef[], scores: Map<string, number> | null, rand: () => number): LocationDef {
    if (scores === null || candidates.length === 1) {
        return candidates[Math.floor(rand() * candidates.length)];
    }
    const sorted = [...candidates].sort((a, b) => (scores.get(a.id) ?? 0) - (scores.get(b.id) ?? 0) || a.id.localeCompare(b.id));
    const total = (1 - Math.pow(GEO, sorted.length)) / (1 - GEO);
    let r = rand() * total;
    let w = 1;
    for (const loc of sorted) {
        r -= w;
        if (r <= 0) {
            return loc;
        }
        w *= GEO;
    }
    return sorted[sorted.length - 1];
}

/**
 * Standard Archipelago assumed-fill: process progression copies in a random (seeded)
 * order; for each one, compute reachability assuming every OTHER copy in the pool
 * (already-placed AND not-yet-placed alike) is collected, then place it into a still-empty
 * location reachable under that assumption. This guarantees the final placement is
 * beatable by construction - a subsequent forward sphere simulation (see
 * `simulateSpheres` below) from the empty state always reaches every progression item,
 * because whichever copy was hardest to place (processed last) was proven reachable
 * without needing itself.
 */
function assumedFill(locations: LocationDef[], quests: QuestReq[], pool: ProgressionCopy[], maxProgressionLevel: number, rand: () => number, spatial: SpatialContext): FillResult {
    const progressionEligible = new Set(
        locations
            .filter(loc => loc.kind !== 'level' || (loc.level !== undefined && loc.level <= maxProgressionLevel))
            .filter(loc => !spatial.infeasibleLocationIds.has(loc.id))
            .filter(loc => !loc.fillerOnly)
            .map(loc => loc.id)
    );
    const unassigned = new Set(locations.map(loc => loc.id));
    const placements = new Map<string, PlacementRecord>();

    const order = shuffle(pool, rand);
    const processingOrder: string[] = [];

    for (const copy of order) {
        processingOrder.push(copy.uid);

        // state = every OTHER copy in the whole pool (placed or not) collected.
        const counts = new Map<string, number>();
        for (const other of pool) {
            if (other.uid === copy.uid) {
                continue;
            }
            other.apply(counts);
        }

        const { reachable } = computeReachability(locations, quests, counts);
        const candidates = locations.filter(loc => progressionEligible.has(loc.id) && unassigned.has(loc.id) && reachable.has(loc.id));

        if (candidates.length === 0) {
            throw new FillError(`assumed-fill: no reachable, unassigned location for ${copy.uid} (${copy.display}) - pool/location catalog mismatch or a genuinely unbeatable configuration`);
        }

        const pick = pickSpatial(candidates, spatial.scores, rand);
        placements.set(pick.id, { item: copy.placementItem, count: copy.placementCount, display: copy.display, copy });
        unassigned.delete(pick.id);
    }

    for (const id of unassigned) {
        placements.set(id, { item: 'filler', count: 0, display: 'filler' });
    }

    return { placements, processingOrder };
}

class FillError extends Error {}

// Spoiler generation is the same forward-sphere loop the placement-aware
// SimulateProgression.ts/ValidateSeed.ts extensions use - reused from PlacementEngine.ts
// (`simulatePlacementSpheres`) rather than reimplemented here, so the generator's own
// spoiler and the tools that later read ap-placements.json narrate identically.

// ---------------------------------------------------------------------------
// Output files
// ---------------------------------------------------------------------------

function writeStartingUnlocks(dir: string): void {
    // All real ap-unlocks.json keys placement mode controls, at count 0. Verified this
    // session against the actual engine comparisons (not the placement-mode.md draft's
    // tentative "count 1" - see the session report for the full derivation):
    //   - ap_gear_locked (levelrequire.rs2): tier 0 (base level < 5, i.e. bronze AND iron)
    //     is unconditionally free - `if ($tier = 0) { return(false); }` runs BEFORE the
    //     unlock-count comparison. Count 0 already satisfies "exactly bronze equipable,
    //     steel+ locked" (steel is tier 1, needs count >= 1).
    //   - progressive_pickaxe (mining.rs2's ap_pickaxe_tier): bronze returns tier 0, and
    //     `ap_unlock_count(...) < 0` is never true - bronze is unconditional at count 0.
    //   - progressive_axe (woodcut.rs2): bronze is the unconditional last-fallback branch
    //     with NO unlock-count check at all - unconditional at count 0.
    // So count 0 is the correct "exactly bronze" starting value for all six gear/tool
    // families, not count 1.
    const unlocks: Record<string, number> = {};
    for (const key of realUnlockKeys()) {
        unlocks[key] = 0;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ap-unlocks.json'), JSON.stringify({ unlocks }, null, 4) + '\n');
}

function writePlacements(dir: string, seed: number, pool: PoolMode, placements: Map<string, PlacementRecord>, spoiler: PlacementSimResult): void {
    const placementsOut: Record<string, { item: string; count?: number; display?: string }> = {};
    for (const [locId, rec] of [...placements.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (rec.item === 'filler') {
            placementsOut[locId] = { item: 'filler' };
        } else {
            placementsOut[locId] = { item: rec.item, count: rec.count, display: rec.display };
        }
    }

    const spoilerOut = {
        spheres: spoiler.spheres.map(s => ({
            sphere: s.sphere,
            finds: s.finds.map(f => ({ location: f.location, item: f.item, display: f.display }))
        })),
        goals: spoiler.goalStatus.map(g => ({ id: g.goal.id, name: g.goal.name, reached: g.reached, sphereReached: g.sphereReached }))
    };

    const out = { seed, pool, questGates: [...QUEST_GATE_IDS], placements: placementsOut, spoiler: spoilerOut };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ap-placements.json'), JSON.stringify(out, null, 2) + '\n');
}

function clearRunState(dir: string): string[] {
    const cleared: string[] = [];
    for (const name of ['ap-checks-fired.json', 'ap-tracker.json']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) {
            fs.rmSync(p);
            cleared.push(name);
        }
    }
    return cleared;
}

// ---------------------------------------------------------------------------
// End-to-end guard: run the (placement-aware) ValidateSeed against a staged scratch dir
// before ever touching the real config dir.
// ---------------------------------------------------------------------------

function stageAndValidate(realConfigDir: string, seed: number, pool: PoolMode, placements: Map<string, PlacementRecord>, spoiler: PlacementSimResult): { ok: boolean; scratchDir: string; output: string } {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-generate-seed-'));

    writeStartingUnlocks(scratchDir);
    writePlacements(scratchDir, seed, pool, placements, spoiler);

    // Region/entrance/gated-area/spawn tables are independent of placement mode - carry
    // the REAL ones over (read-only copy) so the validator's region-aware logic still
    // means something, without ever writing to the real config dir until validation passes.
    for (const name of ['ap-entrances.json', 'ap-gated-areas.json', 'ap-spawn.json', 'ap-options.json']) {
        const src = path.join(realConfigDir, name);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(scratchDir, name));
        }
    }

    let output = '';
    let ok = false;
    try {
        output = execNpxTsx([path.join('tools', 'logic', 'ValidateSeed.ts'), '--config-dir', scratchDir, '--verbose'], { encoding: 'utf8' }) as string;
        ok = true;
    } catch (err: any) {
        output = (err.stdout ?? '') + (err.stderr ?? '');
        ok = false;
    }

    return { ok, scratchDir, output };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function generateOnce(seed: number, pool: PoolMode, quests: QuestReq[], goals: Goal[], locations: LocationDef[], maxProgressionLevel: number, spatial: SpatialContext): { placements: Map<string, PlacementRecord>; spoiler: PlacementSimResult } {
    const rand = mulberry32(seed);
    // Family D: gated quests can't complete (in logic) until their `quest_<id>` pool item
    // is collected - both the fill's reachability and the spoiler walk must see the gates,
    // or the fill could bury a gate item behind its own quest's check.
    const gatedQuests = applyQuestGates(quests, QUEST_GATE_IDS);
    const itemPool = [...buildItemPool(pool), ...buildQuestGateCopies(quests)];
    const { placements } = assumedFill(locations, gatedQuests, itemPool, maxProgressionLevel, rand, spatial);
    const spoiler = simulatePlacementSpheres(locations, gatedQuests, goals, placements);
    return { placements, spoiler };
}

function printSpoilerSummary(seed: number, pool: PoolMode, placements: Map<string, PlacementRecord>, spoiler: PlacementSimResult, itemPoolSize: number, locationCount: number, showSpoiler: boolean): void {
    const progressionPlaced = [...placements.values()].filter(r => r.item !== 'filler').length;
    const fillerPlaced = placements.size - progressionPlaced;
    const goalsReached = spoiler.goalStatus.filter(g => g.reached).length;

    console.log(showSpoiler ? '=== Placement-mode seed spoiler ===' : '=== Placement-mode seed summary ===');
    console.log(`Seed: ${seed}  Pool: ${pool}`);
    console.log(`Locations: ${locationCount}  Progression items placed: ${progressionPlaced}/${itemPoolSize}  Filler locations: ${fillerPlaced}`);
    console.log(`Spheres: ${spoiler.spheres.length}`);
    if (!showSpoiler) {
        // Goal names and the sphere-by-sphere walkthrough are run spoilers -
        // only counts by default. Rerun with --spoiler (or --dry-run, which
        // never commits anything) to print the full walk.
        console.log(`Goals reached in logic: ${goalsReached}/${spoiler.goalStatus.length}`);
        console.log('(--spoiler to print the goal list and the full sphere-by-sphere walkthrough)');
    } else {
        console.log('');
        for (const s of spoiler.spheres) {
            if (s.finds.length === 0) {
                continue;
            }
            console.log(`Sphere ${s.sphere}:`);
            for (const f of s.finds) {
                console.log(`  ${f.location} -> ${f.display}`);
            }
        }
        console.log('');
        console.log('Goals:');
        for (const g of spoiler.goalStatus) {
            console.log(g.reached ? `  [x] ${g.goal.name} - reached at sphere ${g.sphereReached}` : `  [ ] ${g.goal.name} - NOT REACHED`);
        }
    }
    if (spoiler.unreachedLocations.length > 0) {
        console.log('');
        console.log(`${spoiler.unreachedLocations.length} location(s) never became reachable this seed (still hold their assigned item/filler, just unvisited in the spoiler walk): ${spoiler.unreachedLocations.slice(0, 10).join(', ')}${spoiler.unreachedLocations.length > 10 ? ', ...' : ''}`);
    }
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const quests = loadQuests();
    const goals = loadGoals();
    const locations = buildLocationCatalog(quests, loadApOptions(args.configDir));
    const itemPoolSize = buildItemPool(args.pool).length + buildQuestGateCopies(quests).length;

    console.log(`GenerateSeed: building placement-mode seed ${args.seed} (pool=${args.pool}, maxProgressionLevel=${args.maxProgressionLevel})...`);
    const spatial = buildSpatialContext(args.configDir, quests, locations);
    console.log(`GenerateSeed: spatial context - ${spatial.note}`);

    let attempt = 0;
    let lastError: string | null = null;
    for (; attempt <= args.retryBudget; attempt++) {
        const trySeed = args.seed + attempt;
        let placements: Map<string, PlacementRecord>;
        let spoiler: PlacementSimResult;
        try {
            const result = generateOnce(trySeed, args.pool, quests, goals, locations, args.maxProgressionLevel, spatial);
            placements = result.placements;
            spoiler = result.spoiler;
        } catch (err) {
            if (err instanceof FillError) {
                lastError = err.message;
                console.log(`  attempt ${attempt} (seed ${trySeed}): assumed-fill failed (${err.message}) - retrying`);
                continue;
            }
            throw err;
        }

        if (!spoiler.allGoalsReached) {
            lastError = `spoiler forward-simulation found unreached goal(s): ${spoiler.goalStatus.filter(g => !g.reached).map(g => g.goal.name).join(', ')}`;
            console.log(`  attempt ${attempt} (seed ${trySeed}): ${lastError} - retrying`);
            continue;
        }

        // Self-check: every placed location id is in the enumerated catalog, and every
        // progression item was placed exactly its pool copy count.
        const locationIds = new Set(locations.map(l => l.id));
        for (const id of placements.keys()) {
            if (!locationIds.has(id)) {
                throw new Error(`internal error: placement wrote an unknown location id "${id}"`);
            }
        }

        const { ok, scratchDir, output } = stageAndValidate(args.configDir, trySeed, args.pool, placements, spoiler);
        console.log(`  attempt ${attempt} (seed ${trySeed}): ValidateSeed ${ok ? 'PASSED' : 'FAILED'}`);
        if (!ok) {
            lastError = `ValidateSeed exited non-zero:\n${output}`;
            fs.rmSync(scratchDir, { recursive: true, force: true });
            continue;
        }

        // Validated - safe to commit.
        if (args.dryRun) {
            console.log('');
            console.log('--dry-run: not writing to the real config dir. Scratch output (deleted after this run):');
            printSpoilerSummary(trySeed, args.pool, placements, spoiler, itemPoolSize, locations.length, true);
            fs.rmSync(scratchDir, { recursive: true, force: true });
            return;
        }

        for (const name of ['ap-placements.json', 'ap-unlocks.json']) {
            fs.mkdirSync(args.configDir, { recursive: true });
            fs.copyFileSync(path.join(scratchDir, name), path.join(args.configDir, name));
        }
        const cleared = clearRunState(args.configDir);
        fs.rmSync(scratchDir, { recursive: true, force: true });

        console.log('');
        console.log('################################################################');
        console.log('##  NEW PLACEMENT-MODE RUN INITIALIZED - previous progress is  ##');
        console.log('##  no longer valid. Restart the server before playing.        ##');
        console.log('################################################################');
        console.log('');
        console.log(`Wrote ${path.join(args.configDir, 'ap-placements.json')} and ${path.join(args.configDir, 'ap-unlocks.json')}.`);
        if (cleared.length > 0) {
            console.log(`Cleared: ${cleared.join(', ')}`);
        }
        console.log('');
        printSpoilerSummary(trySeed, args.pool, placements, spoiler, itemPoolSize, locations.length, args.spoiler);
        return;
    }

    console.error('');
    console.error(`GenerateSeed: FAILED after ${attempt} attempt(s) (--retry-budget ${args.retryBudget}). Last error:`);
    console.error(lastError ?? '(no error captured)');
    process.exit(1);
}

main();
