# Archipelago integration (real multiworld support)

This is the investigation + v1 design + build record for connecting the 2004scape
server to a real archipelago.gg multiworld. Prior art everything here builds on:
`docs/placement-mode.md` (the local solo-AP fill), `docs/checks-and-unlocks.md`
(the check/item catalog), `tools/sim/PlacementEngine.ts` (the canonical location
catalog + item pool + reachability rules).

## What "hooking into Archipelago" actually takes

Archipelago has two halves, and we need one artifact for each:

1. **Generation side: an `.apworld` Python package.** Archipelago's generator
   (`ArchipelagoGenerate` / the website) reads every player's YAML, calls each
   game's `World` subclass to produce items/locations/rules, and runs its own
   multiworld fill. Our world must declare the location catalog, the item pool,
   and access rules so the fill never strands progression. This *replaces*
   GenerateSeed's local assumed-fill for AP runs - the AP server becomes the
   authority on what every check contains.
2. **Runtime side: a game client speaking the AP network protocol.** A WebSocket
   JSON protocol (`docs/network protocol.md` in the AP repo): handshake
   (`RoomInfo` -> `Connect` -> `Connected`), report checks (`LocationChecks`),
   receive items (`ReceivedItems` with a monotonic `index`), announce goal
   (`StatusUpdate` status 30). The engine already has `ws` as a dependency
   (web.ts uses it) and already has every hook we need: `ApChecks.fireCheck` is
   the single choke point where every check fires, and
   `ApUnlockOverrides.grantUnlock` is the single entry point for applying a
   progression item. The client is a new engine module, `ApClient.ts`.

Nothing about the content layer (rs2 scripts) changes at all: checks still fire
through the same varp watchers/kill bits/xp hooks, announcements still go
through `[queue,ap_check_fired]`.

## Protocol facts (verified against the AP repo's network protocol doc)

- Handshake: server sends `RoomInfo` on connect; client optionally
  `GetDataPackage` (to learn `item_name_to_id`/`location_name_to_id` - we skip
  this and carry our own id tables, see below); client sends `Connect` with
  `{game, name, password, uuid, version: {class:"Version", major, minor, build},
  items_handling, tags, slot_data}`; server answers `Connected` (includes
  `slot_data`, `missing_locations`, `checked_locations`) or `ConnectionRefused`.
