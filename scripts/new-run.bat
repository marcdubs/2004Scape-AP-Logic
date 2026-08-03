@echo off
setlocal enabledelayedexpansion
REM new-run.bat - roll a complete fresh Archipelago run, end to end.
REM
REM   scripts\new-run.bat              (from the 2004Scape-AP-Logic repo, on Windows)
REM
REM NOTE: on AP connect the server writes data\config\ap-seed-options.json from
REM the multiworld YAML's seed options. When that file exists it OVERRIDES the
REM knobs below (via scripts\seed-options-to-env.cjs, same as new-run.sh).
REM `set AP_SEED_OPTIONS=ignore` first (or delete the file) to use the knobs.
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

REM Spoiler-free by default: every stage prints counts only. Run
REM `scripts\new-run.bat --verbose` (or `set VERBOSE=1` first) to also print the
REM gathering/processing/thieving swap tables, the rolled home, the goal list and
REM the full sphere-by-sphere walkthrough.
REM
REM "Counts only" is a console decision, not a data one: every randomizer writes
REM its complete table to a spoiler file next to the tool (tools\gather\
REM gather-seed.json, tools\map\entrance-seed.json, ...) on every run, verbose or
REM not. Read those when you want the answers.
if not defined VERBOSE set VERBOSE=0
if "%~1"=="--verbose" set VERBOSE=1
REM Passed to the randomizers that would otherwise dump their whole table.
set QUIET_FLAG=--quiet
if "%VERBOSE%"=="1" set QUIET_FLAG=

REM --- stage toggles: 1 = run, 0 = skip (skipped stages keep their current state) ---
set RUN_CONTENT=1
REM drip + shops + drops + teleports via RegenerateAll (INCLUDES the ~1:30 pack rebuild)
set RUN_GATHER=1
REM gathering swap table (runtime JSON, restart only)
set RUN_PROCESS=1
REM processing/recipe swap table (runtime JSON, restart only)
set RUN_THIEVING=1
REM thieving loot swap table (runtime JSON, restart only)
set RUN_SPAWN=1
REM random home/respawn point (MUST run before entrances - see note above)
set RUN_ENTRANCES=1
REM entrance shuffle + automatic logic validation/reroll
set RUN_PLACEMENT=1
REM AP placement: checks contain the unlocks (RESETS run progress!)
set REFRESH_REGION_GRAPH=0
REM only after map/content changes (validator input; slow-ish)
set REFRESH_WALK_GRAPH=auto
REM path-helper graph: auto = build only if missing or the region graph just changed (1 = force, 0 = never)
set REFRESH_WORLDMAP_PNG=0
REM tracker map images; only after map changes
set RUN_VALIDATE=1
REM print the beatability report (spheres + goals + item obtainability) at the end

REM ============================ per-stage knobs ================================

REM RegenerateAll.ts - restores pristine content, reruns drip+shops+drops+teleports, rebuilds pack.
REM   all params: [--seed <n>] [--drip-seed <n>] [--shops-seed <n>] [--drops-seed <n>]
REM               [--teleports-seed <n>] [--mode tiered|chaos|mimic] [--skip-drip]
REM               [--skip-shops] [--skip-drops] [--skip-teleports] [--no-rebuild]
REM   (finer control lives in the individual tools if you ever need it:
REM    RandomizeDrip.ts  [--seed n] [--dry-run] [--mixed-gender] [--no-weapons] [--exclude a,b]
REM    RandomizeShops.ts [--seed n] [--dry-run] [--mismatched-titles] [--exclude a,b]
REM    RandomizeDrops.ts [--seed n] [--dry-run] [--mode tiered|chaos|mimic] [--no-death-drop] [--exclude a,b]
REM    RandomizeTeleports.ts [--seed n] [--dry-run] - deranges the 7 spellbook
REM      teleport destinations among themselves; spoiler: tools\map\teleport-seed.json)
set DROPS_MODE=mimic
REM tiered | chaos | mimic ("chicken runs the green dragon table")
set REGENERATE_EXTRA=
REM e.g. "--skip-drip" or "--drip-seed 555"

