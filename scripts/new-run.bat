@echo off
setlocal enabledelayedexpansion
REM new-run.bat - roll a complete fresh Archipelago run, end to end.
REM
REM   scripts\new-run.bat              (from the 2004Scape-AP-Logic repo, on Windows)
REM
REM NOTE: on AP connect the server writes data\config\ap-seed-options.json from
REM the multiworld YAML's seed options. new-run.sh auto-adopts it; this .bat does
REM NOT (batch JSON parsing) - either run the .sh via WSL/git-bash, or read that
REM file and set the knobs below to match by hand.
REM
REM Edit the variables below and re-run. Every stage is independently toggleable and
REM every tool's FULL parameter list is documented next to its knob. Stage order
REM matters and is already correct: content mutation (with the one pack rebuild)
REM first, runtime-JSON randomizers next, placement LAST (it validates against the
REM final entrance table and resets the run state - fired checks + tracker).
REM
REM After it finishes: RESTART THE WINDOWS SERVER. Also make sure world.json has
REM "apSkipTutorial": true (next to xpRate/infiniteRun) if you want new accounts to
REM skip Tutorial Island - that's a world flag, not a seed artifact.
REM
REM SPAWN MUST RUN BEFORE ENTRANCES: RandomizeEntrances's own reroll-until-valid
REM logic validates reachability using whatever data/config/ap-spawn.json happens to
REM be on disk at the time it runs - it has no idea the spawn point is about to
REM change. If spawn runs after entrances, that validation is checking the WRONG
REM (stale) spawn, and the real, final spawn can land somewhere the entrance table
REM never got tested against - possibly a spawn as isolated as a single unreachable
REM tile, with 20 wasted GenerateSeed retries as the only symptom (found in-game
REM 2026-07-16: city-mode picked Trollheim, entrances validated fine against a
REM leftover spawn, and the real run was a 1-region softlock).
REM
REM This is the Windows mirror of new-run.sh - keep both in sync.

set "ENGINE_DIR=%~dp0..\..\Server\engine"
pushd "%ENGINE_DIR%" || exit /b 1

REM ============================== master knobs =================================

REM One seed drives every stage below. Defaults to a fresh random roll each run;
REM pin it to re-roll the exact same run: `set SEED=12345` in the console first
REM (or hardcode a number here). RANDOM*32768+RANDOM = uniform 0..2^30-1.
if not defined SEED set /a SEED=%RANDOM% * 32768 + %RANDOM%

REM Spoiler-free by default: the placement stage only prints counts. Run
REM `scripts\new-run.bat --verbose` (or `set VERBOSE=1` first) to print the
REM goal list and the full sphere-by-sphere walkthrough.
if not defined VERBOSE set VERBOSE=0
if "%~1"=="--verbose" set VERBOSE=1

REM --- stage toggles: 1 = run, 0 = skip (skipped stages keep their current state) ---
set RUN_CONTENT=1
REM drip + shops + drops via RegenerateAll (INCLUDES the ~1:30 pack rebuild)
set RUN_GATHER=1
REM gathering swap table (runtime JSON, restart only)
set RUN_PROCESS=1
REM processing/recipe swap table (runtime JSON, restart only)
set RUN_SPAWN=1
REM random home/respawn point (MUST run before entrances - see note above)
set RUN_ENTRANCES=1
REM entrance shuffle + automatic logic validation/reroll
set RUN_PLACEMENT=1
REM AP placement: checks contain the unlocks (RESETS run progress!)
set REFRESH_REGION_GRAPH=0
REM only after map/content changes (validator input; slow-ish)
set REFRESH_WORLDMAP_PNG=0
REM tracker map images; only after map changes

REM ============================ per-stage knobs ================================

REM RegenerateAll.ts - restores pristine content, reruns drip+shops+drops, rebuilds pack.
REM   all params: [--seed <n>] [--drip-seed <n>] [--shops-seed <n>] [--drops-seed <n>]
REM               [--mode tiered|chaos|mimic] [--skip-drip] [--skip-shops] [--skip-drops]
REM               [--no-rebuild]
REM   (finer control lives in the individual tools if you ever need it:
REM    RandomizeDrip.ts  [--seed n] [--dry-run] [--mixed-gender] [--no-weapons] [--exclude a,b]
REM    RandomizeShops.ts [--seed n] [--dry-run] [--mismatched-titles] [--exclude a,b]
REM    RandomizeDrops.ts [--seed n] [--dry-run] [--mode tiered|chaos|mimic] [--no-death-drop] [--exclude a,b])
set DROPS_MODE=mimic
REM tiered | chaos | mimic ("chicken runs the green dragon table")
set REGENERATE_EXTRA=
REM e.g. "--skip-drip" or "--drip-seed 555"

REM RandomizeGathering.ts - what mining/fishing/woodcutting actually yield.
REM   all params: [--seed <n>] [--mode shuffle|chaos]
REM               [--skills mining,fishing,woodcutting] [--exclude <item,item>]
REM               [--pin-quest-items] [--no-quest-pins] [--dry-run]
set GATHER_MODE=shuffle
REM shuffle (bijective, everything obtainable) | chaos
set GATHER_EXTRA=

