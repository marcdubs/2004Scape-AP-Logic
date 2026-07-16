#!/usr/bin/env -S npx tsx
// Progression simulator CLI - the logic engine + narrator for the Archipelago
// randomizer's quest/goal reachability (2004Scape-AP-Logic docs/progression-sim.md).
//
// Usage (run from Server/engine):
//   npx tsx tools/sim/SimulateProgression.ts [--verbosity 0|1|2] [--json out.json]
//       [--config-dir data/config]
//
// Exit code 0 = every goal reachable, 1 = at least one goal blocked (so a future CI
// step can gate seed generation on this before ever handing a seed to a player).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadSeedConfig } from './ConfigLoader.js';
import { runSimulation } from './Engine.js';
import { buildQuestIndex, renderPlacementV0, renderPlacementV1, renderPlacementV2, renderV0, renderV1, renderV2, toJsonSafe, toJsonSafePlacement } from './Narrate.js';
import { applyQuestGates, buildLocationCatalog, loadPlacements, simulatePlacementSpheres } from './PlacementEngine.js';
import { Goal, QuestReq } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { verbosity: 0 | 1 | 2; jsonOut: string | null; configDir: string } {
    let verbosity: 0 | 1 | 2 = 0;
    let jsonOut: string | null = null;
    let configDir = path.join('data', 'config');

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
        } else if (arg === '--help' || arg === '-h') {
            console.log('Usage: npx tsx tools/sim/SimulateProgression.ts [--verbosity 0|1|2] [--json out.json] [--config-dir data/config]');
            process.exit(0);
        } else {
            throw new Error(`Unrecognized argument: ${arg}`);
        }
    }

    return { verbosity, jsonOut, configDir };
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

function main(): void {
    const { verbosity, jsonOut, configDir } = parseArgs(process.argv.slice(2));

    const quests = loadQuestDatabase();
    const goals = loadGoalDatabase();
    const seedConfig = loadSeedConfig(configDir);

    // Placement mode (docs/placement-mode.md "Simulator & validator"): an ap-placements.json
    // present in configDir switches this tool to the placement-aware sphere loop (compute
    // reachable checks -> collect their items -> recompute) and narration. Absent file =
    // the exact vanilla-path code below, untouched - byte-compatible with prior behavior.
    const placementsFile = loadPlacements(configDir);
    if (placementsFile.present) {
        const locations = buildLocationCatalog(quests);
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

    const result = runSimulation(quests, goals, seedConfig);
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
