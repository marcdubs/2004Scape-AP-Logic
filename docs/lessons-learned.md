# Lessons learned & dev process

Written at the end of the session (2026-07-13) that built the entrance randomizer,
for future agents/sessions picking this project up. Read this before touching
anything. The companion design doc is [archipelago-ideas.md](archipelago-ideas.md).

## The project, in one paragraph

We're building Archipelago (archipelago.gg) randomizer support for 2004scape
(LostCityRS, rev 274 - Nov 2004 era RuneScape). This repo holds *everything custom*;
the `Server/` checkout next door stays vanilla LostCityRS and gets our files copied
onto it by `scripts/install.js`. We deliberately did NOT fork the LostCityRS repos
(five empty private mirror repos were created and then abandoned in favor of this
overlay approach - the user deleted them).

## Architecture decisions (and why)

### Overlay repo instead of forks

`start.js` in the Server repo clones engine/content/webclient/javaclient from a
hardcoded `repoOrg`. Forking all five repos means owning upstream merges forever.
Instead: `overlays/<target>/<path>` mirrors the checkout layout, `scripts/install.js`
copies files into place. Whole-file replacement only - no patch/diff mechanism. If an
edit to a vanilla file is needed, keep a full modified copy of that file in the
overlay (e.g. `ClientCheatHandler.ts`, `ScriptOpcode.ts`, `ServerOps.ts`,
`ladders+stairs/scripts/*.rs2`).

Consequence to keep in mind: overlay copies of vanilla files will go stale as
upstream moves. If the user updates their LostCityRS checkouts, diff the overlay
copies against the new vanilla before reinstalling.

### Runtime override table instead of script rewriting

The first working implementation baked the entrance shuffle into the `.rs2` source
text per seed. It worked, but had two killer frictions discovered through real use:

1. **The server does not run `.rs2` files.** It loads compiled scripts from
   `engine/data/pack/server/script.dat`/`.idx` (built by `tools/pack/Build.ts`, which
   takes ~1-2 min and rebuilds far more than scripts). In production mode
   (`node.production: true` in `engine/data/config/world.json`) there is no live
   recompile. The user tested a "randomized" world and saw vanilla behavior because
   the pack was stale. This wasted a whole debugging round trip.
2. Editing vanilla content per seed makes every reseed a content diff + rebuild.

The replacement (current architecture): a custom script command
`ap_entrance_override(coord)(coord)` implemented in the engine reads
`engine/data/config/ap-entrances.json` at runtime; every ladder/stair handler has a
4-line preamble that consults it and jumps to a label on hit. Reseed = rewrite JSON +
restart server. One pack rebuild ever (when the preamble/command first land).

This same pattern (engine command + JSON table + tiny script hook) is the intended
plumbing for drop randomization and shop-location randomization later. Build on it,
don't invent a second mechanism.

## How to add a custom script command (the full recipe)

Discovered by reading `engine/tools/pack/Compiler.ts`. Four touch points:

1. `engine/src/engine/script/ScriptOpcode.ts` - add to the `ScriptOpcode` enum
   **with an explicit number** (we used 1900, high in the server-ops 1000-1999 range,
   so upstream additions can't collide - compiled scripts bake opcode numbers in) AND
   add a `['NAME', ScriptOpcode.NAME]` entry to `ScriptOpcodeMap` in the same file.
   The compiler gets its command list from `ScriptOpcodeMap`, not from content.
2. `engine/src/engine/script/handlers/ServerOps.ts` (or the appropriate ops file) -
   add the runtime handler: `state.popInt()` args, `state.pushInt()` result.
3. Any content `.rs2` file - declare the signature:
   `[command,ap_entrance_override](coord $coord)(coord)`. It does NOT have to be in
   `engine.rs2` - we put ours in `content/scripts/ap/ap.rs2` and the compiler
   accepted it fine.
4. `ScriptOpcodePointers` (same dir) only needs an entry if the command requires
   protected access/pointers. A pure lookup needs nothing.

New script files and their triggers are **auto-registered** into
`content/pack/script.pack` by the build (ours got ids 10936/10937). No manual pack
editing needed for scripts. (`script.pack` is gitignored in content.)

## rs2 / RuneScript language facts that matter

- `null` compiles to `-1` for int-backed types (coord included). Engine-side "no
  result" = `pushInt(-1)`. Script-side check: `if ($x ! null)`. Inequality is `!`,
  equality is `=` (single equals). Confirmed valid coord range in
  `ScriptValidators.ts` is `0..2^31-1`, so -1 is safely out of band.
- `@label` is a **goto** - control never returns. `~proc` is a call that returns.
  Labels can take typed params: `[label,ap_entrance_go](coord $dest)`. We use a jump
  in the handler preamble precisely because it aborts the vanilla handler (a proc
  would fall through and run the vanilla teleport too, double-teleporting).
- Every oploc handler in this content uses one of: bare statements, `switch_coord
  (loc_coord)` with per-case coords, `switch_int (loc_angle)`, or `if ($coord = X)` /
  `if (loc_coord = X)` chains. `EntranceParser.ts` handles exactly these shapes and
  nothing more - it is NOT a general rs2 parser.
- All content files are **CRLF**. Normalize on read, restore CRLF on write, or the
  whole-file diff noise will hide the real change (this bit us once) and regexes with
  `$`/end-of-line semantics silently fail (this bit us twice - a comment-attribution
  bug came from a trailing `\r`).

## The build / runtime pipeline

- `.rs2` source -> (`npx tsx tools/pack/Build.ts` in engine/) -> `data/pack/server/
  script.dat` + `.idx` -> loaded by `World.ts` at boot via `ScriptProvider.load`.
- `content/pack/*.pack` files are id<->name registries. The build auto-appends new
  names (scripts, maps). `pack/map.pack` and `script.pack` behave this way; an older
  memory note claiming new `.jm2` maps are "silently skipped unless manually added to
  map.pack" did NOT reproduce this session - the build registered `m0_0.jm2` on its
  own.
- The build has harmless side effects on tracked content files: it auto-filled
  missing `model8`/`model9` equipment slots on one Lumbridge NPC config and bumped
  `pack/map.pack`. `git checkout --` them if the diff needs to stay scoped. Don't
  chase these as bugs.
- Server boot order (engine/): `npx tsx src/app.ts`, world logs `Loaded 10936
  scripts.` then `World ready`. Web port comes from `world.json` (`web.port`).

## Environment gotchas (WSL + Windows shared checkout)

The user's checkout lives on `/mnt/c` and is used from BOTH Windows (they run the
server there) and WSL (agent tooling). This causes recurring friction:

- **esbuild platform ping-pong**: `engine/node_modules` ends up with only
  `@esbuild/win32-x64` (after Windows npm) or only `@esbuild/linux-x64` (after WSL
  npm), breaking `tsx` on the other side. Fix that keeps BOTH working:
  `cd engine && npm install && npm install --no-save --force @esbuild/win32-x64`.
  A future plain `npm install` may prune the win32 copy; just re-run the pair.
