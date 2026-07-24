# Item obtainability logic — the four-source model

Status: **built 2026-07-24** (problems.txt #16). Makes quest item requirements a
real logic gate: the seed validator now *proves* each quest-critical item is
actually obtainable under the active randomizers, instead of the old
narrative-only assumption that every item is free. This is what makes
gathersanity / processsanity / shopsanity / drop-randomization genuine **logic
inputs** rather than cosmetic chaos.

## The problem this solves

Before this, `ValidateSeed`'s `heldItems()` returned `{ has: () => true }` — every
quest item was assumed obtainable. That's fine in vanilla (clay comes from
low-level mining), but once a randomizer **moves** where an item comes from it
breaks. The canonical case (the user's own example): Doric's Quest needs clay;
if gathersanity relocates clay behind a Fishing-40 spot, the validator still
thought Doric was doable early. Result: a silently-harder or out-of-logic wall
the validator couldn't catch.

The fix is to model **how every item is actually obtained** and gate quests on it.

## The four-source OR model

An item is **obtainable** if *any* of its sources is reachable, and each source
carries its own randomizer-adjusted accessibility condition:

| Source | Accessibility condition | Randomizer that moves it |
|---|---|---|
| **gather** (mine/fish/chop) | skill cap ≥ level | gathersanity (swap table) |
| **process** (smith/cook/craft/fletch) | skill cap ≥ level **and** every input obtainable (recursive) | processsanity (swap table) |
| **buy** | owner-NPC's region reachable | shopsanity (owner param, read live) |
| **drop** | monster's region reachable | drop-rando / mimic |

Obtainability is a **fixpoint** folded into `ValidateSeed`'s sphere loop,
recomputed each sphere from the growing skill caps AND the growing reachable
region set — so it composes with everything: gathersanity moves gather levels,
shopsanity moves the buy region, drop-rando moves the drop monster,
entrance/area gating moves region reachability. One reachability proof, all
randomizers.

**Why OR (any source) is correct and never false-passes:** a "quest X complete"
gate can't legitimately hide an item quest X itself needs (a vanilla
contradiction), so widening obtainability never makes an unbeatable seed look
beatable. And the never-false-block rule: an item is only ever reported
UNOBTAINABLE when it has a KNOWN source and *none* is reachable — anything not in
the graph is assumed obtainable, so the model can only ever ADD a provable wall,
never invent one. **Absent data files ⇒ every item obtainable ⇒ exact prior
(narrative-only) behaviour.**

## Code — `tools/logic/ItemGraph.ts`

- `ItemSource` is EITHER skill-gated (`skill`/`level`/`inputs`) OR region-gated
  (`region`, with `via: 'buy' | 'drop'`).
- `loadItemSources()` reads `item-sources.json` (gather/process chain).
- `applySwaps(graph, swapMap)` re-keys the graph through the gathersanity/
  processsanity product swap (a vanilla-product → delivered-product map). In
  `ValidateSeed`, `loadGatherProcessSwaps()` builds that name→name map from the
  runtime `ap-gather.json` / `ap-process.json` (which are **obj-id → obj-id**)
  via `content/pack/obj.pack`.
- `addRegionSources(graph, itemToNpcs, npcSpawns, resolveRegion, via)` merges buy
  and drop sources: each provider NPC (shop owner or monster) is resolved to a
  region via its spawn coord + the region graph.
- `computeObtainable(sources, statCaps, reachableRegions)` — the fixpoint: an
  item is obtainable if any source is satisfiable (skill cap for gather/process
  with inputs recursively obtainable; region reachable for buy/drop).
- `itemAvailable(item, sources, obtainable)` — the query the validator uses:
  `true` if the item is unmodelled (assumed obtainable) OR in the reachable set.

## Data files (`tools/logic/data/`, all committed overlays)

Built by subagent extraction passes over the game config (see the session that
added this). All are static game data — regenerate only if content changes.

- **`item-sources.json`** — the gather/process acquisition chain. Mining
  (`mine.dbrow` rock_output/rock_level), Fishing (spot-script `stat(fishing) < N`
  gates), Woodcutting (`trees.dbrow`), Smelting (ore→bar), Smithing
  (`smithing.dbrow` product/levelrequired/bar), Cooking (`cooking_generic.dbrow`
  cooked/uncooked), Crafting (leather + gem), Fletching. Processed items chain
  through `inputs`.
