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

Two specific values are excluded from the pool entirely (`isNeverSwappable()` in
`NpcDripParser.ts`), found via real in-game reports rather than guessed: `*_torso_
backpack` (vanilla's only use of it layers it alongside a separate real torso - it's an
accessory, not a substitute for full coverage, and landing it in an NPC's only torso
slot left them with "no torso") and `*_<part>_demon` (zero vanilla NPCs use any `_demon`
variant, in any category - unlike the ~120 other never-worn model.pack values, which are
mostly just unused holiday hats/hairstyles, a value unused across every category it
appears in is a strong signal it's reserved for an actual Demon-type creature).

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

### Armor sets (torso/arms/legs)

Torso/arms/legs are also reassigned per NPC block rather than per slot, for the same
reason weapons are: these three pieces are sculpted as matched pairs per armor "set"
(platemail/plaguesuit/split_bark_armour), and independent per-slot sampling could (and,
found via actual in-game testing, did) produce combinations vanilla never uses - e.g. a
`man_torso_chainmail` + `man_arms_platemail` combo that renders with a visible gap and a
floating, disconnected arm mesh, since the plate sleeve's shoulder geometry is sculpted
to dock against a plate torso specifically. `bodySetFor()` in `NpcDripParser.ts`
classifies each torso/arms/legs value into a set family (or `null`/generic for the vast
majority - bare/basic/buff/leather/tatty/chainmail/...) by checking real vanilla
pairings first (every vanilla `arms_platemail` occurrence pairs with a plate-family
torso, zero with a generic one). Each NPC's torso/arms/legs slots are grouped, the
group's target set is read from whatever it already is in vanilla, and every slot in
the group reassigns from ONLY that set's sub-pool (or the generic sub-pool if the NPC
has no protected set) - so a shuffle can freely reassign WITHIN a set but can never
create a new mismatched pairing.

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

## Drop randomization

Three modes. `tiered`/`chaos` reassign which item sits in each weighted monster
loot-drop slot, plus a separate shuffle of the `death_drop` guaranteed-item npc param
(bones/ashes on death) - pure script/config mutation, same class of change as
drip/shops, reseeding needs a content pack rebuild. `mimic` instead shuffles which
monster runs which ENTIRE loot table ("chicken mimics green dragon" - complete drop
profile including guaranteed drops, cascade, clue-trail table calls, and the bones) -
runtime-override pattern like entrances, reseeding is restart-only (see below).

### Pieces

Tools (`overlays/engine/tools/drops/`):

- `DropTableParser.ts` - parses `content/scripts/drop tables/scripts/*.rs2`, the 73
  files holding monster loot cascades (`def_int $var = random(total); if ($var < N)
  obj_add(npc_coord, item, qty, ^lootdrop_duration); else if (...) ...`). Finds branch
  boundaries by text position rather than brace-tracking, so it handles both
  brace-delimited and brace-less single-line branch styles uniformly (both occur in
  vanilla). Every slot's rarity is `weight/total` (probability), never the raw
  threshold delta - cascades use different `random()` denominators (128 is by far the
  most common, but 6/8/65/138/512 all occur too), so raw weight numbers aren't
  comparable across monsters. Also provides `loadQuestCriticalItems()` (pins any drop
  slot whose item is checked via `inv_total`/`inv_del` somewhere in `content/scripts/
  quests/`), `loadStackableItems()` (scans `.obj` configs for `stackable=yes`, used to
  decide whether a reassigned slot keeps its original quantity or gets forced to 1),
  and `parseDeathDropSlots()` for the separate `death_drop` axis.
- `RandomizeDrops.ts` - reassigns eligible slots' items (mode-dependent, see Scope
  below) and separately deranges `death_drop` values across every eligible NPC.
