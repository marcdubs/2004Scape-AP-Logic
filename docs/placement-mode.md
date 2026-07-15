# Placement mode — solo Archipelago: checks contain the unlocks

Status: **decided with the user 2026-07-15** (AskUserQuestion): full AP-style
placement; standard start (all skills capped 20, gear/tools bronze); item pool
granularity **configurable** `--pool per-skill|groups`.

The gap this closes: the simulator's own -v2 narration proved the current build
is "effectively a vanilla-open run" — all lock machinery exists but nothing
grants unlocks, and checks pay out random loot (filler). Placement mode
generates a seed where **check locations contain specific items** (progressive
unlocks or filler), placed with sphere logic so nothing is ever locked behind
itself. Playing = hunting your progression.

## The shared contract — `data/config/ap-placements.json`

Written by the generator, read by the engine (ApChecks). **No file = exactly
today's behavior** (every check rolls a random reward; unlocks stay fail-open).

```json
{
  "seed": 777,
  "pool": "per-skill",
  "placements": {
    "quest_doric": { "item": "progressive_pickaxe", "count": 1, "display": "Progressive Pickaxe (steel)" },
    "first_kill_goblin": { "item": "progressive_mining", "count": 2, "display": "+20 Mining cap" },
    "level_fishing_20": { "item": "filler" }
  },
  "spoiler": { "spheres": [ ... ] }
}
```

- `item` = an ap-unlocks.json key, or the literal `"filler"`. `count` = how much
  to increment the unlock count by (lets "+20 cap" items ride on the existing
  `cap = 20 + 10 × count` engine formula as count += 2 — **the engine formula
  does not change**).
- `display` = the announcement string.
- A check id missing from `placements` = filler (belt and braces).

## Locations (check ids — all already fire through ApChecks)

- `quest_<dirname>` for all 63 quest completions — **new**: implemented as varp
  watches (quest varp ≥ its `^*_complete` constant) appended to `ap-checks.json`,
  reusing the existing watcher wholesale. The old direct reward roll in
  `~ap_quest_complete` must be retired when a placements file exists (no double
  payout); with no placements file it keeps its current behavior.
- `barcrawl_bar_1..10`, `ds_*` stages (existing watches).
- `first_xp_<skill>` (18), `first_kill` + 14 notable kills (existing).
- `level_<skill>_<N>`, N ∈ {10..90 step 10} (existing emitters). The generator
  treats milestones ≤ 60 as plausible progression locations and > 60 as
  filler-only by default (nobody wants Progressive Armour behind level 90
  Runecraft) — tunable.

## Items

- **Gear**: `progressive_melee/armour/ranged/magic` — 7 copies each (tier idx
  1..7; bronze/idx-0 is free by the levelrequire mapping). 28 items.
- **Tools**: `progressive_pickaxe` ×5, `progressive_axe` ×6 (bronze free). 11.
- **Skill caps** (`--pool per-skill`, default): 4 × "+20 cap" items per skill
  (count +2 each) for the 18 cappable skills (HP never capped) = 72 items,
  reaching 99 at 4 copies (20→40→60→80→99, engine min(99, ...) handles the top).
- **Skill caps** (`--pool groups`): `progressive_gathering/artisan/combat/
  support` — the generator expands a group item into +10-cap counts for every
  skill in the group; 8 copies per group = 32 items. Group membership documented
  in the generator.
- Everything else = `filler` (the existing 14-category reward roll).

## Starting state (written by the generator)

- `ap-unlocks.json`: all six gear/tool family counts start at **0** (build-time
  correction: `ap_gear_locked` and the tool gates return tier 0/bronze
  unconditionally BEFORE the count comparison, so bronze is free at count 0 —
  the draft's tentative count-1 was an off-by-one), zero skill-cap counts =
  every skill capped at 20 (the file existing is what activates caps).
- Clears `ap-checks-fired.json` and `ap-tracker.json` — **a new placement seed
  is a new run** (this deliberately supersedes the earlier "fired checks are
  never cleared" rule, which predates placements).

## Placement algorithm

Assumed-fill (the standard AP approach): start from the all-items state,
remove progression items one at a time and place each into a location still
reachable *without* it (using the sim engine's reachability with caps/gear/
region gates); filler fills the rest. Must end with a full-run validation:
simulate collecting every reachable check sphere by sphere, asserting all
three goals reachable — reuse `tools/sim` reachability, do not reimplement.

## Receipt wiring (engine)

`ApChecks.fireCheck` consults placements: unlock → `ApUnlockOverrides.
grantUnlock(item, count)` (new export: bump in-memory + persist ap-unlocks.json;
the existing mtime reload keeps every consumer coherent) + announce `display`;
filler → the existing `~ap_grant_check_reward` path. The `[queue,ap_check_fired]`
script gains the item name as an arg so announcements read "Check: Doric's
Quest — received Progressive Pickaxe (steel)!". The tracker records placements
discovered (category `checks`) for the browser page.

## Simulator & validator

`SimulateProgression`/`ValidateSeed` read ap-placements.json when present:
sphere expansion collects reachable checks' items before recomputing — the -v2
narration then walks the REAL progression ("Sphere 2 opens with the Progressive
Pickaxe from Doric's Quest..."). Exit-1 on an unbeatable placement (generator
bug guard).

## CLI

`npx tsx tools/ap/GenerateSeed.ts [--seed N] [--pool per-skill|groups]
[--dry-run]` — writes placements + starting unlocks + clears run state, prints
the sphere spoiler, runs the validator, and (like RandomizeEntrances) refuses
to ship an invalid seed.