- **`quest-items.json`** — all 63 sim quests → the items the player must
  **supply** (not items the quest hands them), each tagged with its vanilla
  acquisition (`gather`/`process`/`buy`/`drop`/`given`/`quest`).
- **`shop-sources.json`** — 489 buyable items → owner-NPC debugnames (from every
  `*.inv` shop block's stock + the `owned_shop` params, shopsanity-baked because
  the `.npc` files are read live).
- **`drop-sources.json`** — 259 items → monster debugnames (from the drop-table
  cascades' literal `obj_add` + `death_drop` params; shared `~random*` table
  procs are deliberately NOT expanded, mirroring the drops tool's scope).
- **`npc-spawns.json`** — 1114 NPC debugname → representative spawn coord.
  Generated by **`BuildNpcSpawns.ts`** (scans the map `==== NPC ====` sections
  like `LocPlacementScanner`); committed for convenience, regenerable if maps
  change. Used to turn a shop-owner/monster into a region.

## How it wires into `ValidateSeed`

1. At load: `itemSources = applySwaps(loadItemSources(), loadGatherProcessSwaps(...))`,
   then `addRegionSources(...)` merges the buy + drop region sources (resolved via
   `npc-spawns.json` + `graph.resolveRegion`). `questItems = loadQuestItems()`.
2. Each sphere iteration:
   `obtainable = computeObtainable(itemSources, statCaps, reachableRegions)`.
3. `heldItems()` → `itemAvailable(item, itemSources, obtainable)`.
4. Quest completion gains `questItemsSatisfied(id)`: for each quest item tagged
   `gather`/`process` (the ones the randomizers actually move), require it to be
   available. (Buy/drop-tagged items are assumed obtainable at the quest layer;
   the region check on their *sources* is what makes them real once the buy/drop
   graph is populated — see "scope" below.)

## Verification (2026-07-24, offline)

- Graph 108 → **637 items** once buy/drop sources are added.
- At caps-20 + only mainland reachable: obtainable 65 → **486** — **421 items
  rescued** by buy/drop (raw_shark/coal/bars/gems: gather-blocked but
  buyable/droppable from a reachable region), while **`clay` correctly stays
  gather-only** (no shop sells it) — the Doric case, now provably following
  gathersanity.
- Discrimination proven at cap 20: coal (Mining 30) gated, iron_ore (Mining 15)
  passes, raw_shark (Fishing 76) gated — recursion intact (bars require ores).
- Typecheck clean; the live seed validates all goals reachable with the gate
  active and gathersanity ON.

## Scope & known limitations (for the next session)

- **Shuffle vs chaos:** the model is fully safe for the default **shuffle**
  (bijection) gathersanity/processsanity modes — every item stays obtainable at
  *some* level, so the gate verifies without false-blocking. In **chaos** mode
  (independent resampling can *orphan* an item from gathering), the buy/drop
  sources are what rescue a buyable orphan — so populating shop/drop sources is
  not optional there.
- **Quest-layer gate currently keys on `gather`/`process`-tagged needs.** The
  region-source machinery is built and the graph is populated; wiring the quest
  gate to also demand the buy/drop *region* be reachable (so a shopsanity-relocated
  shop actually gates a quest) is a small follow-up now that the data exists.
- **`obj.pack` name coverage:** a handful of shop owners / monsters don't resolve
  to a spawn (script-spawned NPCs) — they contribute no region source (safe:
  fewer buy/drop rescues, never a false pass).
- **Shared drop-table procs** (`~randomherb`/`~randomjewel`/`~ultrarare`) are not
  expanded to literal items — the same scope decision as the drops randomizer.

## Where this is heading

This logic layer — together with the entrance/area gating (see
[entrance-logic.md](entrance-logic.md)) — is the groundwork for moving beatability
into the **Archipelago apworld** so AP's own fill guarantees it by construction
(no reroll, no `--require-perfect`). The data files here are exactly what a Python
`Rules.py` consumes. See the "Archipelago logic layer" GitHub issue for the full
migration plan.
