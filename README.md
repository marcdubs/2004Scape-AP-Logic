# 2004Scape-AP-Logic

Archipelago randomizer logic and tooling for [2004scape](https://github.com/LostCityRS) (Server/Engine-TS/Content), targeting **[LostCity](https://github.com/LostCityRS) revision 274**.

This repo does **not** fork [LostCityRS](https://github.com/LostCityRS). `Server`, `engine`, `content`, `webclient`, and
`javaclient` stay plain, unmodified [LostCityRS](https://github.com/LostCityRS) checkouts (a sibling directory, set up
the normal way via `Server/start.sh`). Everything Archipelago-specific lives here
instead, and gets deployed on top via `scripts/install.js`.

Yes, I used a whole lot of AI to build this, driving it with a lot of human design and testing. Documentation is often written by AI too in order to keep it up to date with the codebase. Documentation that is useful to the AI is also useful to humans, so I keep it in the repo. It also allows for future improvements to be built with the full context of what came before, in both documentation and code. The AI is not perfect, but it is a force multiplier for me and for you.

Current release: **v2** (2026-07-26) - see [CHANGELOG.md](CHANGELOG.md) for what
landed in it.

**New session / new agent?** Read [docs/lessons-learned.md](docs/lessons-learned.md)
first - it captures the architecture decisions, the rs2/engine recipes, the
environment gotchas, and where the project is heading.

## Quick start (for humans): set up, connect, play

The short version of a full evening: roll a seed, host an Archipelago server,
boot the game server, open the tracker, connect, play. Steps 1-2 are one-time.

### 1. One-time: game-server setup

Prereqs: the `Server/` [LostCityRS](https://github.com/LostCityRS) checkout as a **sibling** of this repo (set up
the normal [LostCityRS](https://github.com/LostCityRS) way), **Node 24+** (the engine declares
`"engines": { "node": ">=24" }`; this project's `.nvmrc` pins 24.18.0), and
**Python 3.11+** for the Archipelago server - 3.12 is what this is developed
against, and the Archipelago version pinned here refuses anything outside
`3.11 <= x < 3.14` outright. Use **revision 274** for the checkout - it's the
only revision this project has been tested against; other revisions may work,
but you use them at your own risk. Any OS works; the game server and the
Archipelago server can be the same machine or different ones.

```
node scripts/install.js                             # deploy this repo's overlays -> ../Server
cd ../Server/engine
npx tsx tools/pack/Clean.ts                         # only if this server was EVER built before
npx tsx tools/pack/Build.ts                         # one content pack build (~2 min)
```

**Clean first if the server has ever been packed** - which it has if you set it
up the normal LostCityRS way, because that builds vanilla before you get here.
The pack is incremental and decides what to redo by mtime, so overlays landing
on an already-built server leave the generated cache *newer* than the sources
it came from: the config step is skipped as up to date while the AP registry
entries it never packed are already listed. See the third troubleshooting entry
below for what that looks like when it bites.

`install.js` also sets `build.verify: false` (and `verifyFolder`/`verifyPack`)
in `Server/engine/data/config/world.json` - AP content adds objs/varps, so the
packed cache can never match the vanilla checksums and the engine's
`BUILD_VERIFY` safety check would fail the build with a "checksum mismatch!"
error. Your other `world.json` settings are preserved.

Troubleshooting the pack build:

- **A build failed once and now fails differently** (e.g. "Invalid property
  value" on an `ap_*` config): the aborted run left stale generated registries
  and mtime stamps behind. Run `npx tsx tools/pack/Clean.ts` in
  `Server/engine`, then build again (the post-clean build does a full ~2 min
  crawl).
- **`Cannot read properties of undefined (reading 'type')`** and nothing else -
  no file, no id. `data/pack` holds a vanilla build while `content/pack` holds
  the AP registry, so `Compiler.ts` walks the registry (382 varps, 3902 objs)
  and looks each id up in a binary that only has the vanilla ones (360 / 3895);
  the 23 `ap_*` varps come back `undefined`. It needs BOTH halves to appear:
  config outputs newer than their sources, so the pack step skips them, and
  newer `.rs2` files, so the compiler still runs and reads the mismatch. Fix is
  the same `Clean.ts` + rebuild - and doing that up front is why the build block
  above starts with it.
- **`tsx` dies with an esbuild platform error** (can happen when the same
  checkout is used from two OSes, e.g. Windows + WSL):
  `cd ../Server/engine && npm install`, then additionally
  `npm install --no-save --force @esbuild/<the-other-platform>`
  (e.g. `@esbuild/win32-x64`) if you keep switching back and forth.

`install.js` also seeds the optional flags into
`Server/engine/data/config/world.json` at their defaults so they're easy to
find (values you've already set are never overwritten): `web.port: 8080`
(tracker/client port, matches the examples below), `apSkipTutorial: true` (new
accounts skip Tutorial Island - set `false` for the vanilla tutorial),
`xpRate: 1` (the XP multiplier - worth raising to match your multiworld's
pace; see the "Game-server tweaks" section of
[docs/ap-yaml-options.md](docs/ap-yaml-options.md) for recommendations), and
`infiniteRun: false`.

### 2. One-time: Archipelago server setup

The archipelago.gg website can't generate for custom worlds, so self-host.

**The short way - a prebuilt image.**
[marchipelago](https://github.com/marcdubs/marchipelago) is an Archipelago
WebHost image with this world already baked in and Archipelago pinned to the
exact commit its test suite is validated against, so there is no venv, no
`requirements.txt`, and no apworld to copy:

```
docker run -d --name marchipelago -p 8080:8080 -p 38281-38380:38281-38380 \
    -e GAME_PORTS=38281-38380 -v marchipelago-data:/home/container \
    ghcr.io/marcdubs/marchipelago:latest
```

Open `http://localhost:8080`, upload the YAML below on the player-options page,
and generate from the host page - then skip to step 3. (The image is rebuilt
from this repo's `main`, and also ships a Pterodactyl/Pelican egg.) Note it
serves the WebHost on 8080, the same default the game server's tracker uses -
put them on different machines, or move one of the two ports.

**The manual way.** Clone anywhere you like, then follow the guide for your OS.

**macOS / Linux (or WSL):**

```
git clone --depth 1 https://github.com/ArchipelagoMW/Archipelago.git
cd Archipelago
python3 -m venv venv
./venv/bin/pip install "setuptools>=75,<81"
./venv/bin/pip install -r requirements.txt
mkdir -p custom_worlds Players
```

**Windows (PowerShell or cmd):**

```
git clone --depth 1 https://github.com/ArchipelagoMW/Archipelago.git
cd Archipelago
python -m venv venv
.\venv\Scripts\pip install "setuptools>=75,<81"
.\venv\Scripts\pip install -r requirements.txt
mkdir custom_worlds
mkdir Players
```

Then install the 2004Scape world: run `python build.py` (macOS/Linux:
`python3 build.py`) inside `<this repo>/apworld` and copy the resulting
`rs2004scape.apworld` into `<Archipelago checkout>/custom_worlds/`.

Finally create a player YAML, `<Archipelago checkout>/Players/<Insert Username>.yaml`:

```yaml
name: <Insert Username>
game: 2004Scape
2004Scape:
  goal: dragon_slayer      # or barcrawl / kbd / heroes / legends
  extra_goals: []          # e.g. ["kbd"] - ALL listed goals also required for victory
  progressive_quests: false # one difficulty-ordered "Progressive Quest Unlock" item instead of 61 named ones
  music_checks: false      # 230 extra "first visit to each music region" checks
  gather_speed: 200        # mining/woodcutting/fishing success rate, % of vanilla (100 = untouched)
  region_logic: true       # default. Archipelago reasons about where things physically are,
                           # and rolls the world (entrances, gathering, processing, shops,
                           # drops, spawn) itself so the fill matches what you will play.
```

`name:` is your **slot name** in the multiworld - it's how the game server
identifies itself to Archipelago and how other players see you. It does NOT
need to match your in-game character name: the whole game server plays as this
one slot (checks, received items, and unlock state are server-wide), so you can
log in with any account.

Every YAML option - the 2004Scape ones, the standard Archipelago ones
(`start_inventory`, `exclude_locations`, hints, plando...), and the full
item/location name lists they take - is documented in
[docs/ap-yaml-options.md](docs/ap-yaml-options.md).

### 3. Per run (solo, no AP server): roll a randomized seed and play

```
bash scripts/new-run.sh        # from this repo (Windows: scripts\new-run.bat)
```

Every stage (entrances, drops, gathering, processing, spawn, placement...) is a
documented knob inside the script. It ends with a validated entrance table, a
zeroed unlock state, and cleared check/tracker ledgers. The GenerateSeed stage
placed items locally, so that's the whole setup: skip steps 4-5, boot the
server, and play.

It is **spoiler-free by default** - every stage prints counts, not tables, so
you can watch it run without learning your own seed. Add `--verbose` (or
`VERBOSE=1`) to print the swap tables, the rolled home, the goal list and the
sphere-by-sphere walkthrough. Either way each randomizer writes its complete
table to a spoiler file next to the tool (`tools/gather/gather-seed.json`,
`tools/process/process-seed.json`, `tools/thieving/thieving-seed.json`,
`tools/map/entrance-seed.json`, `tools/map/teleport-seed.json`,
`tools/drops/drop-seed.json`, `data/config/ap-spawn.json`), so nothing is lost
by keeping the console quiet.

**Archipelago run? Don't roll yet.** The seed roll must happen AFTER the game
server has connected to the multiworld (step 5) - connecting is what delivers
your YAML's randomization options to the server. Rolling first silently uses
the script's own default knobs instead of what the YAML asked for.

### 4. Per run (Archipelago): generate + host the multiworld

From the Archipelago checkout. Generation writes `output/AP_<id>.zip`; open it
with any unzip tool and pull the `AP_<id>.archipelago` file out next to it,
then host that file.

**macOS / Linux (or WSL):**

```
./venv/bin/python Generate.py --player_files_path Players --outputpath output
unzip -o output/AP_<id>.zip -d output "*.archipelago"
./venv/bin/python MultiServer.py --host 0.0.0.0 --port 38281 output/AP_<id>.archipelago
```

**Windows (PowerShell or cmd):**

```
.\venv\Scripts\python Generate.py --player_files_path Players --outputpath output
tar -xf output\AP_<id>.zip -C output AP_<id>.archipelago
.\venv\Scripts\python MultiServer.py --host 0.0.0.0 --port 38281 output\AP_<id>.archipelago
```

Leave that terminal running. Server state lives in `output/AP_<id>.apsave` next
to the multidata - delete it to reset the run, regenerate for a new seed.

#### The spoiler log

The same zip also holds `AP_<id>_Spoiler.txt` - pull it out the same way
(`unzip -o output/AP_<id>.zip -d output "*Spoiler.txt"`, or Windows
`tar -xf output\AP_<id>.zip -C output AP_<id>_Spoiler.txt`). No extra flag is
needed: Archipelago's shipped `host.yaml` defaults to `spoiler: 3`, which is
the full log including the playthrough. (`--spoiler 0` turns it off, `1` drops
the playthrough.)

Alongside AP's own sections (options, every location's contents, the
sphere-by-sphere playthrough), 2004Scape writes **the world it rolled** - none
of which Archipelago could report on its own:

```
World seed:                      2769643227
Home / spawn:                    Varrock (0_50_53_13_32)
Entrance layout:                 808 redirect(s), 777/808 pool sides reachable
Gathering swaps:                 38 (shuffle, 1 pinned vanilla)
Processing swaps:                252 (shuffle, 0 pinned vanilla)
Shops relocated:                 113
Drop tables mimicked:            95 monster(s)
```

followed by the full tables - every gathering/processing swap
(`coal -> charcoal`), every shop relocation (`bob now stocks miningstore`),
every drop table (`_chicken drops like black_knight_drops`, or per-slot
`brawling_bandit (rare): iron_scimitar -> firerune` in tiered/chaos mode), and
every entrance redirect. Reading it spoils the run completely, which is the
point - it is the reference for "is this seed doing what I asked", and the
first thing to attach to a bug report.

### 5. Per run (Archipelago): connect, THEN roll the seed, then play

1. Start the game server as usual (`cd Server/engine && npx tsx src/app.ts`,
   wait for `World ready`).
2. **Connect to Archipelago**: open the tracker at http://localhost:8080/ap/ ->
   **Archipelago** tab -> host `localhost` (or wherever the AP server runs; a
   WSL-hosted server is `localhost` from Windows), port `38281`, slot name from
   your YAML -> **Test connection** (expect "2004Scape slot hosted ✓") ->
   **Save & Connect**. The status panel flips to *connected*. (Headless
   equivalent: write `Server/engine/data/config/ap-archipelago.json` by hand.)
   On connect the server adopts the room's live options (goal + extra goals,
   music checks, item-family toggles, relics, infinite run, gather speed,
   progressive XP rate - all applied without a seed roll), rebuilds
   `ap-placements.json` with just the seed's quest gates (the multiworld owns
   item placements), and writes your YAML's randomization options to
   `data/config/ap-seed-options.json` for the seed roll to pick up.
3. **Roll the world**: `bash scripts/new-run.sh` (Windows:
   `scripts\new-run.bat`) - both auto-adopt `ap-seed-options.json`, overriding
   their own knobs, so the world matches what the YAML asked for. The roll
   also removes the local `ap-placements.json` automatically (the multiworld
   owns item placements; the server rewrites the file with the room's quest
   gates when it reconnects). Then **restart the game server**; it reconnects
   to the room on boot.

   What "matches what the YAML asked for" means is stronger than it sounds:
   Archipelago rolled this world *during generation* so its fill could reason
   about it, so the file pins **the seed itself**. Every randomizer the script
   runs (gathering, processing, shops, drops, spawn) is deterministic, so it
   reproduces Archipelago's tables exactly. Entrances skip the roll entirely -
   that table arrives finished in `slot_data` and the client writes it on
   connect. This is why rolling before connecting produces a *different world
   from the one the multiworld was filled against*, and why the order matters.
4. **Game client**: http://localhost:8080/rs2.cgi - play. The tracker shows
   map, discoveries, and unlocks as you go. Checks announce in chat as you
   complete them, received items apply immediately (gear tiers, skill caps,
   quest unlocks) and are announced in-game, and reaching your goal (plus any
   extra goals) reports victory to the multiworld automatically.

#### What the seed roll touches (and what it leaves alone)

Rolling after connecting is safe: `new-run.sh`/`.bat` never touch your
Archipelago connection or the settings the room handed down.

- **Never written.** `ap-archipelago.json` (host/port/slot/password) and
  `ap-options.json` (the room's live toggles - music checks, item families,
  relics, infinite run, gather speed, progressive XP). No tool in the pipeline
  writes either; the seed roll only reads `ap-options.json`. Reconnecting after
  the restart re-applies the room's toggles anyway.
- **Preserved, not re-rolled.** `ap-entrances.json`, when the layout came from
  `slot_data`: the adoption step forces the entrance stage off *and* keeps the
  file, precisely so the map the multiworld's fill reasoned over survives. (A
  genuinely vanilla-entrance run is the only case where the file is removed.)
- **Rewritten, but to the same tables.** `ap-gather/-process/-thieving/-spawn/`
  `-drops.json` plus the content pack. These are re-rolled from the seed
  Archipelago pinned in `ap-seed-options.json`, and every tool is deterministic,
  so they come back identical to what the fill assumed.
- **Deleted on purpose.** `ap-placements.json` - the multiworld owns item
  placement, and the server rewrites the file with the room's quest gates when
  it reconnects.
- **Reset, because a roll IS a new run.** `ap-unlocks.json` (zeroed),
  `ap-checks-fired.json`, `ap-tracker.json`, and `ap-session.json` - the AP
  client's `receivedCount` plus the checks it already reported. That last one
  has to go with the others: the roll zeroes `ap-unlocks.json`, so a surviving
  session would make the room's replay-on-reconnect get skipped as "already
  applied" (leaving those unlocks at zero) and would re-report the old run's
  checks into the new room. The room is the source of truth and resends
  everything on connect, so nothing is lost.

Note: `npx tsx tools/sim/SimulateProgression.ts` reports on the seed's own item
placement, which in AP mode the room owns - so it detects the item-less
`ap-placements.json`, says so, and falls back to the vanilla quest-graph report
instead of pretending everything is unreachable. The AP-mode sanity check is
`npx tsx tools/logic/ValidateSeed.ts` (the spatial layer); item-layer soundness
is Archipelago's own generation.

Full details: [docs/archipelago-integration.md](docs/archipelago-integration.md)
and [apworld/README.md](apworld/README.md).

## Layout

- `docs/` - design docs and process/domain knowledge
  ([lessons-learned.md](docs/lessons-learned.md) is the entry point).
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
quest-gated entrances, and Tutorial Island (six mapsquares, read from the game's own
`tutorial_island.dbrow` by `tools/shared/TutorialIsland.ts`).

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

If an NPC ends up looking broken, `AuditDripModels.ts` is the diagnostic:

```
cd Server/engine && npx tsx tools/npc/AuditDripModels.ts                   # whole pool: geometry, exclusions, review list
cd Server/engine && npx tsx tools/npc/AuditDripModels.ts --npc bob         # one npc: vanilla -> current, with each model's geometry
cd Server/engine && npx tsx tools/npc/AuditDripModels.ts --category man_legs
```

It reads the actual `.ob2` vertex bounds (`ModelGeometry.ts`) plus how vanilla wears
each value, which is what the swap-pool exclusion rules in `NpcDripParser.ts` are
derived from - a piece vanilla only ever layers on top of a real one, a piece that
doesn't reach its category's ground line, or a torso mesh that includes a head all get
gated out of the sample-into pools. Point `--npc` at whatever looked wrong and it names
the model.

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
they're actually selling (chaos/comedy variant, from the original design
brainstorm). Default carries the whole bundle so the shop still makes internal sense
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
- `CapDropRarity.ts` - the drop-RATE pass (no seed, no items): rewrites cascade
  thresholds so no loot slot is rarer than `--min-rate` (default 1/32). Orthogonal to
  every swap mode above and runs after them - see "Rarity cap" below.
- `SimulateDrops.ts` - rolls one monster's real loot table N times and prints what fell
  out, vanilla vs capped side by side. Writes nothing; the capped column is computed in
  memory, so it's safe to run before or after the cap is applied.
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
cd Server/engine && npx tsx tools/drops/CapDropRarity.ts [--min-rate 1/32] [--dry-run] [--exclude <substr,substr,...>]
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
- Every mimicked kill prints `Smells like <monster>...` to the killer's chat (the
  source table's npc display name, also recorded as `nowName` in the spoiler). Only
  redirected kills print - the vanilla fallthrough path is silent.

### Rarity cap (GitHub #11)

`CapDropRarity.ts` guarantees no monster loot slot is rarer than `--min-rate` (default
1/32 ≈ 3.1%). Vanilla rates go down to 1/512, and in a randomizer a required item can
end up behind exactly one of those rolls - which is a wall, not a check. It is a
rate-only pass: it rewrites `if ($random < N)` thresholds and never touches which item
sits in a slot, so it composes with `tiered`/`chaos`/`mimic` in either order and needs
no seed (it is fully deterministic). Run it after `RandomizeDrops.ts`, then rebuild the
pack; `RegenerateAll.ts` does this for you (`--skip-rarity-cap` opts out, `--min-rate`
passes through). Spoiler is `engine/tools/drops/drop-rarity-cap.json`.

Where the extra probability comes from - the actual design decision, since a floor is
not free:

1. the cascade's no-drop tail (rolls above the last threshold) is spent first, down to
   zero if needed;
2. the remainder comes proportionally out of the branches already at or above the
   floor, never pushing any of them below it.

Step 2 is not optional: 46 of the 63 vanilla cascades need more than their entire
no-drop tail to floor everything, and 9 of those (black demon, blue/green/red dragon,
imp, fire giant, guard, chaos dwarf, kalphite queen) have no tail at all - their
cascades already cover the full denominator. The visible cost is that common slots (coins, low-tier junk) shrink by
roughly 15-25% in a typical table. Vanilla rarity ORDER is preserved: donors shrink in
proportion to their surplus, so a 20% slot stays rarer than a 30% one.

Applied to the vanilla corpus at 1/32 this raises 721 of 1212 branches across 62 of the
63 cascades (chicken's two-branch table is already above the floor). Notable results:
bandit's 1/128 steel axe becomes 4/128; werewolf's 1/512 `~randomjewel` becomes 16/512;
imp's 32-branch table becomes exactly uniform at 4/128 each - 32 branches at a 1/32
floor is the arithmetic limit, and imp is the one table that hits it.

- The unit is the cascade BRANCH, not the item slot: a branch fires as a whole, and a
  few branches hold two mutually-exclusive `obj_add` calls behind a `map_members` check.
- Branches that call a shared proc (`~randomherb`, `~randomjewel`, `~ultrarare_getitem`)
  are floored like any other branch - the pass has no opinion on what the proc returns.
  The procs' own internal tables are NOT capped (they use an assignment form,
  `$random = random(128)`, that isn't a cascade for parsing purposes) except
  `megararetable`, which is a real `def_int` cascade and does get capped.
- Vanilla's one explicit "nothing dropped" branch (guard.rs2) is not a drop, so it is
  never floored - it donates like any above-floor branch.
- In mimic mode the generated `ap_mimic.rs2` is capped too (that's where the loot tables
  that actually run live); the cascades left behind in the handlers are the no-override
  fallback and get capped as well.
- If a cascade can't fit the floor inside its own denominator, the whole cascade is
  scaled up (`random(6)` -> `random(24)`) rather than distorted. No vanilla cascade needs
  this at 1/32; a coarser `--min-rate` can. A cascade with more drop branches than the
  floor allows (>32 at 1/32) is impossible by arithmetic - it warns and stays vanilla.

### Seeing it: the drop simulator

```
cd Server/engine && npx tsx tools/drops/SimulateDrops.ts <npc> [--kills 10000] [--seed <n>] [--min-rate 1/32] [--live] [--list]
```

Rolls that monster's actual cascade `--kills` times and prints the result twice - vanilla
weights and capped weights, same seed, so the only thing that differs between the columns
is the table:

```
$ npx tsx tools/drops/SimulateDrops.ts werewolf --kills 5000
_werewolf (werewolf.rs2, vanilla backup) - 5,000 kills, seed 777, floor 1/32

drop                            VANILLA                  CAPPED
                       rate     sim   count       rate     sim   count
~randomjewel          1/512   0.18%       9       1/32   3.24%     162
rune_med_helm       1/170.7   0.52%      26       1/32   3.24%     162
mithril_chainbody    1/51.2   1.68%      84       1/32   2.74%     137
steel_scimitar         1/16   6.30%     315     1/18.3   5.62%     281
coins                 1/3.2  32.00%    1600      1/3.7  27.74%    1387

rarest drop: 1/512 -> 1/32; drops rarer than 1/32: 9 -> 0
nothing at all: 0.59% -> 0.00% of kills
```

`--live` reads the installed content instead of the vanilla backup (including
`ap_mimic.rs2`), which is how you check what a running server would actually give you.
`--list` prints all 63 tables. `rate` is the table's exact odds and `sim`/`count` are the
simulated results, so the two agreeing is the sim checking itself.

Rows are one cascade BRANCH each, which is why a `~randomherb` branch shows as a single
outcome (the proc's own table is out of scope for the cap) and why a `map_members`
branch shows as `bloodrune | body_talisman` - one roll, two possible items. `death_drop`
(bones/ashes) is reported separately when the npc config resolves, since it's guaranteed
and outside the roll.

### Scope

Only the 73-file monster drop-table corpus and the `death_drop` npc param are in
scope - the shared reward sub-tables called via `~procname` (`~randomherb`,
`~randomjewel`, `~ultrarare_getitem`, `~megararetable`, `~randomjunk` in
`shared_droptables.rs2`) and any `obj_add(...)` drops outside that folder (quest/area
scripts) are deliberately left untouched. (Scope here means WHICH ITEM sits in a slot -
the rarity cap above is a rate-only pass with its own, slightly wider scope: it also
floors `megararetable`'s branches.)

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

## Gathering randomization (mining / fishing / woodcutting)

Shuffles which item each gathering action actually hands the player - cut a tree and
get a fish, fish and get a log, mine a rock and get either. Runtime-override design,
the same plumbing as entrance randomization and drops `--mode mimic`: reseeding
rewrites a JSON table and needs a server restart only, no pack rebuild. Deleting
`engine/data/config/ap-gather.json` restores vanilla gathering.

### Pieces

- `overlays/engine/src/engine/ApGatherOverrides.ts` - runtime loader for
  `engine/data/config/ap-gather.json` (obj id -> obj id). Unlike the entrance/mimic
  loaders, a **miss returns the input id unchanged** (vanilla passthrough) rather than
  -1 - the natural miss semantics for an item transform, and it keeps every content
  hook a pure one-token wrap with no null branch.
- `ScriptOpcode.ts` / `ServerOps.ts` - `AP_GATHER_SWAP = 1902`, declared in
  `ap/ap.rs2` as `[command,ap_gather_swap](obj $product)(namedobj)`. The return type
  is `namedobj` (not `obj`) because `inv_add`'s item param is namedobj-typed and obj
  doesn't coerce upward.
- Whole-file overlays of the vanilla skill scripts, each delivery point wrapped as
  `inv_add(inv, ap_gather_swap($product), 1)` (12 wraps total, seed-independent -
  one pack rebuild ever):
  - `skill_mining/scripts/mining.rs2` - normal/fast/essence rock outputs (3)
  - `skill_woodcutting/scripts/woodcut.rs2` - `get_logs` (1)
  - `skill_fishing/scripts/fishing.rs2` - `fish_roll`/`fish_roll_loc`, the chokepoint
    every fishing spot calls (4)
  - `skill_fishing/scripts/fishing_spots/memberfish.rs2` - big-net mackerel/cod/bass (4)
- `overlays/engine/tools/gather/RandomizeGathering.ts` - builds the product pool from
  the game's own data (`mine.dbrow` rock_output, `trees.dbrow` product,
  `~fish_roll`/`~fish_roll_loc` call-site literals + the big-net wraps), writes the
  JSON table and a spoiler at `engine/tools/gather/gather-seed.json`.
- `overlays/engine/tools/gather/FishingLevels.ts` - the level side of that pool.
  Mining and woodcutting state their requirement in a dbrow column; fishing has no
  product table at all, so this walks the spot scripts' `stat(fishing) < N` /
  `>= N` guards (including the one that hides behind
  `~oil_rod_fishing_check_requirements`) and reports the level each fish first
  becomes catchable at. Only `--mode tiered` uses it.
- `::apgather <item_debugname>` test command (e.g. `::apgather logs`) - prints what a
  product is randomized into, via the same engine lookup the skill scripts use.

### Usage

```
cd ../Server/engine
npx tsx tools/gather/RandomizeGathering.ts [--seed <n>] [--mode shuffle|tiered|chaos]
    [--skills mining,fishing,woodcutting] [--exclude <item,...>]
    [--pin-quest-items] [--no-quest-pins] [--dry-run]
```

- `shuffle` (default): one derangement across the combined ~39-product pool - a
  bijection, so every product is still obtainable from exactly one gathering action
  and nothing maps to itself. Seed 777: 38 swapped, 30 land cross-skill.
- `tiered`: the same derangement run separately inside each **progression band**
  (`lvl1-14`, `lvl15-29`, `lvl30-44`, `lvl45-59`, `lvl60-74`, `lvl75+` - see
  [Progression bands](#progression-bands-mode-tiered)). Still cross-skill and still a
  bijection, but a level-1 fish can only become a level-1 ore or log and Runite stays
  behind something you actually need 75+ for. Seed 424242: 38 swapped, 26 cross-skill.
- `chaos`: every product independently resamples from the pool - duplicates allowed,
  so some products can become unobtainable from gathering entirely.
- `--skills` restricts which skills join the pool; unselected skills stay vanilla.

**Quest-critical pinning is mode-aware**, unlike drop randomization's always-on pin:
the `inv_total`/`inv_del` gating scan flags 16 of the 39 products (every log type,
most basic ores) because common gathering products gate quests constantly. Shuffle
and tiered don't pin by default - they're bijections, everything stays obtainable, a
quest just needs its item gathered from a different action (the spoiler says which).
Chaos genuinely can orphan a product, so it pins by default. Override with
`--pin-quest-items` / `--no-quest-pins`.

### Scope

Only the *item that lands in the inventory* changes. Success chances, xp, level
requirements, bait consumption, and the catch/mine messages all stay vanilla - "You
manage to mine some coal." followed by a raw shark in slot 1 is intentional. Stays
vanilla by design: the mining gem bonus roll, Shilo gem rocks, big-net junk catches
(boots/seaweed/oyster/casket), the Tai Bwo Wannai karambwan minigame, the Family
Crest perfect-gold branch, and the Tourist Trap punishment rock (`thpunishrock`,
hard-excluded).

## Processing randomization (cooking / smithing / crafting / fletching)

Shuffles which item each processing recipe actually hands the player - smith some ore
and get a cooked fish, cook some meat and get leather chaps. Same runtime-override
design as gathering: reseeding rewrites a JSON table and needs a server restart only,
no pack rebuild. Deleting `engine/data/config/ap-process.json` restores vanilla
processing.

### Pieces

- `overlays/engine/src/engine/ApProcessOverrides.ts` - runtime loader for
  `engine/data/config/ap-process.json` (obj id -> obj id). Same vanilla-passthrough-
  on-miss semantics as `ApGatherOverrides.ts`.
- `ScriptOpcode.ts` / `ServerOps.ts` - `AP_PROCESS_SWAP = 1903`, declared in
  `ap/ap.rs2` as `[command,ap_process_swap](obj $product)(namedobj)`.
- Whole-file overlays of the vanilla recipe scripts, each final delivery point
  wrapped as `inv_add(inv, ap_process_swap($product), n)`:
  - `skill_cooking/scripts/cooking.rs2` - the success-path delivery in `cook_item`
    (1; the burn-path delivery stays vanilla)
  - `skill_smithing/scripts/smithing/smithing.rs2` - `smithing_anvil`'s bar->item
    delivery (1)
  - `skill_crafting/scripts/leather/leather.rs2` - the `hardleather_body` special
    case plus the general `craft_leather_queue` (2)
  - `skill_crafting/scripts/gem/uncut_gem.rs2` - the gem-cutting success delivery (1;
    the mis-hit's `crushed_gemstone` stays vanilla)
  - `skill_fletching/scripts/arrows.rs2`, `darts.rs2`, `cut_logs.rs2` - final tipped
    arrow, final dart, log->unstrung-bow delivery (1 each)
  - `skill_fletching/scripts/bolts.rs2` - bolt-tip cutting and bolt tipping (2)
  - `skill_fletching/scripts/bows.rs2` - bow stringing (1). The three fletching sites
    that originally spliced `db_getfield(...)`'s two return values straight into
    `inv_add`'s item+qty params were rewritten to destructure into local vars first -
    `ap_process_swap` only takes one `obj` argument.
- `overlays/engine/tools/process/RandomizeProcessing.ts` - builds the product pool
  from the game's own dbtable data (`cooking_generic.dbrow`, `smithing.dbrow`,
  `leather.dbrow`, `gem.dbrow`, `fletching`'s `arrows`/`bolts`/`darts`/`bows.dbrow` +
  `cut_logs.dbrow`), writes the JSON table and a spoiler at
  `engine/tools/process/process-seed.json`.
- `::approcess <item_debugname>` test command (e.g. `::approcess cooked_meat`) -
  prints what a product is randomized into.

### Usage

```
cd ../Server/engine
npx tsx tools/process/RandomizeProcessing.ts [--seed <n>] [--mode shuffle|tiered|chaos]
    [--skills cooking,smithing,crafting,fletching] [--exclude <item,...>]
    [--pin-quest-items] [--no-quest-pins] [--dry-run]
```

- `shuffle` (default): one derangement across the combined ~253-product pool - a
  bijection, so every product is still obtainable from exactly one processing action
  and nothing maps to itself. Seed 777: 253 swapped, 160 land cross-skill.
- `tiered`: the same derangement run separately inside each **progression band** (see
  [Progression bands](#progression-bands-mode-tiered)), so a level-1 recipe yields
  another level-1 product and rune gear stays behind a 75+ recipe. Seed 424242: 252
  swapped, 148 cross-skill, across bands of 63/41/42/29/27/50 products.
- `chaos`: every product independently resamples from the pool - duplicates allowed,
  so some products can become unobtainable from processing entirely.
- `--skills` restricts which skills join the pool; unselected skills stay vanilla.

**Quest-critical pinning is mode-aware**, same reasoning as gathering: shuffle and
tiered don't pin by default (both are bijections - everything stays obtainable, a
quest just needs its item made by a different recipe), chaos pins by default
(independent resampling can genuinely orphan a product). Override with
`--pin-quest-items` / `--no-quest-pins`.

### Scope

Only DBTABLE-driven recipes are wrapped - `cooking_generic` (the bulk of Cooking),
`smithing.dbtable`, crafting's `leather.dbtable` + `gem.dbtable`, and fletching's
`fletching_table` (arrows/bolts/darts/bow-stringing) + `fletch_bow_table`
(log->unstrung bow). **Deliberately NOT wrapped** - composite/multi-step recipes
where the "product" is built across several intermediate items, so swapping an
intermediate would corrupt the recipe rather than just reveal a surprise: cooking's
pies/pizza/cakes/dough/stew/kebab/wine/oomlie/gnome specialties; crafting's
jewellery/glass/pottery/spinning/snelm/studded/battlestaves/dye_cape; fletching's
`ogre_arrows.rs2` (hardcoded shaft/headless/tip chain, no dbtable) and the
`headless_arrow` intermediate in `arrows.rs2`. A future pass could hand-wrap just the
true final `inv_add` in each of those files. Only the item identity is wrapped -
quantities are untouched, so a recipe slot that hands out 5 of its product (the
metal-tier knives, `nails`) still hands out 5 of whatever it got swapped to; same
"structure stays put, content moves" philosophy as tiered drop randomization.

## Thieving randomization (pickpocketing / stalls / trapped chests)

Shuffles what every thieving source actually hands the player - pick a man's pocket and
get an adamantite ore, rob the gem stall and get a shark. Same runtime-override design
as gathering/processing: reseeding rewrites a JSON table and needs a server restart
only, no pack rebuild. Deleting `engine/data/config/ap-thieving.json` restores vanilla
thieving.

The survey step the issue asked for came back clean: **all three surfaces are
dbtable-driven and the reward is a plain scalar item lookup**, not an inline
`if ($random < N) obj_add(...)` cascade - so this is a runtime-override table, not a
config mutation. All three reward cascades even live in one file.

### Pieces

- `overlays/engine/src/engine/ApThievingOverrides.ts` - runtime loader for
  `engine/data/config/ap-thieving.json` (obj id -> obj id). Same vanilla-passthrough-
  on-miss semantics as `ApGatherOverrides.ts`.
- `ScriptOpcode.ts` / `ServerOps.ts` - `AP_THIEVING_SWAP = 1913`, declared in
  `ap/ap.rs2` as `[command,ap_thieving_swap](obj $product)(namedobj)`.
- A whole-file overlay of `skill_thieving/scripts/thieving.rs2`, with all three
  reward chokepoints wrapped as `inv_add(inv, ap_thieving_swap($reward), n)`:
  `pick_pocket_check_for_reward`, `stealing_check_for_reward` and
  `trapped_chest_check_for_reward` (1 each). Each wrap sits **inside** the vanilla
  `if ($roll >= $denominator)` rarity branch, so the drop rate still decides *if* you
  get something and only *what* you get moves - nothing is revealed for loot the
  player never actually received.
- `overlays/engine/tools/thieving/RandomizeThieving.ts` - builds the loot pool from
  the game's own dbtable data (`pickpocket.dbrow`, `stealing.dbrow`,
  `trapped_chest.dbrow`), writes the JSON table and a spoiler at
  `engine/tools/thieving/thieving-seed.json`.
- Tracker "Thieving" tab - rows read `Coins -> steals like -> Adamantite ore`,
  revealed the first time you actually steal the item (the mimic-style presentation
  the Bestiary's "smells like" already established).
- `::apthieving <item_debugname>` test command (e.g. `::apthieving coins`) - prints
  what a thieving reward is randomized into.

### Usage

```
cd ../Server/engine
npx tsx tools/thieving/RandomizeThieving.ts [--seed <n>] [--mode shuffle|tiered|chaos]
    [--surfaces pickpocket,stalls,chests] [--exclude <item,...>]
    [--pin-quest-items] [--no-quest-pins] [--dry-run] [--export-pool <path>]
```

- `shuffle` (default): one derangement across the combined 33-item pool - a bijection,
  so every item is still stealable from exactly one source and nothing maps to itself.
  Seed 777: 33 swapped, 18 land cross-surface.
- `tiered`: the same derangement run separately inside each **progression band** (see
  [Progression bands](#progression-bands-mode-tiered)), so a level-1 pocket yields
  another level-1 item and the gem stall stays in the 75+ band. Seed 777 bands:
  5/2/8/3/5/10 items.
- `chaos`: every item independently resamples from the pool - duplicates allowed, so
  some items can become unstealable entirely.
- `--surfaces` restricts which surfaces join the pool; items only reachable through an
  unselected surface stay vanilla.

**Quest-critical pinning is mode-aware**, same reasoning as gathering/processing:
shuffle and tiered don't pin by default (both are bijections), chaos pins by default.
Override with `--pin-quest-items` / `--no-quest-pins`. Seed 777 with pins forced on:
8 of 33 pinned (coins, lockpick, bread, earthrune, deathrune, cup_of_tea, silk,
naturerune).

### Scope

The three loot-bearing surfaces: pickpocketing (13 `pickpocket.dbrow` rows covering
~50 NPCs), market stalls (9 `stealing.dbrow` rows incl. the two Rellekka viking
stalls) and trapped/locked chests (6 `trapped_chest.dbrow` rows). Everything else in
`skill_thieving` stays vanilla by design: `locked_door.dbrow` (thieving doors have no
loot, they only open), the `chest_steel_arrowtips` lockpick gate (a requirement, not a
reward - its loot row is in the pool like every other chest), and every failure path
(stun rolls, guard aggro, "Too late, they're dead.").

Only the item identity moves. The rarity rolls, XP, respawn timers and chest teleport
traps are untouched, and the stall's `"You steal <message>."` line plus its bread-only
sound check both still read the **pre-swap** reward on purpose - "You steal some
silk." while a raw shark lands in your pack is the reveal, exactly like gathering's
"You manage to mine some coal." Quantities are untouched too, so the 1000-coin
Ardougne chest hands out 1000 of whatever it got swapped to (`inv_add` fills what
space there is for a non-stackable); `--exclude coins` is the escape hatch if a run
wants the big-money rows left alone.

**Not yet modelled in the apworld.** Local/solo mode is complete; the Archipelago fill
does not yet reason about thieving-sourced items the way it does about
gathering/processing (`randomizers.py`). `--export-pool` already emits the input that
port needs - see the open follow-up in `docs/lessons-learned.md`.

## Progression bands (`--mode tiered`)

Gathering, processing and thieving all accept `--mode tiered`, which is shuffle mode
confined to a level band: still a cross-skill derangement, still a bijection, but a product can
only turn into a product of a comparable skill level. `overlays/engine/tools/shared/
SkillTiers.ts` owns the bands and the shuffle all three tools call.

| band | levels | why |
| --- | --- | --- |
| `lvl1-14` | 0-14 | bronze/iron era - shrimp, clay, plain logs |
| `lvl15-29` | 15-29 | steel era - iron ore, oak, trout |
| `lvl30-44` | 30-44 | mithril era - coal, willow, lobster |
| `lvl45-59` | 45-59 | adamant era - mithril ore, maple, swordfish |
| `lvl60-74` | 60-74 | yew/adamantite |
| `lvl75+` | 75+ | rune era - runite ore, magic logs, shark |

Fixed bands, not the percentile buckets tiered drop randomization uses: "rare" only
means something relative to the rest of a loot table, but a skill level is an
absolute number a player already thinks in, and fixed boundaries mean adding a product
to the corpus can't silently reshuffle which band everything else lands in. Each band
gets its own PRNG stream (`mulberry32(seed ^ hashKey(band))`), so widening one band
later doesn't disturb the others.

Every level is read out of the game's own data - `rock_level` / `levelrequired` /
`level` columns for mining, woodcutting, cooking, smithing, crafting, fletching and
all three thieving dbrows,
the level embedded in `fletch_bow_table`'s `shortbow`/`longbow` tuple, and (fishing
having no product table) the `stat(fishing)` guards in the spot scripts, parsed by
`FishingLevels.ts`. A product made by several sources takes the LOWEST level that
yields it - the level it first becomes reachable at. A missing level is a hard error,
not a default: silently banding a level-85 product as level 1 is exactly the failure
this mode exists to prevent.

As a side effect this is the strongest mitigation available for the cross-skill quest
risk: a low-level quest ingredient can only be re-keyed onto another low-level action,
so no quest ends up gated behind a skill level the player has no business having yet.

In Archipelago mode it's the `tiered` value of `gathering_randomization` /
`processing_randomization`; the apworld replays the same per-band derangement from the
`band` each product carries in the exported pool (`randomizers.py`), so its fill knows
exactly what the server will hand out.

## Infinite run energy

A permanent world-config toggle, not a per-seed randomizer - same class of change as the
existing `xpRate`/`NODE_XPRATE` XP multiplier, and
intended to become an Archipelago slot option the same way. Unlike entrance/drop/drip/
shop randomization, there's nothing to reseed: it's a boolean on or off.

### Pieces

- `overlays/engine/src/util/WorldConfig.ts` - adds `node.infiniteRun: boolean` (default
  `false`) to the config schema, alongside a `NODE_INFINITERUN` env var mapping that
  mirrors `xpRate`/`NODE_XPRATE` exactly.
- `overlays/engine/src/engine/entity/Player.ts` - `updateEnergy()` (called once per
  player per tick from `World.ts`) short-circuits to `this.runenergy = 10000` (max, in
  the engine's hundredths-of-a-percent units) when the flag is set, skipping the normal
  drain-while-moving/regen-while-idle logic entirely. This also means the "energy hits 0
  -> force back to walk" branch never triggers, since energy is pinned at max every
  tick before that check runs.

### Usage

Set `"infiniteRun": true` under `"node"` in the server's `data/config/world.json` (a
local, gitignored file - not part of this repo), or set the `NODE_INFINITERUN` env var
before the server's first boot (only applies when `world.json` doesn't exist yet and
gets migrated from a legacy `.env` - see `WorldConfig.ts`). Takes effect on server
restart; no content pack rebuild needed, since this only touches engine TS. Player run
energy will read and display 100% at all times and running is never blocked.

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

## Archipelago integration (v2: region-aware)

Real archipelago.gg multiworld support - full design in
[docs/archipelago-integration.md](docs/archipelago-integration.md), apworld
packaging/usage in [apworld/README.md](apworld/README.md).

**Two randomizers, one logic.** Local/solo seeds are made by generate-and-test:
`RandomizeEntrances.ts` shuffles, `ValidateSeed.ts` grades, the loop rerolls
until the seed is beatable (`--require-perfect`). Archipelago's fill runs once
and cannot reroll, so AP mode is construct-valid instead - the apworld builds a
reachability-preserving entrance layout itself and reasons over the same region
/ gate / quest / item logic the local oracle uses. Both read one exported
bundle, and `scripts/parity-check.py` fails if they ever disagree. The moving
parts:

- `apworld/rs2004scape/` - the Python generation-side world. `logic.py` is the
  region fixpoint (a port of `ValidateSeed.ts`), `entrances.py` the
  construct-valid entrance shuffle, `randomizers.py` the replay of every other
  randomizer (gathering, processing, shops, drops, spawn) so the fill knows the
  world it is filling. Zip it as `rs2004scape.apworld` for an Archipelago
  install.
- `overlays/engine/tools/ap/ExportApWorldData.ts` - generates the shared
  datapackage (`ap-archipelago-data.json` / `rs2004_data.json`); ids are
  append-only.
- `overlays/engine/tools/ap/ExportLogicBundle.ts` - generates the shared logic
  bundle (`ap-logic-bundle.json` / `rs2004_logic.json`): regions, gated areas,
  the entrance pool, the item graph, the quest-doability varp model. Everything
  region-shaped comes from `tools/logic/LogicModel.ts`, the same module
  `ValidateSeed.ts` imports, so the two cannot drift.
- `scripts/parity-check.py` - runs both implementations over the same seed and
  diffs regions / quests / QP / goals.
- `overlays/engine/src/engine/ApClient.ts` - the runtime AP WebSocket client.
  Enabled by `data/config/ap-archipelago.json` (`{"enabled": true, "host": ...,
  "port": 38281, "slot": "..."}`); inert without it. Fired checks go out as
  LocationChecks, received items apply through grantUnlock and announce in-game
  via `[queue,ap_remote_item]`, the slot goal reports via StatusUpdate.

In AP mode the local GenerateSeed placement fill must NOT be active - the AP
server owns all placements (ap-placements.json carries only slot_data's quest
gates). Solo placement mode is unchanged when ap-archipelago.json is absent.

With the default `region_logic: true`, Archipelago also owns the entrance
layout: it arrives in `slot_data.entranceOverrides`, the client writes it to
`data/config/ap-entrances.json` and hot-reloads it, and
`seedOptions.entrances` arrives as `"off"` so the next seed roll leaves that
map alone. Set `region_logic: false` to go back to the v1 contract (server-side
entrance shuffle + travel-agnostic AP rules).

## License & credits

MIT - see [LICENSE](LICENSE). Files under `overlays/` that are modified copies
of vanilla [Lost City](https://github.com/LostCityRS) sources remain (c) Lost
City, also MIT.

- [Lost City / 2004scape](https://github.com/LostCityRS) ([2004.lostcity.rs](https://2004.lostcity.rs/)) - the game server this
  builds on. This repo distributes no game assets; it overlays a checkout you
  set up yourself.
- [Archipelago](https://archipelago.gg/) - the multiworld randomizer framework.
- Not affiliated with or endorsed by Jagex. RuneScape is a trademark of Jagex Ltd.
