#!/usr/bin/env bash
# new-run.sh - roll a complete fresh Archipelago run, end to end.
#
#   bash scripts/new-run.sh              (from the 2004Scape-AP-Logic repo)
#
# Edit the variables below and re-run. Every stage is independently toggleable and
# every tool's FULL parameter list is documented next to its knob. Stage order
# matters and is already correct: content mutation (with the one pack rebuild)
# first, runtime-JSON randomizers next, placement LAST (it validates against the
# final entrance table and resets the run state - fired checks + tracker).
#
# SPAWN MUST RUN BEFORE ENTRANCES: RandomizeEntrances's own reroll-until-valid
# logic validates reachability using whatever data/config/ap-spawn.json happens to
# be on disk at the time it runs - it has no idea the spawn point is about to
# change. If spawn runs after entrances, that validation is checking the WRONG
# (stale) spawn, and the real, final spawn can land somewhere the entrance table
# never got tested against - possibly a spawn as isolated as a single unreachable
# tile, with 20 wasted GenerateSeed retries as the only symptom (found in-game
# 2026-07-16: city-mode picked Trollheim, entrances validated fine against a
# leftover spawn, and the real run was a 1-region softlock).
#
# After it finishes: RESTART THE WINDOWS SERVER. Also make sure world.json has
# "apSkipTutorial": true (next to xpRate/infiniteRun) if you want new accounts to
# skip Tutorial Island - that's a world flag, not a seed artifact.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$(cd "$SCRIPT_DIR/../../Server/engine" && pwd)"
cd "$ENGINE_DIR"

# ============================== master knobs =================================

# One seed drives every stage below. Defaults to a fresh random roll each run;
# pin it to re-roll the exact same run: `SEED=12345 bash scripts/new-run.sh`
# (or hardcode a number here). RANDOM*32768+RANDOM = uniform 0..2^30-1.
SEED="${SEED:-$((RANDOM * 32768 + RANDOM))}"

# Spoiler-free by default: every stage prints counts only. Pass --verbose (or
# VERBOSE=1) to also print the gathering/processing/thieving swap tables, the
# rolled home, the goal list and the full sphere-by-sphere walkthrough.
# (GenerateSeed.ts --dry-run always prints it - nothing committed.)
#
# "Counts only" is a console decision, not a data one: every randomizer writes
# its complete table to a spoiler file next to the tool (tools/gather/
# gather-seed.json, tools/map/entrance-seed.json, ...) on every run, verbose or
# not. Read those when you want the answers.
VERBOSE="${VERBOSE:-0}"
for arg in "$@"; do
  [ "$arg" = "--verbose" ] && VERBOSE=1
done
# Passed to the randomizers that would otherwise dump their whole table.
QUIET_FLAG="--quiet"
[ "$VERBOSE" = 1 ] && QUIET_FLAG=""

# --- stage toggles: 1 = run, 0 = skip (skipped stages keep their current state) ---
RUN_CONTENT=1             # drip + shops + drops + teleports via RegenerateAll (INCLUDES the ~1:30 pack rebuild)
RUN_GATHER=1              # gathering swap table (runtime JSON, restart only)
RUN_PROCESS=1             # processing/recipe swap table (runtime JSON, restart only)
RUN_THIEVING=1            # thieving loot swap table (runtime JSON, restart only)
RUN_SPAWN=1               # random home/respawn point (MUST run before entrances - see note above)
RUN_ENTRANCES=1           # entrance shuffle + automatic logic validation/reroll
RUN_PLACEMENT=1           # AP placement: checks contain the unlocks (RESETS run progress!)
REFRESH_REGION_GRAPH=0    # only after map/content changes (validator input; slow-ish)
REFRESH_WALK_GRAPH=auto   # path-helper graph: auto = build only if missing or the region graph just changed (1 = force, 0 = never)
REFRESH_WORLDMAP_PNG=0    # tracker map images; only after map changes
RUN_VALIDATE=1            # print the beatability report (spheres + goals + item obtainability) at the end

# ============================ per-stage knobs ================================

