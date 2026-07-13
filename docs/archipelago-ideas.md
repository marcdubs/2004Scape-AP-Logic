# Archipelago Randomizer Ideas

Brainstorm of six concepts, grounded in what's actually in this codebase (2004scape,
early-revision OSRS server). Each section: the idea, what already exists in the repo
that helps, and a rough implementation sketch.

---

## 1. Entrance randomization — stairs & ladders only

**Why not doors:** most doors here (`content/scripts/doors/configs/doors.loc`) are just
open/close state toggles on the same tile (`next_loc_stage` flips between two loc IDs in
place) — there's no "entrance" to randomize, they don't teleport you anywhere. That
tracks with your instinct: only randomize doors that actually function as
instance/area entrances, which in this content set are really the ladders and stairs.

**What's already there:** `content/scripts/ladders+stairs/scripts/ladders.rs2` handles
transitions through `[oploc1, <category>]` handlers keyed by loc category
(`ladder`, `laddertop`, `laddermiddle`, `shipladder_angled`, ...). Two distinct patterns
exist in the same file:

- **Same-building floor shifts** — `~climb_ladder(movecoord(coord(), 0, 1, 0), true)` —
  relative plane offset, same x/z. This is just "go up/down a floor in this building."
  Not a real entrance, should stay vanilla.
- **Named cross-map connectors** — hardcoded via `switch_coord`, e.g. the "Ladder to
  Dwarf Guard Tower," the Wizard's Tower descent, the "black knights fortress ladder."
  These have real, disconnected destination coordinates. *These* are the entrance-rando
  candidates.

**Implementation sketch:**
1. At seed-gen time, walk every ladder/stair script and extract the `switch_coord`
   special cases into an edge list of `(source coord, dest coord, category)`. Use a
   distance/region heuristic to auto-filter out same-building plane shifts that might
   be hiding in the generic `movecoord` branches.
2. Shuffle destinations among the eligible edge set. Decide up front whether pairs stay
   reciprocal (climb up brings you back to where you climbed down) or become a fully
   one-way directed graph — reciprocal is much easier to keep solvable, one-way is more
   interesting chaos.
3. Runtime: don't rewrite the `.rs2` scripts by hand. Add one indirection —
   `~climb_ladder` and the stair equivalent first check a loaded "entrance table"
   (JSON, keyed by source coord) populated at world boot from the seed data, falling
   through to vanilla `switch_coord` behavior only if no override exists.
4. Watch for ladders whose script branch also depends on quest state at that exact
   coord (the Wizard's Tower ladder checks `$coord` to trigger a message) — those need
   to be excluded from the pool or made randomizer-aware, not just blindly remapped.
5. Export the final edge list as the seed's spoiler log so the AP world's Python logic
   can build region connectivity/access rules from it.

---

## 2. NPC drop randomization (global or per-area, config-driven)

**What's already there:** two coexisting drop systems.
- **Declarative:** `content/scripts/drop tables/configs/drop_table.dbtable`
  (`column=drop,namedobj,int,int,LIST`) used by `shared_droptables.rs2` — pure data.
- **Ad-hoc scripted:** most NPCs (e.g. `bandit.rs2`) use inline cumulative
  `if ($random < N) obj_add(npc_coord, item, qty, ...)` chains hardcoded per NPC.

**Implementation sketch:**
- For dbtable-driven drops: trivial. Shuffle item IDs across weighted slots from a
  seed-driven mapping and regenerate the dbtable pack at build time. No engine changes.
- For inline-scripted NPCs (the majority): two viable approaches —
  - **Source-patch pass:** preprocess the `.rs2` files before compilation, swapping the
    literal item constants inside `obj_add(...)` calls per a generated seed mapping.
    Cheap to build, but it's a text-substitution pass over game scripts every reseed.
  - **Runtime indirection (more sustainable):** introduce a
    `~drop_random_lookup(npc_id, slot_id, item)` gosub that every scripted drop routes
    through once (a one-time mechanical migration across the drop scripts). After that,
    all future rando configs are pure JSON data with no script regeneration needed —
    same pattern as the ladder override table in idea #1.
- "Global vs per-area" maps naturally onto the existing `content/scripts/areas/area_*`
  folder structure — each area's NPCs already live in isolated directories, so a
  per-area drop-pool config (keyed by area folder) is a natural scope boundary, letting
  you keep, e.g., Wilderness-tier drops from leaking into Lumbridge-tier NPCs.
- Exclude or special-case any drop that's actually quest-critical (some NPC drops gate
  quest progression) — either keep those pinned outside the shuffle pool, or reroute
  them through the AP item-grant path instead of the vanilla drop table.