REM RandomizeProcessing.ts - what cooking/smithing/crafting/fletching produce.
REM   all params: [--seed <n>] [--mode shuffle|chaos]
REM               [--skills cooking,smithing,crafting,fletching] [--exclude <item,item>]
REM               [--pin-quest-items] [--no-quest-pins] [--dry-run]
set PROCESS_MODE=shuffle
set PROCESS_EXTRA=

REM RandomizeSpawn.ts - the home/respawn point. Runs BEFORE entrances (see note up top).
REM   all params: [--seed <n>] [--mode city|chunk] [--dry-run] [--include-far-west]
set SPAWN_MODE=city
REM city (7 spellbook landmarks) | chunk (random mainland square)
set SPAWN_EXTRA=
REM chunk mode: "--include-far-west" opens mapX<40 back up

REM RandomizeEntrances.ts - ladder/stair/trapdoor shuffle + gated entrances.
REM   all params: [--seed <n>] [--mixed] [--dry-run] [--no-validate]
REM   (validation rerolls seed+1 automatically, budget 20; --rewrite is legacy, avoid)
set ENTRANCE_EXTRA=
REM e.g. "--mixed" to pool cross-map + floor-shift together

REM GenerateSeed.ts - AP placement (checks contain the unlocks). Writes
REM ap-placements.json + a locked starting ap-unlocks.json, CLEARS fired checks +
REM tracker (a placement seed IS a new run), and refuses to ship an unbeatable seed.
REM   all params: [--seed N] [--pool per-skill|groups] [--dry-run] [--spoiler]
REM               [--max-progression-level N] [--retry-budget N] [--config-dir <dir>]
set POOL=per-skill
REM per-skill (72 "+20 <Skill> cap" items) | groups (32 chunky items)
set PLACEMENT_EXTRA=
REM e.g. "--max-progression-level 50"

REM ================================ stages =====================================

if "%RUN_CONTENT%"=="1" (
    echo.
    echo ==^> npx tsx tools/RegenerateAll.ts --seed %SEED% --mode %DROPS_MODE% %REGENERATE_EXTRA%
    call npx tsx tools/RegenerateAll.ts --seed %SEED% --mode %DROPS_MODE% %REGENERATE_EXTRA% || goto :error
)

if "%RUN_GATHER%"=="1" (
    echo.
    echo ==^> npx tsx tools/gather/RandomizeGathering.ts --seed %SEED% --mode %GATHER_MODE% %GATHER_EXTRA%
    call npx tsx tools/gather/RandomizeGathering.ts --seed %SEED% --mode %GATHER_MODE% %GATHER_EXTRA% || goto :error
)

if "%RUN_PROCESS%"=="1" (
    echo.
    echo ==^> npx tsx tools/process/RandomizeProcessing.ts --seed %SEED% --mode %PROCESS_MODE% %PROCESS_EXTRA%
    call npx tsx tools/process/RandomizeProcessing.ts --seed %SEED% --mode %PROCESS_MODE% %PROCESS_EXTRA% || goto :error
)

if "%RUN_SPAWN%"=="1" (
    echo.
    echo ==^> npx tsx tools/spawn/RandomizeSpawn.ts --seed %SEED% --mode %SPAWN_MODE% %SPAWN_EXTRA%
    call npx tsx tools/spawn/RandomizeSpawn.ts --seed %SEED% --mode %SPAWN_MODE% %SPAWN_EXTRA% || goto :error
)

if "%RUN_ENTRANCES%"=="1" (
    echo.
    echo ==^> npx tsx tools/map/RandomizeEntrances.ts --seed %SEED% %ENTRANCE_EXTRA%
    call npx tsx tools/map/RandomizeEntrances.ts --seed %SEED% %ENTRANCE_EXTRA% || goto :error
)

if "%REFRESH_REGION_GRAPH%"=="1" (
    echo.
    echo ==^> npx tsx tools/logic/BuildRegionGraph.ts
    call npx tsx tools/logic/BuildRegionGraph.ts || goto :error
)

if "%REFRESH_WORLDMAP_PNG%"=="1" (
    echo.
    echo ==^> npx tsx tools/map/RenderWorldmapPng.ts
    call npx tsx tools/map/RenderWorldmapPng.ts || goto :error
)

if "%VERBOSE%"=="1" set PLACEMENT_EXTRA=--spoiler %PLACEMENT_EXTRA%

if "%RUN_PLACEMENT%"=="1" (
    echo.
    echo ==^> npx tsx tools/ap/GenerateSeed.ts --seed %SEED% --pool %POOL% %PLACEMENT_EXTRA%
    call npx tsx tools/ap/GenerateSeed.ts --seed %SEED% --pool %POOL% %PLACEMENT_EXTRA% || goto :error
)

echo.
echo ================================================================
echo New run rolled (seed %SEED%). Now:
echo   1. RESTART the Windows server.
echo   2. Walkthrough: npx tsx tools/sim/SimulateProgression.ts --verbosity 2
echo   3. Sanity:      npx tsx tools/logic/ValidateSeed.ts
echo   4. Tracker:     http://localhost:8080/ap/   (?spoiler=1 to see everything)
echo   5. Testing aids: tools/ap/SetUnlock.ts ^<name^> ^<count^> ^| --clear
echo ================================================================

popd
endlocal
exit /b 0

:error
echo.
echo Stage failed - aborting.
popd
endlocal
exit /b 1