# RegenerateAll.ts - restores pristine content, reruns drip+shops+drops+teleports, rebuilds pack.
#   all params: [--seed <n>] [--drip-seed <n>] [--shops-seed <n>] [--drops-seed <n>]
#               [--teleports-seed <n>] [--mode tiered|chaos|mimic] [--skip-drip]
#               [--skip-shops] [--skip-drops] [--skip-teleports] [--no-rebuild]
#   (finer control lives in the individual tools if you ever need it:
#    RandomizeDrip.ts  [--seed n] [--dry-run] [--mixed-gender] [--no-weapons] [--exclude a,b]
#    RandomizeShops.ts [--seed n] [--dry-run] [--mismatched-titles] [--exclude a,b]
#    RandomizeDrops.ts [--seed n] [--dry-run] [--mode tiered|chaos|mimic] [--no-death-drop] [--exclude a,b]
#    RandomizeTeleports.ts [--seed n] [--dry-run] - deranges the 7 spellbook
#      teleport destinations among themselves; spoiler: tools/map/teleport-seed.json)
DROPS_MODE=mimic          # tiered | chaos | mimic ("chicken runs the green dragon table")
REGENERATE_EXTRA=""       # e.g. "--skip-drip" or "--drip-seed 555"

# RandomizeGathering.ts - what mining/fishing/woodcutting actually yield.
#   all params: [--seed <n>] [--mode shuffle|tiered|chaos]
#               [--skills mining,fishing,woodcutting] [--exclude <item,item>]
#               [--pin-quest-items] [--no-quest-pins] [--dry-run] [--quiet]
GATHER_MODE=shuffle       # shuffle (bijective) | tiered (bijective within level bands) | chaos
GATHER_EXTRA=""

# RandomizeProcessing.ts - what cooking/smithing/crafting/fletching produce.
#   all params: [--seed <n>] [--mode shuffle|tiered|chaos]
#               [--skills cooking,smithing,crafting,fletching] [--exclude <item,item>]
#               [--pin-quest-items] [--no-quest-pins] [--dry-run] [--quiet]
PROCESS_MODE=shuffle
PROCESS_EXTRA=""

# RandomizeThieving.ts - what pickpockets/market stalls/trapped chests hand you.
#   all params: [--seed <n>] [--mode shuffle|tiered|chaos]
#               [--surfaces pickpocket,stalls,chests] [--exclude <item,item>]
#               [--pin-quest-items] [--no-quest-pins] [--dry-run] [--quiet] [--export-pool <path>]
#   (`--exclude coins` leaves the big-money rows - 1000-coin Ardougne chest, hero/
#    paladin pockets - handing out vanilla coins; quantity is never rescaled.)
THIEVING_MODE=shuffle
THIEVING_EXTRA=""

# RandomizeSpawn.ts - the home/respawn point. Runs BEFORE entrances (see note up top).
#   all params: [--seed <n>] [--mode city|chunk] [--dry-run] [--quiet] [--include-far-west]
SPAWN_MODE=city           # city (7 spellbook landmarks) | chunk (random mainland square)
SPAWN_EXTRA=""            # chunk mode: "--include-far-west" opens mapX<40 back up

# RandomizeEntrances.ts - ladder/stair/trapdoor shuffle + gated entrances.
#   all params: [--seed <n>] [--mixed] [--dry-run] [--no-validate] [--require-perfect]
#   (validation rerolls seed+1 automatically, budget 20; --rewrite is legacy, avoid.
#    --require-perfect refuses tables that strand ANY quest - auto-added for AP runs
#    by the seed-options adoption below, since stranded checks may hold multiworld
#    progression; solo runs may accept stranded tables, those checks become filler)
ENTRANCE_EXTRA=""         # e.g. "--mixed" to pool cross-map + floor-shift together

# GenerateSeed.ts - AP placement (checks contain the unlocks). Writes
# ap-placements.json + a locked starting ap-unlocks.json, CLEARS the run state
# (fired checks, tracker, and the AP client's ap-session.json - a placement seed
# IS a new run), and refuses to ship an unbeatable seed.
#   all params: [--seed N] [--pool per-skill|groups] [--dry-run] [--spoiler]
#               [--max-progression-level N] [--retry-budget N] [--config-dir <dir>]
POOL=per-skill            # per-skill (72 "+20 <Skill> cap" items) | groups (32 chunky items)
PLACEMENT_EXTRA=""        # e.g. "--max-progression-level 50"