- `MimicTransform.ts` - everything specific to `--mode mimic`: parses each
  `[ai_queue3,...]` death handler out of the pristine backup, extracts its
  post-prologue loot into a `[label,ap_drops_<n>]` block in one generated file
  (`content/scripts/drop tables/ap_mimic.rs2` - deliberately NEXT TO the backed-up
  `scripts/` subtree so backup/restore can't mistake it for vanilla), injects a
  seed-independent preamble into each handler, and owns the artifact cleanup used when
  switching back to tiered/chaos. The engine side is `ApDropOverrides.ts` +
  `ScriptOpcode.AP_DROP_GROUP` (opcode 1901) + the `ap_drop_group(int)(int)` command
  declared in `content/scripts/ap/ap.rs2`, mirroring the entrance-override plumbing.

### Usage

```
cd Server/engine && npx tsx tools/drops/RandomizeDrops.ts [--seed <number>] [--dry-run] [--mode tiered|chaos|mimic] [--no-death-drop] [--exclude <substr,substr,...>]
cd Server/engine && npx tsx tools/pack/Build.ts
```

...then restart the server. First run backs up every vanilla drop-table script under
`content/.ap-backup/scripts/drop tables/scripts/` (same convention as the `.npc` backup
drip/shops use) and re-derives from that backup every run, so reseeding never
compounds. Spoiler is `engine/tools/drops/drop-seed.json`.

Mimic-specific: the FIRST mimic run (or the first after `MimicTransform.ts` itself
changes) rewrites the corpus and needs the pack rebuild + restart; every later mimic
reseed only rewrites `engine/data/config/ap-drops.json` and needs a restart only - the
tool prints which case you're in. Deleting `ap-drops.json` reverts to fully vanilla
drops without a rebuild (the preambles fall through). Switching mimic -> tiered/chaos
is handled automatically (the corpus is restored from backup first, which DOES need a
rebuild).

### Scope (mimic)

Every `ai_queue3` handler in the corpus is a shuffle "slot"; every distinct
post-prologue loot body is a "unit". 95 of 97 slots are mappable across 77 units. A
seeded permutation (no slot may keep its own unit - shared-label variants like the four
goblin types count as the same unit for this) is written to `ap-drops.json`; the
`ap_drop_group` command resolves it at runtime and the handler jumps to the mapped
unit's label, or falls through to its untouched vanilla loot on a miss.

- `death_drop` travels WITH the table: `npc_param(death_drop)` reads the DYING npc's
  config, so extraction inlines each unit's own uniform value as a literal (verified
  uniform across category members for all 77 units; `otherworldly_being`'s explicit
  `death_drop,null` becomes "drop nothing", the faithful translation).
- Structurally pinned, always vanilla: `grip` (bespoke Heroes' Quest kill-credit
  handler, no standard prologue) and `_mountain_troll` (its shared label carries
  npc_type-gated Trollheim prison keys BEFORE the prologue, and is jumped to from
  outside the corpus). Pre-prologue logic in INLINE handlers (guard/guard_dog clue
  checks, troll_commander's prison keys) stays in place and still runs - those slots
  are mappable.
- Quest-gated drops whose conditions read only the killer's quest state (rat's tail,
  jailer's key, chaos druid's mould, firebird feather) travel with their table and stay
  obtainable - from whichever monster now mimics that table. The spoiler is
  load-bearing for finding them, same caveat as shopsanity.
- The death_drop .npc-param shuffle is skipped in mimic mode by design.

### Scope

Only the 73-file monster drop-table corpus and the `death_drop` npc param are in
scope - the shared reward sub-tables called via `~procname` (`~randomherb`,
`~randomjewel`, `~ultrarare_getitem`, `~megararetable`, `~randomjunk` in
`shared_droptables.rs2`) and any `obj_add(...)` drops outside that folder (quest/area
scripts) are deliberately left untouched.

`--mode` picks how a slot's replacement item is sampled (kept as a flag rather than one
fixed design, since it's intended to become an Archipelago per-slot option):

