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

## Where this is heading (agreed with the user)

Priority order discussed:
1. ~~Entrance randomization~~ (done: connector + floor-shift pools, --mixed flag)
2. ~~Any-source placements via a `.jm2` LOC scanner~~ (done for
   trapdoor/cellar-ladder types; more surface loc types remain - see unpaired
   scanned placements in the spoiler)
3. Drop randomization, shop-location shuffle, NPC cosmetic ("drip") shuffle - see
   [archipelago-ideas.md](archipelago-ideas.md); reuse the override-table pattern
4. Actual Archipelago protocol integration (AP world Python package, item/location
   handling, `xpRate`/`NODE_XPRATE` as a slot option, junk rewards straight to bank
   via `inv_add(bank, ...)`)

## Session-end state (2026-07-13)

- Everything through commit `c32ddbd` is installed into the user's Server checkout
  and pack-rebuilt. Current table: seed 777, **315 overrides** (48 connector gates
  incl. 39 map-scanned, 107 floor-shift gates, 5 one-ways), coord+op keys.
- **Verified in-game by the user**: the original 23-override cross-map shuffle
  (server logged `loaded 23 redirect(s)`, entrances redirected). Everything after
  that - the floor-shift pool, scanned cellar gates (incl. cook's basement), the
  walkability nudge, and especially the coord+op keying - is verified only by the
  offline checks (typecheck, pack build, loader unit test 315/315, machine
  round-trips 155/155), **not yet by playing**.
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