# ================ Archipelago slot options (auto-adoption) ===================
# On AP connect the server writes data/config/ap-seed-options.json from the
# multiworld YAML's seed options (entrance_randomization, npc_drip, drops...).
# When that file exists it OVERRIDES the knobs above - so the flow is: connect
# once, then re-run this script to roll the seed the multiworld asked for.
# Set AP_SEED_OPTIONS=ignore (or delete the file) to use the script knobs.
SEED_OPTS_FILE="data/config/ap-seed-options.json"
ADOPTED=0
if [ "${AP_SEED_OPTIONS:-}" != "ignore" ] && [ -f "$SEED_OPTS_FILE" ]; then
  # the helper prints the full ARCHIPELAGO MODE banner (what it adopted) to stderr;
  # only its stdout is the assignments this eval consumes.
  eval "$(node "$SCRIPT_DIR/seed-options-to-env.cjs" "$SEED_OPTS_FILE")"
  ADOPTED=1
  echo "    (AP_SEED_OPTIONS=ignore re-runs this with the script's own knobs instead)"
  echo
else
  echo "================================================================"
  echo "LOCAL MODE - rolling from this script's own knobs"
  echo "================================================================"
  if [ "${AP_SEED_OPTIONS:-}" = "ignore" ]; then
    echo "  AP_SEED_OPTIONS=ignore is set - the multiworld's options were"
    echo "  deliberately skipped even if $SEED_OPTS_FILE exists."
  else
    echo "  No $SEED_OPTS_FILE found, so nothing from"
    echo "  Archipelago is being used - this is a solo/local seed."
    echo
    echo "  Playing an Archipelago multiworld? STOP. Connect the game"
    echo "  server to the room first (tracker -> Archipelago tab), which"
    echo "  writes that file, THEN re-run this script. Rolling now gives"
    echo "  you a different world from the one the multiworld was filled"
    echo "  against."
  fi
  echo "================================================================"
  echo
fi

# ================================ stages =====================================

run() { echo; echo "==> npx tsx $*"; npx tsx "$@"; }

[ "$RUN_CONTENT" = 1 ]   && run tools/RegenerateAll.ts --seed "$SEED" --mode "$DROPS_MODE" $REGENERATE_EXTRA
[ "$RUN_GATHER" = 1 ]    && run tools/gather/RandomizeGathering.ts --seed "$SEED" --mode "$GATHER_MODE" $QUIET_FLAG $GATHER_EXTRA
[ "$RUN_PROCESS" = 1 ]   && run tools/process/RandomizeProcessing.ts --seed "$SEED" --mode "$PROCESS_MODE" $QUIET_FLAG $PROCESS_EXTRA
[ "$RUN_THIEVING" = 1 ]  && run tools/thieving/RandomizeThieving.ts --seed "$SEED" --mode "$THIEVING_MODE" $QUIET_FLAG $THIEVING_EXTRA
[ "$RUN_SPAWN" = 1 ]     && run tools/spawn/RandomizeSpawn.ts --seed "$SEED" --mode "$SPAWN_MODE" $QUIET_FLAG $SPAWN_EXTRA
[ "$RUN_ENTRANCES" = 1 ] && run tools/map/RandomizeEntrances.ts --seed "$SEED" $ENTRANCE_EXTRA
[ "$REFRESH_REGION_GRAPH" = 1 ] && run tools/logic/BuildRegionGraph.ts

# ---- path-helper walk graph (SEED-INDEPENDENT - not a per-run stage) ---------
# ap-walk-graph.json is all-pairs WALKING distances, and walking cost depends only
# on map geometry, so a reseed cannot change a single number in it (docs/tracker-map.md
# "Pathfinding helper"). Rebuilding it every run would spend ~70s writing the same
# file back. Hence `auto`: build it only when it's missing - a fresh checkout, where
# ::appath and the tracker's route bar are dead until it exists - or when
# REFRESH_REGION_GRAPH just rebuilt the walk grid it's derived from, which is exactly
# when it goes stale. Set 1 to force, 0 to never.
WALK_GRAPH_FILE=data/config/ap-walk-graph.json
WALK_GRID_FILE=data/config/ap-walk-grid.bin
ENTRANCE_POOL_FILE=data/config/ap-entrance-pool.json
BUILD_WALK_GRAPH=0
case "$REFRESH_WALK_GRAPH" in
  1) BUILD_WALK_GRAPH=1 ;;
  0) : ;;
  auto)
    if [ "$REFRESH_REGION_GRAPH" = 1 ] || [ ! -f "$WALK_GRAPH_FILE" ]; then
      BUILD_WALK_GRAPH=1
    fi
    ;;
  *) echo "new-run: REFRESH_WALK_GRAPH must be auto, 1 or 0 (got '$REFRESH_WALK_GRAPH')" >&2; exit 1 ;;
