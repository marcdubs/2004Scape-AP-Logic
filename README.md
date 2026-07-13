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
  resampled until it actually differs from its own original value. Held items
  (`human_weapons_*`) are shuffled too, but per-NPC-block instead of per-slot - see
  "Weapons" below.

Shared (`overlays/engine/tools/shared/Prng.ts`): the seedable PRNG used for the
per-pool sampling streams, and the `derangement()` helper the entrance gate shuffle
uses (drip doesn't use `derangement()` itself - its pool is bigger than its occurrence
count, so it's independent sampling rather than a permutation of a fixed list).

### Usage

```
cd Server/engine && npx tsx tools/npc/RandomizeDrip.ts [--seed <number>] [--dry-run] [--mixed-gender] [--no-weapons] [--exclude <substr,substr,...>]
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

### Weapons

`human_weapons_*` values (weapons and generic held props alike - vanilla already mixes
them, e.g. a farmer holding `human_weapons_chicken_drumstick`) are shuffled too, but
handled per NPC block rather than per slot, because a block can hold one item (no
shield) or two (a weapon + a shield), and getting that pairing right needs to know
both slots at once:

- **1 weapon slot**: reassigned to anything in the full weapon+prop pool (a farmer can
  end up holding a crossbow, or a knight holding a chicken drumstick - no shield
  present, so nothing to clip with).
- **2 weapon slots (weapon + shield)**: the shield slot draws from the shield pool
  only; the weapon slot draws from the **one-handed pool only** - this is what
  guarantees a two-handed weapon never lands next to a shield. Two-handed is
  determined by name (`bow`, `staff`, `halberd`, `scythe`, `harpoon` substrings) -
  cross-checked against every weapon+shield pairing vanilla itself uses (e.g. `spear`
  pairs with `viking_shield` in vanilla, so spear is treated as one-handed here even
  though it reads as two-handed in plain English; vanilla's own precedent wins over
  genre convention since this is a cosmetic system, not the real equipment rules).
- **The `human_weaponsextra_*` companion piece** (currently just the staff orb) ties
  to one specific weapon - any block using one is left vanilla entirely rather than
  risk stranding the orb on a mismatched weapon.
- Blocks with a two-item group that isn't a clean weapon+shield pair (both shields,
  or neither is a shield - one vanilla item, `excalibur` + `model_526`, is like this)
  are also left vanilla - the structural role can't be inferred safely.

`--no-weapons` disables all of the above and leaves every `human_weapons_*` value
untouched.

**Known risk, not yet mitigated**: some NPCs may be visually load-bearing for quest
recognition (a disguise, an NPC you're told to identify by appearance). There's no
built-in exclude list for this - use `--exclude` once such NPCs are identified.

## Shopsanity (shop location randomization)

Shuffles which NPC has which shop. Pure config mutation on `.npc` files, same class of
change as drip - **not** the runtime-override pattern entrances use (a shop reassignment
touches 5 fields at once and several shop-opening code paths are bespoke scripts that
don't even read the NPC's params, so a runtime override wouldn't cover meaningfully more
ground while being far more complex). Reseeding needs a content pack rebuild, same as
drip - the two tools share one vanilla backup and compose correctly with each other
(each reads its *values* to shuffle from the pristine backup, but writes its edits onto
the *current live* file, so running drip and shops in either order, or re-running either
one, never erases the other's changes).

### Pieces

Tools (`overlays/engine/tools/npc/`):

- `ShopParser.ts` - a shopkeeper NPC points at its stock via `param=owned_shop,<inv
  name>` (`content/scripts/shop/scripts/shop.rs2`'s `~openshop_activenpc` reads it,
  along with `shop_sell_multiplier`/`shop_buy_multiplier`/`shop_delta`/`shop_title`
  from the same NPC). Every one of the 117 `owned_shop` occurrences in vanilla has all
  5 params present, so `parseShopBundles()` treats them as one atomic 5-field bundle.
  `loadHardcodedShopIds()` finds every shop id that's hardcoded as a literal argument
  to `~openshop(...)` somewhere in scripts instead of read from the param (vanilla has
  4: `dommik`, `rommik` pick a members/f2p shop id in a hardcoded if/else in their own
  `opnpc3` handler; `duel_fadli` and `regicidegeneralshopkeeper` similarly have a
  same-shop-id hardcoded elsewhere) - any bundle whose current shop matches one of
  these is excluded, since reassigning its param would silently do nothing (or worse,
  make its dialogue path and its right-click-Trade path show different shops).
- `RandomizeShops.ts` - deranges the whole bundle across every eligible shopkeeper by
  default, so a shop's title/pricing stays internally consistent, just relocated to a
  different NPC ("stock stays put, access moves").

### Usage

```
cd Server/engine && npx tsx tools/npc/RandomizeShops.ts [--seed <number>] [--dry-run] [--mismatched-titles] [--exclude <substr,substr,...>]
cd Server/engine && npx tsx tools/pack/Build.ts
```

...then restart the server. Spoiler is `engine/tools/npc/shop-seed.json`.

`--mismatched-titles` deranges only the `owned_shop` field, leaving each NPC's own
title/pricing in place - a shopkeeper's personality/prices no longer match what
they're actually selling (chaos/comedy variant, per archipelago-ideas.md #4's own
suggestion). Default carries the whole bundle so the shop still makes internal sense
at its new location.

**Known risk, not yet mitigated**: since players may rely on specific shops for quest
items, a shuffled seed needs its spoiler treated as load-bearing data once real AP
logic-gen exists, not just a nice-to-have log. Not yet verified in-game.