- **Do not try to fully boot the server from WSL.** The world starts, but the
  login/friend/logger/OnDemand worker threads crash with `ERR_INVALID_MODULE_SPECIFIER`
  on `#/` import aliases (tsx/worker interaction under this setup), and port 80 needs
  root (we set `web.port` to 8080 in the user's local gitignored `world.json`). The
  **user boots the server on Windows** - hand testing off to them.
- WSL disk I/O on `/mnt/c` is slow; the pack build takes 1-2 min, full tsc a while.
  Don't interpret slowness as a hang.

## Domain knowledge: entrances

All of this is encoded in `EntranceParser.ts` / `RandomizeEntrances.ts`, but the
reasoning:

- Entrance scripts live in `content/scripts/ladders+stairs/scripts/{ladders,stairs}.rs2`
  (53 oploc handlers total). Parsed into 353 entrance records.
- Classification: `floor-shift` (same mapsquare or small relative movecoord - same
  building) vs `cross-map` (real area connectors; also anything crossing the +100
  mapsquare "underground layer" convention - dungeons are the overworld coordinate
  +6400 tiles on Z, i.e. mapZ+100). Only literal-source, literal-destination
  cross-map entries are shuffle candidates today.
- **Bidirectional gate pairing** is heuristic: A pairs with B when A's destination is
  within 10 tiles (`PAIR_RADIUS`) of B's source and vice versa. Works at current
  sparsity (9 gates). Known risk: at floor-shift density (293 entries, staircases a
  few tiles apart in towns) this will mispair - tighten before expanding scope.
- **Land players on vanilla arrival tiles, not on trigger tiles.** The loc itself may
  block its own tile. The JSON override path does this correctly; the legacy
  `--rewrite` path still lands on trigger source tiles (one reason it's deprecated).
- **Duplicate script entries exist**: the blackarm-hideout stairs appear twice with
  identical source+dest (`case 0_49_52_52_61` in two handlers). Without deduping by
  source coord they pair with each other as a bogus zero-length gate. Dedupe is in.
- **Asymmetric classification exists**: that same staircase's down-trigger is
  cross-map (crosses a mapsquare boundary) while its up-trigger is floor-shift, so
  only one side is a candidate -> it lands in the one-way pool. Correct behavior,
  looks surprising in the numbers.
- **Gated entrances** (e.g. the mcannon dwarf trapdoor requiring quest progress) are
  auto-excluded because their transitions resolve through gosubs to relative coords.
  If scope ever expands, keep the preamble bypass in mind: the override check runs
  BEFORE any quest gate in the handler, so putting a gated entrance's coord in the
  table would skip its quest check.
- **Any-source categories** (`ladder_cellar`, `ladder_from_cellar`,
  `phoenixladder`, ...): one generic handler for every physical placement of the loc
  category, no coordinates in script. The runtime override already handles them at
  *application* time (loc_coord is concrete at runtime); what's missing is
  *enumeration* - finding placements. Map files (`content/maps/m<X>_<Z>.jm2`) are
  plain text with a `==== LOC ====` section, lines `level localX localZ: locId shape
  angle`. Loc ids resolve via `content/pack/loc.pack` (id=name) and category
  membership via `category=` in `.loc` configs. A placement scanner is the next
  logical tool.
- Tutorial Island is mapsquare (48,48); `PROTECTED_MAPSQUARES` hard-excludes it.
- Same seed number does NOT reproduce the same layout across algorithm changes (the
  dedupe fix changed the candidate list, which changed what seed 1803231336
  produces). Treat seeds as valid only within one tool version.
- **Relative-destination stairs (`movecoord(coord, dx, dy, dz)`) are resolved via
  forceapproach geometry (`ApproachResolver.ts`), never via the trigger's own
  coordinate.** History: the user reported Falador's bar/smith staircases stayed
  vanilla (some handlers encode the destination relative to the player, e.g.
  `case 0_46_52_27_42 : p_telejump(movecoord(coord, 0, 1, 4)); // Falador smith`).
  The bare `coord` token in that expression is **not** the loc's own switch-case
  coordinate - it's `ScriptOpcode.COORD` (`PlayerOps.ts`), which reads
  `state.activePlayer`: the *operating player's own live tile*. First attempt
  approximated it with the trigger tile; dry-run math looked fine but live testing
  caught players landing two tiles outside the Falador smith wall - reverted.
  The correct fix (implemented): the player's tile isn't arbitrary - every affected
  loc has `forceapproach=<side>` in its `.loc` config, so the pathfinder parks the
  player on one specific footprint edge before the script runs. `ApproachResolver.ts`
  computes that edge from config width/length + forceapproach and the placement's
  angle from map data (conventions: placement coord = SW corner, odd angles swap
  width/length, forceapproach side rotates **clockwise** with angle - all confirmed
  by the script authors' own literals, e.g. Yanille West Gate's level-1 down cases
  land exactly on the computed level-0 approach tiles). `edge_tile + offset` is then
  a genuine vanilla landing. Safety gate: a resolution is only accepted if it
  validates *reciprocally* - the computed landing must sit on the counterpart loc's
  own approach edge one plane over, and the counterpart's landing (literal or
  computed) must sit on ours; failures keep the entrance vanilla/excluded, so the
  failure mode is "stays vanilla", never "lands in a wall". All 14 player-relative
  `p_telejump` cases resolve (8 gate pairs: Falador smith/pub, Yanille West Gate x2,
  Ardy Arlenas/Carnillean, Draynor manor, Varrock lumbermill; 309 -> 317 floor-shift
  gates at seed 1). Deliberately NOT resolved: quest-gated transitions (`gated` flag,
  e.g. dwarf guard tower ladder), `~climb_ladder` relatives (the literal-source ones
  carry side effects like the black knights aggro; generic ones are covered by
  scanned ladder gates), and non-constant offsets (board-game stairs use
  `random()`). `spoiler.approachResolved` in `ap-entrances.json` lists every
  trigger -> landing pair for in-game spot-checks, and `spoiler.excluded` explains
  every remaining non-candidate.
- The "byte-identical parser output on patched files" regression gate needs a
  `line`-field strip before comparing: the installed handlers carry a 5-line
  override preamble per handler, so record line numbers legitimately differ from
  the vanilla backup. Everything else must match exactly (353 records).

## Testing & verification process that worked

- `EntranceParser` output on patched handler files must be **byte-identical** to
  vanilla (same 353 records, same kinds). This is the regression gate for any change
  to the preamble or parser. The preamble was designed for this: it contains no
  `~climb_ladder`/`p_telejump` text and its `if` doesn't match the parser's
  coord-check regexes.
- The engine loader was unit-tested directly without booting the game:
  `npx tsx --input-type=module -e "import { getEntranceOverride } from './src/engine/ApEntranceOverrides.js'; ..."` -
  assert every JSON entry round-trips and misses return -1. Fast and catches
  coord-packing mistakes.
- `--dry-run` on the randomizer prints counts and writes nothing - use it after any
  pairing-logic change and eyeball gate/one-way/excluded counts.
- Verify claims against the *running* system, not the source tree. The script.pack
  lesson: file timestamps under `engine/data/pack/server/` tell you whether a build
  actually picked up your change.
- typecheck: `npx tsc --noEmit -p .` in engine/ (fast enough; lint via
  `npx eslint --no-warn-ignored <file>`).

## In-game safety valves added

- `::home` - available to ALL players (added as an ungated block in
  `ClientCheatHandler.ts`, which otherwise gates everything behind staffModLevel >= 2),
  no cooldown, teleports to Lumbridge (`::tele 0,50,50,22,22` equivalent). Exists so a
  shuffled world can never permanently strand someone.
- To restore vanilla entrances entirely: delete `engine/data/config/ap-entrances.json`
  and restart.
- `content/.ap-backup/` holds pristine vanilla copies of the entrance scripts, made
  before any modification. The randomizer parses from there. With the override
  architecture it's less load-bearing, but keep it - it's also the base the patched
  overlay files were generated from.

## Expansion pass (same day, after the user asked for wider scope)

Floor-shift stairs and map-scanned cellars are now in. Additional lessons:

- **jm2 LOC lines have optional fields.** Format is `level lx lz: id [shape] [angle]`
  - `0 9 16: 1568 22` (no angle) and `0 9 15: 278` (neither) are valid. A regex
  requiring all three silently dropped the cook's-basement trapdoor; symptom was
  "placement not found" with zero errors. Both default to 0.
- **The cellar "down" side is often a different loc type than expected.** Lumbridge
  kitchen's entrance is loc `trapdoor` (id 1568) handled in
  `content/scripts/general_use/scripts/trapdoors.rs2`, not a `ladder_cellar`. Only
  the `[oploc1,trapdoor_open]` (descend) handler gets the preamble - opening/closing
  handlers must stay vanilla. Expect more of this pattern if scope grows (caves,
  manholes, dungeon holes all have their own handler files).
- **Override table is keyed by coord + op** (`"coord:op"` keys). It started
  coord-only, which forced excluding any tile with multiple distinct transitions
  (spiralstairsmiddle: climb-up, climb-down and a menu on one coord) - the user
  immediately noticed Lumbridge castle stairs were vanilla. The fix: the command
  takes an op argument, each handler's preamble passes its own op number, and the
  `stair_options`/`ladder_options` menu labels consult the op2/op3 keys (mirroring
  the explicit oploc2/oploc3 handlers on the same locs) so both entry paths agree.
  The op1 menu record still auto-drops out via multi-destination exclusion - by
  design, its redirects ride on the op2/op3 keys. Note the menu labels rely on
  loc_coord remaining valid after an @jump within the same script run.
- **Pairing needed a plane-equality check** once floor-shifts entered the pool (an
  up-stairs' destination is on a different plane than its own trigger; without the
  check, dense towns mispair). Floor pairing radius 6, cross-map 10, scanned 6.
- **Unpaired floor-shift halves stay vanilla** rather than becoming one-way shuffles:
  a one-way redirect on a building staircase breaks the return-trip guarantee for no
  payoff. Unpaired scanned placements (cellar ups whose surface side is an unhandled
  loc type) also stay vanilla - 24 of them at time of writing.
- **Scanned gates land on the far loc's own tile**, which is usually blocked - the
  engine op nudges to the nearest walkable neighbor via `isMapBlocked` at teleport
  time. This runtime safety net means arrival math can be approximate everywhere.
- **Reciprocity is machine-verified**: for every gate, entering A must land within 8
  tiles of some trigger whose own override lands within 8 tiles of A. 137/137 gates
  passed. Keep this check in the loop after any pairing change (it caught nothing
  this time, but it's the cheapest strong invariant we have).
- `--rewrite` legacy mode branches off *before* the pool shuffle so its derangements
  consume the PRNG deterministically - seeds are not comparable between modes (and
  not comparable across tool versions either).
- phoenixladder scanned to zero placements (the hideout may use a different loc or
  dynamic spawning) - silently absent, fine to ignore.

## Domain knowledge: NPC drip randomization

Built same day as the entrance ladder-scanning expansion, as a separate/unrelated
feature (see [archipelago-ideas.md](archipelago-ideas.md) #3). Encoded in
`NpcDripParser.ts` / `RandomizeDrip.ts`, but the reasoning:

- **This is config mutation, not runtime override** - deliberately does NOT reuse the
  JSON-table-plus-engine-command pattern entrance randomization uses. `model#=` is
  compiled into `npc.dat` at pack-build time (see `NpcConfig.ts`'s
  `parseNpcConfig`/`packNpcConfigs` - `ModelPack.getByName(value)` resolves the config
  text value to an id), there's no runtime hook reading it, and archipelago-ideas.md
  reasoned explicitly that drip is cosmetic/no-gameplay-coupling and doesn't need one.
  Consequence: reseeding needs `npx tsx tools/pack/Build.ts` (~1-2 min), unlike
  entrances. Don't "fix" this into a runtime table without a reason - it was a
  deliberate choice, not an oversight.
- **There is no body-slot system at all - `model#=` is just an unordered list of mesh
  parts to merge, not a struct with a head/torso/legs field.** Verified in the client:
  `NpcType.ts` calls `Model.load()` on every `model#` entry and hands the whole array to
  `Model.combineForAnim()` (`webclient/src/dash3d/Model.ts`), which just concatenates
  every model's points/faces/vertex-labels into one composite mesh in array order - no
  positional meaning anywhere. That's *why* `model2` is a necklace on Duke Horacio but a
  hat on the Cook: there's no schema being violated, because there was never a schema to
  violate. The only real semantic signal in the data is each value's own naming
  convention, `(man|woman)_<part>_<detail>` (e.g. `man_torso_basic`, `woman_hat_witch`).
  Swap pools are keyed by `gender_part` extracted from the *value*, never by the
  `model<N>` field name - and since the tool only ever replaces a value in place (never
  reorders the array), merge/draw order stays byte-identical to vanilla too.
- **Non-conforming model values are the safety net, not an explicit exclude list.**
  Creature-specific models (`npc_troll_head`, `model_2909_npc`, `npc_1095i3`, ...) and
  held-item/weapon overlays (`human_weapons_longsword`, ...) don't match the
  `man_`/`woman_` convention and are left alone automatically - no per-NPC exclusion
  needed to keep monsters and quest-specific NPCs from getting corrupted into nonsense.
  ~563 distinct model values exist across the tree; roughly half don't match the
  convention and are correctly never touched.
- **`content/scripts/_unpack/{225,244,254,274}/all.npc`** (old-cache-revision dumps,
  coordinate-keyed debugnames like `[0_45_48_seabird1]`) turned out to be **live
  content, not dead reference material** - confirmed via `PackFile.ts`'s
  `NpcPack = new PackFile('npc', ..., true)`, which scans `.npc` recursively under
  `scripts/` with no `_unpack` exclusion at the load level (only a structural lint
  rule in `crawlConfigNames` exempts that folder from the "must live in a `configs/`
  folder" check). They're included in the shuffle scan for that reason.
- **Sample from the full cache universe, not just what vanilla NPCs already wear.**
  The first version of this tool deranged *occurrences* (a permutation of the values
  already found across `.npc` files) - the user asked directly whether it was
  randomizing "against a list of all possible wearables," which it wasn't, and the gap
  was real: `content/pack/model.pack` (a static id=name catalog, checked into vanilla
  content, NOT build-generated/gitignored like script.pack/map.pack) has meaningfully
  more valid models per category than vanilla ever assigns to an NPC - e.g. `woman_hat`
  has 23 valid models in the cache but only 8 ever show up on a vanilla NPC, `man_hands`
  7 vs 3. `NpcDripParser.ts`'s `loadModelUniverse()` now parses `model.pack` directly
  (same `SWAPPABLE_RE` convention) to build the real per-category universe, and
  `RandomizeDrip.ts` samples each slot independently from it (resampled up to 50x until
  it differs from the slot's own original value) instead of deranging a fixed list.
  Lesson for future sessions: when a randomizer's pool source is "whatever this repo's
  authors happened to already use" vs. "everything the underlying system actually
  supports," check which one was asked for - they silently produce very different
  amounts of variety, and the narrower one is easy to reach for first because it's
  already sitting there parsed.
- **Per-pool sub-seeding** (`seed ^ hashKey(poolName)`): without it every pool draws
  from the PRNG in lockstep and produces suspiciously-correlated results. Cheap, fully
  reproducible from one `--seed`.
- **`head#=` (chat-portrait bust models) and `recol#s`/`recol#d` (palette color
  swaps) are out of scope for this pass** - deliberate, not an oversight. Recoloring
  in particular is a plausible follow-up (recolors are generic palette-index remaps,
  not model-specific, so they'd very likely still apply cleanly to a swapped model)
  but adds a second axis of chaos that wasn't asked for yet.
- **No verified in-game testing yet** - offline checks only: typecheck, a full
  `tools/pack/Build.ts` run completing without error (confirms every sampled value
  resolves against `model.pack` - trivially true now since `loadModelUniverse()` reads
  its candidate values directly from `model.pack`, so nothing sampled can be an invalid
  name), and a line-diff spot-check against the vanilla backup showing only the
  intended `model#=` lines changed, CRLF intact. Hand off actual visual verification to
  the user (see WSL boot restriction above).
- **Weapons/held items (`human_weapons_*`) need group-level reasoning, not per-slot -
  the body-part pattern above doesn't fit them.** A `.npc` block can carry 0, 1, or 2
  `human_weapons_*` values - counted directly off the vanilla backup: 1232 blocks with
  0, 210 with exactly 1, 55 with exactly 2 (nothing observed above 2). A 2-value block is (almost) always a
  weapon + a shield, never two independent slots, so swapping each value
  independently (the body-part approach) could put a two-handed weapon next to a
  shield - the user asked specifically to avoid this. `parseWeaponGroups()` in
  `NpcDripParser.ts` groups by block instead of flattening to individual slots, and
  `RandomizeDrip.ts` decides per-group: 1-slot blocks draw from the unrestricted pool
  (nothing to clip with), 2-slot blocks identify the shield half by name (`isShieldName`)
  and restrict the other half to the one-handed pool only.
- **Two-handedness is classified by name substring
  (`/bow|staff|halberd|scythe|harpoon/`), validated against vanilla's own
  weapon+shield pairings, not assumed from real-world/RS-lore weapon logic.** Counted
  every vanilla `human_weapons_*` pair via a Python one-off over the backup tree before
  writing any classification code. This caught a real surprise: vanilla pairs
  `warhammer` with a shield twice, and `spear` with `viking_shield` four times - both
  read as two-handed by genre convention (and warhammers legitimately are 2h in real
  OSRS combat), but this is a purely cosmetic model system with its own precedent, and
  vanilla's own precedent should win. Trusting assumption over data here would have
  produced a *more* restrictive (wrong) classification, not a less safe one, but wrong
  either way - the same "check the data, don't assume" lesson as the earlier
  wearables-universe fix.
- **`human_weaponsextra_stafforb`** is a companion piece glued to one specific weapon
  (`staff`/`staffstraight`), not an independent slot - any block containing one is left
  vanilla entirely (5 blocks in vanilla). One more vanilla oddity, `excalibur` +
  `model_526` (1 block), is a two-piece item where *neither* half is shield-named, so
  the weapon/shield role can't be inferred - also left vanilla. Both exclusions were
  found empirically (by enumerating every observed pair) rather than guessed.
- **Verified**: a Python script re-derived every 2-slot group's final (post-swap)
  values from the spoiler and confirmed zero groups end up with both a shield-tagged
  and a two-handed-tagged value present (259/259 reassigned groups clean). Same offline
  caveats as the body-part pools apply - pack build succeeds, no in-game check yet.

## Domain knowledge: shopsanity (shop location randomization)

Built right after weapon shuffling, same day. Encoded in `ShopParser.ts`/
`RandomizeShops.ts`, config-mutation approach like drip (see the file header comment
in `RandomizeShops.ts` for why this deliberately does NOT use the runtime-override
pattern, despite an earlier session's note in this doc suggesting shop-location
randomization should - that note was an aspiration written before drip proved config
mutation is the right call whenever the field being swapped isn't a single scalar and
the reseed-speed win doesn't matter enough to justify the complexity. Treat "build on
the override pattern" as a default to consider, not a hard rule - see the entrance vs.
drip vs. shops split for when each is actually justified).

- **Shop stock lives in `.inv` config files** (e.g. `content/scripts/areas/
  area_alkharid/configs/alkharid.inv`), each holding multiple `[shopname]` blocks
  with `size`/`restock`/`stock1=obj,qty,respawn` etc - same "one file, multiple named
  blocks" shape as `.npc`. An NPC points at one via `param=owned_shop,<name>` (an
  `inv`-typed param, validated against `inv.pack`'s id<->name registry at build time -
  same validation mechanism as `model.pack` for `model#=`). This tool never touches
  `.inv` stock files at all - "stock stays put, access moves" (archipelago-ideas.md
  #4's own framing) falls out naturally from only ever moving the *pointer*.
- **All 117 vanilla `owned_shop` occurrences carry the full 5-param bundle** (`shop_
  sell_multiplier`/`shop_buy_multiplier`/`shop_delta`/`shop_title` alongside
  `owned_shop` itself) - verified by scanning every occurrence before writing any
  shuffle logic, same "check the data first" discipline as the weapon
  classification. This is what makes a clean whole-bundle derangement safe: no
  partial/default-value cases to special-case.
- **Found real hardcoded-shop NPCs by grepping every `~openshop(` call site**, not by
  assuming the param path is universal. `~openshop_activenpc` (reads
  `state.activeNpc.type` params) is the common path (~109 NPCs), but `dommik`/`rommik`
  branch on `map_members` with a **literal** `~openshop(craftingshop2, ...)` /
  `~openshop(craftingshop2_free, ...)` call in their own `opnpc3` handler - their
  `opnpc1` dialogue path DOES read the param (inconsistent even in vanilla), so
  reassigning their param would make talk-to and right-click-Trade show different
  shops. `duel_fadli` and `regicidegeneralshopkeeper` have the same pattern. All 4
  were caught automatically by `loadHardcodedShopIds()` (collects every literal id
  argument to `~openshop(`, excludes any bundle whose current value matches) - a
  manual first-pass inspection of a handful of these files missed 2 of the 4
  (`duel_fadli`, `regicidegeneralshopkeeper` - eyeballing a narrow grep context around
  the debugname isn't reliable; the automated whole-file scan caught what manual
  spot-checking didn't). Lesson: when a "does X read from data or is it hardcoded"
  question matters for correctness, write the check as code and run it over
  everything, don't eyeball a sample.
- **Found and fixed a real cross-tool data-loss bug while designing this**: both
  `RandomizeDrip.ts` and `RandomizeShops.ts` touch the same `.npc` files. The
  original `RandomizeDrip.ts` write step rebuilt each file's full text from the
  *pristine backup* every run (by design, so re-seeding drip alone never compounds) -
  but that means if shops had run first, drip's rewrite-from-backup would silently
  erase the shop edits (and vice versa, whichever tool runs last wins). Fixed by
  splitting the two roles: parse/decide *values* from the backup (unaffected by any
  prior tool run, keeps seeds reproducible), but read the base text to edit from the
  **current live file**, not the backup - safe because line indices are identical
  between backup and live (edits only ever replace a line's value, never add/remove
  lines). `ensureNpcBackup()`/`BACKUP_ROOT`/`findNpcFiles`/`readNpcSource` moved into
  `NpcDripParser.ts` as shared infrastructure so every future `.npc`-config tool
  reuses the same backup + read-live-write-live convention automatically instead of
  re-deriving it (and re-risking the same bug) per tool.
- **Verified**: re-ran drip after shops (and shops after drip) and confirmed via diff
  that both tools' edits coexist in the same file with zero unexpected lines changed
  (only `model#=`/weapon/`param=` lines touched). Seed 777: 113/117 shops reassigned,
  4 excluded (the hardcoded ones above), pack build clean. Not yet verified in-game.

## Domain knowledge: drop randomization

Built after shopsanity, in a later session (2026-07-13, per the addendum below).
Encoded in `DropTableParser.ts`/`RandomizeDrops.ts`, config/script-mutation approach
like drip/shops (see README's "Drop randomization" section for the user-facing
usage/scope). The reasoning that isn't obvious from the code:

- **Two coexisting drop systems exist; only one is actually used.** The dbtable system
  (`content/scripts/drop tables/configs/drop_table.dbtable` + `roll_on_drop_table` proc
  in `shared_droptables.rs2`) looked like the "declarative, trivial to shuffle" path
  archipelago-ideas.md #2 called out, but it's essentially unused - only
  `skill_mining/scripts/mining.rs2` calls it (for gem rocks), no monster in the 73-file
  drop-table corpus does. The REAL loot system, for every monster, is ad-hoc inline
  `if ($random < N) obj_add(npc_coord, item, qty, ^lootdrop_duration) else if (...)`
  cascades, one per `[ai_queue3,name]`/`[label,name]` block. Checked every file before
  writing any parsing code, same discipline as every prior tool.
- **Probability is `weight/total`, never the raw threshold delta - cascades use
  different `random()` denominators.** 128 is overwhelmingly the most common (64 of the
  73 files), but 6, 8, 65, 138, and 512 all occur too (werewolf.rs2 uses
  `random(512)`). A raw weight of 100 means ~78% in a `/128` cascade and ~20% in a
  `/512` one - bucketing by raw weight instead of normalized probability was the first
  design that got caught and fixed by actually reading werewolf.rs2's numbers rather
  than assuming every file shared bandit.rs2's `/128` shape.
- **Branch bodies come in two syntactically different styles, and a third file
  (salarin_the_twisted.rs2) has an unrelated `if(random(6)...)` that must NOT be
  mistaken for a cascade.** Most files brace-delimit each branch
  (`if ($random < N) { obj_add(...); }`), but werewolf.rs2 writes every branch as a
  single brace-less statement (`if ($random < 32) obj_add(...);`). Character-by-character
  brace-depth tracking (the natural first instinct, and what NpcDripParser-style parsers
  don't need since `.npc`/`.obj` configs have no control flow at all) would need two
  separate code paths for these styles and is fragile. The parser instead finds every
  branch header's *text position* via regex and treats the span between consecutive
  headers as that branch's body, scanning for `obj_add(...)` within the span regardless
  of bracketing - this handles braced, brace-less, and nested-conditional bodies (e.g.
  `if (map_members = ^true) {...} else {...}` gating two alternate drops at the same
  weight) uniformly with one code path. Verified against all 73 files via a throwaway
  survey script (1127 slots, 243 distinct items, 63 cascades across 119 blocks) before
  committing to this as the real parser, cross-checked against an independent
  brace-stack-based first attempt that produced identical totals.
- **Editing must be a targeted substring replace within the line, not a whole-line
  replace.** Unlike `.npc`/`.obj` config lines (always bare `key=value`, safe to
  replace wholesale - see NpcDripParser.ts), an `obj_add(...)` call shares its physical
  line with arbitrary surrounding code: `if`/`else if` prefixes, trailing comments, and
  (in werewolf.rs2's brace-less style) the entire branch condition. `DropSlot.raw`
  captures the exact matched `obj_add(npc_coord, item, qty, ^lootdrop_duration)`
  substring at parse time; the edit does `line.replace(slot.raw, newRaw)`, a single
  non-global replace, leaving everything else on the line untouched.
- **Only literal-item, literal-qty `obj_add(...)` calls inside an actual cascade are
  captured - this excludes several categories of drop with no per-file exclusion list
  needed, mirroring the "non-conforming values are the safety net" pattern from drip's
  model-swap scope:**
  - `~procname` calls (`~randomherb`, `~randomjewel`, `~ultrarare_getitem`,
    `~megararetable`, `~randomjunk` in `shared_droptables.rs2`) - out of scope per an
    explicit user scoping decision, left as opaque calls other monsters route through.
  - `npc_param(death_drop)` - always precedes the cascade (never inside a `def_int
    $var = random(...)` span), so it's structurally never mistaken for a weighted slot.
    Handled as its own axis (see below).
  - Non-literal quantities like kalphite_queen's `iron_arrow, add(random(335), 1)` (one
    occurrence in the whole corpus) - the qty regex requires a literal int and simply
    doesn't match, so the line is silently left vanilla rather than guessed at.
  - Anything outside a cascade entirely: rat.rs2's quest-gated `rats_tail` drop,
    jailer.rs2's fixed `obj_add(npc_coord, jail_key, 1, 100)` (note: literal `100` tick
    duration instead of `^lootdrop_duration`, another reason this couldn't be mistaken
    for a cascade slot) - both are guaranteed drops with their own bespoke conditions,
    16 of the 73 files have no cascade at all.
- **Quest-critical-item detection needed a real, data-checked pattern - a first,
  broader attempt pinned 82% of all slots and was caught by looking at the actual
  numbers, not by assumption.** The first version tokenized every identifier appearing
  ANYWHERE in `content/scripts/quests/**/*.rs2` and treated any match against a
  candidate item as quest-critical - this flagged 131 of 243 corpus items (922 of 1127
  slots!) because coins, ores, bars, and basic food are mentioned constantly in quest
  dialogue/rewards without ever gating anything. Reading real usage
  (`content/scripts/quests/quest_imp/scripts/imp_journal.rs2`'s
  `inv_total(inv, black_bead) > 0`) found the actual gating idiom: `inv_total(inv|bank,
  item)` / `inv_del(inv|bank, item)`. Narrowing to that pattern dropped the pinned set
  to 53 items (568 of 1127 slots, since a handful of those 53 - coins chief among them,
  278 corpus occurrences - are extremely common drops) and, just as importantly,
  correctly UN-pinned false positives like `unidentified_rogues_purse` (mentioned in
  two quests, but always via `inv_add` - handed to the player directly through a
  search-box/herb-pick interaction, never gated by an `inv_total` check, so its
  drop-table copy isn't actually load-bearing). Pinned items stay eligible as
  *replacement* values for other slots - only their own original slot is protected,
  since being sampled INTO another slot can only add availability.
- **Rarity buckets (ultra/rare/uncommon/common/verycommon) are corpus-derived
  percentile bands, not arbitrary round numbers** - computed from the actual
  probability distribution of all 1127 slots (roughly 300/550/170/80/30 across
  ≤1%/1-4%/4-10%/10-25%/>25%) via a throwaway survey script before picking the
  boundaries, then spot-checked against familiar drops (coin slots land in
  common/verycommon, rune sets in rare/uncommon, one-off dragon-tier items in ultra) to
  confirm the bands feel right, not just that they're statistically even.
- **`--mode tiered|chaos` is a flag because the user explicitly said they want this to
  be an Archipelago slot option eventually, not a single fixed design.** Asked directly
  which swap strategy to use (preserve-rarity-tier vs. full chaos) and the user
  declined to pick one, saying they'd want it as an AP option - so both are implemented
  behind one flag rather than picking a default and closing the door on the other.
- **No safe "widen to the full catalog" move exists here, unlike drip's `model.pack`
  widening.** Model values self-describe their category via naming convention
  (`man_torso_basic`), so widening drip's pool to everything in `model.pack` was safe.
  Item names have no equivalent convention (`dragonstone` doesn't self-describe
  "monster-loot-appropriate" the way `man_torso_basic` self-describes "torso"), so both
  swap modes sample only from items already observed in the vanilla drop-table corpus -
  the narrower, "check the data" choice this codebase favors when there's no structural
  signal to safely widen with.
- **Quantity: stackable-aware, not blanket-preserved or blanket-reset.** A reassigned
  slot keeps its original quantity only if the new item is stackable (per its `.obj`
  config's `stackable=yes` - the same per-item config convention `owned_shop` uses for
  shops), otherwise forced to 1. Verified this isn't a false signal by manually reading
  a swapped `.rs2` diff line-by-line: a `rune_knife` landing at quantity 9 was initially
  suspected as a bug (assumed knives aren't stackable) until checking the actual `.obj`
  config confirmed rune_knife genuinely has `stackable=yes` in this content set (it's
  thrown ammo, same as darts) - a reminder to verify against the data before concluding
  something is a bug.
- **`death_drop` is a separate, much simpler axis** - a single guaranteed-on-death
  namedobj param (`big_bones`/`dragon_bones`/`ashes`/... - and at least one legitimately
  odd vanilla value, `shellpoint_swamp`, a real registered `obj.pack` entry that turned
  out to be a Mort Myre snail-minigame point token, not a bug) set on ~30 `.npc` files
  scattered across `areas/`/`quests/`/`tutorial/`/minigames. Structurally identical to
  shopsanity's `owned_shop` - a lone pointer field, shuffled via a straight
  `derangement()`. Deliberately excludes `quests/` and `tutorial/` (Tutorial Island
  protected the same way entrance randomization protects it; quest-NPC death drops are
  left alone for the same "don't touch quest logic" caution applied to the main
  cascade, even though none of their actual values were found to be quest-critical
  items themselves). A handful of "fixed points" in the spoiler (`was === now`) are
  expected, not a bug: `derangement()` guarantees no INDEX maps to itself, but two
  different NPCs can and do share the same death_drop VALUE (multiple monsters drop
  `big_bones`), so a genuine index-level reassignment can still show the same value.
- **Verified with the same rigor as prior tools, each check re-derived independently
  rather than trusted from the write path**: typecheck clean, a full `tools/pack/
  Build.ts` run completing without error (confirms every sampled item resolves against
  `obj.pack`), and three scripted checks against the seed-777 spoiler - zero
  quest-critical slots reassigned (re-cross-referenced `loadQuestCriticalItems()`
  against every `dropSwaps` entry's `wasItem`), zero tiered-mode swaps crossing their
  probability bucket (rebuilt each bucket's vanilla item universe independently and
  confirmed every `nowItem` is a member of the bucket recorded on its own spoiler
  entry), and a line-diff spot-check across a brace-delimited file (bandit.rs2) and the
  brace-less file (werewolf.rs2) confirming only the intended item/qty tokens changed,
  CRLF intact, `if`/`else if` prefixes and comments untouched. **Not yet verified
  in-game** - same caveat as every other content-mutation tool in this repo.

## Session-end addendum 5: goals/checks/rewards plan decided (2026-07-13)

The user chose the pre-AP direction; the full work plan lives in
[goals-and-checks.md](goals-and-checks.md) - **read it before building any of
this**. Summary of the decisions:

- **Goals:** Barcrawl, Dragon Slayer, KBD kill. All three's tracking mechanisms
  are verified in that doc (barcrawl bitfield, `%dragonquest`, a new varp set in
  the KBD death script after `npc_findhero`).
- **Quest completions are checks**, firing a random **level-based reward**
  (runes/ranged/arrows/weapons/armour/cash/potions/food, tiered by the relevant
  stat) - single choke point `send_quest_complete` in `general/scripts/quests.rs2`,
  called by all ~64 quests. This reward roll is the future AP junk/filler handler.
- **Approved randomizers:** groundsanity (jm2 `==== OBJ ====` remap, runtime
  loader hook preferred), random respawn/home point (constrained to the 7 vanilla
  spellbook teleport coords; hits `death.rs2:32` + `::home`), teleport
  destination shuffle (derange the 7 `tele_coord` dbrow values).
- **Rejected by the user - do not build:** shop stock shuffle, NPC recolors,
  NPC spawn shuffle.
- **Every feature must ship with a test command.** Production mode blocks
  debugprocs (`ClientCheatHandler.ts` gates on `!production && staffModLevel >= 4`),
  so the plan is one ungated `ap*`-prefix dispatcher in the overlaid handler that
  runs `[debugproc,ap_<name>]` content scripts; all test commands then live in
  content. Build this dispatcher first.

## Where this is heading (agreed with the user)

Priority order discussed:
1. ~~Entrance randomization~~ (done: connector + floor-shift pools, incl. generic
   building ladders, --mixed flag)
2. ~~Any-source placements via a `.jm2` LOC scanner~~ (done for
   trapdoor/cellar-ladder types; more surface loc types remain - see unpaired
   scanned placements in the spoiler)
3. ~~NPC cosmetic ("drip") shuffle~~ (done: `model#=`/weapons shuffled by
   gender+body-part pool and shield-safe weapon pool, config-mutation approach per
   archipelago-ideas.md #3, not yet played), ~~shop-location shuffle~~ (done:
   whole-bundle derangement across shopkeepers, config-mutation approach per
   archipelago-ideas.md #4, not yet played - see the shopsanity domain-knowledge
   section above for why this also skipped the runtime-override pattern), and
   ~~drop randomization~~ (done: weighted loot-slot item reassignment + death_drop
   shuffle, config/script-mutation approach per archipelago-ideas.md #2, not yet
   played - see the "Domain knowledge: drop randomization" section below).
4. Actual Archipelago protocol integration (AP world Python package, item/location
   handling, `xpRate`/`NODE_XPRATE` as a slot option, junk rewards straight to bank
   via `inv_add(bank, ...)`)

## Session-end state (2026-07-13)

- Everything through commit `4d16341` is installed into the user's Server checkout
  and pack-rebuilt. Current table: seed 777, **719 overrides** (48 connector gates
  incl. 39 map-scanned, 309 floor-shift gates incl. 202 map-scanned generic
  ladders, 5 one-ways), coord+op keys.
- Generic building ladders (Lumbridge castle walls etc.) were the last
  user-reported gap: their handlers use a relative "same tile, plane +/-1" rule,
  so they're map-scanned like the cellars and paired vertically (up-edge at plane
  p with down-edge at p+1, radius 3; laddermiddle contributes op2-up/op3-down
  edges). Scan exclusion uses ALL parsed literal source coords - not just shuffle
  candidates - so special-cased ladders (quest-gated dwarf trapdoor, black
  knights aggro ladder, Zanaris) can never be scanned-shuffled past their
  scripted behavior.
- **Verified in-game by the user**: the original 23-override cross-map shuffle
  (server logged `loaded 23 redirect(s)`, entrances redirected). Everything after
  that - the floor-shift pool, scanned cellar gates (incl. cook's basement), the
  walkability nudge, and especially the coord+op keying - is verified only by the
  offline checks (typecheck, pack build, loader unit test 719/719, machine
  round-trips 357/357), **not yet by playing**.
- **Highest-risk untested piece**: the patched `stair_options`/`ladder_options`
  menu labels assume `loc_coord` stays valid after an `@jump` within the same
  script run. If a middle-landing *menu* errors or acts vanilla while right-click
  Climb-up/Climb-down shuffle correctly, that assumption is wrong - rework by
  passing the coord into the label as a parameter instead.
- Second-risk untested piece: scanned-gate arrivals land on the far ladder's own
  tile and rely on the engine-side walkability nudge; watch for players stuck in
  walls at cellar destinations.
- The user's local `world.json` has `web.port: 8080` (changed from 80 for WSL; file
  is gitignored so this won't propagate anywhere).
- Old artifacts that may still exist and are safe to delete:
  `engine/tools/map/entrance-seed.json` (legacy spoiler), `engine/tools/map/
  entrances.json` (export tool output, regenerate at will).
- Future sessions should be started in this repo (CLAUDE.md is auto-loaded;
  `.claude/settings.json` pre-authorizes `../Server`). The old agent memory keyed
  to the Server/ directory is superseded by these docs.

## Session-end addendum: NPC drip randomization (2026-07-13, later same day)

Built entirely independently of the entrance-ladder work above (different files, no
overlap) - see the "Domain knowledge: NPC drip randomization" section for the design
reasoning.

- New files: `overlays/engine/tools/npc/{NpcDripParser,RandomizeDrip}.ts`,
  `overlays/engine/tools/shared/Prng.ts` (mulberry32/shuffle/derangement factored out
  of `RandomizeEntrances.ts` so both tools share the exact same tested shuffle code -
  `RandomizeEntrances.ts` now imports from it instead of defining its own copies).
  README.md has a new "NPC drip randomization" section with usage.
- Installed, typechecked (`npx tsc --noEmit -p .` clean), and run end-to-end: seed 777
  produced 21 gender+body-part pools, 4193 model swaps across 113 of the 138 `.npc`
  files in the tree, `content/.ap-backup/scripts/` now also holds pristine `.npc`
  backups (138 files, same backup root the entrance scripts already used - just a
  different subtree). `npx tsx tools/pack/Build.ts` completed clean afterward
  (confirms every swapped value resolved against `model.pack`).
- **Verified**: typecheck, pack build success, line-diff spot check (only `model#=`
  lines changed, CRLF intact, category-correct swaps e.g. torso->torso). **Not yet
  verified**: nothing in-game. The user needs to boot the (already pack-rebuilt)
  Windows server and eyeball a few NPCs (bank in Lumbridge is an easy one - `banker1`
  changed jaw/arms/torsoextra in the seed-777 run above) before trusting this beyond
  "it compiles."
- **Known open risk, called out in both README and the domain-knowledge section
  above**: no exclude list exists yet for NPCs whose vanilla appearance might be
  load-bearing for quest recognition/disguises. `--exclude <substr,...>` is wired up
  and works, but nothing is populated into it by default - future session should
  either audit quest scripts for appearance-dependent checks, or wait for the user to
  report a broken quest and pin that NPC reactively.
- The live Server checkout currently has the seed-777 drip shuffle applied and
  pack-built (on top of the seed-777 entrance shuffle from the earlier session) - both
  randomizers' outputs currently coexist in the same running-ready state.

## Session-end addendum 2: drip pool widened to the full model.pack universe (2026-07-13)

The user asked "are you randomizing against a list of all possible wearables?" - the
honest answer was no (see the domain-knowledge section's "Sample from the full cache
universe" bullet for the full reasoning and numbers), and they asked for it to be
fixed. `RandomizeDrip.ts` no longer deranges occurrences; it samples each `model#`
slot independently from `NpcDripParser.ts`'s new `loadModelUniverse()` (parses
`content/pack/model.pack` directly). `derangement()` is no longer used by drip at all
(still used by `RandomizeEntrances.ts` - only removed the import in `RandomizeDrip.ts`).

- Re-ran seed 777 end-to-end after the change: 21 pools, **5520** model swaps (up from
  4193 - every eligible slot changes now, since resampling from a bigger pool almost
  never lands on the original value on the first draw, and the tool retries up to 50x
  when it does). Universe sizes per pool now logged in the spoiler
  (`engine/tools/npc/drip-seed.json`) alongside occurrence counts, e.g. `man_hat`:
  25 available / 111 occurrences / 111 changed.
- Re-typechecked (clean) and re-ran a full `tools/pack/Build.ts` (clean, ~1:24) -
  confirms every sampled value resolves, which is now closer to a tautology than a
  test (`loadModelUniverse()` sources candidates straight from `model.pack`'s own
  entries), but still confirms the parsing/regex logic didn't drift.
- Spot-checked `banker1`/`banker2`/`banker3` diffs against the vanilla backup again:
  every `model#=` line for these blocks changed this time (previously derangement left
  some unchanged when a slot happened to keep its own value in the permutation), values
  now include combinations no vanilla NPC wears (`man_hands_hook`,
  `man_feet_climbingboots_crampons`, `woman_hands_dragon_vambrace`).
- Same caveats as addendum 1 still apply: no in-game testing yet, no disguise/quest
  exclude list populated by default.

## Session-end addendum 3: weapon/held-item shuffling, shield-safe (2026-07-13)

The user asked for NPC weapons to be randomized too ("would be funny"), with one
explicit constraint: two-handed weapons must never end up paired with a shield. See
the "Weapons/held items need group-level reasoning" bullets in the domain-knowledge
section above for the full design and the empirical process (counted every vanilla
weapon+shield pairing before writing any classification logic, which caught real
surprises like `warhammer`+shield and `spear`+`viking_shield` both existing in
vanilla despite reading as two-handed).

- New exports in `NpcDripParser.ts`: `WeaponSlot`, `WeaponGroup`, `parseWeaponGroups()`,
  `isShieldName()`, `isTwoHandedName()`, `loadWeaponUniverse()`. `RandomizeDrip.ts`
  gained a second, group-aware assignment pass alongside the existing per-slot body-part
  pass, merged into one write per file so both land in the same pack rebuild. New
  `--no-weapons` flag to disable just this part.
- Re-ran seed 777: 259/265 weapon-bearing blocks reassigned (6 left vanilla - 5
  staff-orb companion pieces, 1 the excalibur/model_526 two-piece item). Universe:
  9 shields, 15 two-handed, 84 one-handed values in `model.pack`.
- **Verified the actual constraint, not just that it compiles**: wrote a one-off
  Python check over the spoiler that reconstructs every 2-slot group's final values
  and confirms none contain both a shield-tagged and two-handed-tagged value - 0
  violations across all 259 reassigned groups. This is the load-bearing check for this
  feature; typecheck and pack-build-succeeds are necessary but not sufficient (they'd
  pass even if every guard ended up holding a longbow and a kiteshield at once).
  Re-verify this same way after any future change to `isTwoHandedName`/`isShieldName`
  or the group-assignment logic.
- Same caveats as addenda 1-2: no in-game testing yet (so no confirmation the "one
  weapon + one shield" pairing actually looks right rendered, only that the data-level
  constraint holds), no disguise/quest exclude list populated by default.

## Session-end addendum 4: shopsanity (2026-07-13)

User asked to add shopsanity next. See the "Domain knowledge: shopsanity" section
above for the full design - the two things most worth a future session knowing:

1. **A real bug was caught and fixed while building this**: `RandomizeDrip.ts` used
   to rebuild each `.npc` file from the pristine backup on every run, which would have
   silently erased `RandomizeShops.ts`'s edits (or vice versa) whenever both tools
   touch the same file. Fixed by making every `.npc`-config tool parse values from the
   backup but write onto the current live file. If a future tool is added that also
   edits `.npc` files, use `ensureNpcBackup()`/`BACKUP_ROOT`/`findNpcFiles()` from
   `NpcDripParser.ts` rather than reinventing backup/write logic - that's exactly the
   mistake this bug came from.
2. **4 shopkeepers are permanently excluded** because their shop is hardcoded in
   script rather than read from their `.npc` param: `dommik`, `rommik`,
   `duel_fadli`, `regicidegeneralshopkeeper`. Found by grepping every `~openshop(`
   call site across all scripts, not by inspecting a sample - a manual first pass at
   a handful of files only caught 2 of the 4.

New files: `overlays/engine/tools/npc/{ShopParser,RandomizeShops}.ts`. Modified:
`NpcDripParser.ts` (added `BACKUP_ROOT`/`ensureNpcBackup()`), `RandomizeDrip.ts`
(uses the shared backup helper, write-from-live fix). README.md has a new
"Shopsanity" section.

- Re-ran seed 777: 113/117 shops reassigned (4 excluded as above), pack build clean.
  Cross-tool composition verified: ran drip (seed 555) after shops (seed 777) and
  confirmed via diff that both tools' edits survive in the same files with zero
  unexpected lines touched.
- The live Server checkout currently has: drip seed 555 (outfits + weapons) + shops
  seed 777 (shop reassignments) + entrance seed 777 (from the first session), all
  coexisting, all pack-built. Seeds are independent per tool/run right now - there's
  no single "one seed drives everything" entry point yet; that's natural follow-up
  work once actual AP integration needs one.
- Not yet verified in-game. User said they'll test when they get a chance and may
  have feedback later - don't assume the current design choices (whole-bundle
  derangement as default, `--mismatched-titles` as the opt-in chaos variant) are
  final until then.

## Session-end addendum 5: drop randomization (2026-07-13, later session)

User asked to work on NPC drop randomization next (archipelago-ideas.md #2, the last
remaining item from the original six-idea brainstorm). Unlike drip/shops, this one has
real gameplay-balance stakes rather than being purely cosmetic, so it started with
`AskUserQuestion` rather than diving straight to implementation - see the "Domain
knowledge: drop randomization" section above for the full design reasoning, including
two real course-corrections found by checking real data (the `random()` denominator
normalization bug caught by reading werewolf.rs2, and the quest-critical-item
over-pinning bug caught by comparing pinned-slot counts before/after narrowing the
detection pattern).

- User's answers to the upfront questions: scope = monster drop-table corpus (73
  files) + `death_drop` param, explicitly NOT the shared reward sub-tables or
  quest/area inline drops; swap strategy = user declined to pick one, said they'd want
  it as an Archipelago slot option - so both `tiered` (rarity-band-preserving, default)
  and `chaos` (full corpus-wide sampling) modes are implemented behind `--mode`.
- New files: `overlays/engine/tools/drops/{DropTableParser,RandomizeDrops}.ts`. No
  existing files modified - reuses `BACKUP_ROOT`/`SCRIPTS_ROOT`/`ensureNpcBackup()`/
  `findNpcFiles()`/`readNpcSource()` from `NpcDripParser.ts` directly for the
  `death_drop` .npc-side pass, and gets its own `ensureDropScriptBackup()` for the
  `.rs2` side (different file extension/subtree, same backup-root convention). README.md
  has a new "Drop randomization" section.
- Installed, typechecked (clean), and run end-to-end: seed 777, tiered mode - 559 of
  1127 drop slots reassigned across 54 files (568 pinned: 53 quest-critical items'
  original slots + 0 via `--exclude` in this run), 84 of ~94 eligible `death_drop`
  params reassigned across 11 files. `npx tsx tools/pack/Build.ts` completed clean
  (~1:20) afterward, confirming every sampled item/death_drop value resolves against
  `obj.pack`.
- **Verified** (all re-derived independently from the spoiler + a fresh parse, not just
  trusted from the write path): 0 quest-critical slots reassigned away, 0 tiered-mode
  swaps landed outside their recorded probability bucket, 0 no-op "swaps" (every
  spoiler entry actually changed something), every swapped-in item traced back to the
  vanilla corpus. Line-diff spot-checked `bandit.rs2` (brace-delimited style) and
  `werewolf.rs2` (brace-less style) - only the intended item/qty tokens changed, CRLF
  intact, surrounding `if`/`else if` code and comments untouched in both styles.
- The esbuild win32/linux ping-pong (see the Environment gotchas section) recurred this
  session; the documented fix's second half (`npm install --no-save --force
  @esbuild/win32-x64`) hit an `ENOTEMPTY` error mid-run, but the plain `npm install`
  half alone was sufficient to unblock `tsx` from WSL - didn't chase the win32
  reinstall further since nothing in this session needed to run from Windows.
- **Not yet verified in-game** - same caveat as every other content-mutation tool in
  this repo. The live Server checkout currently has seed-777 drop randomization
  (tiered mode) layered on top of the drip seed 555 + shops seed 777 + entrance seed
  777 state from prior sessions, all coexisting, all pack-built.
- **Known open risk, not yet mitigated**: the `inv_total`/`inv_del`-argument pattern
  for quest-critical detection is a real improvement over "any mention" but is still a
  heuristic, not a proof - a quest could theoretically gate on an item through some
  other check shape (a `switch` on the item, a custom proc, a param comparison) that
  wouldn't match `inv_total(inv|bank, item)` literally. If a future session or the user
  finds a quest broken by a missing drop-table item, that's the first place to look,
  and the fix is either widening the regex or adding the specific item to `--exclude`.

## Session-end addendum 6: two real bugs found via actual in-game testing (2026-07-13)

The user finally booted the (pack-built) Windows server against seed-777 drip + seed-777
drops and played against it - the first real in-game verification any content-mutation
tool in this repo has had. It immediately surfaced two genuine bugs neither offline
check (typecheck, pack build, spoiler-vs-corpus cross-checks) had caught, because both
were about *visual/runtime correctness*, not data validity.

**Bug 1 - drip's torso/arms/legs pools had no cross-category awareness.** The user
reported an NPC with `model3=man_torso_chainmail`/`model4=man_arms_platemail` rendering
with "no torso and a floating platebody, almost like it's in the backpack slot." First
instinct was to suspect array-order-dependent rendering - re-checked
`webclient/src/dash3d/Model.ts`'s `combineForAnim()` and `NpcType.ts` directly rather
than trust the earlier "no positional meaning" claim blindly, and confirmed it still
holds (pure unordered vertex/face concatenation, no hiding logic). The real cause: torso/
arms/legs pieces are sculpted as matched pairs per armor "set", and drip's pools were
category-only (`man_torso`, `man_arms`) with no notion of this. Counted every vanilla
torso<->arms pairing before writing any fix (same discipline as the original weapon/
shield check): every one of 34 vanilla `man_arms_platemail` occurrences pairs with a
plate-family torso, zero with a generic one; `man_torso_chainmail` never once pairs with
platemail arms in 17 occurrences. torso<->legs showed the same pattern (weaker, ~78%,
still enforced fully rather than reproducing vanilla's own inconsistency); feet/hands
were checked too and do NOT need this (boots/gloves/basic dominate regardless of torso
material in vanilla - the only "set" variant there, `split_bark_armour`, is a single
vanilla occurrence).
  - Fix: `bodySetFor()` in `NpcDripParser.ts` classifies a torso/arms/legs value as
    `platemail`/`plaguesuit`/`split_bark_armour`/`null` (generic) by detail substring
    (`platemail`, `paladin`, `armouredskirt`, anything containing `forplate` -> the
    "platemail" family; the "forplate" arms variants are a self-documenting naming
    signal, confirmed against real pairings, not guessed). `RandomizeDrip.ts` groups
    each NPC's torso/arms/legs slots by `(file, block)`, picks the group's target set
    from whatever it already is in vanilla, and reassigns every slot in the group from
    ONLY that set's sub-pool (or the generic sub-pool if the group has no protected set)
    - so a shuffle can never CREATE a mismatched pairing that didn't exist before, even
    though it freely reassigns WITHIN a set (chainmail torso can become any other
    generic torso; platemail arms can become any other plate-family arms).
  - Verified: re-ran seed 555, 703 groups reassigned set-aware, 2118 slots changed, 122
    left vanilla (target set had <2 candidates - small pools like plaguesuit/
    split_bark_armour). Rebuilt a re-derivation check straight from the spoiler:
    grouped every torso/arms/legs swap by (file,block) again and confirmed zero groups
    contain more than one distinct non-null `bodySetFor()` result post-shuffle (0/702
    violations) - this is the load-bearing check, same pattern as the original weapon
    shield-safety verification.

**Bug 2 - reseeding drop randomization silently failed to write changes.** User reseeded
drops from `--mode tiered` to `--mode chaos` (same seed 777) and reported the in-game
drops looked unchanged. The spoiler proved the chaos-mode logic HAD computed genuinely
different values (`brass_necklace -> rune_knife`, not the tiered run's `brass_necklace
-> black_mace`) - so the bug was specifically in the WRITE step, not the decision logic.
Root cause: the edit searched the live line for `slot.raw`, the EXACT VANILLA TEXT
captured when parsing the pristine backup, and replaced that substring with the new
value. On the very first run (live file fresh from `node scripts/install.js`, identical
to the backup) this matches fine. On any SUBSEQUENT run, the live line already contains
the PREVIOUS run's shuffled text, so searching for the stale vanilla substring finds
nothing and `.replace()` silently no-ops - the file is never actually rewritten, even
though the spoiler (and every offline check derived from it) shows the "correct" new
value. This is a different, narrower bug than the compounding-drift problem the
existing backup-then-write-live convention already solves (see the shopsanity
domain-knowledge section) - the VALUE decision was correctly re-derived from backup
every time (no drift), only the mechanical act of locating text-to-replace on an
already-modified line was broken. `.npc`-config tools (drip/shops) don't have this
class of bug because their edits replace a line wholesale BY INDEX, which doesn't care
what the line currently contains.
  - Fix: `findObjAddCall()` in `DropTableParser.ts` finds whatever `obj_add(npc_coord,
    ITEM, QTY, ^lootdrop_duration)` text is CURRENTLY on a line (vanilla or
    already-shuffled) via a plain (non-DropSlot-tied) regex match, and `RandomizeDrops.ts`
    replaces that instead of `slot.raw`. Any future `.rs2`-editing tool that does
    targeted substring replacement (rather than whole-line replacement) needs the same
    "find current text at edit time, don't reuse text captured at parse time from the
    backup" discipline - `slot.raw` is still useful for other purposes (it's what parse
    time actually saw) but must never be used as the substring to search-and-replace
    against a potentially-already-edited live file.
  - The live corpus was left in a genuinely inconsistent state by this bug (each
    previously-touched line stuck holding the FIRST run's value even after later reseeds
    claimed to change it) - fixed by restoring `content/scripts/drop tables/scripts/`
    from the pristine `content/.ap-backup/scripts/drop tables/scripts/` backup before
    re-running, rather than trying to patch forward from an inconsistent state.
  - Verified: re-ran seed 777 chaos mode after the fix, then wrote a whole-corpus check
    (not just one sample file) confirming all 559 spoiler `dropSwaps` entries are
    actually present in their live files (0/559 mismatches), plus re-ran the
    quest-critical-pinning/no-op/universe-membership checks from addendum 5 (all still
    0 violations). Also re-verified at the compiled-bytecode level (see below) that the
    correct chaos-mode values, not the stale tiered-mode ones, are what's actually
    loaded by the running server.

## Session-end addendum: test-command dispatcher + goals (2026-07-14)

Built the first two items of goals-and-checks.md's suggested build order: the
ungated `ap`-prefix test-command dispatcher, and Feature 1 (goals system: `::apgoals`,
`::apkbd`). See that doc for the design; the reasoning not obvious from the code:

- **The dispatcher is a second, parallel mechanism to the vanilla `~`-prefixed
  debugproc dispatch, not a modification of it** - `ClientCheatHandler.ts` now has
  `cmd.startsWith('ap')` as a new `else if` branch alongside the existing `::home`
  block, both unconditional (no `Environment.node.production`/`staffModLevel` gate).
  It looks up `[debugproc,ap_<rest of cmd>]` (`::apgoals` -> `ap_goals`) and reuses
  the vanilla debugproc's argument-parsing loop, which was extracted into a shared
  `private static buildDebugProcParams()` so both dispatch paths build script params
  identically. Adding a new test command from here on is content-only: a new
  `[debugproc,ap_<name>]` block in `overlays/content/scripts/ap/ap.rs2` (or its own
  file under `overlays/content/scripts/ap/`), no engine touch, no reinstall of
  anything but content.
- **Writing a player varp from inside an NPC's `ai_queue3` death script needs a
  specific protected-access dance, and the compiler enforces it statically, not at
  runtime.** Adding `%ap_kbd_killed = 1;` right after the `npc_findhero = ^false`
  check (as goals-and-checks.md's Feature-1 section literally suggested) failed
  `tools/pack/Build.ts` with `Attempt to access uninitialized pointer
  ['p_active_player']` - a compile-time static pointer-flow check performed by the
  `@lostcityrs/runescript` compiler package (grepped `node_modules` for the message
  text since it doesn't appear anywhere in this repo or `engine/src`). Root cause,
  traced through `ScriptOpcodePointers.ts`: `npc_findhero` only sets the *unprotected*
  `active_player` pointer (enough for `mes(...)`, which only `require`s
  `active_player`), but writing any `%varp` requires the *protected* `p_active_player`
  pointer, which only `p_finduid(uid)` sets (`uid` itself requires `active_player`,
  which is why the sequence npc_findhero -> uid -> p_finduid works). This is exactly
  the same problem every other vanilla boss/hero-kill script with a varp-writing
  reward already solves - once grepped for, the precedent was everywhere
  (`khazard_ogre.rs2`, `kolodion_fight.rs2`, `count_draynor.rs2`, `alomone.rs2`,
  `witches_experiement.rs2`, etc.), all following the identical shape:
  ```
  if (npc_findhero = ^true) {
      if_close;
      if (p_finduid(uid) = true) {
          // varp writes / mes / whatever needs protected access, here or via @jump
      } else {
          queue(some_queue_label, 0, 0); // player was busy; retry once they're free
      }
  }
  ```
  `if_close` closes the hero's current modal first so `p_finduid` can actually claim
  protected access; the `queue(...)` fallback re-enters via a `[queue,...]` trigger,
  which (per `Player.ts`'s `processQueue()` - `ScriptRunner.init(request.script,
  this, null, ...)`) always runs with the player as direct `self`, i.e. always has
  full protected access already, no `p_finduid` needed inside the queue block itself.
  `king_black_dragon.rs2`'s `ai_queue3` handler now follows this exact shape, with a
  new `[queue,ap_kbd_mark_killed]` trigger as the busy-player fallback. **This will
  recur for Feature 2** (the quest-completion reward roll's `inv_add`/bank-fallback
  logic likely needs protected access too, though `send_quest_complete` already runs
  in normal player-script context so it may not need the npc_findhero dance at all -
  check `general/scripts/quests.rs2:15`'s calling context before assuming either way).
- **`bitcount(int)` exists as a script command (`ScriptOpcode.BITCOUNT` in
  `ScriptOpcode.ts`, handler in `NumberOps.ts`) but had zero usages anywhere in vanilla
  content** - confirmed compiles and runs via the decompiled-bytecode check (see
  below) before trusting it for `::apgoals`'s barcrawl bar-count
  (`bitcount(getbit_range(%barcrawl, 3, 12))`).
- New files: `overlays/content/scripts/ap/configs/ap.varp` (`ap_kbd_killed`, scope
  perm, registered as varp id 359 - confirmed via `content/pack/varp.pack`). Modified:
  `overlays/content/scripts/ap/ap.rs2` (added `ap_goals`/`ap_kbd` debugprocs),
  `overlays/engine/src/network/game/client/handler/ClientCheatHandler.ts` (dispatcher
  + shared param-builder), `overlays/content/scripts/areas/area_wilderness/scripts/
  king_black_dragon.rs2` (whole-file overlay, CRLF-preserved, diffed clean against
  vanilla except the added lines - only the death-hook lines changed).
- **Verified**: typecheck clean, `tools/pack/Build.ts` clean (~1:19), both new
  debugprocs resolve via `ScriptProvider.getByName()` in a no-boot script check
  (`[debugproc,ap_goals]` compiled to 43 opcodes), new varp registered at id 359.
  **Not yet verified in-game** - same caveat as every other feature in this repo;
  the user needs to boot the Windows server and try `::apgoals`/`::apkbd`/`::home`
  (regression-check the unrelated `::home` block still works) themselves.
- Barcrawl/Dragon Slayer tracking needed no new plumbing (confirmed the doc's claim
  that vanilla already tracks both) - only KBD needed the new varp + hook.

## Session-end addendum: quest-completion reward system, Feature 2 (2026-07-14, same session continued)

Built item 2 of goals-and-checks.md's suggested build order: the quest-completion
check hook + level-based random reward system. New test commands `::apreward
[category] [level]` and `::apquestcheck`.

- **Every one of the 64 `~send_quest_complete(...)` call sites runs from a
  `[queue,...]` trigger** - verified by scanning all 64 files with an awk one-liner
  that prints the nearest preceding `[...]` block header for each call site, not by
  spot-checking a few. This matters because `Player.ts`'s `processQueue()` calls
  `executeScript(script, protect=true)` for queue triggers specifically (confirmed by
  reading `runScript()`: `protect=true` adds the `ProtectedActivePlayer` script
  pointer) - so `send_quest_complete`, and anything it calls, already has protected
  access (bank writes, varp writes) with NO `p_finduid` dance needed. This is a
  different, simpler situation than the KBD kill hook from Feature 1 (an
  `ai_queue3` NPC-death script, executed unprotected by default) - don't assume the
  KBD pattern is universally required; check what trigger type actually calls the
  hook point first.
- **`inv` (main inventory) and `bank` have opposite protection defaults** -
  `InvType.protect` defaults to `true`; `player.inv` config explicitly sets
  `protect=no`, `bank`'s config has no override so it stays protected. Consequence:
  `inv_add(inv, ...)` never needs protected access, but `inv_add(bank, ...)` always
  does. The reward delivery proc (`ap_deliver_reward` in the new
  `overlays/content/scripts/ap/ap_rewards.rs2`) picks inventory-first with a bank
  fallback on a full inventory (`inv_freespace(inv) > 0 | inv_total(inv, $item) > 0`),
  so only the fallback branch needs protection - callers without it already (the two
  new debugprocs) do the same `if_close`/`p_finduid`/`queue` dance as the KBD fix.
  `queue*(label, delay)(args...)` (not plain `queue`, which only carries a single int
  arg per its `(queue, int, int)` signature) is the syntax for passing typed args
  through a queue retry - confirmed against `[queue,crafting_glass](namedobj $item,
  string $name, ...)` and its `weakqueue*(crafting_glass, ...)($glass_item, $name,
  ...)` call site.
- **Reward data is a dbtable** (`ap_rewards.dbtable` + `.dbrow`, 94 rows across 8
  categories: armour/weapons/ranged_gear/arrows/runes/potions/food/cash), one row
  per (category, item, min_level) option rather than a LIST-column-per-tier design -
  simpler, and `db_find(ap_rewards:category, $category)` + `db_findnext` already
  gives one-row-at-a-time iteration so no need for the LIST/tuple-index machinery
  `drop_table.dbtable` uses. Real OSRS-era level requirements were used for
  `min_level` (bronze=1, steel=10, mithril=20, adamant=30, rune=40, dragon=60 for
  armour/weapons) rather than made-up brackets - this wasn't just aesthetic, the
  user's own example in the plan ("40 Defence → rune armour") is literally rune's
  real OSRS defence requirement, so matching real tiers was the safer reading of
  intent. Item names were verified against `content/pack/obj.pack` (a checked-in
  id=name text registry, same mechanism as `model.pack`) before writing any dbrow,
  catching one real gap: this content set has no `4dose1strength` potion (every
  other `4dose1<stat>` exists) - used `3dose1strength` instead rather than guessing.
- **Weighted-toward-the-top tier selection needed a single-pass algorithm, not an
  array sort** - this rs2 dialect has no arrays/dynamic collections (confirmed
  again this session; the only iteration-with-state primitives are counters and
  dbrow cursors). Used weighted reservoir sampling (the "A-Chao" algorithm): iterate
  eligible rows once, accumulate `total_weight`, and after each row keep it as the
  selection with probability `weight/total_weight` (`if (random($total_weight) <
  $weight)`), weighting by `min_level + 1` so higher tiers dominate among a player's
  eligible set without ever discarding lower tiers entirely. **Verified with a
  Python re-simulation of the exact same algorithm against the real armour tier
  data** (20000 trials per level): level 1 only ever produces bronze/iron (the only
  eligible tier), level 10 correctly favors steel/black over bronze/iron once they
  unlock, level 40 and 99 both correctly skew hard toward rune (~35% each of the 3
  rune pieces) over adamant (~26% each) - confirms the bias direction and that nothing
  outside the eligible min_level window ever gets selected.
- **Found and worked around a real, pre-existing race condition in the vanilla
  build tooling's "should I even bother rebuilding" staleness check** - not
  something this session introduced, but very likely to bite any future session
  that adds a brand-new-*named* dbtable/dbrow/enum/inv/mesanim/struct/seq/loc/
  npc/obj/idk/varp/varbit/spotanim entry (anything going through `PackFile.ts`'s
  `validateConfigPack`). Symptom: `tools/pack/Build.ts` failed with `Invalid
  property value: table=ap_rewards` from `DbRowConfig.ts` even though the new
  `ap_rewards.dbtable` file was correctly formed and `crawlConfigNames('.dbtable')`
  (the actual, reliable, synchronous crawl used once revalidation is triggered)
  found it fine in isolation. Root cause, found by direct instrumentation (not
  guessed): `validateConfigPack` first calls `shouldRevalidatePackFile`, which
  decides whether to re-crawl at all by comparing `content/pack/dbtable.pack`'s own
  mtime against the latest `.dbtable` file mtime *as computed by
  `SourceSnapshot.ts`'s async parallel directory walk* - and that walk is racy on
  this WSL-on-`/mnt/c` setup: instrumenting it directly (dumping its internal
  `latest` map after a real scan) showed it repeatedly reported a DIFFERENT,
  LOWER-than-actual max mtime across three consecutive runs, meaning some
  `fs.readdir` calls in its unbounded `Promise.all(entries.map(...))` recursion are
  silently failing (the `walk()` function's `catch { return; }` swallows any
  readdir error with no logging) under the concurrency this creates against a 9P/
  DrvFs-backed mount. This is DIFFERENT from `getLatestModified()`/`shouldBuild()`
  (used for the actual `.dat`/`.idx` rebuild-needed checks) and from
  `crawlConfigNames()`/`loadDirExtFull()` (used for the actual crawl once it runs) -
  both of those use a synchronous `listFilesExt`-based walk and are NOT racy; only
  the `SourceSnapshot`-gated "should I re-crawl the id registry at all" pre-check is
  affected. **Workaround, not a real fix**: delete the stale registry text file(s)
  (here, `content/pack/dbtable.pack` and `content/pack/dbrow.pack`) before
  rebuilding - `validateConfigPack`'s `if (!fileExists(packFile)) return true;`
  early-out forces the reliable crawl path unconditionally, regenerating the
  registry (with fresh, possibly renumbered ids - harmless, since the compiled
  `.dat`/`.idx` and all `.rs2` references get rebuilt fresh in the same pass, so
  nothing else references the old numbers) from scratch. Left the vanilla tooling
  itself unfixed (out of scope for an overlay repo, and it's an existing-upstream
  bug, not something this repo introduced) - if this recurs, the fix is the same
  delete-and-rebuild, or add a comment to whoever maintains upstream LostCityRS.
- New files: `overlays/content/scripts/ap/ap_rewards.rs2` (roll/delivery logic +
  both debugprocs), `overlays/content/scripts/ap/configs/ap_rewards.{dbtable,dbrow}`
  (94 reward rows). Modified: `overlays/content/scripts/general/scripts/quests.rs2`
  (whole-file overlay, one line added: `~ap_quest_complete;` at the very end of
  `[proc,send_quest_complete]`, right after the vanilla "Congratulations!" mes -
  diffed clean against vanilla, CRLF intact).
- **Verified**: typecheck clean, pack build clean (~1:30, after the dbtable/dbrow
  registry workaround above), all new scripts resolve via `ScriptProvider.getByName`
  in a no-boot check (`[debugproc,ap_reward]` compiled with 2 correctly-typed
  params, `[proc,send_quest_complete]` compiled successfully referencing
  `~ap_quest_complete` with no undefined-proc error, which would have hard-failed
  compilation if the hook wire-up were wrong), reward-roll algorithm
  cross-verified via independent Python simulation (above). **Not yet verified
  in-game** - same caveat as every content-mutation/addition in this repo; the user
  should try `::apreward` bare, `::apreward armour 1/20/40/60/99`, fill their
  inventory and confirm the bank-fallback message fires, and `::apquestcheck`, then
  eventually complete a real quest to confirm the hook fires unprompted.

**New verification technique worth keeping**: decompiling the actual compiled
`script.dat`/`.idx` directly, without booting the full server, to settle "is my source
edit actually what the server will run" definitively:
```
npx tsx --input-type=module -e "
import ScriptProvider from './src/engine/script/ScriptProvider.ts';
ScriptProvider.load('data/pack');           // NOT 'data/pack/server' - load() appends that itself
const s = ScriptProvider.getByName('[label,goblin_drop_table]');
// s.intOperands are the resolved obj/int constants baked into this script's bytecode;
// cross-reference against content/pack/obj.pack's id->name mapping to check
// which items are actually compiled in, independent of what the .rs2 SOURCE says.
"
```
This resolved two rounds of "is this actually working or is the server just stale"
uncertainty in this session faster than any other method available from WSL (can't
boot the real server here - see the Environment gotchas section) - worth reaching for
again whenever a script-based feature's in-game behavior is in doubt. Script names for
bracket blocks are the literal source text, e.g. `[ai_queue3,goblin]` and
`[label,goblin_drop_table]` are two SEPARATE addressable compiled scripts (an `@label`
jump crosses script boundaries, it's not inlined) - `ScriptProvider.getByName()` needs
the exact bracket-and-all string.

**Also confirmed while investigating the user's "goblins look vanilla" report**: giant
spiders (`giantspider1`/`giantspider2` in `_unpack/225/all.npc`) have
`param=death_drop,null` and no `ai_queue3` script anywhere in the content tree - this
vanilla LostCityRS rev-274 content set simply hasn't implemented a drop table for them
yet. Not a randomizer gap; nothing exists there to shuffle. General lesson: when a
specific monster "isn't randomized," check whether it ever had scriptable drop content
in the first place before assuming the tool missed it.

The esbuild win32/linux flip (see Environment gotchas) recurred TWICE more this session,
confirming the user was actively running things from Windows in between WSL tool
invocations - a useful tell for "has the user touched this checkout since I last built
it" in future sessions, worth noticing rather than just silently re-running `npm
install` each time.

## Session-end addendum 7: two more drip bugs, and a RegenerateAll.ts pipeline (2026-07-13, same session continued)

The user kept testing in-game after addendum 6 and found two more real problems, both
in drip - plus asked a design question ("can the rando script restore to pristine
before every run?") that led to a genuinely useful new tool.

**Bug 3 - `man_torso_backpack` is an accessory, not a torso.** Tanner (Al Kharid) had
"no torso." `model.pack` tags `man_torso_backpack` with the `torso` category by naming
convention, but its ONLY vanilla usage (`quest_death.npc`'s `death_sherpa`/Tenzing) is
as a SECOND torso-tagged value layered alongside a real one
(`model3=man_torso_basic`, `model9=man_torso_backpack` - a hiking pack worn over a
normal torso). Landing it in an NPC's only torso slot leaves no actual body mesh.
Checking for this pattern surfaced something bigger: **multiple same-category model#
values within one NPC block is a common, intentional vanilla convention**, not an
anomaly - `legs: basic+combats`, `head: viking_helmet+viking_helmet_basic`,
`torsoextra: cloak+buttons`, `necklaces: basic+stylesaradomin` all layer routinely
(logged via a full-corpus scan before writing the fix, same discipline as every other
finding this session). `backpack` is the one torso-category value that's actually an
accessory hiding in the wrong category name, not a genuine second torso.

**Bug 4 - `everyone has demon hands`.** Checked the distribution first (not a sampling
bug - `man_hands_demon` gets roughly its fair ~1/7 share of the tiny hands pool, same as
every other option) before concluding it's a data problem: every `_demon` variant
(arms/legs/feet/hands, both genders) has ZERO vanilla usage in ANY category - a
complete, never-touched reserved family, unlike the ~120 other never-worn model.pack
values (mostly unused holiday hats/hairstyles, exactly the "extra variety" this tool
is supposed to surface). Strong signal it's reserved for an actual Demon-type creature,
not generic human wear.

- Fix for both: `isNeverSwappable()` in `NpcDripParser.ts` excludes
  `man_torso_backpack`/`woman_torso_backpack` (by exact value) and any value whose
  detail is exactly `demon` (by category-stripped suffix), used by BOTH `parseSlots()`
  (so an NPC's OWN occurrence, like Tenzing's, is never treated as swappable - left
  permanently vanilla, same treatment `human_weaponsextra_stafforb` gets) and
  `loadModelUniverse()` (so it can never be sampled INTO any other slot).
- **A subtlety this surfaced**: fixing the code doesn't retroactively fix data a
  PREVIOUS, buggier run already wrote. `mourner_armed`'s vanilla
  torso/arms/legs are all `plaguesuit` - but `plaguesuit` torso has only ONE valid
  value in the whole cache, so the (correctly working) armor-set-aware group logic
  sees a pool of size 1, decides "nothing different to reassign to," and skips writing
  that slot. The bug: this NPC's torso had ALREADY been corrupted to
  `man_torso_backpack` by the run that happened BEFORE the armor-set fix existed (back
  when torso/arms/legs were still independently, unconstrained-ly sampled). "Skip" in
  the current code means "leave current content alone," not "restore to vanilla" - so
  the old mistake persisted across every reseed since, even after the code that
  produced it was fixed. Manually spot-checking a couple of "should be fixed now" NPCs
  after the demon/backpack fix (rather than assuming the fix alone was sufficient) is
  what caught this.
- Fix: restored the ENTIRE `.npc`/drop-table-script tree to pristine vanilla (not just
  the one affected file - drip and shopsanity share the same live files, so a targeted
  restore would risk clobbering shopsanity's edits) and re-ran drip + shops + drops
  together from clean. This is the same remedy as bug 2's reseed fix - "restore
  pristine, don't try to patch forward from an inconsistent state" - now confirmed as a
  recurring need whenever a content-mutation tool's OWN logic changes, not just when
  two tools collide.

**New tool: `overlays/engine/tools/RegenerateAll.ts`.** The user asked whether "the
rando script" should restore to pristine before every run. Direct answer: not by
default, and deliberately - drip/shops/drops all write onto the CURRENT LIVE file
specifically so reseeding one tool doesn't erase another's edits (see the shopsanity
domain-knowledge section for the original cross-tool data-loss bug this convention
fixes); if every tool restored to pristine on its own before running, running drip
after shops would wipe shops' `owned_shop` reassignments, and vice versa. Instead, this
new script is a single pipeline that restores ONCE, then runs drip + shops + drops
(`--mode` forwarded) in sequence, then rebuilds the pack - the exact manual sequence
used to fix bug 3, now a real command:
```
npx tsx tools/RegenerateAll.ts [--seed <n>] [--drip-seed <n>] [--shops-seed <n>] [--drops-seed <n>] [--mode tiered|chaos] [--skip-drip] [--skip-shops] [--skip-drops] [--no-rebuild]
```
Backed by two new exports: `restoreNpcBackup()` in `NpcDripParser.ts` and
`restoreDropScriptBackup()` in `DropTableParser.ts` (both copy backup -> live for every
file; NOT called by any individual tool automatically, only by this orchestrator -
their own doc comments repeat why). This is the right entry point going forward
whenever a content-mutation tool's logic changes and old data needs a clean re-derive,
not just for the user's original "start fresh" ask.

- Verified: ran `RegenerateAll.ts --drip-seed 555 --shops-seed 777 --drops-seed 777
  --mode chaos` end to end (restore -> drip -> shops -> drops -> pack build, ~1:50
  total). Re-checked `mourner_armed` (now correctly stays vanilla plaguesuit, not
  `backpack`), `tanner` (now a real generic torso, `man_torso_model_300`), a full-corpus
  grep for any remaining `backpack`-as-primary-torso or `_demon` value (zero), and
  re-ran every drops-side offline check (quest-pinning, no-op, universe-membership,
  live-vs-spoiler consistency) plus the drip group-mismatch check (0/702 violations) -
  all clean on the freshly regenerated state.

## Session-end addendum 8: mimic mode - whole-table drop shuffle via runtime override (2026-07-14)

The user asked (after testing chaos mode in-game) for a third drop mode: instead of
shuffling items WITHIN tables, shuffle which monster runs which ENTIRE drop table -
"chicken replaces green dragon", full profile. They explicitly asked for it to work
"kinda like how random locations was implemented" (runtime JSON + dispatch), named
`--mode mimic` (kept alongside tiered/chaos as a future AP slot option). New files:
`overlays/engine/tools/drops/MimicTransform.ts`, `overlays/engine/src/engine/
ApDropOverrides.ts`; modified: `RandomizeDrops.ts`, `RegenerateAll.ts`,
`ScriptOpcode.ts` (AP_DROP_GROUP = 1901), `ServerOps.ts`, `ap.rs2`
(`[command,ap_drop_group](int)(int)`). See README "Drop randomization" for usage/scope.
Design knowledge that isn't obvious from the code:

- **The transform is entrance-style preamble injection, NOT script rewriting.** Each
  eligible `[ai_queue3,...]` handler gets a seed-independent preamble
  (`def_int $ap_group = ap_drop_group(<slot idx>); if ($ap_group >= 0) { <standard
  prologue>; @ap_drops_go($ap_group); }`) inserted immediately before its own
  `gosub(npc_death);` line (inline handlers) or between header and jump (jump-style
  handlers). On a JSON miss the engine returns -1 and the handler falls through to its
  UNTOUCHED vanilla loot - delete `ap-drops.json` and drops are vanilla with no
  rebuild. Each unit's post-prologue loot is extracted into `[label,ap_drops_<n>]`
  blocks in ONE generated file plus an if-chain dispatch label `ap_drops_go`. The
  preamble runs the prologue itself because jump-style handlers' vanilla prologue
  lives inside the label being bypassed (jumping to a loot label after the vanilla
  path had already gosub'd npc_death would double-run the death logic - this shape
  avoids both double-run and skip).
- **`if ($ap_group >= 0)` not `! null`**: int null IS -1 engine-side, but `>= 0` with
  the engine returning -1 on miss is unambiguous to the compiler; didn't want to
  find out mid-build whether the type checker unifies `null` with a plain int local.
- **The generated file lives at `drop tables/ap_mimic.rs2`, deliberately NOT under
  `drop tables/scripts/`** - `ensureDropScriptBackup()`/`restoreDropScriptBackup()`
  walk only `scripts/`, so generated output can never be mistaken for (or backed up
  as) vanilla content. It's fully self-contained (dispatch + labels), so a stale copy
  after a restore still compiles - but `removeMimicArtifacts()` deletes it (+ the
  JSON) whenever switching back to tiered/chaos (RandomizeDrops auto-detects a
  mimic-transformed live corpus via the `ap_drop_group(` marker and restores first -
  the item modes edit live lines by BACKUP line index, which the preamble insertions
  would shift).
- **Slot indices are baked into compiled preambles; the JSON only maps slot->unit.**
  Both index spaces are deterministic sorts of the backup corpus, so a mimic RESEED
  is a byte-identical transform + new JSON = restart only, no rebuild (the tool
  byte-compares and prints which case you're in). 97 slots, 95 eligible, 77 units
  (multiple handlers share one label unit - all four goblin variants run
  goblin_drop_table; each variant is its own SLOT though, so they can mimic four
  different monsters).
- **The permutation must reject UNIT-level fixed points, not just index-level.**
  `derangement()` guarantees no index maps to itself, but goblin -> goblin_armed is an
  index-level move that lands on the SAME unit (no in-game change). Reshuffle-until-
  no-unit-fixpoint converges in a few attempts at this pool shape.
- **death_drop travels with the table via literal inlining.** `npc_param(death_drop)`
  resolves against the DYING npc, so a green dragon running chicken loot would still
  drop dragon bones; extraction replaces it with the unit's own value. Verified every
  unit's value is uniform across its handlers' category members before inlining
  (parse `.npc` backups: name -> category/death_drop, `_x` handler = category x
  members, default `bones` per npc_combat.param). One special case found by running,
  not guessing: `otherworldly_being` has an EXPLICIT `param=death_drop,null` ("drops
  nothing"), so its unit's death-drop line is REMOVED rather than inlined (first
  implementation kept npc_param as a fallback there, which would have wrongly given
  mimics their own bones). The .npc death_drop shuffle pass is skipped in mimic mode.
- **Structural pins are about code that can't run on the wrong npc, not about item
  availability**: `grip` (bespoke prologue - Heroes' Quest kill credit via
  `finduid(%npc_aggressive_player)`, no npc_findhero gate) and `_mountain_troll`
  (jump-style, and its label `troll_drop_table` carries npc_type-gated Trollheim
  prison keys BEFORE the prologue; the label is also jumped to by `_troll_thrower`/
  `_troll_spectator` from OUTSIDE the corpus - originals stay untouched, so those
  external jumpers are unaffected). Pre-prologue logic in INLINE handlers
  (guard/guard_dog `~trail_checkmediumdrop`, troll_commander's keys) stays put
  because the preamble inserts AFTER it - those slots stay mappable. Quest-gated
  drops that only read the killer's quest state (rats_tail, jail_key, unholy mould,
  hot_feather) travel WITH their tables - still obtainable, spoiler is load-bearing.
- **Same-line handler bodies exist**: `[ai_queue3,goblin] @goblin_drop_table; //lvl 2`
  puts the whole body on the header line - a line-based block parser that starts
  bodies at header+1 sees them as empty (bit the survey script first). The transform
  parses header rest-of-line as body and rewrites jump headers to header + preamble +
  original jump text.
- **Verified offline** (in addition to typecheck + clean pack build ~1:25): a
  decompile-level check via `ScriptProvider.getByName()` (77/77 unit labels + dispatch
  compiled; the cow unit's bytecode intOperands contain the inlined
  bones/raw_beef/cow_hide; the cow handler's bytecode carries its slot index), engine
  loader round-trip 95/95 with misses returning -1, zero self-mimics in the spoiler,
  JSON<->spoiler consistency for all 95 mappings, every live handler carries its
  preamble, CRLF intact. Behavior checks: reseed over a transformed corpus correctly
  reports "restart only, no rebuild"; running `--mode chaos` over a mimic corpus
  correctly restores + cleans up first. **Not yet verified in-game.**
- The live Server checkout now has: mimic seed 777 (`ap-drops.json` + transformed
  corpus + `ap_mimic.rs2`, pack-built) layered with drip seed 555 + shops seed 777 +
  entrance seed 777. The tiered/chaos seed-777 item shuffle from the previous session
  was REPLACED by the mimic state (modes are mutually exclusive by design). Cows mimic
  paladins, chickens mimic goblins in this seed - easy first in-game checks.
- The esbuild win32/linux flip recurred again (user ran from Windows in between);
  plain `npm install` alone unblocked WSL, the win32 half hit the same ENOTEMPTY as
  before and was skipped - re-run the pair if the user reports Windows breakage.

## Session-end addendum 9: drip bug 5 - model.pack names with no model data ("invisible Betty") (2026-07-14)

User report: after the current rando run, Betty (Port Sarim mage shop) is completely
invisible - yellow minimap dot present (server-side entity fine), no character model.
Cause: drip had assigned her `model2=woman_torso_leatherfat`, which has an id in
`content/pack/model.pack` (455) but **no `.ob2` file anywhere under
`content/models/`**. When any model id in an NPC's compose list has no data, the
client renders NOTHING for that NPC - not just a missing part. Betty was only the
first one noticed: the same seed had written **272 dataless-model slots across ~200
NPC blocks** (Duke of Lumbridge, King Roald, Sir Amik, Merlin, Aggie, Leela, ...).

- **Root cause**: `loadModelUniverse()`/`loadWeaponUniverse()` treated model.pack as
  ground truth ("every entry the cache actually has" - its comment even said so), but
  model.pack is an id=NAME catalog only. 34 `(man|woman)_*` names + 1
  `human_weapons_*` name are dangling: mostly placeholder names that literally embed
  their id (`man_torso_model_300`, `woman_head_model_402`, ...) but ALSO a few
  real-looking ones (`woman_torso_leatherfat`, `woman_legs_crossed`,
  `woman_feet_spurboots`, `man_torsoextra_spotty_cloak`, `woman_necklaces_style2`) -
  which is why name-based curation (isNeverSwappable) never caught them. No vanilla
  NPC wears any of them; they entered the game exclusively via our sample pools.
- **The pack build does NOT fail on these** - `tools/pack/graphics/pack.ts` packs
  whatever `.ob2` files exist by basename and prints a buried per-id
  `missing model <name> (<id>)` warning for referenced-but-absent ids. Grep future
  Build.ts output for `missing model` after content-tool changes - it would have
  caught this a session earlier.
- **Fix**: `hasModelData()` in `NpcDripParser.ts` - lazily walks `content/models/`
  once, collects `.ob2` basenames, and both universe loaders now require membership.
  parseSlots() deliberately does NOT get the gate (vanilla never wears these; if it
  somehow did, swapping away would be an improvement). Offline check: 448 pool
  entries, 0 dangling (was 483/35).
- **Embarrassing corollary**: addendum 7's "verified" tanner fix gave him
  `man_torso_model_300` - itself dataless. A config-level spot check ("it's a
  different name now") is not a render-level check. The in-game report is what
  caught it.
- Re-ran `RegenerateAll.ts --drip-seed 555 --shops-seed 777 --drops-seed 777
  --mode mimic` (restore -> drip -> shops -> drops -> pack build 1:36). Verified:
  full-corpus scan of live `.npc` files for all 35 dataless names = 0 hits; Betty's 8
  models all resolve to real `.ob2` files; armor-set group-mismatch check 1/744 and
  that one (`doorman` in lostcity.npc: plaguesuit torso + longsleeves arms +
  platemail legs) is byte-identical to VANILLA - the set-aware logic correctly left
  his plaguesuit group alone (pool of 1), i.e. 0 randomizer-introduced violations;
  engine typecheck clean. **Not yet verified in-game** - user should restart the
  server and eyeball Betty + a couple of the other formerly-broken NPCs (Duke of
  Lumbridge, Aggie in Draynor are close to spawn).
- esbuild flip recurred (same as addendum 8's note); this time the documented pair
  ALSO hit `ENOTEMPTY ... rename @esbuild/win32-x64 -> .win32-x64-<hash>` on the
  win32 half - fix is `rm -rf node_modules/@esbuild/.win32-x64-*` then re-run
  `npm install --no-save --force @esbuild/win32-x64` (succeeded; both platforms now
  installed).

### Addendum 8 follow-up: "Smells like <x>..." chat line on mimicked kills (2026-07-14)

The user asked for a chat print revealing whose table just dropped. Each generated
`[label,ap_drops_<n>]` now opens with `if (npc_findhero = ^true) { mes("Smells like
<npc display name>..."); }` before the loot. Two things worth remembering:

- **mes() needs the active_player pointer and the compiler's pointer-flow check is
  static PER SCRIPT** - the preamble's npc_findhero (in the ai_queue3 script) doesn't
  carry over into the label script for the static check, even though the runtime
  pointer does carry across the @jump. Re-calling `npc_findhero` inside the label
  satisfies the checker; the double-call is precedented by vanilla guard.rs2/
  guard_dog.rs2 (they call it twice around their clue-trail check).
- Display name = most common `name=` across the unit's handlers' category members
  (man_drop_table spans Man/Woman/Thief -> "Man"), lowercased in the message,
  recorded as `nowName` in the spoiler so in-game lines can be matched back. Labels
  are only reachable via dispatch, so vanilla/unmapped kills stay silent.
- Verified same as before (typecheck, pack build ~1:30, full offline check suite
  still green) plus the compiled cow label's stringOperands containing
  "Smells like cow...". Still not verified in-game.

## Session-end addendum 9: infinite run energy toggle (2026-07-14)

User asked for "a parameter to the rando that makes run speed always stay at 100%".
This is NOT a per-seed randomizer (nothing to shuffle, no spoiler) - it's a permanent
world-config toggle, same class of feature as the already-planned `xpRate`/
`NODE_XPRATE` XP multiplier (archipelago-ideas.md #5), and the intended model for how
this becomes an AP slot option later. Built and installed, **not yet verified
in-game** (same caveat as almost everything else in this doc).

- **New WorldConfig field, not a new mechanism**: `node.infiniteRun: boolean` (default
  `false`) added to `overlays/engine/src/util/WorldConfig.ts`, plus a
  `NODE_INFINITERUN` env var mapping in `migrateFromLegacyEnv` mirroring `xpRate`/
  `NODE_XPRATE` exactly. `Environment.ts` needed no change - it just spreads the config
  object, so the new field flows through to `Environment.node.infiniteRun`
  automatically.
- **One-line short-circuit in `Player.ts:updateEnergy()`** (called once per player per
  tick from `World.ts`'s main loop): when the flag is set, sets `runenergy = 10000`
  (max, engine units are hundredths-of-a-percent) and returns before the normal
  drain-while-moving/regen-while-idle logic. This automatically means the "energy hits
  0 -> force player back to walk" branch never fires, since energy is pinned at max
  before that check runs each tick. No changes needed to potions/graceful/agility
  regen code (`HEALENERGY` opcode in `PlayerOps.ts`) or the walk/run toggle logic
  (`P_RUN`/`VarPlayerType.RUN`) - those are orthogonal (still work normally, just moot
  since energy never actually depletes) and the client UI orb needs no change either
  (`UpdateRunEnergy` just mirrors whatever `runenergy` is each tick).
- **Why an engine code change instead of the runtime-JSON-table pattern** (entrances,
  drop mimic): that pattern exists specifically for values that vary *per seed* and
  need to reseed without a rebuild. This is a static on/off world rule, not seeded
  data, so a direct code overlay is the right fit - same reasoning as why `::home` in
  `ClientCheatHandler.ts` is a hardcoded safety valve, not a data table.
- **This required overlaying `Player.ts` for the first time** (2299-line core vanilla
  file, previously never touched by this repo) - `cp`'d from the vanilla checkout
  rather than retyped, to guarantee a byte-identical base before the 7-line patch (diff
  against vanilla is exactly those 7 added lines, confirmed via `diff`). Same
  "overlay copies go stale as upstream moves" caveat as every other overlaid vanilla
  file applies here now too - worth diffing against a fresh vanilla `Player.ts` if this
  ever needs revisiting after an upstream update.
- **Enabled directly in the user's local `Server/engine/data/config/world.json`**
  (`"infiniteRun": true` added next to their existing `"xpRate": 30`) since that file
  is gitignored/local-only and the feature is inert until a field is added there or via
  env var anyway - takes effect on next server restart, no pack rebuild needed (pure
  engine TS change, nothing content-side).
- Verified: typecheck clean (`npx tsc --noEmit -p .` in engine/), diff review against
  vanilla for both touched files. **Not yet verified in-game.**
- **Found unrelated concurrent uncommitted work in the tree while doing this**: a
  gathersanity-shaped feature (`ApGatherOverrides.ts`, `skill_fishing`/`skill_mining`/
  `skill_woodcutting` overlay scripts, modified `ap.rs2`/`ScriptOpcode.ts`/
  `ServerOps.ts`) with file timestamps ~2 minutes before this session's work started -
  not created by this session, deliberately left untouched and NOT included in this
  addendum's commit. If a future session finds this work still uncommitted, it's
  probably an interrupted session (or the user's own edits) rather than an accident -
  check with the user before assuming it's abandoned.

## Session-end addendum 10: drip bug 6 - placeholder-named models are bespoke pieces ("invisible monk legs") (2026-07-14)

Right after addendum 9's regeneration, user reported Monks of Entrana with invisible
LEGS (partial, unlike Betty's whole-NPC invisibility). `entrana_monk` had drawn
`model7=man_legs_model_270` - which PASSES the new hasModelData() gate (a real 360-byte
.ob2 exists). The model is the Genie's floating smoke-tail: vanilla's only use is
`macro_geni` layering it as a SECOND legs value (`model7=man_legs_crossed` +
`model8=man_legs_model_270`) - the exact `torso_backpack` shape from addendum 7 again,
an accessory/bespoke piece hiding in a primary category by naming convention.

- **The generalization, not the one-off**: `*_model_<id>` names literally embed the
  model id - they're the entries nobody ever identified when the cache was named. The
  family only pattern-matches into gender/category pools because someone prefixed the
  ids. 24 such entries were in the (data-filtered) pools; the current seed had put 289
  of them into real (non-_unpack) areas. They can't be visually vetted one-by-one from
  WSL, and "unidentified asset" is the same signal the `_demon` family exclusion was
  built on - so the whole family is now excluded via `hasPlaceholderName()` in
  `NpcDripParser.ts`: folded into `isNeverSwappable()` (bodies: never sampled into,
  and vanilla wearers like the Genie's tail keep their slot - that's a fix in itself)
  and checked separately in `loadWeaponUniverse()` (weapons don't go through
  isNeverSwappable; `human_weapons_model_526` is one half of vanilla's two-piece
  excalibur, sampling it alone would give half a sword).
- Weapon slots ARE still allowed to swap AWAY from a placeholder (parseWeaponGroups
  has no isNeverSwappable) - the fresh seed moved sir_mordred off
  `human_weapons_model_513` and earthwarrior(225) off `human_weapons_model_520`;
  swapping away from an unidentified prop to a real named one is an improvement, so
  this asymmetry is deliberate.
- **Pre-existing vanilla wart, do not "fix"**: `lady_pirate` in `_unpack/225/all.npc`
  wears dataless `woman_legs_model_434` IN VANILLA (backup line 4754) - a full-corpus
  dataless scan now reports exactly 1 hit and that's it; she's never spawned by any
  .rs2. Same for the `_unpack` legacy dumps generally: they're old-revision config
  archives, blocks there mostly aren't live NPCs.
- Verified after `RegenerateAll --drip-seed 555 --shops-seed 777 --drops-seed 777
  --mode mimic` + pack build: 0 placeholder assignments in the spoiler; live
  placeholder occurrences == vanilla exactly (body) modulo the two weapon
  swap-aways; dataless scan = only the vanilla lady_pirate wart; armor-set mismatch
  check still 1/744 = the vanilla doorman; entrana_monk/shipmonk2 now wear real legs
  (pirate/viking); Betty still all-valid; typecheck clean. **Not yet verified
  in-game** - Monks of Entrana + Genie (should keep smoke tail) are the eyeball
  targets.
- Pipeline wrinkle: the esbuild flip hit DURING RegenerateAll this time - the
  randomizer children succeeded, the Build.ts child died, and RegenerateAll's
  execFileSync error hides the child's stderr (output [null,null,null]). If
  RegenerateAll "fails at Build.ts", run `npx tsx tools/pack/Build.ts` directly to see
  the real error / finish the pipeline - the randomizer steps before it completed fine
  and don't need re-running.

## Session-end addendum 11: gathering-skill randomization (2026-07-14)

(Implementation files for this feature were committed in `24f758f` - a concurrent
session's drip-fix commit happened to sweep this session's in-progress files into its
commit. The feature is complete and verified regardless; this addendum + the README
section landed separately.)

User asked to randomize gathering skills (Mining/Fishing/Woodcutting) - "cut a tree
and get a fish", parameterized like the other randomizers. Runtime-override design
(entrance/mimic plumbing): `AP_GATHER_SWAP = 1902` + `ApGatherOverrides.ts` reading
`engine/data/config/ap-gather.json` (obj id -> obj id), 12 delivery points wrapped
`inv_add(inv, ap_gather_swap($product), 1)` in whole-file overlays of mining.rs2 /
woodcut.rs2 / fishing.rs2 / memberfish.rs2, generated by
`tools/gather/RandomizeGathering.ts`. See README "Gathering randomization" for
usage/scope. Design knowledge not obvious from the code:

- **Miss semantics are PASSTHROUGH (return the input id), not -1** - a deliberate
  deviation from the entrance/mimic loaders' convention. It makes each content hook a
  one-token wrap with no null branch, and "input unchanged" is the natural miss
  meaning for an item transform. Anything not in the JSON (pinned products,
  perfect_gold_ore, unselected skills) is vanilla for free.
- **`inv_add`'s item param is `namedobj`-typed, and `obj` does NOT coerce upward** -
  the first build failed with `Type mismatch: 'inv,obj,int' was given but
  'inv,namedobj,int' was expected` on every wrap. Fix: declare the command's RETURN
  as namedobj (`[command,ap_gather_swap](obj $product)(namedobj)`) - namedobj passes
  anywhere obj is accepted, so the obj-typed PARAM is fine. Precedent:
  `[proc,mining_gem_table]()(namedobj)`. Remember this for any future command that
  feeds items back into inv_add/inv_del.
- **All three skills funnel through tiny chokepoints, so no parser was needed** -
  unlike entrances (353 records) this is 12 hand-wrapped lines across 4 whole-file
  overlays. Mining/woodcutting products live in dbtables (`mine.dbrow` rock_output,
  `trees.dbrow` product); fishing has NO product table - fish are literal args at
  `~fish_roll`/`~fish_roll_loc` call sites (parsed from the live scripts), plus 3
  big-net fish delivered directly in memberfish.rs2 (wrapped individually; the junk
  catches - boots/seaweed/oyster/casket - stay vanilla). The pool parser reads
  `ap_gather_swap(<literal>)` occurrences for those, so "what's in the pool" is by
  construction "what's actually wrapped".
- **Quest-critical pinning had to be MODE-AWARE or the feature guts itself.** The
  drops-style `inv_total`/`inv_del` scan flags 16 of 39 products - including every
  single log type and most basic ores (common gathering products gate quests
  constantly). Pinning them all in shuffle mode leaves woodcutting with hollow_bark
  alone. But shuffle is a bijection - everything stays obtainable, quests just need
  their item gathered from a different action - so the obtainability rationale behind
  drops' always-on pin doesn't apply. Default: shuffle doesn't pin, chaos does
  (independent resampling genuinely can orphan a product); `--pin-quest-items` /
  `--no-quest-pins` override. `thpunishrock` (Tourist Trap punish-rock task "ore") is
  hard-excluded in both modes - it's quest plumbing, not a product, and the
  inv_total idiom can't be relied on to catch it.
- **Pinned products are also removed as REPLACEMENT values** (unlike drops, where
  pinned items stay eligible as replacements): shuffle is a bijection, so keeping a
  pinned item's source vanilla while also handing it out elsewhere would double it up
  and orphan whatever product lost its slot.
- Messages/xp/success rolls stay vanilla on purpose - "You manage to mine some
  coal." + a raw shark appearing is the intended mimic-style reveal. Only the
  inv_add argument changes.
- **The esbuild ping-pong hit a NEW failure shape this session**: `npm install
  --no-save --force @esbuild/win32-x64` PRUNED the linux-x64 package (left a
  version-mismatched/empty state), and recreating it hit a DrvFs ghost directory -
  `stat` said ENOENT, `mkdir` said EEXIST, `ls` showed nothing - almost certainly a
  Windows-side delete-pending handle. It cleared on its own within a minute; the
  robust recovery that doesn't depend on npm reify at all: `npm pack
  @esbuild/linux-x64@<exact esbuild version>` into the scratchpad, untar, and copy
  the package dir to `node_modules/@esbuild/linux-x64` (or set ESBUILD_BINARY_PATH
  at the staged binary if the path stays stuck). Match the version to
  `require('esbuild/package.json').version` - a mismatched platform binary fails
  with a confusing "installed for another platform" error naming the SAME package.
- **Verified offline**: typecheck clean, pack build clean, loader round-trip 38/38 +
  passthrough on misses, decompile check confirms all 12 wraps compiled into the
  bytecode (opcode 1902 in fish_roll x2, fish_roll_loc x2, fish_roll_big_net x4,
  get_logs, get_ore_normal/fast/essence) + `[debugproc,ap_gather]`, spoiler checks
  (bijection with 0 fixed points, 0 pin leaks, spoiler<->JSON consistent, 0 id/name
  mismatches vs obj.pack). **Not yet verified in-game** - user should restart the
  server (pack already rebuilt + seed-777 shuffle table written: chop a normal tree
  -> raw mackerel, fish shrimp -> raw shark, mine iron -> raw lava eel) and try
  `::apgather logs`.
- The live Server checkout now has: gather seed 777 (shuffle) layered with mimic
  drops seed 777 + drip seed 555 + shops seed 777 + entrance seed 777.

## Session-end addendum 12: processing-skill randomization (2026-07-15)

User asked to randomize Cooking/Smithing/Crafting the same way gathering was done -
"smith some ore to get a cooked fish, cook some meat to get leather chaps" - then
added Fletching mid-session ("Should have included fletching btw"). Same
runtime-override plumbing as gathering: `AP_PROCESS_SWAP = 1903` +
`ApProcessOverrides.ts` reading `engine/data/config/ap-process.json` (obj id -> obj
id), delivery points wrapped `inv_add(inv, ap_process_swap($product), n)` in
whole-file overlays, generated by `tools/process/RandomizeProcessing.ts`. See README
"Processing randomization" for usage/scope. Design knowledge not obvious from the
code:

- **Scope was negotiated up front, not assumed**: cooking/smithing/crafting recipes
  split into two shapes - clean single/double-chokepoint DBTABLE-driven recipes
  (cooking_generic, smithing.dbtable, leather.dbtable, gem.dbtable) vs. multi-step
  composite recipes where the "product" is built across several intermediate items
  (pies, pizza, cakes, jewellery, glass, pottery, spinning, studded, battlestaves,
  dye_cape - e.g. pie_shell -> filled pie). Swapping an intermediate in the second
  group would corrupt the recipe, not just reveal a surprise, so those need per-file
  hand-identification of the true FINAL `inv_add` - asked the user via
  `AskUserQuestion` before building rather than guessing scope; they picked
  "dbtable core only" for the first pass. Fletching (added after the initial scope
  was already built) turned out to be ENTIRELY dbtable-driven (`fletching_table` +
  `fletch_bow_table`) except `ogre_arrows.rs2` (hardcoded shaft/headless/tip chain)
  and `arrows.rs2`'s `headless_arrow` intermediate - both excluded, same reasoning.
- **13 delivery points across 9 files**: `cooking.rs2` (1 - the success path only;
  the burn-path `$burnt_item` delivery, `$additional_item`, and gnome half-baked
  reassignment all stay vanilla by construction - those items are never in the
  dbrow-sourced pool, so `ap_process_swap` passthroughs them for free with no
  special-casing needed), `smithing.rs2` (1), `leather.rs2` (2 - the
  `hardleather_body` special case plus the general `craft_leather_queue`),
  `uncut_gem.rs2` (1 - the mis-hit `crushed_gemstone` stays vanilla, same "failure
  output stays vanilla" precedent as gathering's big-net junk), `arrows.rs2` (1),
  `darts.rs2` (1), `cut_logs.rs2` (1), `bolts.rs2` (2 - bolt-tip cutting AND bolt
  tipping share one `fletching_table`/file), `bows.rs2` (1 - stringing).
- **Three fletching sites needed a destructure-first rewrite, not a pure one-token
  wrap**: `bolts.rs2`'s bolt-tip-cutting delivery and `bows.rs2`'s stringing delivery
  originally spliced `db_getfield($data, fletching_table:product, 0)`'s TWO return
  values (namedobj,int) straight into `inv_add`'s item+qty params
  (`inv_add(inv, db_getfield(...))`- RuneScript auto-fills consecutive call params
  from a multi-return). `ap_process_swap` only takes one `obj` argument, so it can't
  wrap that call result inline - both sites now `def_namedobj`/`def_int` the two
  return values into locals first, then `inv_add(inv, ap_process_swap($local_item),
  $local_qty)`. `darts.rs2`/`arrows.rs2`'s equivalent recipes already destructured
  this way for other reasons (level-gating needs the item name pre-extraction), so
  only 2 of the 4 shared-table fletching files needed the rewrite.
- **A `null` sentinel value leaked into the first dry run** and had to be filtered:
  `cooking_generic_raw_oomlie`'s row is `data=cooked,null` (raw oomlie can't be
  cooked directly - it always hits the cantcookmessage branch before any `inv_add`),
  not a real product. `extractDataField()` now skips `m[1] === 'null'` explicitly -
  a literal string "null" in a dbrow field is a legitimate sentinel in this content,
  not an item name, and the tool has no other way to distinguish it from a real obj
  named "null" (there isn't one, but nothing enforces that).
- **The product-pool regex needed a second generalization for fletching's two
  multi-value columns**: `fletching_table:product` is `namedobj,int` (item + max
  count per action) and `fletch_bow_table:shortbow`/`longbow` are `namedobj,int,int`
  (item + level + xp) - cooking/smithing/leather/gem's product columns are all
  single-value. `extractDataField()`'s regex went from anchoring `$` right after the
  first captured token to an optional `(?:,.*)?$` tail, so it captures just the
  leading namedobj and ignores whatever trailing ints follow.
- **Quantity is never touched, only item identity** - same "structure stays put,
  content moves" philosophy as tiered drop randomization's probability bands. A
  recipe slot that hands out 5 of its product (bronze/iron/steel/mithril/adamant/
  rune knives, `nails` x2 in smithing) still hands out that many of whatever it got
  swapped to - accepted as part of the feature (a bronze-bar knife slot CAN land you
  5 rune platebodies if the derangement puts it there), not clamped against the
  target item's own native quantity. Considered a `min(sourceQty, targetNativeQty)`
  safety clamp and rejected it as unneeded complexity for ~13 non-1 quantity slots
  out of 253 pool entries, consistent with gathering already accepting "chop a
  normal tree -> get a raw shark" with zero rarity gating.
- Quest-critical pinning reuses `loadQuestCriticalItems()` from `DropTableParser.ts`
  verbatim (mode-aware: shuffle off by default, chaos on - same reasoning as
  gathering, since shuffle is a bijection and everything stays obtainable from a
  different recipe). Seed 777, shuffle, no pins: 18/212 pool would've been pinned if
  forced on (three-skill pool); 19/253 with fletching added.
- Verified offline: typecheck clean, pack build clean (`pack: 1:52.265`, single
  timing line, no errors), tool dry-runs across shuffle/chaos/`--skills`/
  `--pin-quest-items`/`--exclude` all produce sane output (253-product pool: cooking
  55, smithing 129, crafting 28, fletching 41; seed 777 shuffle: 253/253 swapped,
  160 cross-skill). Real (non-dry-run) seed 777 written to `ap-process.json` +
  `process-seed.json`, pack rebuilt on top of it. **Not yet verified in-game** - user
  should restart the server and try `::approcess cooked_meat` /
  `::approcess bronze_dagger` / `::approcess bronze_arrow`.
- No decompile tool exists in this checkout (unlike the gathering addendum's
  bytecode grep) - relied on typecheck + a clean pack build (the compiler itself
  validates `ap_process_swap`'s signature and opcode registration; a mismatch would
  have failed the build) instead. Worth building a decompile-based verification step
  if a future randomizer wants the same level of bytecode-level confidence gathering
  got.

## Session addendum: checks-and-unlocks design research (2026-07-15)

Docs-only session: researched and wrote [checks-and-unlocks.md](checks-and-unlocks.md)
(the full check catalog / reward expansion / unlock-item proposal). No code written,
nothing installed. Hook-point facts verified this session, worth not re-deriving:

- **`Player.setVar(id, value)` (`Player.ts:1767`) is the single varp-write
  chokepoint** (all script writes route POP_VARP -> setVar) - the proposed generic
  "quest progression stage / barcrawl bit" check watcher hangs there. Engine
  internals also call it (e.g. RUN toggle at Player.ts:724), so any watcher must be
  a cheap by-varp-id map lookup.
- **`Player.addXp(stat, xp, allowMulti)` (`Player.ts:1821`)**: XP units are tenths
  of a point; `allowMulti` defaults true and multiplies by `Environment.node.xpRate`
  (user runs 30x) - any fixed-size XP reward must pass `false` via a new opcode
  (1903 proposed; 1900-1902 taken). `stats[stat] === 0` before an add = "first XP in
  skill" (hitpoints never qualifies - starts at level 10 / 11540 units).
- **`[proc,npc_death]` (`skill_combat/scripts/npc/npc_death.rs2:10`) is the global
  NPC death chokepoint** and already does `finduid(%npc_aggressive_player)` - the
  right overlay point for first-kill/notable-kill checks. Mimic mode doesn't affect
  it (npc identity is real there; only loot lies).
- **All 19 `[advancestat,<stat>]` triggers exist** (`levelup/scripts/levelup.rs2:3-21`)
  funneling into one `@levelup(stat)` label - the level-milestone check hook.
  The `[stats]` enum (`player/configs/stat.enum`, vals 1-19 int->stat) is how to
  pick a random skill from script.
- **Every tiered equipable routes its wear-op through
  `levelrequire/scripts/levelrequire.rs2`** (17 `levelrequire_*` labels; per-item
  trigger lists in `tier*.rs2`) - overlaying that ONE file gates all gear tiers,
  the proposed flagship "Progressive Melee/Armour/Ranged/Magic" unlock. Quest-gated
  variants (`levelrequire_dragon_slayer_quest_defence` etc.) live in the same file.
- **Dragon Slayer's start is gated `%qp >= 32`**
  (`quests/quest_dragon/scripts/dragon_journal.rs2:7`) - this is why quest-based
  progression works as the "region system": the goal quest already forces a wide
  quest spread. 65 quest dirs exist; 88 quest varps.
- **Prior art**: the official OSRS Archipelago world's goal is also Dragon Slayer,
  items = chunk unlocks + progressive gear tiers, locations = skill tasks + quests
  (https://archipelago.gg/games/Old%20School%20Runescape/info/en). We adopt gear
  tiers/skill tasks, drop chunks.
- Proposed opcode allocations to keep collision-free: **1903 =
  ap_stat_advance_raw, 1904 = ap_unlock_count** (unlock table needs a RELOAD path,
  unlike entrances - AP items arrive mid-session).

## Session addendum: tracker-map feasibility research (2026-07-15, same session)

Second docs-only deliverable: [tracker-map.md](tracker-map.md) (browser discovery
tracker). Web-layer facts verified this session, worth not re-deriving:

- **`engine/src/web.ts` is a plain `http.createServer` if-chain router**
  (`handleWebRequest`), NOT express/fastify. It already serves static files from
  `engine/public/` as a fallthrough (`web.ts:174-177`) - a static tracker page under
  `public/ap/` needs zero engine changes; only JSON data routes need a web.ts
  overlay. A second management-port server exists too (`web.ts:393`).
- **`/worldmap.jag` is already a route** (`web.ts:144`), built by
  `engine/tools/pack/map/Worldmap.ts` from packed map data (underlay/overlay/loc/
  labels dats), and **`webclient/src/mapview/MapView.ts` (1962 lines) is a full
  browser port of the 2004 world-map applet** - already a bundle entry
  (`webclient/bundle.ts:156`), fetches /worldmap.jag, renders a pannable canvas
  map. Any future "render the world in a browser" work should start from these
  two files.
- **Every runtime randomizer lookup is a one-function discovery hook**:
  `getEntranceOverride`, `getGatherSwap` (ApGatherOverrides.ts:53),
  `getProcessSwap` (ApProcessOverrides.ts:54), `getDropGroupOverride`
  (ApDropOverrides.ts:48). The lookup moment IS the "player did it once" moment,
  so reveal-after-first-use costs nothing extra. Config-mutation randomizers
  (teleports, shops) have no runtime lookup - proposed generic `ap_track` command
  (opcode 1905) for content-side discovery calls.
- Opcode ledger now: 1900 entrance, 1901 drop group, 1902 gather swap, 1903
  (proposed) ap_stat_advance_raw, 1904 (proposed) ap_unlock_count, 1905 (proposed)
  ap_track.

### Same-session follow-up: quest-reward items for the reward pool (2026-07-15)

Researched for checks-and-unlocks.md's new "Quest keepsakes" section. Facts worth
keeping: **quest-completion wield gates live in the same levelrequire file as the
level gates** (dragon dagger/long = Lost City, dragon mace/b-axe = Heroes, halberd =
Regicide, dragon sq = Legends, iban staff = its own label, rune platebody +
dragonhide_body = Dragon Slayer, viking helmets = Fremennik Trials) - so quest-gated
gear can go straight into the reward pool with zero new gating code. Family Crest
gauntlets (cooking/goldsmithing/chaos) are a one-choice-per-account vanilla reward -
all three exist as separate objs, so the randomizer can hand out the unchosen ones.
`arthur_journal.rs2:55` checks `inv_total(inv, excalibur)` - excalibur WILL flag in
the quest-critical scan (additive-only risk: sequence-skips Merlin's Crystal fetch
steps, can't brick). `dramen_staff` stays out of every pool (it is Lost City's
completion mechanic). When building the dbrow, run candidates through
`loadQuestCriticalItems()` and sign off on each flagged item explicitly.

## Session-end addendum: parallel-agent build of checks/rewards/unlocks/tracker (2026-07-15)

The user asked to fan out subagents to build everything in checks-and-unlocks.md +
tracker-map.md. Orchestration shape that worked: the orchestrator built the SHARED
plumbing first (files touched by multiple workstreams), froze those files, then ran
4 parallel agents with strictly disjoint file ownership and no build/install rights
(one integration build at the end). Facts a future session needs:

- **Opcode ledger CORRECTION vs the design docs' first drafts**: 1903 was already
  AP_PROCESS_SWAP (processing randomizer). Actual: **1904 = AP_STAT_ADVANCE_RAW**
  (addXp with allowMulti=false - xpRate-proof reward XP), **1905 = AP_UNLOCK_COUNT**,
  **1906 = AP_TRACK**. Next free: 1907.
- **Player.ts now carries three AP seams** (frozen - agents never touch Player.ts):
  setVar calls ApChecks.onVarpSet after every numeric write; addXp routes the
  post-multiplier gain through ApUnlockOverrides.clampStatXp (<=0 = skip) and fires
  ApChecks.onXpGain(stat, beforeBase, afterBase, firstXp) at the end. All three
  modules default to vanilla no-ops when their JSON tables are absent.
- **The varp.pack staleness race (addendum: quest-completion rewards session) hit
  again**, this time on the new `ap_kills` varp: build failed with "'%ap_kills'
  cannot be resolved". Same workaround: `rm content/pack/varp.pack`, rebuild. Expect
  this for ANY new config NAME on this WSL/DrvFs setup.
- **What got built** (all offline-verified; NOTHING in-game tested yet):
  - Checks: ApChecks.ts (varp watcher from data/config/ap-checks.json - 10 barcrawl
    bars + 6 dragonquest stages; first-XP per skill exc. hitpoints; level milestones
    every 10), fired-set persisted to ap-checks-fired.json (once-ever, survives
    restart, NOT cleared on reseed - deliberate), npc_death.rs2 overlay (1 line ->
    ~ap_track_kill; %ap_kills bitfield, 14 notable kills matched by npc_type OR-chains
    - hill giant doesn't exist in this content set), payoff = [queue,ap_check_fired]
    (engine enqueues via player.enqueueScript(script, PlayerQueueType.ENGINE, 0,
    [checkId])) -> mes + ~ap_grant_check_reward. Tests: ::apcheckfire <id>, ::apchecks.
  - Rewards: 94 -> 172 dbrows; categories now 14 (was actually 9 incl. tools, not 8
    as the doc first said): +xp (10k-50k via 1904, random skill via stats enum),
    +herb_supplies (unidentified herbs - it's 2004), +runecraft_supplies (blankrune
    NOT rune_essence; talismans at real altar levels; blood/soul excluded - no altar
    in 274), +crafting_supplies (leather - soft_leather doesn't exist), +keepsakes
    (excalibur..cape_of_legends, flat weight); dragon weapons/dhide/viking helms into
    weapons/armour (vanilla levelrequire enforces their quests at wear time).
    [proc,ap_grant_check_reward] is the stable checks->rewards interface.
  - Unlocks: ApUnlockOverrides.ts reads data/config/ap-unlocks.json with mtime-
    throttled (2s) MID-SESSION reload; no file = all unlocked (count 99/cap 99/
    passthrough), file present + key missing = 0. levelrequire.rs2 overlay gates 13
    base labels via ~ap_gear_locked (tiers 1/5/10/20/30/40/45-50/60-70 -> idx 0-7;
    families melee/armour/ranged/magic); mining/woodcut overlays gate pickaxe/axe
    tiers (pickaxe: locked = treated as absent; axe: falls back to best unlocked -
    asymmetry documented in the agent report, driven by pickaxe_checker.rs2 being
    outside ownership). Skill caps = 20 + 10/item, hitpoints never capped, exp table
    duplicated locally in the module (circular-import avoidance vs Player.ts).
    KNOWN DESIGN POINT: progressive_magic/progressive_ranged are SHARED keys between
    gear tier and skill cap (one item raises both); melee splits into
    attack/strength/defence caps. Tools: tools/ap/SetUnlock.ts CLI; ::apunlock.
  - Tracker: ApTracker.ts (dedupe + 2s debounced temp-file+rename flush to
    data/config/ap-tracker.json), discovery hooks in all 4 Ap*Overrides (record on
    hit only), web.ts overlay adds GET /ap/tracker.json (names enriched server-side:
    ObjType for gather/process, ap-drops.json spoiler arrays for drops; totals per
    category; ?spoiler=1 merges full tables), SPA at public/ap/ (tabs Map/Gathering/
    Recipes/Bestiary/Teleports, 5s poll, pan/zoom + SVG markers), RenderWorldmapPng.ts
    (source = maps-server.zip via Worldmap.ts's decode; FloType.rgb palette with
    hand-picked fallbacks for rgb==0 texture flos; hand-rolled PNG encoder, no deps;
    surface 3584x7424@2px/tile + underground 2432x2304 + meta json - COMMITTED as
    generated artifacts? No: they live only in Server/engine/public/ap, regenerate
    with the tool after map rebuilds). teleport.rs2 overlay tracks casts
    ("teleports" category, key = spell name literal). RegenerateAll.ts now deletes
    ap-tracker.json on reseed (fired-checks ledger intentionally NOT deleted).
    ::aptracker <cat> <key> <val>.
- **Integration state**: install.js run, engine typecheck clean, pack build clean
  (1:43 after the varp.pack workaround), decompile check green for all 11 new/changed
  scripts ([queue,ap_check_fired], ap_grant_check_reward, ap_gear_locked,
  ap_track_kill, all debugprocs), %ap_kills registered, public/ap assets present.
  **In-game verification checklist for the user (nothing tested live)**: ::apchecks,
  ::apcheckfire test_check (expect announce + reward), kill a chicken (first_kill +
  first_kill_chicken), ::apreward xp / ::apreward keepsakes 1, ::apunlock, then
  tools/ap/SetUnlock.ts progressive_melee 0 + try equipping steel (should block,
  bronze fine, delete file to restore), sign a barcrawl bar, open
  http://localhost:8080/ap/ (or :80) and watch discoveries appear, ?spoiler=1 for the
  full map.
- A stray identical-to-live overlays/content/scripts/interface_bank/configs/
  bank.constant snapshot (1024 slots, matches the user's live file) was found
  untracked and committed as-is - it's a no-op overlay; ask the user if it was
  deliberate before ever changing it.

## Session-end addendum: skip-tutorial + random spawn (2026-07-15, same session)

Second parallel-agent round (2 Sonnet agents), same orchestration shape (orchestrator
pre-built shared plumbing: ApSpawnOverrides/ApNewPlayer stubs, opcodes 1907
AP_HOME_COORD + 1908 AP_REROLL_LOOK; next free: 1909). Integrated: typecheck clean,
pack build clean (no new config names -> no staleness race this time), decompile
checks green incl. [queue,player_death] carrying opcode 1907. NOT in-game tested.

- **Skip tutorial** (`node.apSkipTutorial` in world.json, default false; env
  NODE_APSKIPTUTORIAL): hook in new PlayerLoading.ts overlay (both exit points of
  load(); idempotent module-side via %tutorial >= 1000 check). %tutorial varp
  (^tutorial_complete = 1000, quest.constant); pre-setting it before [login,_] runs
  suppresses both tutorial re-entry AND the design screen (allowdesign(true) exists
  only inside tutorial.rs2's start_tutorial). Starter kit copied from
  tutorial_complete label (18 items + 25 bank coins); random look via IdkType
  index (type 0-6 male/7-13 female parts; female jaw legitimately empty -> -1;
  colors sized off Player.DESIGN_BODY_COLORS). Accounts mid-tutorial get skipped
  out on next login while the flag is on - deliberate. Tests: ::apnewlook, ::apkit.
  Open risk (agent-flagged): PlayerLoading mutates x/z/level/vars pre-login same as
  vanilla save-load does, but a live fresh-account login is the real test.
- **Random spawn** (`tools/spawn/RandomizeSpawn.ts [--seed N] [--mode city|chunk]`):
  writes data/config/ap-spawn.json (reseed = rewrite + restart). City = 1 of the 7
  vanilla spellbook landmarks (tool cross-checks live magic_spells.dbrow and warns
  loudly if the teleport shuffle deranged it - home uses vanilla coords regardless).
  Chunk = random mainland square from 127 candidates (surface, mapX>=40, mapZ<=62
  core band, no Tutorial Island/wilderness/Karamja; wilderness boundary VERIFIED:
  x in [2944,3392) & z in [3520,6400), 3520 = mapsquare edge 55, confirmed by both
  Player.isInWilderness() and move.rs2's [mapzone,0_46_55]; >=8 LOCs or >=1 NPC to
  skip ocean; --include-far-west opens mapX<40 back up). death.rs2 overlay = 2-line
  diff using ap_home_coord() (zero-arg command WITH parens compiles fine); ::home
  engine block now reads getHomeCoord(). Test: ::apspawn. KNOWN chunk-mode risk:
  offline reachability is heuristic; if home lands somewhere enclosed, ::home loops
  to the same place - the spoiler prints the square prominently, reroll if bad.
- User answered the progression-simulator design questions (AskUserQuestion):
  logic engine + narrator, hand-authored script-verified requirements JSON, fully
  seed-aware, spheres/steps/story verbosity levels - agent dispatched with that
  spec; see docs/progression-sim.md once it lands.

## Session-end addendum: progression simulator (2026-07-15, same session)

Third agent round (1 Sonnet agent), built to user-locked design decisions (logic
engine + narrator / hand-authored script-verified quests.json / fully seed-aware /
spheres-steps-story verbosity). See docs/progression-sim.md for the schema, model,
simplifications and roadmap. Facts for future sessions:

- `npx tsx tools/sim/SimulateProgression.ts [--verbosity 0|1|2] [--json out.json]
  [--config-dir data/config]` from Server/engine. Exit 0 = all goals reachable,
  exit 1 = blocked (CI-gateable). ORCHESTRATOR-VERIFIED both exit codes against the
  live seed (0) and a scratch all-capped ap-unlocks.json (1, with precise per-skill
  blocker diagnosis incl. recursive chain tracing Heroes'->Lost City->woodcutting/
  crafting caps). Careful measuring exit codes through pipes in zsh - `cmd | tail;
  echo $?` reports tail's status, not cmd's (bit this session).
- quests.json: 63 entries (65 quest dirs minus interfaces + barcrawl-the-goal), QP
  100% verified against quest.constant (sum 135), 21 skill-gated + 5 chain-gated
  quests grep-verified INCLUDING absence-of-gates. Dragon Slayer = %qp>=32 only.
  Vanilla sphere structure: sphere 1 = 57 ungated quests, sphere 2 = Dragon Slayer,
  3 = Heroes/Regicide, 4 = Legends.
- Judgment calls to relitigate via data files, not code: KBD goal uses a
  40 atk/str/def/hp combat floor (no vanilla map gate exists); Karamja/Crandor/
  Zanaris are narrative-only region tags; travel = one connected mainland
  (entrances are flavor because gate pairing is bidirectional).
- Roadmap (in progression-sim.md): AP item-receipt-order simulation, entrance
  flavor mining for -v2, CI gate wiring, --json feed into the browser tracker.

## Session-end addendum: entrance logic - gated areas, gated entrances, seed validation (2026-07-15, same session)

Fourth parallel-agent round (3 Sonnet agents: A enforcement, B inclusion, C region
logic), triggered by a real user bug report: shuffled stairs dropped them inside the
Champions' Guild without 32 QP. Root cause: the guild is gated by its DOOR script
(championdoor, %qp < 32), doors aren't entrances, and the guild's interior staircase
was a legit floor-shift candidate - AREA gates were never modeled, only
entrance-SCRIPT gates (which were excluded). User-directed design pivot, decided via
AskUserQuestion (all recommended options): include gated things + enforce
requirements + validate seeds like a real AP game. Full design:
docs/entrance-logic.md. Integrated: typecheck clean, pack build clean (~1:31),
zanarisdoor bytecode carries opcode 1900, live validator run green, reroll loop
exercised end-to-end. NOT in-game tested.

- **Area gates** (ApAreaGates.ts + data/config/ap-gated-areas.json, 7 curated areas):
  enforcement lives in the AP_ENTRANCE_OVERRIDE handler - on a blocked arrival the
  module messages the player (throttled 600ms - menu-label lookups hit the same path)
  and the op returns the player's OWN tile (telejump no-op; zero content changes to
  block). Same-area transit rule: a player already inside an area's boxes may use its
  interior stairs. Schema v1.1 gained { stat, gte } (BASE level, stricter than
  vanilla's boostable stat() on purpose) - all four require forms
  (varp/stat/item/allOf) must be handled by every consumer. Crafting Guild requires
  level AND worn brown_apron (vanilla parity). Mining/Prayer Guild boxes staged but
  currently unreachable via shuffle (their ladders aren't in the pool) - inert.
- **Gated entrances now shuffle** (workstream B): mcannon dwarf-tower ladder
  ({varp: mcannon, gte: 2}) + Zanaris shed door ({item: dramen_staff}) - handlers
  restructured so the requirement check runs BEFORE the override consult (the
  documented preamble-bypass is now fixed for these), gate guards wherever the
  entrance leads. Zanaris's one-way exit ladder auto-paired with the door into a
  proper connector gate (one-ways 5 -> 4). ap-entrances.json gained a top-level
  `gates` object (trigger "coord:op" -> { require, name }). Black knights ladder
  stays excluded (side-effect, not a gate); bespoke gated transports (spirit trees,
  kalphite burrow, magic-guild portals...) were never in the 353-record baseline -
  documented backlog, not silently included. Parser regression 352/353 byte-identical
  + 1 record gains `requires` only.
- **Region graph + seed validation** (workstream C, tools/logic/): BuildRegionGraph
  flood-fills real collision (maps-server.zip via the engine's own routefinder -
  gotcha: pre-allocate collision zones or canTravel reads NULL=blocked everywhere;
  first symptom was 5.8M singleton regions). 16,455 regions; mainland = id 37
  (Lumbridge/Varrock/Falador/Ardougne/Camelot all in it); doors treated walkable
  UNLESS within 2 tiles of a gated-area box (gated doors split regions, vanilla
  doors don't - their loc configs are indistinguishable, the curated boxes are the
  only signal). ValidateSeed.ts: sphere expansion over regions+gates+quests
  (consumes ap-entrances gates, ap-gated-areas incl. stat form vs skill caps,
  sim's quests.json), exit 0/1, ~2s. Live seed: 464/16455 regions reachable, 63/63
  quests, all 3 goals (KBD's route this seed goes through a shuffled staircase
  straight into the lever room - detected from the real graph, not assumed).
- **RandomizeEntrances now rerolls until valid** (orchestrator wiring): after
  writing, runs ValidateSeed (skips loudly if region-graph.json missing); on exit 1
  re-invokes itself with seed+1 (deterministic convergence), budget 20, opt out
  --no-validate. Exercised: seed 777 wrote 736 overrides + 2 gates and passed.
- **Cross-agent schema evolution worked via SendMessage**: workstream A added the
  stat require form mid-build; the orchestrator updated entrance-logic.md and
  messaged workstream C, which handled it (not fail-open). Pattern to reuse.
- Backlog (user: "later"): entrance-barring by AP check rewards ("Key to X") - the
  gates schema accommodates a future { unlock: <name> } form reading ap-unlocks.json.

## Session-end addendum: placement mode - solo AP (2026-07-15, same session)

Fifth agent round (2 Sonnet agents: engine receipts + tools generator), triggered by
the user finding the sim's -v2 "boring" - correctly diagnosed as "nothing is locked,
checks pay confetti". Design: docs/placement-mode.md (user decisions: full AP
assumed-fill placement; start caps 20 + bronze; pool granularity configurable
--pool per-skill|groups). Integrated: typecheck clean (after fixing my own
newCount reference in the group-expansion edit), pack build clean, decompile checks
green, GenerateSeed --seed 777 --pool per-skill run for real + placement-aware sim
verified. NOT in-game tested.

- **The loop**: GenerateSeed.ts (assumed-fill over 274 locations x 111 progression
  items per-skill / 71 groups) writes ap-placements.json + starting ap-unlocks.json
  + clears fired/tracker state (NEW RULE: a placement seed IS a new run - supersedes
  "fired checks never clear"). ApChecks.fireCheck consults placements: unlock ->
  ApUnlockOverrides.grantUnlock (persist + forced mtime bookkeeping so ensureFresh
  doesn't spuriously reload) -> announce via 3-arg [queue,ap_check_fired](check,
  display, is_unlock); filler/missing/no-file -> old reward roll. No placements
  file = byte-identical old behavior (verified).
- **Quest completions are now watcher checks** (quest_<simid> x63 in ap-checks.json,
  authoritative varp/value source = count_questpoints in quests.rs2). Three
  edge cases: blackarmgang = TWO watches sharing one check id (gang OR-paths);
  cog = bit mode on the step counter's bit 3; horror = a genuine VARBIT -> the
  watch schema gained a "varbit" field (VarBitType-resolved) because raw-varp gte
  would false-trip on sibling bits. ~ap_quest_complete is now a no-op shell -
  the watcher is the single payout path in both modes (double-payout fix).
- **Kill checks were silently outside the placement pipeline** (rs2 enqueued the
  payoff directly, never through fireCheck) - found by the receipts agent, fixed by
  making kills pure %ap_kills bit-writes + 15 bit watches; Player.setVar routes them
  through the same engine path as everything else now.
- **--pool groups uses 4 synthetic keys** (progressive_gathering/artisan/combat/
  support) that grantUnlock expands into member-skill bumps (SKILL_GROUPS map in
  ApUnlockOverrides.ts; MUST stay in sync with tools/sim/PlacementEngine.ts's
  definitions - both sides carry mirror comments). per-skill mode uses only real
  keys.
- **Off-by-one caught by reading the gate code**: tier 0/bronze is unconditionally
  free BEFORE the count comparison in ap_gear_locked + tool gates -> starting
  gear/tool counts are 0, not the doc draft's 1 (doc corrected).
- **Honest depth assessment (tell the user, don't oversell)**: seed-777 per-skill
  validates at ~2 collection spheres and DS reachable sphere 0 - the caps gate only
  the 21 skill-gated quests and milestones; gear tiers gate nothing in logic and
  quest-access gates (unlock family D) are unbuilt. Placement works; DEPTH now
  comes from: family D quest gates as placement items, gear tiers entering the KBD
  combat floor, brutal-start option, entrance/area gates entering the fill's own
  reachability (currently only ValidateSeed sees regions).
- ValidateSeed needs ap-entrances.json present for region traversal (pre-existing;
  GenerateSeed stages a copy) - run entrance rando at least once before placement
  mode on a fresh checkout.

## Hotfix addendum: first live boot crash - circular import TDZ (2026-07-15, late)

The user's first real Windows boot after the placement round crashed the login
worker: `ReferenceError: Cannot access 'Player' before initialization` at
`NetworkPlayer.ts:38` (`export class NetworkPlayer extends Player`). Root cause:
`ApNewPlayer.ts` had a RUNTIME `import Player` (for the `Player.DESIGN_BODY_COLORS`
static), and the login worker's graph reaches Player via PlayerLoading -> ApNewPlayer
BEFORE NetworkPlayer loads - Player was mid-execution (TDZ) when NetworkPlayer's
`extends Player` evaluated. The main thread happened to load in a safe order (boot
reached "World ready"), which is why every offline check missed it - only a worker
entrypoint exposes the alternate order.

**RULE for all Ap* engine modules: `import type Player` ONLY - never a runtime
import of Player (or NetworkPlayer).** Player statics must be read off a passed
instance's constructor (`player.constructor as unknown as { STATIC: T }` - statics
inherit through NetworkPlayer fine). ApUnlockOverrides already duplicated the exp
table for exactly this reason; ApChecks/ApAreaGates were already type-only;
ApNewPlayer was the one violation. Audited all Ap* modules after the fix - clean.

Verified by reproducing the worker's import order directly (no boot needed):
`npx tsx -e "await import('./src/engine/entity/PlayerLoading.ts'); await
import('./src/engine/entity/NetworkPlayer.ts')"` - crashed before the fix's
semantics, loads clean after. Add this graph-order repro to the toolbox: module
init order differs PER ENTRYPOINT, so "the server boots" only proves the main
thread's order.

Also: the esbuild ping-pong hit again right when diagnosing (user had booted from
Windows); the documented npm-install pair restored both platforms.

## Session addendum: problems.txt batch fixes (2026-07-16)

Eight user-reported problems from the first real placement-mode run, fixed by four
parallel subagents (grouped by file footprint so none shared files), then one pack
build + typecheck at the end. Per-problem root causes and rules:

- **Progressive items announcing the wrong tier (bone -> "melee tier 5", fm10 ->
  "rune axe")**: NOT a granting bug - `grantUnlock` always incremented correctly.
  `GenerateSeed`/`PlacementEngine` bake a `display` string into `ap-placements.json`
  from each copy's position in the *simulated fill order*, but players receive copies
  in arbitrary order. RULE: placement `display` strings are spoiler text only; live
  announcements must be rebuilt from the real post-grant count
  (`ApUnlockOverrides.describeUnlock(name, newCount)`, used by
  `ApChecks.resolvePlacement`). `ap-tracker.json` still holds the wrong historical
  strings for the 28 checks fired before the fix - unfixable without an event log.
- **Rewards dropping on full inventory**: `ap_deliver_reward`'s bank fallback treated
  "already carrying one" as "it will fit" - only true for stackables. Gate that
  branch on `oc_stackable($item)` (`ap_rewards.rs2`).
- **Capped XP now banks instead of vanishing**: `Player.clampStatXp` overflow goes to
  perm varps `ap_xpbank_<skill>` (`configs/ap.varp`), re-applied through `addXp`
  (which re-clamps/re-banks) when a cap-raising unlock lands, and on login via new
  opcode `AP_APPLY_BANKED_XP` (1909) called from a one-line `login.rs2` overlay.
  Tradeoff (deliberate): banks overflow from ANY xp source, not just AP rewards -
  no source signal exists inside `addXp`.
- **Subagent gotcha**: the login-XP agent implemented opcode + handler but missed
  recipe step 3 (the `[command,ap_apply_banked_xp]` declaration in content) - pack
  build failed with `'ap_apply_banked_xp' could not be resolved to a symbol`. That
  error message = missing `[command,...]` declaration, fixed in `ap.rs2`.
- **Skill caps display**: `UPDATE_STAT` has no spare field and repurposing `level`
  breaks boost/drain coloring; webclient rebuild out of scope. Shipped `::apcaps`
  (`[debugproc,ap_caps]` via the ungated `::ap<name>` dispatcher) printing every
  cap from the same `20 + 10*count` formula the engine enforces.
- **Lowe's invisible legs**: `man_legs_stitches` - real `.ob2` geometry (passes
  `hasModelData()`) but vanilla only ever uses it as a HIGH-numbered layered
  accessory next to a real legs value (all 5 uses in viking.npc), same class as
  `torso_backpack`. Blacklisted `(man|woman)_legs_stitches` in `isNeverSwappable()`;
  live seed had FOUR victims (lowe, reldo, king_roald, father_lawrence in
  varrock.npc), all restored to vanilla values by hand. RULE: when a named (non
  `_model_<id>`) model renders invisible, check the "only ever layered above a real
  value" pattern before assuming missing geometry.
- **Burnt meat randomized away (Witch's Potion)**: `cooking_generic.dbrow`'s
  `[cooking_burn_meat]` row models the deliberate cooked->burnt action but reuses
  the `cooked` field for it, so `loadCookingProducts()` swept `burnt_meat` into the
  pool. Excluded that block unconditionally in `RandomizeProcessing.ts` (all modes)
  and removed the single live `ap-process.json` entry. RULE: dbrow field scans must
  be block-aware; "action" rows can reuse the primary product field.
- **Rat tail never dropped in mimic mode - by construction**: the derangement
  forbids self-mapping, so the real rat can never roll the table containing its own
  quest-gated tail (it leaked to whoever mimicked rat instead).
  `STRUCTURAL_DROP_HOISTS` in `MimicTransform.ts` hoists the tail block (assert-
  matched against the backup) into rat.rs2's preamble, unconditional, and strips it
  from the mimicable unit. Template for `jail_key`/`hot_feather` if ever reported.
  Process rule: snapshot `engine/data/config/ap-*.json` before any non-dry-run tool
  run against a live seed - the dir is gitignored, there is no recovery path.
- **Tracker "Entrances" list tab**: driven by the same discovery-gated
  `discoveries.entrances` the map gets; names mined from `ap-entrances.json`
  spoiler blocks (`loadEntranceNames()` in web.ts, ~84% coord coverage, tile-coord
  fallback); rows merge A->B with discovered B->A into one "A <-> B", click pans the
  map. Also fixed `/ap/` directory-index serving in web.ts.

End state: install + pack build (2:26) + engine typecheck clean; worker
import-order repro (`PlayerLoading` then `NetworkPlayer`) still loads clean (the
Ap* type-only-Player rule held). Live-seed hand-patches applied to ../Server:
`ap-process.json` (one entry removed), `varrock.npc` (4 legs lines), rat.rs2 +
ap_mimic.rs2 (regenerated via same-seed tool re-run). NOT committed here: the
parallel session's in-flight new-run.sh/GenerateSeed/RegenerateAll/spawn/entrance
tool edits.

## Session addendum: quest combat floors (2026-07-16)

The user flagged Dragon Slayer at sphere 0 in the sim. NOT a requiredQp bug - the
engine enforces it - but 40 of 63 quests had zero requirements, so 32 QP was free
within one sphere and DS unlocked instantly. Fix (user decision via AskUserQuestion:
combat floors now + family D quest-gate items as a second wave; DS itself stays
QP + floor, no unlock item):

- **Combat floors are data-only** (`tools/sim/data/quests.json`), same convention as
  the KBD goal's existing 40 atk/str/def/hp floor: 25 quests with script-enforced
  mandatory kills got atk/str/def/hp floors sized to the hardest kill.
  Curve: kill<15 none, 15-39 -> 25, 40-79 -> 30, 80-119 -> 40, 120+ -> 50.
  Each entry's notes name the boss, level, and the ai_queue3/queue evidence.
  KBD goal raised 40 -> 50 to sit on the same curve (never shallower than Legends).
- **Kill survey method**: grep quest dirs for `[ai_queue3,...]` death handlers, but
  the big bosses advance quests via `queue(player,...)`/`@label` idioms that a
  varp-write regex misses (elvarg, delrith, tree_spirit...) - spot-read those.
  vislevel comes from .npc configs. A few levels (ikov fire warrior, nazastarool,
  dagannoth mother) are era knowledge, debugnames didn't resolve - noted per entry.
- **Verified**: live seed still beatable under stricter logic (ValidateSeed 63/63
  quests, 3/3 goals; DS goal sphere 0 -> 2), fresh GenerateSeed --dry-run converges,
  placement fill spreads quest checks across spheres 2-3 now instead of everything
  in sphere 1. Floors are logic-only - the game does not enforce them.
- **Cap-item semantics reminder**: "+20 <Skill> cap" pool items grant +2 progressive
  counts each (engine cap formula is 20 + 10*count) - looks like a mismatch, isn't.
- **JSON data files are hand-formatted** (leaf arrays/objects inline) - a plain
  json.dump(indent=2) reformats ~400 lines of noise; use a style-matching dumper
  (see this session's approach) or edit lines surgically.
- **Family D scoping done**: no shared quest-START proc exists (only
  send_quest_complete on completion) - quest starts are scattered per-NPC varp
  writes. The viable enforcement seam is engine-side interception of the 0->started
  varp transition in Player.setVar (same routing the kill checks use), with a
  quest-varp -> unlock-key table; blocking mid-dialogue is safe because quest
  dialogue re-reads the varp on every interaction (one-time cosmetic desync only).
  NOT BUILT YET.

## Session addendum: family-D quest gates (2026-07-16, same session)

Built per the user's "Do #2" decision: central engine-side quest-start gating, not
per-quest dialogue overlays. 17 curated quests ("Quest unlock: <name>" single-copy
pool items); DS excluded per the earlier decision. Design facts:

- **The enforcement seam is Player.setVar** - there is no shared quest-START proc in
  this content (only ~send_quest_complete on completion), quest givers write their
  progress varps directly. ApQuestGates.interceptVarpWrite vetoes a gated quest's
  0 -> nonzero varp write when `quest_<id>` isn't received, with a player message.
  One-time cosmetic dialogue desync only: quest dialogue re-reads its varp per
  interaction. PlayerLoading writes player.vars[] directly (never setVar), so save
  restores can NEVER be blocked - verified before building.
- **Gates are seed-declared**: GenerateSeed writes `questGates: [...]` into
  ap-placements.json; the engine loads gates only from that list (old seeds/absent
  file/parse failure = zero gates = vanilla). quest id -> varp resolves through
  ap-checks.json's own quest_<id> watches - no second varp table to drift. That's
  also why curation excludes cog (bit counter), horror (varbit), blackarmgang
  (two-watch OR): the gate rule assumes a plain varp that goes 0 -> nonzero.
- **Logic plumbing**: QuestReq/ReqLike gained optional `gateKey` (attached at load
  by PlacementEngine.applyQuestGates, NEVER present in quests.json);
  Engine.gateSatisfied treats "no unlocks map" as open (vanilla sim path);
  completableQuests/isSatisfied/diagnose take an optional unlocks map - the counts
  map doubles as unlock state since quest_ keys flow through
  applyPlacementItem/grantUnlock generically (both were verified name-agnostic, no
  changes needed). statsAffectedByUnlockKey returns [] for quest_ keys, so the
  banked-XP drain no-ops on them.
- **Cycle avoidance**: QUEST_GATE_LABELS + questGateLabel live in ApUnlockOverrides
  (describeUnlock needs them), and ApQuestGates imports FROM ApUnlockOverrides -
  putting labels in ApQuestGates would have made
  ApUnlockOverrides <-> ApQuestGates circular.
- **Depth payoff measured**: seed 424242 per-skill dry-run went 3 spheres -> 7
  spheres with real chains (Family Crest's unlock inside Doric's Quest's check,
  whose unlock sits in Scorpion Catcher's check). All 128 items placed, all goals
  reachable. Live pre-family-D seed re-validated identical (gates inert on it).
- Test command: ::apquests (mirror of QUEST_GATE_IDS in rs2 - keep in sync; caveat
  in its header about pre-family-D seeds reading LOCKED while inert).
- Verified: typecheck, pack build clean, worker import-order repro still clean
  (Player gained the ApQuestGates import - type-only Player rule respected).
  NOT in-game tested - needs a fresh seed roll (new-run) to actually place gates.

## Session addendum: tracker "Unlocks" tab (2026-07-16, same session)

New tracker tab showing the player's CURRENT unlock state - gear tiers, tool tiers,
all 18 skill caps, and every family-D quest gate (open/LOCKED with an X/17 counter).
`buildUnlocksPanel()` in web.ts composes it server-side from getUnlockCount (fresh
per request - grants mutate ap-unlocks.json mid-play) + questGates from
ap-placements.json; GEAR_TIER_LEVELS/PICKAXE_TIERS/AXE_TIERS/GEAR_FAMILY_LABELS are
now exported from ApUnlockOverrides for it. Not a spoiler surface: shows only items
already received plus the gated-quest LIST (which blocked-start messages announce
anyway), never where the remaining items are placed. present:false (sentinel 99 on
progressive_melee = no ap-unlocks.json = not an AP run) hides the panel with an
explanatory empty-state. Engine/web change only - restart, no pack rebuild.

## Session addendum: quest-region extractor (2026-07-17)

The user challenged the "62 of 63 quests only need the mainland" assumption, and the
data proved them right: `tools/logic/ExtractQuestRegions.ts` (new) statically parses
all quest spatial requirements and found only **8 of 64 quests are satisfiable
entirely on the mainland region**. 56 need review/anchoring (upstairs NPCs behind
shuffle-pool staircases, islands, instances, gated interiors).

- **How it works**: for each quest, gathers rs2 trigger blocks from the quest folder
  PLUS any block tree-wide that touches the quest's varps (declared in
  `configs/*.varp`; quest logic leaks heavily - Dragon Slayer's varps appear in 21+
  non-quest files under doors/, areas/, ladders+stairs/). From each block it
  extracts: trigger-subject entities (`[opnpc1,x]`/`[oploc1,x]`/`[opobj*,x]`/
  `[ai_*,x]`, `_category` subjects expanded via `category=` config lines), zone
  triggers, raw coord literals (comment-stripped, classified by enclosing command:
  p_teleport/p_telejump -> script-edge destination, inzone -> zone corner, else
  generic), and `npc_find`/`npc_add`/`loc_add`/`obj_add` entity refs. Placements come
  from the jm2 `==== NPC/OBJ/LOC ====` sections via pack-file id->name; every tile
  resolves to a region id via region-graph.json.
- **Semantics**: entities with multiple placements are ANY-OF (scripts trigger on the
  entity TYPE - any reachable placement satisfies the interaction; `mainlandOk` =
  some placement is mainland). Static extraction over-collects (can't tell mandatory
  from flavor), so the draft is conservative in the safe direction: it can flag a
  fine seed, never bless a broken one. p_teleport literals also emit draft EDGES with
  same-block context regions as candidate sources (Holy Grail's Karamja<->fisher-realm
  pair extracts perfectly, both directions + correct source region).
- **Output**: `tools/logic/data/quest-regions.generated.json` (~1.6MB, checked in
  like region-graph.json) - per quest: classification (all-mainland/needs-review),
  region rollup, provenance-annotated evidence (`file:line`), edges, flags
  (unresolved-category, unwalkable = cutscene/unbuilt tile, no-placements =
  script-spawned-only). Run from Server/engine:
  `npx tsx tools/logic/ExtractQuestRegions.ts` (~19s, no pack build needed).
- **RegionGraph extracted to tools/logic/RegionGraph.ts** (verbatim from
  ValidateSeed.ts, which now imports it) so the extractor and the planned
  GenerateSeed spawn-distance weighting share one implementation. ValidateSeed
  re-run post-refactor: identical result (474 regions, 63/63 quests, 3/3 goals).
- **Spot-checks that build confidence**: Dragon Slayer -> Duke Horacio upstairs
  (level 1 Lumbridge castle, behind a shuffle-pool staircase) + Guildmaster inside
  the QP-gated Champions' Guild + Crandor +100 instance regions; Imp Catcher ->
  Mizgog level 2 Wizards' Tower. All real, all missed by the single hand-curated
  anchor that existed before. `barcrawl` appears as a 64th "quest" (folder exists,
  sim models it as a goal) - expected, maps to the barcrawl goal.
- **Known limits (v1, documented not silently dropped)**: proc/label calls are NOT
  followed cross-file (varp sweep is the cross-file mechanism; following shared
  helpers like ~set_sail would over-collect wildly); `p_teleport($var)` where the
  var holds a def_coord literal is captured as a generic coord but not as an edge;
  opnpct/oploct spell-subjects and a few `_category` subjects flag as unresolved.
- **Next steps agreed with the user**: (1) review/merge needs-review quests into
  curated quest-regions.json - the review question per item is only "mandatory or
  optional?", the spatial facts are machine-verified; (2) extend quest-regions.json
  schema with any-of anchor groups + derived script edges and teach ValidateSeed to
  consume them; (3) bridge RegionGraph into GenerateSeed for spawn-distance-weighted
  progression placement (assumed fill's uniform candidate pick at
  GenerateSeed.ts:171 becomes distance-weighted - safe, fill only ever places into
  provably reachable locations).
- **Env note**: the esbuild ping-pong fix hit an `ENOTEMPTY`/`Input/output error` on
  a locked `.win32-x64-*` temp dir (Windows-side file lock on esbuild.exe). Harmless:
  if `ls node_modules/@esbuild/` shows BOTH linux-x64 and win32-x64, proceed - the
  leftover temp dir doesn't break either side.

## Session addendum: extracted regions wired into ValidateSeed + region-aware fill (2026-07-17, same session)

The extractor's output is now LIVE LOGIC, not just a draft, and GenerateSeed is
region-aware ("progressive checks by accessibility"). End state: GenerateSeed
--dry-run passes strict validation on attempt 0, deterministic (same seed = same
md5), 37/63 quests region-feasible from scratch, 26 quest checks filler-only.

- **ValidateSeed consumes quest-regions.generated.json** (GeneratedQuestRegions.ts):
  every evidence item = a requirement GROUP (any-of regions, >=1 must be reachable)
  gating quest/goal completion; extracted edges join the fixpoint (step 2b). Curated
  quest-regions.json gained a `generated` section (`ignore` per quest by evidence
  `key`, `ignoreGlobal`) as the human review lever - ignoring is the ONLY relaxation.
  Optimistic edges never enter curated gated-area interiors (step 3 stays the sole
  authority there).
- **Extractor v2 mechanisms** (each added after a triage round, in order of impact):
  (1) WORLD EDGES - quest-agnostic transitions from EVERY block: literal
  p_teleport/p_telejump/~climb_ladder, `case <coord> :` lines give precise triggers
  (reproduces the vanilla ladders+stairs edge set; consumers drop edges whose case
  trigger the seed's overrides replaced), movecoord(coord|loc_coord,dx,dy,dz)
  relatives (region-level resolution absorbs the 1-2 tile player-vs-trigger offset
  that landing-precision work could not), scripted door/gate traversal
  (open_and_close_door/loc_change loc-subject blocks probe flanking regions),
  label/proc/queue delegation depth 1 (caller context -> callee teleport dests;
  arg-driven helpers like ~set_sail have no literals so are naturally skipped).
  (2) ADJACENCY SEMANTICS - interaction evidence (subject/entity-ref/dynamic-spawn)
  is satisfied from ANY region within radius 3 of a placement: ops work through
  fences/bars (Wormbrain's jail, the mourner watchtower). Any-of lists are deduped
  BY REGION before capping (cap 24) so a satisfiable region can't be truncated away.
  (3) INZONE PAIRS - inzone(a,b) corners are a bounding box, not standing spots: one
  any-of group sampled across the box (corners/center/midpoints, all levels in
  span); zone-trigger subjects sample their 8x8 box. Before this fix a grandtree
  inzone corner landed in the 1.1M-tile empty level-3 "sky" region.
- **Triage method that worked**: cluster unsatisfied groups by unreachable region
  (blockedQuests now in ValidateSeed --json), then optimistic-BFS (assume ALL edges)
  to separate cascade blockage from true ROOTS. Roots = real transport gaps.
- **Strictness**: placements present => every non-filler placement must be collected
  by the fixpoint or the seed FAILS ("stranded progression"). New
  `--lenient-placements` downgrades that to a report - used ONLY by
  RandomizeEntrances's reroll loop (it validates before placements are regenerated
  for the new layout; goals-reachability is its contract).
- **RegionFeasibility.ts** (new): maximal-player-state region fixpoint from the
  seed's spawn over the same tables, CONSERVATIVE where the validator is (unknown
  varp gates closed, hero/legends flags closed) so feasibility never exceeds what
  strict validation accepts. Exposes feasibleQuestSet (region + prereq chain + QP
  fixpoint) and questDistanceScore (max over groups of min over tiles of
  hops*10000+euclid from spawn).
- **GenerateSeed**: buildSpatialContext excludes infeasible quests' checks from
  progression (filler-only) and weights assumed fill's location pick by spawn
  distance - rank-geometric GEO=0.93 over score-sorted candidates, one rand() per
  pick, ds stages inherit dragon's score, barcrawl bars the barcrawl score,
  level/xp/kill checks sit at the median (non-spatial). Beatability guarantee
  unchanged (still only picks reachable candidates).
- **Curated additions**: entrana + crandor anchors and their alwaysConnected boat
  edges (monk_of_entrana.rs2 ~set_sail; Dragon Slayer ship) - with radius-3
  adjacency these took the live-config completion from 16/63 to 32/63 and made all
  3 goals green.
- **FOOTGUN (bit this session)**: `install.js` copies the CHECKED-IN
  quest-regions.generated.json over the engine's freshly-regenerated one. After any
  install that should use new extraction: re-run ExtractQuestRegions.ts, and copy
  the result back into overlays/ so the checked-in artifact stays current. Symptom
  of staleness: `[undefined]` evidence keys in ValidateSeed output, wrong edge
  counts.
- **Remaining curation backlog** (quests still region-infeasible from scratch, all
  with known root causes from the triage - each needs either a curated transport
  edge with a script-verified note, or per-quest ignores for cutscene/failure-path
  coords): upass/regicide (Underground Pass obstacle chain + Tirannwn),
  legends/zombiequeen (Kharazi jungle), eadgar/troll (Trollheim), viking (Fremennik
  trial maze), grail remnants (fisher-realm castle doors), haunted (Draynor manor
  top), druidspirit (Mort Myre grotto), desertrescue (mining camp), itwatchtower
  (skavid caves), horror (lighthouse bridge), crest dungeon, elemental_workshop
  bookcase room, seaslug (fishing platform boat), scorpcatcher, elena, fluffs,
  fishingcompo, biohazard (mourner HQ), arena (jail = failure path, likely ignore),
  squire, tbwt, waterfall, ikov, grandtree, sheep/cook/doric/druid gate-cascades.
  The system is safe meanwhile: their checks hold filler, seeds validate green.
- **Live seed status told to the user**: current ap-placements.json predates the
  strict logic - 18 progression items sit on now-provably-stranded checks (strict
  exit 1, lenient exit 0, all 3 goals reachable). A GenerateSeed re-run fixes it but
  resets placement-mode run state - the user decides when.

## Session addendum: full quest-by-quest curation - 63/63 region-feasible (2026-07-17, same session)

The backlog is CLEARED: region-only validation (scratch config, no placements)
completes 63/63 quests, GenerateSeed reports 63/63 region-feasible with 0
filler-only checks and passes strict validation on attempt 0.

- **New extractor mechanism**: `~forcewalk`/`~forcewalk2` (skill_agility's clipped
  telewalk) added to the absolute+relative destination regexes - obstacle crossings
  (desert jail rocks, Elena's sewer pipe) are walks, not teleports.
- **New curated primitive: `openAreas`** in quest-regions.json (consumed by
  ValidateSeed step 2c + RegionFeasibility's hub edges): named boxes whose
  intersecting regions are treated as mutually connected and connected to listed
  anchors. THE scalable answer for quest gauntlets (Underground Pass: ~80 obstacle
  micro-regions; the viking portal maze: ~109) whose internal transitions are
  bespoke handlers. Blanket justification, valid for every entry: ONLY the
  353-record ladders+stairs set is ever shuffled; everything else is
  seed-independent vanilla; item/level needs along the way are narrative-only per
  the sim's documented policy.
- **CRITICAL guard**: upper levels have world-spanning walkable void/roof
  megaregions (level 3: 1.1M tiles, region 3; level 2: 250k, region 29). A box
  overlapping one by a single tile would connect it - and thereby every stray
  cutscene coord on that level worldwide. `OPEN_AREA_MEMBER_TILE_CAP = 100000`
  (largest legit area, Kharazi underground, is ~40k) excludes them in both
  consumers; grand-tree-tops additionally uses tight boxes around the branch
  platforms.
- **23 open areas curated** (underground-pass, tirannwn, kharazi-jungle, trollheim,
  fremennik-trial-maze, fisher-realm, desert-mining-camp, gutanoth-skavid,
  lighthouse, mort-myre, crest-dungeon, elemental-workshop, tamayu-hunt,
  fight-arena-prison, mourner-yard, plague-tunnels, lumber-yard,
  sorcerers-tower-top, grand-tree-tops, baxtorian-falls, temple-of-ikov-depths,
  yanille-dungeon, fishing-platform) + 1 ignore (squire: shared cupboards.rs2
  multi-quest block misattribution). Each entry's note names the vanilla mechanism.
- **Interesting cascade**: Draynor manor top (grail whistle + haunted) looked
  seed-stranded (its spiral stair was shuffled away, one-way pools don't preserve
  arrivals) but became reachable once the open areas connected the regions feeding
  the right shuffled staircase chain - the fixpoint found a route no one hand-traced.
- Sanity level: reachable regions 5154/16455 in the region-only run (not a runaway
  16k), spot-checked goals green, generation deterministic.

## Session addendum: last 5 blockers + the megaregion lesson (2026-07-17, same session)

After the user's fresh run rolled (seed 480430917), 5 quests showed blocked:
upass (+ legends/regicide prerequisite dominoes), tree, squire. All fixed; every
view now 63/63 (live strict, region-only scratch, generator feasibility).

- **squire**: cupboards.rs2's [label,search_cupboard] is the world-wide cupboard
  dispatcher (one switch_coord over every cupboard, %squire in the block) - all six
  non-Vyvin coords ignored, Vyvin's (2_46_52_40_8) kept as the real requirement.
- **tree**: gnome-village-maze open area - the maze center is entered via
  treegnomelooserailing's ~agility_exactmove (computed coords, unextractable). A
  LATENT gap masked until now: earlier entrance tables happened to drop a shuffled
  arrival inside the maze region.
- **upass**: two walkway locs resolve into the LEVEL-1 MEGAREGION (region ~730,
  415k tiles). Curated per-quest ignores; traversal is the underground-pass open
  area's job.
- **MEGAREGION LESSON (tried and reverted)**: filtering level>=1 megaregions out of
  extraction resolution looked principled but regressed region-only completion
  63 -> 51 and dropped 88 world edges. The merged upper-level layers are PARTIALLY
  LEGITIMATE - real upstairs floors merge into them and world edges route THROUGH
  them (stair -> mega landing -> adjacent room). Megaregions must stay in
  resolution/edges; only (a) open-area membership (tile cap) and (b) individual
  evidence items (curated ignores) exclude them. Note to this effect lives in both
  ExtractQuestRegions.ts and quest-regions.json's _notes.upass.
- The user's live run (seed 480430917) validates fully green; its 5
  previously-infeasible checks still HOLD filler (placed before the fix) - harmless,
  just not progression-bearing. A GenerateSeed rerun would make all 274 checks
  progression-eligible but resets run state - offered, user's call.

## Session addendum: all-quests gating + hidden quest tab (2026-07-17, same session)

User: "only 17 gated quests makes it less progressive" -> QUEST_GATE_IDS expanded to
61 (every quest except dragon - prior user decision, goal quest stays 32 QP - and
horror - varbit completion watch, the varp-write veto can't key off it). Pool
128 -> 172 progression items. All shipped-ap-checks.json quest watches turned out
plain-varp (the old "cog bits / blackarmgang OR" exclusions were about START paths,
not watches): start-path leaks are handled by ApQuestGates' new EXTRA_GATE_VARPS
(blackarmgang +phoenixgang, upass +ibanmulti - both PROVEN from update_questlist's
special cases; other quests' alternate paths, if any, fail OPEN = quest startable
despite lock, mild and logic-safe).

Quest tab: new overlays/content/scripts/general/scripts/quests.rs2 (first full
vanilla-file content overlay besides levelrequire) - ~ap_quest_tab_entry wraps all
61 gated entries of ~update_questlist: locked (unlock count < 1 AND progress 0) ->
if_settext "???" + grey 0x5A5A5A; else restore the questlist.if name + vanilla
colour proc. ap_unlock_count returns 99 outside AP runs = vanilla untouched.
Component ids match quest ids EXCEPT fortress -> blackknight. ap_checks.rs2's
unlock-announce branch now calls ~update_questlist so the tab un-hides the moment
the item lands (also flips the sidebar to the quest tab - vanilla-parity behavior
of that proc). Generated programmatically from the vanilla file (CRLF preserved,
names parsed from questlist.if); pack build 1:41 clean. Best-of-5 entrance grading
addendum: RandomizeEntrances grades 5 candidate tables via ValidateSeed
--strict-quests --json on a placements-free scratch dir and keeps the
least-stranded goals-ok one (perfect tables are empirically rare: ~0/20 samples).
Tracker's Unlocks tab reads questGates dynamically - no hardcoded 17 anywhere.

## Session: activity checks + AP caskets (2026-07-17)

Check surface #7 built - 13 activity/minigame checks + the casket junk-reward
category. Full design record in checks-and-unlocks.md section 7; what a future
session needs beyond that:

- **Vanilla trail caskets are NOT stateless** - `[opheld1,_trail_casket_<tier>]`
  is a CATEGORY handler that unconditionally advances the shared `%trail_status`
  progress bits (and its completion test has an RNG tail:
  `add(progress,2) >= maxsteps & random(2)=0`), so gifting a vanilla casket would
  start a phantom trail or short-circuit a real one. That's why
  `ap_casket_easy/medium/hard` exist (no category -> no vanilla handler; own
  opheld1 replicates the tier roll loop + presents via the real trail_reward
  interface, skipping only `~clear_trail_progress`). If a later feature hands out
  clue items, same trap applies to CLUES (opheld also advances state).
- **`%magearena` needed zero hooks** - perm varp 114, strictly increasing
  (1..8: started/4 fights/complete/prayed=cape/staff_given) - gte watches only.
  When surveying a new activity, always check for a lifetime-monotonic perm varp
  FIRST; hooks are the fallback. Counterexamples found: `%trawler` cycles 2<->3
  every round (gte watch would work once but the transition semantics are ugly -
  hooked the queue script instead); course-progress varps are perm but ZEROED on
  lap completion; `%targetscore` resets on judge payout; `%gnomeball_owedball`
  is overloaded (confiscation flag, not a win marker - do NOT watch it).
- **`~ap_activity_mark` bit map lives in three places** that must stay in sync:
  ap_checks.rs2 (comment + hooks), ap-checks.json (`ap_activities` bit watches),
  PlacementEngine.ts `ACTIVITY_LOCATIONS`. Same discipline as the kill list.
- **`LocationDef.fillerOnly`** is the new generic "never holds progression"
  flag (GenerateSeed assumed-fill filter). Trails use it (clue drops are RNG);
  use it for any future luck-gated check.
- The varp.pack staleness race hit AGAIN on `%ap_activities` (third time) -
  `rm content/pack/varp.pack`, rebuild (1:31). obj.pack auto-appended the three
  casket objs fine (ids 3894-3896) without the workaround.
- Verified offline: pack build clean, engine typecheck clean, GenerateSeed
  --seed 777 --dry-run places progression on activity checks (gnome course,
  gnomeball, arena ticket in sphere 0-2), trails stay filler, spheres + all
  three goals still complete. NOT in-game tested. User checklist:
  `::apchecks` (new "Activity flags" line), `::apcheckfire trail_easy_complete`,
  complete a gnome course lap (expect check announce), `::apreward caskets 60`
  (expect a casket -> open it -> trail reward interface, `%trail_status`
  untouched - verify via a real in-progress clue surviving), and a trawler win
  with a second account if convenient.

## Session addendum: music-track checks (2026-07-17, same session)

Surface #8 built - 230 music-track unlock checks, ZERO content hooks. Key facts:

- `music_playbyregion` (move.rs2 -> music.rs2) already does a guarded
  `~music_setvar(varp_idx, bit)` on first entry to any mapsquare in
  musicregion.dbrow - that's a plain POP_VARP setbit on perm `%musicmulti_1..9`,
  so the ApChecks watcher sees it for free. Quest/dungeon areas included (their
  squares are region-mapped too).
- Watch entries + the PlacementEngine MUSIC_TRACK_IDS mirror were GENERATED by
  parsing music.dbrow (track -> unlock=(varp 1-9, bit); 230/233 tracks have one,
  Newbie Melody doesn't; all pairs unique; check id = music_<name sanitized to
  snake_case>). If content ever changes, regenerate rather than hand-edit - the
  parse script shape is in the git history of this session (scratchpad, not
  committed; ~30 lines, trivial to rewrite).
- Kind 'music' is fillerOnly at buildLocationCatalog (not per-def): 230
  always-reachable locations would swamp assumed fill (progression would mostly
  land on "walk to region X"). Flip = one line, documented in
  checks-and-unlocks.md section 8. Pool now 517 locations / 172 progression /
  345 filler; seed 777 dry-run still places 172/172 and completes all goals.
- Pre-AP consequence the user should feel in-game: every first visit to a new
  music region announces a check + rolls a reward. If that's too much loot,
  thin ap_random_category's odds or give music checks a cheaper payoff branch
  keyed off the "music_" id prefix in [queue,ap_check_fired].
- No new varps -> the varp.pack staleness race did NOT apply this time (only
  ap-checks.json + tools changed; no pack rebuild needed at all, install.js +
  typecheck + dry-run was the whole verification loop).
