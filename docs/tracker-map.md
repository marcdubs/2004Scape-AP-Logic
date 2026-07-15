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
| Anything content-side | new script command `ap_track(category, key, value)` — **opcode 1905** | script says so |

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

- **Map tab**: markers for every *discovered* shuffled entrance with lines to
  their landing spots (paired gates get two-way arrows); home-spawn flag;
  optional "N shuffled entrances undiscovered" counter as the hunt motivator
  (count comes from the override table size — not a spoiler, just a total).
- **Gathering tab**: "Normal tree → Raw mackerel", one row per discovered swap,
  vanilla-vs-now with item icons if we're feeling fancy (obj icons are
  extractable from the cache later; text first).
- **Recipes tab**: same for processing swaps (cooking/smithing/crafting/
  fletching outputs).
- **Bestiary tab**: "Goblin — smells like Cow" per discovered mimic.
- **Teleports/Shops tab**: revealed cast-by-cast / visit-by-visit.
- **Goals strip** (piggybacks checks-and-unlocks.md): barcrawl bars N/10,
  Dragon Slayer stage, KBD status, checks fired — the varp watcher and
  `~ap_check_fired` proposed there can call `recordDiscovery('checks', ...)`
  too, making this page the pre-AP progress tracker and, later, the local
  companion to the real AP multiworld tracker.

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

## Effort estimate

| Piece | Size |
|---|---|
| `ApTracker.ts` + 4 lookup hooks + opcode 1905 | small — an evening |
| `web.ts` overlay route | small |
| PNG renderer tool | medium — the flo-color render is the one genuinely new bit, but `Worldmap.ts` is the crib sheet |
| Tracker SPA (map + tabs, polling) | medium — plain web dev, spoiler mode makes it fast to iterate |
| Content-side `ap_track` calls (teleports/shops/home) | small |

No new infrastructure categories: runtime-JSON pattern (existing), engine
command recipe (existing, 1905 next), whole-file overlays (existing), static
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