- `items_handling: 0b111` = receive remote items + own-world items + starting
  inventory. We want all three (our own placed items must round-trip through the
  server so the AP server's state is authoritative).
- `LocationChecks {locations: [int...]}` - idempotent, duplicates are safe.
  On (re)connect, send the FULL fired set - that is the documented resync path.
- `ReceivedItems {index, items: [{item, location, player, flags}...]}` - track
  the last processed index; `index: 0` means full inventory replay; a gap means
  send `Sync` + full `LocationChecks` and wait for the replay.
- `StatusUpdate {status: 30}` announces goal completion.
- All packets travel as a JSON *array* of packet objects; every packet has a
  `cmd` field.

## ID scheme (the stable contract between all three sides)

AP identifies items/locations by integers, unique per game namespace. Ours:

- **Base offset `20040000`** for both items and locations (well inside the
  recommended int ranges; mnemonic: 2004scape).
- `tools/ap/ExportApWorldData.ts` (new) enumerates the canonical catalogs -
  `buildLocationCatalog()` with EVERY option enabled (musicChecks on: option
  toggles must never renumber ids; disabled checks simply go unused that seed)
  and `buildItemPool('per-skill')` plus the filler item - and writes
  `apworld/rs2004scape/data/rs2004_data.json` with `{locations: {name: id},
  items: {name: id}, ...}` plus everything the Python side needs for rules
  (quest requirement records from quests.json, location kind/skill/level
  metadata, goal definitions).
- **Ids are append-only**: the exporter preserves ids from an existing data file
  and only assigns fresh ids (max+1) to new names. Re-running it after adding a
  check surface never renumbers old entries - the same rule obj.pack lives by.
- The engine client loads the same JSON (path resolved relative to the repo's
  `data/config/ap-archipelago-data.json`, a copy installed by install.js) so
  check-id -> location-id and item-id -> unlock-key mapping agree byte-for-byte
  with what generation used. AP's DataPackage exchange is thereby unnecessary
  (we never need to look up another game's ids).

Item name conventions (AP-visible display names):
- `Progressive Melee|Armour|Ranged|Magic` (7 copies each) -> grantUnlock
  (`progressive_melee` etc., +1).
- `Progressive Pickaxe` (5), `Progressive Axe` (6) -> +1.
- `Progressive <Skill> Cap` (4 copies per cappable skill) -> grantUnlock
  (`progressive_<skill>`, **+2** - the engine cap formula is 20 + 10*count, one
  copy = +20 levels).
- `Quest Unlock: <Name>` (61, single copy) -> grantUnlock(`quest_<id>`, 1).
- Filler (`Mystery Reward`, `Ore Pack`, `Bar Pack`, `Herb Pack`, `Rune Pack`) -
  no grant; on receipt ApClient passes the item's `pack` id through
  `[queue,ap_remote_item]` to `~ap_grant_named_pack`, which rolls that resource
  category (or, for `Mystery Reward`, a weighted random one via
  `~ap_grant_check_reward`) for the online player - queued while nobody is
  online. The apworld splits filler across these names by the `filler_weights`
  option, so the multiworld hints and spoiler log name the real thing; the
  CONTENTS are still rolled game-side at receipt, against the stats the player
  has when it lands. An empty/unknown pack id degrades to the random roll, so a
  newer apworld against an older server still pays out.

## Logic model in the apworld (v2: region-aware, GitHub #3)

**Both randomizers stay first-class.** Local/solo seeds are still made by
generate-and-test (`RandomizeEntrances.ts` shuffles, `ValidateSeed.ts` grades,
the loop rerolls; `--require-perfect` is its acceptance criterion and is *not*
going anywhere). Archipelago cannot reroll - its fill runs once - so AP mode is
construct-valid instead: the apworld builds a sound layout up front and reasons
over it. One logic source, two consumers.

### The shared artifact: `data/rs2004_logic.json`

`tools/ap/ExportLogicBundle.ts` emits the logic half of the contract (the
catalog half is `ExportApWorldData.ts`). It is region-id based and
seed-*independent* - the shape of the world, not one shuffle of it:

| Key | What it carries |
| --- | --- |
| `meta` | mainland region id, vanilla spawn region, cap formula, cappable skills, quest-gate ids |
| `varpModel` | `VARP_TO_QUEST`, `SPLIT_VARPS`, `COMPLETION_ONLY`, `STAT_VARPS` - the quest-doability model |
| `anchors` / `questAnchors` / `goalAnchors` | curated `quest-regions.json` spatial requirements, resolved to region ids |
| `alwaysConnected`, `openAreas` | curated free connectivity (Karamja boat, quest gauntlets) |
| `gatedAreas` | all 107 areas with `require` + resolved interior/outside region ids |
| `questScriptEdges`, `worldEdges` | extracted transitions (world edges keep their trigger coords so a seed's overrides can retire them) |
| `requirementGroups` | `quest-regions.generated.json` evidence, per quest/goal, after curated ignores |
| `entrancePool` | every physical gate's two sides (trigger, op, arrival, both resolved to regions) + one-ways + gate requirements |
| `itemSources`, `questItems` | the four-source item-obtainability graph |
| `quests`, `goals` | quests.json / goals.json verbatim |

Everything region-shaped comes from `tools/logic/LogicModel.ts` - the *same*
module `ValidateSeed.ts` imports - so the exported model and the local oracle's
beliefs cannot drift by construction. The entrance pool comes from
`RandomizeEntrances.ts --export-pool`, i.e. the shuffle's input, not its output.

### `logic.py`: the fixpoint, in Python

A faithful port of `ValidateSeed.ts`'s sphere expansion, in the same order:
item obtainability -> entrance edges -> `alwaysConnected` -> script/world edges
-> open areas -> gated areas -> quests, repeat to fixpoint. The non-obvious
rule is ported verbatim: **a quest-progress varp gate opens when its quest is
DOABLE, not COMPLETE** (otherwise a quest's own interior door deadlocks the
quest), with `SPLIT_VARPS` keeping post-quest guild gates completion-safe.

`derive(caps, unlocked_quests)` is memoized - the fixpoint only depends on the
skill caps and which quest-gate items the state holds, which is exactly what an
AP access rule varies. A full derive is ~10ms, so rules stay cheap.

Access rules with `region_logic` on (the default):

- Quest checks and `Completed: <quest>` events: `quest in derive(state).completed`
  - which already folds in skills, QP, the prereq chain, the quest-gate item,
  gathered/processed item availability *and* physical reachability.
- `barcrawl_bar_N`: bar N's curated anchor region must be reachable (they line
  up 1:1 with `goalAnchors.barcrawl`, in `quest_barcrawl.constant` order).
- Goals: `goals.json`'s own definition - skills + QP + quest chain + the
  anchors and extracted regions the goal needs you to stand in.
- `level_*` / activities: skill caps, unchanged.
- `ds_*` stages: Dragon Slayer startable, but QP now comes from the fixpoint.

**Feasibility exclusion.** A check the region model cannot justify even with
every item collected can never fire in game either, so the world does not
create that location at all - putting anything there, even filler, would lose
it. This is the AP-side twin of `GenerateSeed.ts`'s exclusion. The model only
ever claims reachability it can prove, so the failure direction is "a real
check sits out", never "an unreachable check holds progression". A configured
*goal* being unreachable is fatal instead, with an explicit `OptionError`.

### `entrances.py`: construct-valid entrance randomization

With `region_logic` on, **the apworld builds the entrance layout**, in
`generate_early`, before any rule runs - a reachability-preserving frontier,
the same shape as Archipelago's own `worlds/generic/randomize_entrances`:

```
while unpaired exits remain:
  pick a RANDOM unpaired exit whose trigger region is already reachable
  pair it with a partner that opens new ground (any partner if none does)
  re-derive reachability and repeat
```

Every exit is consumed only once it is reachable, so the layout is connected by
construction - **nothing to reroll**. Pairing gate `i`'s A side with gate `j`'s
B side writes `overrides[i.a.trigger] = j.a.arrival` and
`overrides[j.b.trigger] = i.b.arrival`, the same reciprocity the local tool
guarantees (walk back the way you came, end up where you started).

The finished table rides to the game server in `slot_data.entranceOverrides`;
`ApClient` writes it to `data/config/ap-entrances.json` and hot-reloads it, and
`slot_data.seedOptions.entrances` is pinned to `"off"` so the next
`scripts/new-run` cannot reshuffle the map the fill reasoned over.

Measured (bundle of 2026-07-26, 402 gates + 4 one-ways): the vanilla layout
leaves 730/808 pool sides reachable and strands 2 quests in the model; every
frontier layout tried reached 777/808, all 63 quests and all 5 goals, in ~3s,
with zero rerolls.

The pool grew from 366 gates to 402 on 2026-07-26 - not new content, but the
angle-keyed handlers GitHub #4 added finally reaching the exported bundle. Any
figure here quoted against 736 sides predates that; see
`docs/lessons-learned.md`, "The bundle export reuses stale pool dumps".

### `randomizers.py`: the rest of the seed, rolled during generation

Entrances ship as a finished table because the engine reads them from JSON at runtime.
The other four randomizers can't all work that way - shopsanity rewrites `.npc` params
and needs a pack rebuild - so they use the other half of the same trick: **Archipelago
picks the seed, and the deterministic TypeScript tools reproduce the identical table
server-side.** `scripts/new-run.sh` already feeds one shared `$SEED` to every tool, so
one number in `slot_data.seedOptions.seed` pins all of them
(`seed-options-to-env.cjs` emits it as `SEED=`).

That matters because the apworld needs to *know* those tables while its fill runs:

| randomizer | effect on logic |
| --- | --- |
| gathersanity / processsanity | re-key which action yields which item, so item obtainability - and every quest needing a gathered/processed item - moves with the roll (`LogicEngine(item_swaps=...)`) |
| shopsanity | an item's `buy` source moves to wherever its new shopkeeper stands (`relocate_buy_sources`) |
| drop randomization | an item's `drop` source moves to whatever monster drops it now - all three modes, including mimic's whole-table swaps (`relocate_drop_sources`) |
| spawn | changes the start region, i.e. sphere 0 itself (`LogicEngine(spawn_region=...)`) |

Each roll mirrors its TypeScript original exactly: the same ordered candidate pool
(exported by that tool's own `--export-pool`, into `bundle.randomizerPools`), the same
PRNG (`prng.py` is a byte-exact port of `Prng.ts`), the same pin rules (quest-critical
products pinned in chaos, not in the bijective shuffle/tiered modes), the same mode
semantics. Gathersanity/processsanity's `tiered` mode is the one place the apworld is
handed a *derived* value rather than deriving it: the TS tool stamps each product with
its progression band and exports the band order alongside, and `randomizers.py` groups
by those strings instead of re-deriving the boundaries - a band table duplicated on
both sides is a band table that can drift, and a drifted band means the apworld's logic
describes swaps the server never made.
`test_randomizers.py` pins both layers against vectors captured from the real tools -
raw `mulberry32` / `derangement` output, and the actual `ap-gather.json` /
`ap-process.json` / `ap-spawn.json` / `shop-seed.json` / `drop-seed.json` written for
seed 424242. (The tiered/chaos drop vectors are a verified *subset*: the capture ran
`--dry-run` against a mimic-transformed live corpus, so the tool could only locate half
the lines to record. The mapping itself comes from the pristine backup and is
unaffected; mimic and death-drop vectors are complete and order-exact.)

**Drop randomization, all three designs.** `tiered`/`chaos` rewrite each weighted loot
slot's item (plus a derangement of the guaranteed `death_drop` params); `mimic` leaves
items alone and points each monster's death handler at another monster's ENTIRE table.
Both change which monster - and therefore which region - an item can be killed for.

The relocation is applied as a **delta**, not a recomputation, because the two datasets
involved do not coincide: an item's vanilla drop regions come from `drop-sources.json`,
which is broader in places than the weighted-loot corpus the roll touches (bespoke
handlers, scripted gives) and narrower in others. So per item the model takes the
monsters that *stopped* dropping it and the ones that *started*, and moves only those
regions - keeping a region if some monster that still drops the item stands there.
Anything the corpus cannot account for is left alone in both directions, and an unrolled
roll is exactly the identity (pinned by a test).

### World rolls are retried; item fills are not

If a rolled world can't reach a configured goal even with every item collected,
`generate_early` rolls **another whole world** (up to `WORLD_ROLL_ATTEMPTS = 8`) and only
raises `OptionError` if none works. Measured miss rate for the hardest goal (Legends)
with every randomizer on and drops on mimic: ~1 roll in 5 - a gathersanity swap or a
mimicked loot table puts a goal quest's item somewhere the region model can't justify.
Expected cost ~1.25 attempts; chance of exhausting the budget ~2e-6.

This is *not* the local mode's generate-and-test creeping back in. AP's fill still runs
exactly once, over a world already known to be sound - the retry is over the WORLD (a
~2.5s operation entirely inside `generate_early`), not over item placement. Re-rolling
the map is a much better answer than failing the whole multiworld.

### Spoiler output

`write_spoiler_header` / `write_spoiler` document the rolled world, because nothing else
in an AP spoiler can: the world seed, the home/spawn, entrance-layout coverage, and full
gathering-swap, processing-swap, shop-relocation and entrance tables. For a world whose
locations all live in one AP region, this is the only readable record of what was
randomized.

### Parity: the two implementations must agree

The failure mode of one logic, two implementations is silent drift.

- `scripts/parity-check.py` runs `ValidateSeed.ts --json` and `logic.py` over
  the *same* spatial-only scratch config (entrances + gated areas + spawn, no
  placements or unlocks -> uncapped, no quest gates: exactly what
  `RandomizeEntrances` grades against) and diffs reachable regions, completed
  quests, QP and goals. `--write-fixture` freezes the result.
- `apworld/rs2004scape/test/test_parity.py` replays that frozen fixture through
  `logic.py` on every CI run - no engine checkout needed - and asserts the
  model's invariants (cap formula, monotonicity, quest gates actually gating)
  plus that frontier layouts stay beatable.

### v1 (still available: `region_logic: false`)

The older travel-agnostic rules - a direct port of `reachableFromState` +
`completableQuests`, the path GenerateSeed itself uses - remain selectable for
debugging or if the bundle is stale. In that mode the game server rolls its own
entrance table again and `seedOptions.entrances` carries the chosen mode:

- Every quest is an AP location AND an AP *event* ("Completed: <quest>") so
  other rules can require quest completion; QP is computed by summing the qp of
  completed-quest events in the rule lambda.
- Quest location rule: gate item received (if the seed gates it) AND
  requiredQp satisfied AND every skill requirement within the player's cap
  (cap for level L needs `ceil((L - 20) / 20)` cap copies; hitpoints is never
  capped) AND all prereq quests' events collected (incl. `questsAny` OR-groups)
  AND combat floors (atk/str/def floors -> cap copies; hp floor -> free).
- `level_<skill>_N` needs `ceil((N - 20) / 20)` copies of that skill's cap.
- `first_xp_*`, `first_kill_*`, `barcrawl_bar_*`, `music_*`, ungated
  activities: sphere 0. `ds_*` stages: Dragon Slayer startable (QP >= 32).
- Goals (slot option `goal`): `barcrawl` (all 10 bars), `dragon` (DS complete),
  `kbd` (KBD kill check + the 50-combat floor via caps). Completion event =
  the corresponding check id(s) firing client-side.

In v1 region/entrance logic was deliberately NOT in the apworld: the entrance
shuffle happened on OUR server with its own seed, after AP generation, and
soundness rested on the server running a table that validated fully green
(`RandomizeEntrances --require-perfect`). That is still the fallback contract
whenever `region_logic: false`.

## Engine client design (ApClient.ts)

- **Config**: `data/config/ap-archipelago.json` -
  `{enabled, host, port, slot, password}`. Missing file or `enabled: false` =
  module completely inert (the same fail-open convention as every Ap* table).
  Not part of ap-options.json: that file is a 3-reader boolean-toggle contract
  (engine/tools/rs2), this is engine-only connection config.
  **Managed from the tracker's "Archipelago" tab** (added 2026-07-19): GET/PUT
  `/ap/archipelago.json` reads/writes the file and hot-applies it via
  `ApClient.reconfigure()` (no restart), and POST `/ap/archipelago/test`
  probes any host/port for the RoomInfo greeting (AP version, seed name,
  whether a 2004Scape slot is hosted, password requirement) without touching
  the live connection. Hand-editing the JSON still works for headless setups.
- **Lifecycle**: `initApClient()` called from `startWeb()` (web.ts is already
  an overlay and runs exactly once at boot on the main thread - no new overlay
  file needed, and worker threads never touch it). Reconnect with backoff
  (5s..60s) forever; the game stays fully playable offline - checks keep
  accumulating in the fired ledger and resync on reconnect (`LocationChecks`
  is the documented resync mechanism and our fired set already persists).
- **Sending**: `ApChecks.fireCheck` calls `ApClient.onCheckFired(checkId)`
  after dedupe/persist. In AP mode the local placement consult is skipped
  (`resolvePlacement` is only for solo placement seeds); the check announce
  says the check was sent. The client maps check id -> location id via the
  data file; unknown ids (e.g. a check added after the apworld was built) are
  logged and skipped, never crash.
- **Receiving**: `ReceivedItems` applies each item once (index bookkeeping in
  `data/config/ap-session.json`): progression -> `grantUnlock` (global state,
  works with nobody logged in) + queued in-game announce; filler -> queued
  reward roll. A 600ms poller drains the queue to the first online player via
  the existing `[queue,ap_check_fired]` script (announce path) and a new
  `[queue,ap_remote_item]` shell for filler delivery.
- **Goal**: on every fired check, test the goal condition from `slot_data.goal`;
  when satisfied send `StatusUpdate 30` (idempotent flag in ap-session.json).
- **slot_data**: `{goal, musicChecks, questGates: [...], regionLogic,
  entranceOverrides: {...}}`. `entranceOverrides` is the apworld-built entrance
  table (v2 logic, above): the client validates each key/value as a raw coord,
  writes `data/config/ap-entrances.json` preserving any existing `gates` block
  (a gate stays with the physical location, not the destination), and calls
  `ApEntranceOverrides.reloadEntranceOverrides()` so it applies without a
  restart. Absent/empty = the server keeps rolling its own.
  `seedOptions.seed` is the shared seed the world rolled everything else from -
  `seed-options-to-env.cjs` emits it as `SEED=`, so the next `scripts/new-run`
  reproduces the same gathering, processing, shop and spawn tables (and will
  not delete an entrance table that came from slot_data). On `Connected`, the
  client writes `questGates` into `data/config/ap-placements.json` (placements
  object empty - AP mode has no local placements) so ApQuestGates/quest-tab
  hiding work unchanged, and adopts `musicChecks` via
  `ApOptions.setApOption` + an ApChecks watch-cache reset - options are
  configured on the AP YAML/website side and the game server follows on
  connect, no hand-edited ap-options.json. Written only when different;
  ApQuestGates reads lazily so a first-boot connect activates gates without
  restart.

## Mode interlock

Exactly one of the two placement sources may be active:

- **Solo placement mode**: ap-placements.json has real placements; no
  ap-archipelago.json. Behavior byte-identical to today.
- **AP mode**: ap-archipelago.json enabled; ap-placements.json holds ONLY
  questGates (written from slot_data). fireCheck sends to AP instead of
  consulting local placements. ap-unlocks.json still starts zeroed (the
  new-run flow) and fills up from ReceivedItems instead of local grants.

`new-run.sh`-style AP setup: roll the randomizer seeds as usual (entrances must
validate green), zero ap-unlocks.json, delete fired/tracker state, write
ap-archipelago.json, boot.

## Setup walkthrough (once built)

1. Refresh the two generated data files the apworld ships (only needed after a
   catalog / region-graph / gated-area / quest-region change):
   ```
   cd ../Server/engine
   npx tsx tools/ap/ExportApWorldData.ts     # catalog -> rs2004_data.json
   npx tsx tools/ap/ExportLogicBundle.ts \
       --copy ../../2004Scape-AP-Logic/apworld/rs2004scape/data/rs2004_logic.json
   ```
   then re-run `python3 scripts/parity-check.py --write-fixture` so the frozen
   parity fixture matches the new bundle.
2. Zip `apworld/rs2004scape/` as `rs2004scape.apworld`, drop it in an
   Archipelago install's `custom_worlds/`, include a `2004Scape` YAML in the
   players folder, generate, host (locally or archipelago.gg).
3. On the game side: fresh run state + `data/config/ap-archipelago.json`
   `{"enabled": true, "host": "archipelago.gg", "port": 38281, "slot":
   "Marcus", "password": null}`, boot the server.

## Roadmap / not in v1

- **Slot options beyond `goal`/`music_checks`**: pool granularity (`groups`
  mode), xpRate as a slot option feeding NODE_XPRATE. (`music_checks` is fully
  wired: the apworld skips creating music locations when off AND the client
  adopts the toggle from slot_data so the engine's watch set matches.)
- **LocationScouts** on connect -> tracker could show what OTHER players' items
  sit on our undiscovered checks in spoiler mode.
- **PrintJSON handling** -> in-game chat line when our found item goes to
  another world ("Your X was sent to Bob's world").
- **DeathLink** (2004scape deaths are cheap - probably as an option, default
  off).
- ~~**Region-aware apworld logic**~~ - **done** (GitHub #3): see "Logic model
  in the apworld (v2)" above. Every randomizer that can move an item or the
  player - entrances, gathersanity, processsanity, shopsanity, drops (all three
  modes) and spawn - is now rolled by the apworld during generation, so the
  fill reasons about the world the player actually gets.
- **Auto-release/collect semantics** on goal: AP handles via server settings;
  nothing client-side needed.