REM RandomizeGathering.ts - what mining/fishing/woodcutting actually yield.
REM   all params: [--seed <n>] [--mode shuffle|tiered|chaos]
REM               [--skills mining,fishing,woodcutting] [--exclude <item,item>]
REM               [--pin-quest-items] [--no-quest-pins] [--dry-run] [--quiet]
set GATHER_MODE=shuffle
REM shuffle (bijective) | tiered (bijective within level bands) | chaos
set GATHER_EXTRA=

REM RandomizeProcessing.ts - what cooking/smithing/crafting/fletching produce.
REM   all params: [--seed <n>] [--mode shuffle|tiered|chaos]
REM               [--skills cooking,smithing,crafting,fletching] [--exclude <item,item>]
REM               [--pin-quest-items] [--no-quest-pins] [--dry-run] [--quiet]
set PROCESS_MODE=shuffle
set PROCESS_EXTRA=

REM RandomizeThieving.ts - what pickpockets/market stalls/trapped chests hand you.
REM   all params: [--seed <n>] [--mode shuffle|tiered|chaos]
REM               [--surfaces pickpocket,stalls,chests] [--exclude <item,item>]
REM               [--pin-quest-items] [--no-quest-pins] [--dry-run] [--quiet] [--export-pool <path>]
REM   (`--exclude coins` leaves the big-money rows handing out vanilla coins;
REM    quantity is never rescaled.)
set THIEVING_MODE=shuffle
set THIEVING_EXTRA=

REM RandomizeSpawn.ts - the home/respawn point. Runs BEFORE entrances (see note up top).
REM   all params: [--seed <n>] [--mode city|chunk] [--dry-run] [--quiet] [--include-far-west]
set SPAWN_MODE=city
REM city (7 spellbook landmarks) | chunk (random mainland square)
set SPAWN_EXTRA=
REM chunk mode: "--include-far-west" opens mapX<40 back up

REM RandomizeEntrances.ts - ladder/stair/trapdoor shuffle + gated entrances.
REM   all params: [--seed <n>] [--mixed] [--dry-run] [--no-validate] [--require-perfect]
REM   (validation rerolls seed+1 automatically, budget 20; --rewrite is legacy, avoid.
REM    --require-perfect refuses tables that strand ANY quest - auto-added for AP runs
REM    by the seed-options adoption below, since stranded checks may hold multiworld
REM    progression; solo runs may accept stranded tables, those checks become filler)
set ENTRANCE_EXTRA=
REM e.g. "--mixed" to pool cross-map + floor-shift together

REM GenerateSeed.ts - AP placement (checks contain the unlocks). Writes
REM ap-placements.json + a locked starting ap-unlocks.json, CLEARS the run state
REM (fired checks, tracker, and the AP client's ap-session.json - a placement seed
REM IS a new run), and refuses to ship an unbeatable seed.
REM   all params: [--seed N] [--pool per-skill|groups] [--dry-run] [--spoiler]
REM               [--max-progression-level N] [--retry-budget N] [--config-dir <dir>]
set POOL=per-skill
REM per-skill (72 "+20 <Skill> cap" items) | groups (32 chunky items)
set PLACEMENT_EXTRA=
REM e.g. "--max-progression-level 50"

REM ================ Archipelago slot options (auto-adoption) ===================
REM On AP connect the server writes data\config\ap-seed-options.json from the
REM multiworld YAML's seed options. When that file exists it OVERRIDES the knobs
REM above - flow: connect once, then re-run this script. The helper emits
REM `set "K=V"` lines (with !VAR! delayed expansion for appends) executed below.

