# Browser tracker map — feasibility & design (proposal)

Status: **researched 2026-07-15, feasible, decisions pending** (bottom). The ask: a
separate browser page with a world map that progressively reveals what the
randomizers did — entrances show where they lead *only after you've used them
once*, gather/manufacture swaps appear *only after you've performed them once*,
etc. A discovery journal, not a spoiler dump.

**Verdict: very feasible.** Every hard part already exists in the checkout:

1. **The engine web server is trivially extensible.** `engine/src/web.ts` is a
   plain `http.createServer` with an if-chain router (`handleWebRequest`), and it
   already falls through to serving static files from `engine/public/`
   (`web.ts:174-177`) — a tracker SPA dropped into `engine/public/ap/` is served
   with ZERO engine changes. Only the live-data endpoint needs a `web.ts` overlay.
2. **Every randomizer's runtime lookup is a one-function chokepoint we own** —
   perfect discovery-recording hooks (details below).
3. **A browser world-map renderer for this exact map data already exists**:
   `webclient/src/mapview/MapView.ts` (1,962 lines, a full port of the 2004
   world-map applet, already a build entry in `webclient/bundle.ts:156`). It
   fetches `/worldmap.jag` (already routed: `web.ts:144-147`, built from map data
   by `engine/tools/pack/map/Worldmap.ts`) and renders a pannable canvas map.
   Even if we don't reuse it directly, it proves the data → browser-map pipeline
   end to end.

---

## Architecture (three small pieces)

### 1. Discovery recording — engine module `ApTracker.ts`

A tiny module with `recordDiscovery(category, key, value)` appending to
`engine/data/config/ap-tracker.json` (in-memory map + debounced flush; reads are
served from memory). Discovery events come from hooks that ALL already exist as
single owned functions:

| Discovery | Hook (verified) | Fires when |
|---|---|---|
| Entrance destinations | `ApEntranceOverrides.getEntranceOverride()` — record on hit | player actually uses a shuffled entrance |
| Gather swaps | `ApGatherOverrides.getGatherSwap()` (`:53`) | swapped product actually delivered (mine/chop/fish) |
| Manufacture/recipe swaps | `ApProcessOverrides.getProcessSwap()` (`:54`) | swapped output actually crafted/cooked/smithed |
| Drop-table mimics | `ApDropOverrides.getDropGroupOverride()` (`:48`) | monster with a mimicked table actually killed |
| Anything content-side | new script command `ap_track(category, key, value)` — **opcode 1906** | script says so |

The first four are engine-only edits inside files this repo already overlays —
the lookup *is* the "player did the thing" moment, so "revealed only after doing
it once" falls out for free. Note the natural semantics: vanilla (non-shuffled)
things never hit an override table, so they never clutter the tracker.

