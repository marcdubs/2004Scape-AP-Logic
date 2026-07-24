#!/usr/bin/env -S npx tsx
// Progression simulator CLI - the logic engine + narrator for the Archipelago
// randomizer's quest/goal reachability (2004Scape-AP-Logic docs/progression-sim.md).
//
// Usage (run from Server/engine):
//   npx tsx tools/sim/SimulateProgression.ts [--verbosity 0|1|2] [--json out.json]
//       [--config-dir data/config] [--current-unlocks]
//
// Exit code 0 = every goal reachable, 1 = at least one goal blocked (so a future CI
// step can gate seed generation on this before ever handing a seed to a player).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadSeedConfig } from './ConfigLoader.js';
import { runSimulation } from './Engine.js';
import { buildQuestIndex, renderPlacementV0, renderPlacementV1, renderPlacementV2, renderV0, renderV1, renderV2, toJsonSafe, toJsonSafePlacement } from './Narrate.js';
import { PoolMode, applyQuestGates, buildLocationCatalog, endOfRunCounts, loadApOptions, loadPlacements, simulatePlacementSpheres } from './PlacementEngine.js';
import { Goal, QuestReq } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Args {
    verbosity: 0 | 1 | 2;
    jsonOut: string | null;
    configDir: string;
    /** Opt out of the end-of-run cap model - see resolveVanillaUnlocks below. */
    currentUnlocks: boolean;
}

function parseArgs(argv: string[]): Args {
    let verbosity: 0 | 1 | 2 = 0;
    let jsonOut: string | null = null;
    let configDir = path.join('data', 'config');
    let currentUnlocks = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--verbosity' || arg === '-v') {
            const v = Number(argv[++i]);
            if (v === 0 || v === 1 || v === 2) {
                verbosity = v;
            } else {
                throw new Error(`--verbosity must be 0, 1 or 2 (got "${argv[i]}")`);
            }
        } else if (arg === '--json') {
            jsonOut = argv[++i];
        } else if (arg === '--config-dir') {
            configDir = argv[++i];
        } else if (arg === '--current-unlocks') {
            currentUnlocks = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log('Usage: npx tsx tools/sim/SimulateProgression.ts [--verbosity 0|1|2] [--json out.json] [--config-dir data/config] [--current-unlocks]');
            process.exit(0);
        } else {
            throw new Error(`Unrecognized argument: ${arg}`);
        }
    }

    return { verbosity, jsonOut, configDir, currentUnlocks };
}

function loadQuestDatabase(): QuestReq[] {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'quests.json'), 'utf8');
    const parsed = JSON.parse(raw) as { quests: QuestReq[] };
    return parsed.quests;
}

function loadGoalDatabase(): Goal[] {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'goals.json'), 'utf8');
    const parsed = JSON.parse(raw) as { goals: Goal[] };
    return parsed.goals;
}

/**
 * Decides which unlock counts the VANILLA (no-placements) path should reason about.
 *
 * The vanilla path answers a beatability question - "is this seed finishable" - and
 * progression-sim.md's central simplification assumes the counts it reads are the ones
 * "an AP client would have delivered by the end". That assumption held when the only
 * ap-unlocks.json on disk was a hand-written test file, but placement mode changed the
 * file's meaning underneath it: GenerateSeed now writes a LOCKED, all-zero starting table,
 * and during a live AP run the file holds only what the multiworld has delivered so far.
 * Read as an end state, a starting table says every skill is capped at 20 forever, so the
 * tool diagnosed essentially the entire quest graph as blocked ("attack capped at 20 by
 * unlocks; needs 40" x N) on a seed the generator and ValidateSeed both call beatable.
 *
 * Default: model the caps the run ENDS with (the whole progression pool collected), which
 * restores the documented semantics regardless of what stage the live run is at.
 * `--current-unlocks`: keep the raw on-disk snapshot - the right mode when you're poking
 * at a live run with tools/ap/SetUnlock.ts and want "what can I do RIGHT NOW".
 */