esac

if [ "$BUILD_WALK_GRAPH" = 1 ]; then
  if [ ! -f "$WALK_GRID_FILE" ]; then
    # Don't abort the run over the path helper - it's an optional convenience.
    echo
    echo "==> skipping BuildWalkGraph: $WALK_GRID_FILE missing - set REFRESH_REGION_GRAPH=1 once (it emits the grid), then re-run."
  else
    # The graph is keyed off the UNSHUFFLED entrance catalog, which is seed-independent
    # too. --export-pool is a dry run that writes only that pool (no entrance table), so
    # filling in a missing one here can't disturb the shuffle rolled above.
    [ -f "$ENTRANCE_POOL_FILE" ] || run tools/map/RandomizeEntrances.ts --export-pool "$ENTRANCE_POOL_FILE"
    run tools/logic/BuildWalkGraph.ts
  fi
fi

[ "$REFRESH_WORLDMAP_PNG" = 1 ] && run tools/map/RenderWorldmapPng.ts
[ "$VERBOSE" = 1 ]       && PLACEMENT_EXTRA="--spoiler $PLACEMENT_EXTRA"
[ "$RUN_PLACEMENT" = 1 ] && run tools/ap/GenerateSeed.ts --seed "$SEED" --pool "$POOL" $PLACEMENT_EXTRA

# AP run (seed options adopted): the multiworld owns item placements, and ApClient
# refuses to overwrite a file holding a real (solo) fill - GenerateSeed above still
# ran for its reset + validation duties, but its local placements must go. The
# server rewrites the file with just the room's quest gates on reconnect.
if [ "$ADOPTED" = 1 ]; then
  rm -f data/config/ap-placements.json
  echo "==> AP run: removed local ap-placements.json (multiworld owns placements; quest gates re-sync on connect)"
fi

# Beatability report: sphere-by-sphere reachability incl. the four-source item
# obtainability model. --verbose prints every sphere; otherwise just the verdict.
# (Skips gracefully if region-graph.json isn't built yet - see the one-time note.)
if [ "$RUN_VALIDATE" = 1 ]; then
  if [ -f tools/logic/region-graph.json ]; then
    # tolerate a non-zero (BLOCKED) exit - the report is the point, don't abort the run.
    if [ "$VERBOSE" = 1 ]; then npx tsx tools/logic/ValidateSeed.ts --verbose || true; else npx tsx tools/logic/ValidateSeed.ts || true; fi
  else
    echo; echo "==> skipping ValidateSeed: tools/logic/region-graph.json missing - run 'npx tsx tools/logic/BuildRegionGraph.ts' once (one-time)."
  fi
fi

echo
echo "================================================================"
if [ "$ADOPTED" = 1 ]; then
  echo "New run rolled (seed $SEED) in ARCHIPELAGO MODE."
  echo "  Every stage above used the multiworld's options from"
  echo "  $SEED_OPTS_FILE - this world matches the one"
  echo "  Archipelago filled. Now:"
else
  echo "New run rolled (seed $SEED) in LOCAL MODE (no Archipelago options). Now:"
fi
echo "  1. RESTART the Windows server."
echo "  2. Walkthrough: npx tsx tools/sim/SimulateProgression.ts --verbosity 2   (AP runs get the quest-graph report instead: the room owns placements)"
echo "                  add --current-unlocks to ask 'what can I do RIGHT NOW' with the unlocks already received"
echo "  3. Re-validate: npx tsx tools/logic/ValidateSeed.ts --verbose   (ran above unless RUN_VALIDATE=0)"
echo "  4. Tracker:     http://localhost:8080/ap/   (?spoiler=1 to see everything)"
echo "  5. Testing aids: tools/ap/SetUnlock.ts <name> <count> | --clear"
echo "================================================================"