- `tiered` (default): every slot is bucketed by probability into
  ultra(≤1%)/rare(1-4%)/uncommon(4-10%)/common(10-25%)/verycommon(>25%) bands (derived
  from the corpus's own distribution, not guessed), then reassigned to a different item
  independently sampled from everything else observed in that same band. A monster's
  1%-chance slot always stays a 1%-chance slot, but which item fills it moves.
- `chaos`: every eligible slot samples from the full corpus-wide item pool regardless
  of band - a common slot can roll what used to be someone's 1% drop.

Both modes sample from items actually observed in the vanilla drop-table corpus, not
the full `obj.pack` catalog - unlike drip's `model.pack` widening, item names have no
safe structural naming convention to filter the full catalog down to "plausible monster
loot" (`man_torso_basic` self-describes a category; `dragonstone` doesn't self-describe
"drop-table-appropriate"), so the vanilla tables' own item set is the only vetted pool.

Quantity: a reassigned slot keeps its original quantity if the new item is stackable
(per its `.obj` config), otherwise gets forced to 1 - so a slot that used to read "1
iron_dagger" can't land on "35 abyssal_whip".

**Quest-critical items are pinned**: any item referenced as the argument to
`inv_total(inv|bank, item)` or `inv_del(inv|bank, item)` anywhere in `content/scripts/
quests/` has its original slot(s) excluded from reassignment (found 53 such items empirically,
not guessed - e.g. the four coloured beads used in a Myreque-line quest). They remain
eligible as a *replacement* value for other slots though, since that can only add
availability, never remove it. An earlier, broader version of this check (any mention
anywhere in quest scripts, not just requirement checks) pinned 82% of all slots because
common items like coins/runes/ores are mentioned constantly in quest dialogue and
rewards without ever gating anything - narrowed to the `inv_total`/`inv_del`-argument
pattern after checking real usage.

`death_drop` shuffling excludes `quests/` and `tutorial/` npc configs (Tutorial Island
is protected the same way entrance randomization protects it).

**Verified in-game**: the user tested a seed-777 run and confirmed monster drops
changed as expected; a subsequent reseed (`--mode tiered` -> `--mode chaos`, same seed)
surfaced a real bug where the edit step searched the live `.rs2` line for the exact
vanilla text captured at parse time, which only matches on the very first run - any
later reseed silently failed to write its new values even though the spoiler showed
them correctly. Fixed by having the edit step look at whatever text is CURRENTLY on the
line instead (`findObjAddCall()` in `DropTableParser.ts`) - see
docs/lessons-learned.md's "two real bugs found via actual in-game testing" addendum for
the full story and the verification method (decompiling the compiled `script.dat`
directly to confirm what the server will actually run, without needing to boot it).

## Regenerating everything at once

`overlays/engine/tools/RegenerateAll.ts` restores the `.npc`/drop-table-script tree to
pristine vanilla ONCE, then runs drip, shopsanity, and drop randomization in sequence,
then rebuilds the pack:

```
cd Server/engine && npx tsx tools/RegenerateAll.ts [--seed <n>] [--drip-seed <n>] [--shops-seed <n>] [--drops-seed <n>] [--mode tiered|chaos|mimic] [--skip-drip] [--skip-shops] [--skip-drops] [--no-rebuild]
```

This is deliberately NOT what each individual tool does on its own - drip/shops/drops
all write onto the *current live* file rather than a fresh copy of the backup,
specifically so reseeding one tool doesn't erase another's edits (see the shopsanity
section above). Restoring to pristine is only safe as one step in a pipeline that then
re-runs every tool that's supposed to be part of the seed; doing it inside a single
tool would silently wipe whatever the others had already written. Use this script
whenever you want a fully clean regeneration (e.g. after a tool's own logic changes -
"skip this slot" in the current code means "leave it as whatever's already there," not
"restore to vanilla," so stale mistakes from an older version of a tool can otherwise
persist across reseeds indefinitely) or when reseeding everything for a fresh test.
`--seed` sets a shared default for all three tools; the per-tool `--*-seed` flags
override it individually.
