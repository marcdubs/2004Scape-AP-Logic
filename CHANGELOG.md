# Changelog

High-level notes on what changed, newest first. This file starts at v2; for
anything earlier, `git log` is the record.

## v2 — unreleased (`feat/v2`)

The theme of this release is **provable beatability** and **Archipelago
parity**: every randomizer is now modelled by one shared logic engine that both
the local seed roller and the apworld consume, so a multiworld fill can no
longer hide progression behind a door this seed leaves shut or an item this
seed makes unobtainable.

### Logic

- **Entrance / area-gate logic expanded from 7 hand-curated gated areas to 107.**
  Every passage-controlling loc in the game is enumerated deterministically
  (`ScanDoors.ts`), classified free vs gated, and turned into a real gated area
  with exact door tiles (`DeriveGatedAreas.ts`). Gates now resolve by the true
  set of enclosed regions rather than a bounding box, which fixes the
  over-isolation that stranded quests, and they are symmetric, so deep dungeon
  gates (Elvarg's lair, Golrie's cell) work from either side.
- **Four-source item obtainability.** Quest item requirements are a real gate:
  an item counts as held only if it can be **gathered, processed, bought or
  dropped** from somewhere currently reachable, recomputed every sphere from the
  growing skill caps and reachable regions. Swap-aware, so gathersanity,
  processsanity, shopsanity and drop randomization all move the answer.
- **Quest-doability model** — a quest-progress gate opens when its quest is
  *doable*, not complete, which breaks circular deadlocks without false passes.
- **Skill quest gates** — Runecrafting requires Rune Mysteries (a hard script
  gate on the essence mine), Herblore requires Druidic Ritual (a balance
  choice). Applies to checks *and* item sources, in both solo and AP mode.
- All 10 barcrawl pubs are hard region anchors instead of a single "karamja"
  requirement.

### Archipelago

- **The apworld now owns the full logic.** `logic.py` is the sphere fixpoint in
  Python, exported from the TS model as a seed-independent bundle
  (`ExportLogicBundle.ts`), with `scripts/parity-check.py` and a frozen fixture
  test proving the two implementations agree.
- **AP mode is construct-valid instead of generate-and-test.** Archipelago
  builds a reachability-preserving entrance layout itself and ships the finished
  table in `slot_data`, so its single fill pass never needs a reroll. Local/solo
  seeds keep the old shuffle-grade-reroll loop unchanged.
- **Every randomizer is rolled during generation**, not after it: gathering,
  processing, shops, spawn and drops (all three drop modes, including `mimic`'s
  whole-table swap). One shared seed in `slot_data` lets the server's
  deterministic tools replay the identical tables.
- If a configured goal comes out unreachable, generation re-rolls the *world*
  (up to 8 times) rather than failing the multiworld.
- **The spoiler log now describes this world** — seed, home, entrance coverage
  and the full gathering / processing / shop / drop / entrance tables.
- New `region_logic` YAML option (default on) keeps the older travel-agnostic
  rules available.

### New randomizers and modes

- **Thieving randomization (#6)** — pickpockets, market stalls and trapped
  chests hand out shuffled loot from a 33-item pool, via a runtime override
  table (no rebuild to reseed). Vanilla rarity still decides *if* you get
  something. Not yet modelled by the apworld.
- **Tiered mode for gathering and processing (#15)** — shuffles within fixed
  level bands, so a low-level quest ingredient stays on a low-level action.
  Levels are read out of the game's own data, including fishing spot scripts.
- **Drop rarity cap (#11)** — no monster drop is rarer than 1/32 (configurable).
  Rate-only: it never changes which item sits in a slot, so it composes with
  tiered/chaos/mimic in either order and needs no seed.
- **`gatherSpeed` option (#13)** — mining / woodcutting / fishing success rate
  as a percentage of vanilla, default 200. Scales the roll rather than forcing
  success, so tool tier and level still matter; nothing else that rolls against
  a skill (cooking burn, fletching, thieving) is affected. Applies live.

### Tracker

- **New Checks tab** listing all 517 locations, grouped, with a Miscellaneous
  group for the odds and ends (barcrawl bars, gnomeball, the Mage Arena cape).
  Checks that can never fire this seed are struck through and excluded from the
  denominator.
- **One continuous map canvas** — surface and underground drawn together and
  aligned on world X, so a shuffled staircase is an ordinary line instead of a
  layer switch. Opens centered on the run's home point with a home pin.
- **The four swap tabs list what's still undiscovered**, so "30 left" tells you
  whether it's rocks, fish or logs.
- Spoiler mode draws entrance destinations (previously emitted but never read).

### Fixes

- Tutorial Island's real six-mapsquare footprint is protected, derived from the
  game's own dbrow instead of a hand-written constant (#14). Also stops
  chunk-mode spawn placing HOME there.
- Angle-keyed stair/ladder handlers (all 21 Tree Gnome Stronghold spirals plus
  16 ship ladders) now reach the shuffle pool (#4).
- Long AP messages wrap on the client's own font metrics instead of being
  clipped at the chatbox edge (#9).
- Glitchy NPC appearances: drip model exclusions are now derived from `.ob2`
  vertex geometry rather than hand-curated per bug report (#8).
- `SimulateProgression`'s vanilla path models end-of-run skill caps, removing a
  false "everything is blocked" wall.

### Tooling

New: `ScanDoors`, `DeriveGatedAreas`, `LogicModel`, `ItemGraph`,
`BuildNpcSpawns`, `ExportLogicBundle`, `CapDropRarity`, `SimulateDrops`,
`RandomizeThieving`, `FishingLevels`, `SkillTiers`, `TutorialIsland`,
`LocAngleResolver`, `ModelGeometry`, `AuditDripModels`, `parity-check.py`.
`new-run.sh` / `new-run.bat` gained the thieving stage and print the
beatability report at the end of every roll.

### Docs

`docs/item-logic.md` (the four-source model) is new; README,
`docs/archipelago-integration.md`, `docs/ap-yaml-options.md`,
`docs/testing-checklist.md` and `docs/lessons-learned.md` are all updated.