function resolveVanillaUnlocks(seedConfig: ReturnType<typeof loadSeedConfig>, currentUnlocks: boolean, pool: PoolMode): ReturnType<typeof loadSeedConfig> {
    if (!seedConfig.unlocks.present) {
        return seedConfig; // no table at all = uncapped already; nothing to substitute.
    }
    if (currentUnlocks) {
        return { ...seedConfig, unlocks: { ...seedConfig.unlocks, capsLabel: 'current ap-unlocks.json snapshot (--current-unlocks)' } };
    }
    return {
        ...seedConfig,
        unlocks: {
            present: true,
            unlocks: endOfRunCounts(pool),
            capsLabel: `end-of-run (full ${pool} progression pool collected; ap-unlocks.json on disk is a STARTING state - pass --current-unlocks for a right-now snapshot)`
        }
    };
}

function main(): void {
    const { verbosity, jsonOut, configDir, currentUnlocks } = parseArgs(process.argv.slice(2));

    const quests = loadQuestDatabase();
    const goals = loadGoalDatabase();
    const seedConfig = loadSeedConfig(configDir);

    // Placement mode (docs/placement-mode.md "Simulator & validator"): an ap-placements.json
    // present in configDir switches this tool to the placement-aware sphere loop (compute
    // reachable checks -> collect their items -> recompute) and narration. Absent file =
    // the vanilla path below.
    //
    // A present-but-item-less file is the AP-multiworld shape: new-run deletes the local
    // placements and ApClient rewrites the file with the room's questGates only, because
    // the MULTIWORLD owns item placement. Running the placement sphere loop over zero
    // placed items would "prove" every goal unreachable, so that case takes the vanilla
    // path too and says why. (Family-D quest gates are deliberately NOT applied there:
    // under the end-of-run model every `quest_<id>` item the room holds does eventually
    // arrive, so gating on them would re-introduce the same false-blocker class.)
    const placementsFile = loadPlacements(configDir);
    if (placementsFile.present && placementsFile.placements.size === 0) {
        console.log('(ap-placements.json holds no item placements - this is an AP multiworld run where the room owns placement. Falling back to the vanilla quest-graph report; the multiworld generator is what proves ITS placement beatable.)\n');
    }
    if (placementsFile.present && placementsFile.placements.size > 0) {
        const locations = buildLocationCatalog(quests, loadApOptions(configDir));
        // Family D: lock the seed's declared questGates behind their `quest_<id>` items.
        const gatedQuests = applyQuestGates(quests, placementsFile.questGates);
        const startingCounts = seedConfig.unlocks.present ? seedConfig.unlocks.unlocks : undefined;
        const result = simulatePlacementSpheres(locations, gatedQuests, goals, placementsFile.placements, startingCounts);

        const lines =
            verbosity === 0
                ? renderPlacementV0(result, placementsFile.seed ?? -1, placementsFile.pool ?? 'per-skill')
                : verbosity === 1
                  ? renderPlacementV1(result, placementsFile.seed ?? -1, placementsFile.pool ?? 'per-skill')
                  : renderPlacementV2(result, placementsFile.seed ?? -1, placementsFile.pool ?? 'per-skill');
        console.log(lines.join('\n'));

        if (jsonOut) {
            fs.writeFileSync(jsonOut, JSON.stringify(toJsonSafePlacement(result, placementsFile.seed ?? -1, placementsFile.pool ?? 'per-skill'), null, 2));
            console.log(`\n(machine-readable result written to ${jsonOut})`);
        }

        process.exit(result.allGoalsReached ? 0 : 1);
    }

    const vanillaConfig = resolveVanillaUnlocks(seedConfig, currentUnlocks, placementsFile.pool ?? 'per-skill');
    const result = runSimulation(quests, goals, vanillaConfig);
    const index = buildQuestIndex(quests);

    const lines = verbosity === 0 ? renderV0(result) : verbosity === 1 ? renderV1(result, index) : renderV2(result, index);
    console.log(lines.join('\n'));

    if (jsonOut) {
        fs.writeFileSync(jsonOut, JSON.stringify(toJsonSafe(result), null, 2));
        console.log(`\n(machine-readable result written to ${jsonOut})`);
    }

    process.exit(result.allGoalsReached ? 0 : 1);
}

main();