---

## 3. NPC "drip" randomization (cosmetic only)

**What's already there:** `.npc` config files (e.g.
`content/scripts/interface_bank/configs/banker.npc`) directly expose `model1..model8`
(per body-slot equipped model) and `recol#s/#d` (color swap pairs) per NPC — this *is*
the equipment/appearance system, fully declarative, no code involved.

**Implementation sketch:** the easiest of the six — pure config mutation, no engine or
script changes, no gameplay coupling, arguably doesn't even need to be an AP "check,"
just a fun toggle. At seed time, pool all valid `model#=` values seen across every
`.npc` file per body slot, and reassign randomly per NPC (or per NPC category, so you
can bucket "citizen"/"guard"/"quest-critical" separately if you don't want, say, a
quest giver becoming unrecognizable). Runs as a pre-build content transform over the
vanilla `.npc` files — reroll by regenerating from vanilla + seed. Keep an exclude list
for any NPC whose model is load-bearing for gameplay (disguises required for quest
recognition, etc).

---

## 4. Shop location randomization (stock stays put, access moves)

**What's already there:** shopkeeper NPCs are already fully decoupled from their shop's
stock. E.g. in `content/scripts/areas/area_alkharid/configs/alkharid.npc`:

```
category=shop_keeper
param=owned_shop,scimitarshop
param=shop_sell_multiplier,1000
param=shop_buy_multiplier,550
param=shop_title,Zeke's Superior Scimitars.
```

The actual stock lives in a separate `.inv`/dbtable keyed by `scimitarshop`. The NPC is
just a pointer.

**Implementation sketch:** this is a clean, surgical randomization — collect every
`owned_shop` id across all area `.npc` configs, shuffle which NPC spawn gets which id
(carry `shop_title`/multipliers along with it so the shop still makes internal sense,
or deliberately leave the title mismatched as a chaos/comedy toggle). This is pure data
mutation on the `.npc` config files, same class of change as idea #3 — no engine or
script changes required. The one thing this *does* need that #3 doesn't: since players
rely on specific shops for specific tools/items as part of quest logic, the shuffled
shop-id → location mapping has to be exported into the seed's spoiler data so the AP
Python world can build correct access rules.

---

## 5. XP multiplier, 10x–30x

**What's already there:** this is already fully wired.
`engine/src/util/WorldConfig.ts` defines `xpRate: number` (default `1`), overridable via
`NODE_XPRATE` env var (`tryParseInt(env.NODE_XPRATE, config.node.xpRate)`).

**Implementation sketch:** no game-logic work needed at all. Add `xp_rate` as a normal
Archipelago per-slot YAML option (range 10–30), and have whatever deploys/launches a
player's server instance write the chosen value into `NODE_XPRATE` at boot. This is
pure plumbing from AP slot-data into an env var that already does the right thing.

---

## 6. Junk rewards deposit straight to the bank

**What's already there:** `inv_add(bank, item, qty)` is an established, already-used
primitive — e.g. the tutorial banker setup, `quest_legends.rs2`, and the debug
`cheat_bank.rs2` all deposit items directly to a player's bank without touching
inventory space.

**Implementation sketch:** when the AP client-side item-receive handler processes an
incoming item, filler/junk items (worthless in this game, or items that only matter to
someone else's game in the multiworld) should never be able to cause an inventory-full
soft-lock or get dropped on the ground and lost. Route those through
`inv_add(bank, item, qty)` directly — the exact primitive already in use elsewhere —
rather than the normal "goes to inventory, overflow drops on ground" path. Items that
are actually meaningful and possibly needed immediately (e.g. a quest item granted
mid-quest-script) should probably still land in inventory, so this likely wants a
per-item-type flag (`bank_safe` vs `must_be_held`) rather than a blanket rule.

---

## Shared plumbing across #1, #2, #4

All three of these (entrances, drops, shops) follow the same shape: a seed-time
shuffle producing a data mapping, a small runtime override/indirection layer that
consults that mapping before falling back to vanilla behavior, and a spoiler export so
the AP Python world's logic/rules generation knows what the seed actually did. Worth
building that override-table pattern once and reusing it for all three rather than
inventing a bespoke mechanism per idea.