set ADOPTED=0
if /i "%AP_SEED_OPTIONS%"=="ignore" goto :seedopts_local
if not exist "data\config\ap-seed-options.json" goto :seedopts_local
REM the helper prints the full ARCHIPELAGO MODE banner (what it adopted) to stderr;
REM only its stdout is the `set` lines this for /f consumes.
for /f "usebackq delims=" %%L in (`node "%~dp0seed-options-to-env.cjs" "data\config\ap-seed-options.json" --bat`) do %%L
set ADOPTED=1
echo     (set AP_SEED_OPTIONS=ignore to re-run with the script's own knobs instead)
echo.
goto :seedopts_done

:seedopts_local
echo ================================================================
echo LOCAL MODE - rolling from this script's own knobs
echo ================================================================
if /i "%AP_SEED_OPTIONS%"=="ignore" (
    echo   AP_SEED_OPTIONS=ignore is set - the multiworld's options were
    echo   deliberately skipped even if the file exists.
) else (
    echo   No data\config\ap-seed-options.json found, so nothing from
    echo   Archipelago is being used - this is a solo/local seed.
    echo.
    echo   Playing an Archipelago multiworld? STOP. Connect the game
    echo   server to the room first ^(tracker -^> Archipelago tab^), which
    echo   writes that file, THEN re-run this script. Rolling now gives
    echo   you a different world from the one the multiworld was filled
    echo   against.
)
echo ================================================================
echo.
:seedopts_done

REM ================================ stages =====================================

if "%RUN_CONTENT%"=="1" (
    echo.
    echo ==^> npx tsx tools/RegenerateAll.ts --seed %SEED% --mode %DROPS_MODE% %REGENERATE_EXTRA%
    call npx tsx tools/RegenerateAll.ts --seed %SEED% --mode %DROPS_MODE% %REGENERATE_EXTRA% || goto :error
)

if "%RUN_GATHER%"=="1" (
    echo.
    echo ==^> npx tsx tools/gather/RandomizeGathering.ts --seed %SEED% --mode %GATHER_MODE% %QUIET_FLAG% %GATHER_EXTRA%
    call npx tsx tools/gather/RandomizeGathering.ts --seed %SEED% --mode %GATHER_MODE% %QUIET_FLAG% %GATHER_EXTRA% || goto :error
)

if "%RUN_PROCESS%"=="1" (
    echo.
    echo ==^> npx tsx tools/process/RandomizeProcessing.ts --seed %SEED% --mode %PROCESS_MODE% %QUIET_FLAG% %PROCESS_EXTRA%
    call npx tsx tools/process/RandomizeProcessing.ts --seed %SEED% --mode %PROCESS_MODE% %QUIET_FLAG% %PROCESS_EXTRA% || goto :error
)

if "%RUN_THIEVING%"=="1" (
    echo.
    echo ==^> npx tsx tools/thieving/RandomizeThieving.ts --seed %SEED% --mode %THIEVING_MODE% %QUIET_FLAG% %THIEVING_EXTRA%
    call npx tsx tools/thieving/RandomizeThieving.ts --seed %SEED% --mode %THIEVING_MODE% %QUIET_FLAG% %THIEVING_EXTRA% || goto :error
)

if "%RUN_SPAWN%"=="1" (
    echo.
    echo ==^> npx tsx tools/spawn/RandomizeSpawn.ts --seed %SEED% --mode %SPAWN_MODE% %QUIET_FLAG% %SPAWN_EXTRA%
    call npx tsx tools/spawn/RandomizeSpawn.ts --seed %SEED% --mode %SPAWN_MODE% %QUIET_FLAG% %SPAWN_EXTRA% || goto :error
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

REM ---- path-helper walk graph (SEED-INDEPENDENT - not a per-run stage) ---------
REM ap-walk-graph.json is all-pairs WALKING distances, and walking cost depends only
REM on map geometry, so a reseed cannot change a single number in it (docs\tracker-map.md
REM "Pathfinding helper"). Rebuilding it every run would spend ~70s writing the same
REM file back. Hence `auto`: build it only when it's missing - a fresh checkout, where
REM ::appath and the tracker's route bar are dead until it exists - or when
REM REFRESH_REGION_GRAPH just rebuilt the walk grid it's derived from, which is exactly
REM when it goes stale. Set 1 to force, 0 to never.
set BUILD_WALK_GRAPH=0
if "%REFRESH_WALK_GRAPH%"=="1" set BUILD_WALK_GRAPH=1
if "%REFRESH_WALK_GRAPH%"=="auto" (
    if "%REFRESH_REGION_GRAPH%"=="1" set BUILD_WALK_GRAPH=1
    if not exist "data\config\ap-walk-graph.json" set BUILD_WALK_GRAPH=1
)

if "%BUILD_WALK_GRAPH%"=="1" (
    REM The grid is the one input in this chain that is NOT checked in, while its sibling
    REM tools\logic\region-graph.json IS - both come out of the same BuildRegionGraph pass.
    REM So a fresh checkout has the region graph and no grid, REFRESH_REGION_GRAPH defaults
    REM to 0, and this stage used to hit a "skip, go set a knob" branch on EVERY run: with
    REM stock knobs it could never fire at all, which is exactly how a finished run still
    REM left the tracker saying "No walk graph on the server" ^(found 2026-08-03, mid-run^).
    REM Building it is ~15s and deterministic, and rewrites only region-graph.json ^(identical
    REM payload - just meta.generatedAt/buildMs^) plus the grid. Same "handle the prerequisite,
    REM don't crash on it" call as the entrance pool below.
    if not exist "data\config\ap-walk-grid.bin" (
        if not "%REFRESH_REGION_GRAPH%"=="1" (
            echo.
            echo ==^> data\config\ap-walk-grid.bin missing ^(not a checked-in artifact^) - building it first
            echo ==^> npx tsx tools/logic/BuildRegionGraph.ts
            call npx tsx tools/logic/BuildRegionGraph.ts || goto :error
        )
    )
    if not exist "data\config\ap-walk-grid.bin" (
        REM Don't abort the run over the path helper - it's an optional convenience.
        echo.
        echo ==^> skipping BuildWalkGraph: data\config\ap-walk-grid.bin still missing after BuildRegionGraph.ts.
    ) else (
        REM The graph is keyed off the UNSHUFFLED entrance catalog, which is seed-independent
        REM too. --export-pool is a dry run that writes only that pool ^(no entrance table^), so
        REM filling in a missing one here can't disturb the shuffle rolled above.
        if not exist "data\config\ap-entrance-pool.json" (
            echo.
            echo ==^> npx tsx tools/map/RandomizeEntrances.ts --export-pool data/config/ap-entrance-pool.json
            call npx tsx tools/map/RandomizeEntrances.ts --export-pool data/config/ap-entrance-pool.json || goto :error
        )
        echo.
        echo ==^> npx tsx tools/logic/BuildWalkGraph.ts
        call npx tsx tools/logic/BuildWalkGraph.ts || goto :error
    )
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

REM AP run (seed options adopted): the multiworld owns item placements, and
REM ApClient refuses to overwrite a file holding a real (solo) fill - GenerateSeed
REM above still ran for its reset + validation duties, but its local placements
REM must go. The server rewrites the file with the room's quest gates on reconnect.
if "%ADOPTED%"=="1" (
    if exist "data\config\ap-placements.json" del /q "data\config\ap-placements.json"
    echo ==^> AP run: removed local ap-placements.json - multiworld owns placements; quest gates re-sync on connect
)

REM Beatability report: sphere-by-sphere reachability incl. the four-source item
REM obtainability model. --verbose prints every sphere; otherwise just the verdict.
if "%RUN_VALIDATE%"=="1" (
    if exist "tools\logic\region-graph.json" (
        echo.
        REM tolerate a non-zero (BLOCKED) exit - the report is the point, don't abort the run.
        if "%VERBOSE%"=="1" (
            echo ==^> npx tsx tools/logic/ValidateSeed.ts --verbose
            call npx tsx tools/logic/ValidateSeed.ts --verbose
        ) else (
            echo ==^> npx tsx tools/logic/ValidateSeed.ts
            call npx tsx tools/logic/ValidateSeed.ts
        )
    ) else (
        echo.
        echo ==^> skipping ValidateSeed: tools\logic\region-graph.json missing - run "npx tsx tools/logic/BuildRegionGraph.ts" once ^(one-time^).
    )
)

echo.
echo ================================================================
if "%ADOPTED%"=="1" (
    echo New run rolled ^(seed %SEED%^) in ARCHIPELAGO MODE.
    echo   Every stage above used the multiworld's options from
    echo   data\config\ap-seed-options.json - this world matches the one
    echo   Archipelago filled. Now:
) else (
    echo New run rolled ^(seed %SEED%^) in LOCAL MODE ^(no Archipelago options^). Now:
)
echo   1. RESTART the Windows server.
echo   2. Walkthrough: npx tsx tools/sim/SimulateProgression.ts --verbosity 2   (AP runs get the quest-graph report instead: the room owns placements)
echo                   add --current-unlocks to ask "what can I do RIGHT NOW" with the unlocks already received
echo   3. Re-validate: npx tsx tools/logic/ValidateSeed.ts --verbose   (ran above unless RUN_VALIDATE=0)
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