`ap_track` covers the stragglers that are config-mutation rather than runtime
lookups: teleport spells (one call in `teleport.rs2`'s cast path reveals where
that spell ACTUALLY goes — chef's kiss alongside the destination shuffle),
shopsanity (one call in `~openshop_activenpc` reveals which shop that keeper
holds), the seeded home point (reveal on first death/`::home`). Each is a 1-line
addition to a file, most of which are already overlaid.

Two mechanical cautions from prior lessons: the recorder must be **fire-and-
forget cheap** (these lookups run inside the game tick — no sync fs writes; the
debounce flush does the I/O), and dedupe in memory (only first discovery writes).

### 2. Serving — one route in a `web.ts` overlay

- `GET /ap/tracker.json` → current discovery state, **names resolved
  server-side** (obj ids → names via ObjType, coords → readable places), plus
  seed stamps. The browser stays dumb; polling every ~5s is plenty for a
  single-player server. (WebSocket push is possible — the server already runs
  one for the game client — but polling wins on simplicity.)
- Static SPA in `engine/public/ap/` (plain HTML/JS/CSS, no build step) — served
  by the existing public-dir fallthrough, zero engine code.
- `web.ts` becomes an overlaid vanilla file (first time) — standard "whole-file
  copy, diff against upstream on update" caveat applies.

### 3. The map itself — two viable renderers

**Option B — pre-rendered PNG + HTML overlay (RECOMMENDED for v1).** A one-time
tool `tools/map/RenderWorldmapPng.ts` reuses `Worldmap.ts`'s data extraction
(underlay/overlay flo colors per tile — the exact data `worldmap.jag` is built
from) to emit `public/ap/worldmap.png` at 1–2 px/tile, regenerated only on
content rebuild. The tracker page is then ordinary web dev: pan/zoom the image
(CSS transforms), absolutely-positioned markers, an SVG layer for entrance
connection lines. Tile→pixel math is linear (`abs = mapsquare*64 + local`), no
projection nonsense. The +100-mapsquare underground convention gets its own
rendered strip behind a surface/underground toggle (same tool, different Z
band); cross-layer entrances draw a marker on each layer plus a linking badge.

**Option A — reuse `MapView.ts` (the deluxe version).** Authentic 2004 world-map
look, already bundled. But it's a `GameShell` applet with its own input/render
loop — injecting marker layers and discovery state means real surgery on a
2,000-line port. Worth revisiting for polish after B proves the data flow.

Don't build tiled-Leaflet anything; the whole surface world at 2px/tile is a
few-thousand-pixel image, one file is fine.

## What the page shows (all progressively revealed)

- **Map tab** (redesigned — see "Map interaction" below): one pin per map spot,
  no connecting lines until a pin is selected. Explored spots are solid, *not-yet-
  explored* shuffled entrances are hollow (their existence is shown, never their
  destination), teleport landings are gold, and a spot stacking several entrances/
  levels shows a count badge. Home-spawn flag; discovered/total counters per
  category (totals come from the override table size — not a spoiler).
- **Gathering tab**: "Normal tree → Raw mackerel", one row per discovered swap,
  vanilla-vs-now with item icons if we're feeling fancy (obj icons are
  extractable from the cache later; text first).
- **Recipes tab**: same for processing swaps (cooking/smithing/crafting/
  fletching outputs).
