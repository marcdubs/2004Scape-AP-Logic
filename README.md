# 2004Scape-AP-Logic

Archipelago randomizer logic and tooling for [2004scape](https://github.com/LostCityRS) (Server/Engine-TS/Content).

This repo does **not** fork LostCityRS. `Server`, `engine`, `content`, `webclient`, and
`javaclient` stay plain, unmodified LostCityRS checkouts (a sibling directory, set up
the normal way via `Server/start.sh`). Everything Archipelago-specific lives here
instead, and gets deployed on top via `scripts/install.js`.

**New session / new agent?** Read [docs/lessons-learned.md](docs/lessons-learned.md)
first - it captures the architecture decisions, the rs2/engine recipes, the
environment gotchas, and where the project is heading.

## Layout

- `docs/` - design notes ([archipelago-ideas.md](docs/archipelago-ideas.md)) and
  process/domain knowledge ([lessons-learned.md](docs/lessons-learned.md)).
- `overlays/<target>/...` - files to be copied on top of the matching directory in the
  `Server` checkout. `overlays/engine/tools/map/ExportEntrances.ts` deploys to
  `Server/engine/tools/map/ExportEntrances.ts`, and so on. Directory name under
  `overlays/` must match the target folder name inside `Server/` (`engine`, `content`,
  `webclient`, `javaclient`, or `server` for the top-level repo itself).
- `scripts/install.js` - copies everything under `overlays/` into place.

## Usage

```
node scripts/install.js
```

Assumes `Server/` is a sibling directory (`../Server` relative to this repo). Override
with `node scripts/install.js --server-root /path/to/Server`.

## Adding something new

Drop the file under `overlays/<target>/<path it should land at>`, then re-run
`node scripts/install.js`. No manifest to update. This works for edits to *existing*
vanilla files too (e.g. `ClientCheatHandler.ts`) - just keep a full copy of the edited
file under the overlay and it replaces the vanilla one wholesale on install.

## Entrance randomization

Runtime-override architecture: the shuffle lives in a JSON table the engine reads at
runtime, not in the scripts. Reseeding = re-run one command + restart the server. No
per-seed content rebuild.

### Pieces

Engine (`overlays/engine/src/`):

- `engine/ApEntranceOverrides.ts` - loads `engine/data/config/ap-entrances.json`
  (lazily, on first lookup) into a coord -> coord map. Missing file = everything
  vanilla.
- `engine/script/ScriptOpcode.ts` + `engine/script/handlers/ServerOps.ts` - add the
  custom `AP_ENTRANCE_OVERRIDE` script command (opcode 1900, explicitly numbered high
  in the server-ops range so upstream additions can't collide).

Content (`overlays/content/scripts/`):

- `ap/ap.rs2` - declares `[command,ap_entrance_override](coord)(coord)` for the script
  compiler, plus the `ap_entrance_go` jump label the handler preambles use.
- `ladders+stairs/scripts/*.rs2` - vanilla handlers with a 4-line preamble injected at
  the top of every `[oploc*]` handler: look up `loc_coord` in the override table, and
  if present jump to `ap_entrance_go` (a jump, not a gosub, so the vanilla transition
  can never also run). Preamble is deliberately invisible to `EntranceParser.ts`
  (verified byte-identical parse output vs vanilla).

Tools (`overlays/engine/tools/map/`):

- `EntranceParser.ts` - shared parser for the ladder/stair oploc handlers.
- `ExportEntrances.ts` - dumps the parsed entrance edge list to
  `engine/tools/map/entrances.json`. Read-only.
- `RandomizeEntrances.ts` - pairs up entrances into bidirectional gates, shuffles with
  a seeded derangement, writes `engine/data/config/ap-entrances.json` (override table +
  spoiler in one file).

### Usage

One-time setup (after `node scripts/install.js`): rebuild the content pack so the
patched handlers + new command exist in the compiled scripts:

```
cd Server/engine && npx tsx tools/pack/Build.ts
```

Then, per seed (seconds, repeat as often as you like):

```
cd Server/engine && npx tsx tools/map/RandomizeEntrances.ts [--seed <number>] [--dry-run]
```

...and restart the server. The spoiler is the `spoiler` section inside
`engine/data/config/ap-entrances.json`. To go back to vanilla entrances, delete that
file and restart.

The legacy `--rewrite` flag still bakes the shuffle into the `.rs2` source instead
(requires a full pack rebuild per seed); it's kept as a fallback until the override
path has been played end-to-end.

### Scope

Two gate pools, shuffled separately by default (`--mixed` merges them into one chaos
pool):

- **connector pool**: dungeon/area entrances - the parsed literal cross-map
  transitions plus map-scanned placements of the generic cellar locs (`trapdoor`,
  `ladder_cellar`, `ladder_from_cellar`, ...) found by `LocPlacementScanner.ts` in
  `content/maps/*.jm2`. The cook's-basement class of entrance lives here.
- **floor-shift pool**: same-building staircases with literal coordinates plus
  map-scanned generic building ladders (`ladder`/`laddertop`/`laddermiddle`/ship
  ladders - the "same tile, one plane up/down" handlers, e.g. the Lumbridge castle
  wall ladders). ~300 gates.

Overrides are keyed by trigger coord **and op** (`"coord:op"`), so the middle
landings of multi-storey towers (Lumbridge castle, Clock Tower, ...) shuffle their
climb-up and climb-down independently; the choice menu on those landings consults the
same op2/op3 keys via the patched `stair_options`/`ladder_options` labels.

Left vanilla on purpose: unpaired floor-shift halves (a one-way redirect on a house
staircase breaks the "come back the way you came" guarantee), unpaired scanned
placements (cellars whose surface entrance is a loc type we don't handle yet),
quest-gated entrances, and Tutorial Island (mapsquare 48,48 -
`PROTECTED_MAPSQUARES`).

Reciprocity is guaranteed for every shuffled gate: the far side of wherever you land
leads back to next to where you entered. Scanned-gate arrival tiles are the far
ladder's own tile, nudged to the nearest walkable neighbor at teleport time by the
engine (see the `AP_ENTRANCE_OVERRIDE` handler).

## NPC drip randomization

Pure config mutation, no engine or script changes - unlike entrance randomization,
this shuffles the `.npc` config files themselves, so a reseed needs a content pack
rebuild (not just a server restart).

### Pieces

Tools (`overlays/engine/tools/npc/`):

- `NpcDripParser.ts` - recursively finds every `.npc` file under `content/scripts/`
  and extracts `model<N>=<value>` lines whose value matches the composable human body
  part naming convention (`man_<part>_<detail>` / `woman_<part>_<detail>`, e.g.
  `man_torso_basic`, `woman_hat_witch`). `model<N>` is NOT a fixed body-part slot - the
  client just merges every `model#` entry into one composite mesh in array order
  (`Model.combineForAnim`), so `model2` is a necklace on one NPC and a hat on another.
  The value's own naming convention is the only real signal, which is why grouping is
  by that instead of by index.
- `RandomizeDrip.ts` - groups those values into pools keyed by gender + body-part
  category, and reassigns every slot to a value independently sampled from
  `loadModelUniverse()` (every valid model for that category in `content/pack/
  model.pack`, not just the ones some NPC already happens to be wearing - see Scope
  below), then writes the result back into the live `.npc` files. Each slot is
  resampled until it actually differs from its own original value.

Shared (`overlays/engine/tools/shared/Prng.ts`): the seedable PRNG used for the
per-pool sampling streams, and the `derangement()` helper the entrance gate shuffle
uses (drip doesn't use `derangement()` itself - its pool is bigger than its occurrence
count, so it's independent sampling rather than a permutation of a fixed list).

### Usage

```
cd Server/engine && npx tsx tools/npc/RandomizeDrip.ts [--seed <number>] [--dry-run] [--mixed-gender] [--exclude <substr,substr,...>]
cd Server/engine && npx tsx tools/pack/Build.ts
```

...then restart the server. First run backs up every vanilla `.npc` file under
`content/.ap-backup/scripts/` (mirroring the same backup convention entrance
randomization uses) and every subsequent reseed re-derives from that backup, so
reseeding never compounds onto a previous seed's output. The spoiler is
`engine/tools/npc/drip-seed.json`. To go back to vanilla outfits, restore the `.npc`
files from `content/.ap-backup/scripts/` and rebuild the pack.

`--mixed-gender` merges the `man_*`/`woman_*` pools per category (e.g. `man_torso` and
`woman_torso` become one pool) for more chaotic results; default keeps them separate.
`--exclude` takes a comma-separated list of substrings matched against either the npc's
debugname or its file path - any matching model slot is left vanilla, for pinning
NPCs whose appearance might be load-bearing (quest recognition/disguises).

### Scope

Only `model#=` values matching the `man_`/`woman_` body-part convention are shuffle
candidates - creature-specific models (`npc_troll_head`, `model_2909_npc`, ...) and
held-item/weapon models (`human_weapons_*`) don't match that convention and are always
left vanilla, since swapping them in would produce nonsense (a torso slot getting a
weapon model, a monster getting a human body part). `head#=` (chat-portrait models) and
`recol#s`/`recol#d` (palette color swaps) are untouched in this pass - a possible
future extension.

The replacement pool per category is every valid model in `content/pack/model.pack`
matching that category, not just the values vanilla NPCs happen to already wear -
those two are meaningfully different sizes (e.g. `woman_hat` has 23 valid models in
the cache but only 8 ever appear on a vanilla NPC). This means swaps can and do
produce combinations no vanilla NPC ever wore.

**Known risk, not yet mitigated**: some NPCs may be visually load-bearing for quest
recognition (a disguise, an NPC you're told to identify by appearance). There's no
built-in exclude list for this - use `--exclude` once such NPCs are identified.
