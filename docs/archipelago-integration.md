# Archipelago integration (real multiworld support)

Written 2026-07-19 (problems.txt: "actually make this work with Archipelago").
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
- `Mystery Reward` - the filler; on receipt the client rolls the existing
  `~ap_grant_check_reward` random reward for the online player (queued while
  nobody is online).

## Logic model in the apworld (v1: travel-agnostic, mirrors PlacementEngine)

The Python rules are a direct port of `reachableFromState` +
`completableQuests` (the travel-agnostic path GenerateSeed itself uses):

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

**Region/entrance logic is deliberately NOT in the apworld** (same division of
labor as GenerateSeed vs ValidateSeed): the entrance shuffle happens on OUR
server with its own seed, after AP generation. The rule that keeps this sound
is unchanged from placement mode: an AP-mode server must run an entrance table
that validates fully green (RandomizeEntrances already rerolls/grades until
goals + quests are reachable). The apworld's travel-agnostic logic is exactly
as strong as what GenerateSeed enforces locally today.

## Engine client design (ApClient.ts)

- **Config**: `data/config/ap-archipelago.json` -
  `{enabled, host, port, slot, password}`. Missing file or `enabled: false` =
  module completely inert (the same fail-open convention as every Ap* table).
  Not part of ap-options.json: that file is a 3-reader boolean-toggle contract
  (engine/tools/rs2), this is engine-only connection config.
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
- **slot_data**: `{goal, musicChecks, questGates: [...]}`. On `Connected`, the
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

1. `cd ../Server/engine && npx tsx tools/ap/ExportApWorldData.ts` - refresh
   `apworld/rs2004scape/data/rs2004_data.json` (only needed after catalog
   changes).
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
- **Region-aware apworld logic**: port the region fixpoint to Python, or
  precompute a per-seed reachability matrix - only matters if entrance shuffle
  should constrain the AP fill; today's validation-gated entrance tables make
  it unnecessary for soundness.
- **Auto-release/collect semantics** on goal: AP handles via server settings;
  nothing client-side needed.