- **Thieving tab** (built 2026-07, GitHub #6): "Coins — steals like —
  Adamantite ore" per discovered pickpocket/stall/chest loot swap.
- **Bestiary tab**: "Goblin — smells like Cow" per discovered mimic.
- **Teleports/Shops tab**: revealed cast-by-cast / visit-by-visit.
- **Checks tab** (built 2026-07, GitHub #19 — see "Checks tab" below): the
  517-location check catalog, grouped, with fired/not per row. This is the
  "goals strip" idea below, delivered as a full tab.
- **Goals strip** (piggybacks checks-and-unlocks.md): barcrawl bars N/10,
  Dragon Slayer stage, KBD status, checks fired — the varp watcher and
  `~ap_check_fired` proposed there can call `recordDiscovery('checks', ...)`
  too, making this page the pre-AP progress tracker and, later, the local
  companion to the real AP multiworld tracker.

## Map interaction (2026-07 redesign)

The original map drew every discovered connection's line + endpoints + label on
every 5s poll. Once a few dozen entrances were found it became a laggy tangle, so
the map was rebuilt around **pins + on-demand selection**:

- **Sites**, not raw entrances, are the unit. `buildSites()` (app.js) groups every
  shuffled entrance source *and* teleport landing by map pixel (`absX_absZ`). A
  single spot commonly stacks several plane levels and several loc ops (spiral
  staircase up + down, trapdoors on different floors) — grouping is what lets a
  click "separate out the multiple levels available" instead of piling identical
  pins.
- **No lines by default.** Only the *selected* site draws its links (each stacked
  entrance gets its own palette color, matched by a swatch in the info panel).
- **Click-to-select** is done by manual hit-test (`handleMapClick`) in world
  space, because the viewport owns the pointer capture for pan/drag, so native SVG
  clicks never fire. A pointerup that didn't move >4px is treated as a click.
- **Unexplored entrances are shown** as hollow pins. This needs the source coords,
  so `web.ts` now returns `entranceSources` (from `getEntranceSources()` in
  `ApEntranceOverrides.ts`) — the override-table *keys* only. It reveals that a
  shuffled entrance exists at a spot (which the player sees in-game the moment they
  walk up to it) but never where it leads; the destination stays gated behind
  actually using it. Source-coord place names are added to `names.places` too
  (`loadEntranceNames` only ever describes the source location, never its dest).
- **Performance:** the pin layer (potentially hundreds of circles) is rebuilt only
  when the layer or discovered-data signature changes (`lastPinKey`); selection is
  a separate, cheap `<g>` redrawn on click. Polling no longer churns the DOM.

## Authentic map render (2026-07 rewrite)

The v1 background was a flat flo-mapcolor fill (terrain only, no buildings/labels) and
read as "weird/generated". `RenderWorldmapPng.ts` was rewritten to bake the **authentic
2004 world map** by reusing the webclient's own renderer, headless:

- **Source is `engine/data/pack/mapview/worldmap.jag`** (built by `Worldmap.ts`) — the
  exact data the in-client world-map applet reads. Its `.dat` streams carry *every*
  mapsquare keyed by its own `mx/mz` (the applet just windows the surface ones out), so
  both layers bake from it; underground is still just `mapZ >= 100` bucketing.
- **The pixels come from MapView's routines, not a re-derivation.** `getRgb` +
  `getBlendedGroundColour` (the directional HSL terrain shading), `renderWorldMap`'s
  per-tile fill + wall pass, and `drawOverlayShape` (diagonal coastline/path tiles) are
  ported verbatim into the tool and run into a raw pixel buffer at 2px/tile. Output:
  shaded terrain, real coastlines, and building/wall outlines (grey walls, red doors).
  This is the render *routine* only — none of MapView's GameShell/applet/input loop.
- **No applet embed, no live canvas.** The tracker keeps the flat-PNG + SVG-pin
  architecture; the bake just replaces the PNG content. Bounds/`pxPerTile` are
  byte-identical to v1, so existing pin coords line up unchanged.
- **Mapscene/mapfunction icons are skipped** for now (they'd need sprite depack from the
  jag) — a possible follow-up. Walls + overlay shapes + blend already deliver the look.
- **Place-name labels ship as data, not pixels.** `labels.dat` (absolute-tile coords +
  size tier, `/` = line break) is emitted into `worldmap-meta.json` as `labels[]`; the
  SPA draws them as SVG `<text>` in map space (`rebuildLabels`), so they scale with the
  map like real map lettering and stay crisp — no bitmap-font port needed. Region names
  (size 2) render gold/uppercase, towns (1) and POIs (0) white.

Regenerate with `npx tsx tools/map/RenderWorldmapPng.ts` (run in `../Server/engine`);
it reads the built jag, so it only needs re-running when map content changes. Copy the
three outputs (`worldmap-surface.png`, `worldmap-underground.png`, `worldmap-meta.json`)
back into `overlays/engine/public/ap/` so `install.js` deploys them.

## Checks tab (2026-07, GitHub #19)

Every other tab answers "what did the randomizer do"; this one answers "what
have I actually done". The data was already there — `ApChecks.fireCheck` calls
`recordDiscovery('checks', ...)` on both the solo-placement and the AP path — so
this was a UI change plus one new read-only route.

- **Route split.** The catalog (517 names/kinds/flags) is per-seed *static*, so it
  rides its own `GET /ap/checks.json` instead of bloating the 5s `tracker.json`
  poll. Fired state stays on `tracker.json` as `discoveries.checks`. The SPA
  fetches the catalog once at load and again whenever the tab is opened (cheap,
  and it self-corrects after an Archipelago connect changes what's excluded).
- **The catalog is the AP datapackage.** `data/config/ap-archipelago-data.json`
  (written by `tools/ap/ExportApWorldData.ts`, already shipped for the AP client)
  has all 517 locations with the same ids and display names the multiworld and
  the spoiler log use — no second source of truth to drift.
- **Grouping** reuses `RS2004World._KIND_GROUP`'s labels verbatim, with the three
  odds-and-ends kinds (`activity` 13 + `barcrawl` 10 + `ds` 6 = 29) merged into a
  **Miscellaneous** group that is open by default and keeps their headings as
  sub-sections. Quests/Levels/First XP/First Kills/Music start collapsed with
  `n/total` counters — they're long and self-evident; Miscellaneous is the list
  you consult to find what you forgot exists.
- **Not-obtainable ≠ not-done.** Two per-seed sources, one per mode:
  - AP mode: `ApClient` now remembers `missing_locations` + `checked_locations`
    from the `Connected` packet — together, exactly the locations the multiworld
    generated for this slot. Anything in the catalog but not in that set was
    dropped by the apworld's feasibility exclusion and can never fire.
  - Solo placement mode: `GenerateSeed.ts` now writes its own
    `spatial.infeasibleLocationIds` to `ap-placements.json` as `infeasibleChecks`
    (outside the `spoiler` block — it says *which* checks are impossible, never
    what's in them, so the runtime may read it).

  Either source may be absent (never connected; a seed rolled before this
  existed) — then nothing is marked, which is the safe direction. Excluded rows
  render struck-through as "not in this seed" and are **out of the denominator**,
  or 100% completion would be unreachable on paper.
- **`fillerOnly` is a different thing** and gets its own "luck-gated" tag, not
  exclusion: the three clue-trail tiers and the music tracks are perfectly
  reachable, they just never hold progression (clue *acquisition* is drop RNG).
- **`musicChecks: false`** drops the group entirely rather than showing 0/230 —
  those watches are never even loaded (`ApChecks.loadWatches`).
- **Contents.** A fired check shows what it gave you (that's a discovery, already
  in the ledger). Unfired contents appear only under `?spoiler=1`, and only in
  solo mode — in AP mode the multiworld owns them and a stale
  `ap-placements.json` from an earlier solo run must never be shown as this
  run's answer.

## Seed lifecycle & testing

- The tracker JSON carries each randomizer's seed stamp; reseed tools (and
  `RegenerateAll.ts`) delete/reset `ap-tracker.json` — stale discoveries from a
  previous seed are lies, worse than nothing.
- `::aptrack` test command: dump discovery counts per category in-game (and
  `::aptrack <category>` to force-record a synthetic discovery for testing).
- **Spoiler mode for UI development**: every randomizer already writes a spoiler
  (`ap-entrances.json`'s spoiler block, gather/process/drops seed JSONs). A
  `?spoiler=1` query param (or a dev-only route) renders the page fully
  populated from spoilers without playing a minute — this is how the map/UI gets
  built and eyeballed from WSL despite the "can't boot the server here" rule.
  In normal mode the endpoint must NOT expose spoiler data, only discoveries.

## Pathfinding helper (built 2026-07-30)

"Which entrances do I take, in what order, to get from here to there in the fewest
movement ticks." Shipped to **both** front ends off one router.

### Why it was cheap: the cost splits cleanly

A route alternates two kinds of movement, and only one of them is seeded:

| half | depends on | so it is |
|---|---|---|
| walking between tiles | map geometry only | precomputed **once, forever** |
| using an entrance | the seed | rebuilt per seed, from a tiny table |

That split is the whole design. The expensive part (all-pairs walking distances) never
needs recomputing on reseed, and the seed-dependent part is a few hundred edges. A query
is then a Dijkstra over ~1.7k nodes.

### The pieces

1. **`ap-walk-grid.bin`** (~8.5 MiB) — emitted by **`BuildRegionGraph.ts`**, not a new
   tool, because it must come from the *same door-opened collision state* as the regions;
   building it separately would risk the two disagreeing. One byte of step mask per tile
   (bit d = `canTravel` allows direction d) plus a walkable bit-plane. Format and reader:
   `ApWalkGrid.ts`.
   - **8 directions, not the flood's 4.** The region flood only needs cardinals; distance
     needs diagonals, since a diagonal step costs the same tick. Omitting them would
     overstate travel by up to ~41% on open ground.
   - **The unit is therefore a movement tick**, not a tile: 1 per step walking, 2 per tick
     running. That is the thing worth minimizing.
2. **`ap-walk-graph.json`** (~0.93 MiB) — `BuildWalkGraph.ts`. 1,751 nodes: a trigger and
   an arrival node per entrance side (1,616) plus one per world-map label (135). Walking
   edges as per-region distance matrices — **all pairs, not k-nearest**: within a region the
   walk metric obeys the triangle inequality, so the direct edge *is* the shortest walk and
   sparsifying could only return worse-than-optimal routes. ~70s to build, seed-independent.
3. **`ApPathfinder.ts`** — overlays this seed's `ap-entrances.json` as entrance edges,
   floods the grid to attach the player's arbitrary tile, runs Dijkstra. ~10ms warm.
4. **`ApPathGuide.ts`** + `ap_path.rs2` + opcodes 1915-1919 — the in-game side.
5. **`/ap/path.json`** + `/ap/places.json` + the tracker's route bar — the browser side.
6. **`/ap/guide.json`** — the browser arming the in-game arrow. Picking a route in the
   tracker is picking it in game: 135 destinations is a dropdown's job, not a chat prompt's.
   Deliberately a *separate* endpoint from `path.json` rather than a flag on it, because it
   is the one that changes the game's state; keeping `path.json` a pure query means a stray
   refresh or a bookmarked URL can never move a player's arrow. It only fires when the route
   starts at the player — routing from an explicit From place is planning a trip, not
   walking one, and would aim the arrow at a leg nobody has reached. The call is advisory:
   the map route is already drawn when it runs, so a failure reports itself without
   discarding the answer that was asked for.

### Two traps worth remembering

- **Map labels are typographic, not positional.** Resolving a label to its *nearest*
  walkable tile put Falador in a sealed 207-tile shop interior, Edgeville in a 20-tile
  room, Port Sarim in a 41-tile one — all unreachable, silently making those towns
  un-routable. A label names the open area around it, so `resolvePlaceTile` picks the
  candidate in the **largest** region within 24 tiles, tie-broken by proximity. Entrances
  keep nearest-walkable: a ladder inside a building really does belong to that building.
- **Entrance trigger tiles are mostly not walkable** (loc footprints). Only 345 of 1,616
  endpoint tiles were directly standable; the rest need the same ring-probe
  `RegionGraph.resolveRegion` uses. Skip it and 4 in 5 entrances have no route.

### Spoiler discipline

`::appath` defaults to **discovered-only** — routing through entrances the player has
never opened would hand them the entrance layout on request, which is the one thing a
randomizer exists to withhold. `::appathall` is the explicit, differently-named opt-in;
the tracker follows the page's existing `?spoiler=1`. Unrestricted routes still *flag*
unexplored hops rather than hiding that they were used.

### The arrow

`hint_coord` (`^hint_center = 2`) is the Tutorial Island arrow and already a stock content
command — no engine work for the arrow itself. The client has no waypoint-path rendering,
so a multi-leg route is delivered the only way it can be: one arrow, re-pointed at the next
entrance as you reach the current one (`tickRoute`, called from `Player.updateMovement`).
It is armed lazily — the client only draws a coord arrow inside its loaded scene, so
pointing across the world does nothing; the guide arms it once the waypoint is within ~90
tiles and disarms if you leave.

### Inspecting a seed

`npx tsx tools/logic/ExplainPath.ts <place> [--from x] [--explored] [--list] [--compare]`.
`--compare` ranks destinations by how much the shuffle beats walking — on the seed this was
built against, **81 of 105 destinations were faster via a shuffled entrance** (Sinclair
Mansion: 789 steps on foot vs 76 with 3 hops).

## Effort estimate

| Piece | Size |
|---|---|
| `ApTracker.ts` + 4 lookup hooks + opcode 1906 | small — an evening |
| `web.ts` overlay route | small |
| PNG renderer tool | medium — the flo-color render is the one genuinely new bit, but `Worldmap.ts` is the crib sheet |
| Tracker SPA (map + tabs, polling) | medium — plain web dev, spoiler mode makes it fast to iterate |
| Content-side `ap_track` calls (teleports/shops/home) | small |

No new infrastructure categories: runtime-JSON pattern (existing), engine
command recipe (existing, 1906 was next), whole-file overlays (existing), static
web serving (already in vanilla).

## Decisions needed from the user

1. **Renderer**: PNG-overlay v1 (recommended) — OK to defer the authentic
   MapView look to later?
2. **Undiscovered hints**: show "N undiscovered" counters per category, or pure
   fog (nothing until found)?
3. **Scope of v1 tabs**: map + gathering + recipes + bestiary, with
   teleports/shops/goals after? Or all at once?
4. **Should discovered checks/goals live here too** (one dashboard), or keep
   this purely "what did the randomizer do"?
