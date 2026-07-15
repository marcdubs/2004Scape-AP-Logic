# Entrance logic — gated areas, gated entrances, and seed validation

Status: **decided with the user 2026-07-15** (three AskUserQuestion answers, all
recommended options). Root cause that triggered this: the user walked down a
shuffled staircase and appeared inside the Champions' Guild without 32 QP —
verified: the guild is gated by its DOOR script (`championdoor`, `%qp < 32` in
`areas/area_varrock/scripts/champions_guild.rs2`), doors aren't entrances, and the
guild's interior staircase was a legitimate floor-shift shuffle candidate. Two
arrivals in the current seed-777 table land inside the guild footprint. Area gates
were never modeled — only entrance-script gates were (and those were excluded).

**Design pivot (user-directed):** stop EXCLUDING gated things — INCLUDE them and
enforce requirements, with logic guaranteeing beatability, like any Archipelago
game. "Complete a quest → gain an area → the ladder there leads to new
progression" is the intended experience.

## Decisions

1. **Blocked-arrival UX**: refuse with a flavor message, player stays put —
   "A strange force bars your way. (Champions' Guild: requires 32 Quest Points)".
   Engine mechanism (already plumbed): `AP_ENTRANCE_OVERRIDE` consults
   `ApAreaGates.applyAreaGate(player, dest)`; on false the module messages the
   player and the op returns the player's own tile (telejump no-op — zero content
   changes needed for blocking).
2. **Scope**: full build now, three staged agents (A enforcement, B gated-entrance
   inclusion, C region-graph logic validation).
3. **Gate list**: curated guilds + quest zones, enumerated by scanning every door/
   gate script with a qp/stat/quest-varp check.

## Shared schema — `data/config/ap-gated-areas.json` (static per game version, ships in overlays)

```json
{ "areas": [
  { "name": "Champions' Guild",
    "boxes": [ { "level": 0, "x1": 3185, "z1": 3358, "x2": 3197, "z2": 3369 },
               { "level": 1, "x1": 3185, "z1": 3358, "x2": 3197, "z2": 3369 } ],
    "require": { "varp": "qp", "gte": 32 },
    "message": "A strange force bars your way. (Champions' Guild: requires 32 Quest Points)" }
] }
```

- `require` v1 forms: `{ "varp": <name>, "gte": <n> }` (covers QP and quest-stage
  completion — quest varps at/above their complete constant) and
  `{ "item": <objname> }` (held-item gates like the Zanaris shed's dramen staff).
  `{ "allOf": [ ... ] }` combines. **v1.1 (added by workstream A during build):**
  `{ "stat": <PlayerStat name>, "gte": <n> }` — skill-level gates (Crafting/
  Wizards'/Mining guilds have no varp), checked against BASE level (stricter than
  the vanilla doors' boostable check, deliberately). All consumers (ValidateSeed,
  future tools) must handle all four forms.
- Boxes are absolute tile coords, inclusive. Multiple boxes per area (floors,
  annexes). Slightly-generous boxes are safer than leaky ones.
- Missing file = everything allowed (vanilla fail-open, same as every AP table).

## Workstream A — area-gate enforcement

`ApAreaGates.ts` internals (stub exists; frozen API `applyAreaGate(player, dest):
boolean`, module sends its own denial via `player.messageGame`, throttled per
player ~1/sec because menu-label lookups hit the same path). Curate the launch
list: Champions' Guild, Heroes' Guild, Legends' Guild, Crafting Guild, Wizards'
Guild, plus quest-locked zones found by grepping door/gate/entry scripts for
`%qp` / `stat_base` / quest-varp checks. Test command `::apgates` (what gate, if
any, covers my current tile + do I pass).

## Workstream B — gated-entrance inclusion

The previously auto-excluded gated entrance scripts join the shuffle pool with
their gates kept: patch each gated handler so the quest/item check runs BEFORE
the override consult (the vanilla-order bypass documented in lessons-learned).
The gate then guards WHEREVER the entrance now leads. Emit a `gates` section into
`ap-entrances.json` (trigger key → require expression, same schema as above) so
the validator can consume it. Candidates enumerated from EntranceParser's `gated`
exclusions — include what's safely includable (e.g. dwarf trapdoor, Zanaris
shed), keep excluding side-effect-laden ones (black knights aggro ladder) and
non-constant destinations (board-game stairs), and document every keep/exclude.

## Workstream C — region graph + seed logic validation

Offline tools (`engine/tools/logic/`):
- `BuildRegionGraph.ts`: flood-fill walkable tiles from the packed collision/map
  data into region ids (per level), map every entrance trigger + arrival tile and
  every gated-area box to a region. Output `region-graph.json`.
- `ValidateSeed.ts`: consume region graph + `ap-entrances.json` (incl. `gates`) +
  `ap-gated-areas.json` + the simulator's `tools/sim/data/quests.json`. Sphere
  expansion: reachable regions ⇄ satisfiable requirements (QP/quests/items) ⇄
  newly traversable gated edges, until goals reachable or fixpoint. Exit 0/1 +
  precise blocker report (mirrors SimulateProgression's contract).
- Wiring `RandomizeEntrances.ts` to reroll-until-valid is an integration step
  AFTER both land (avoids two agents editing the randomizer concurrently).

## Backlog (user: "track and accomplish later")

- **Entrance items**: bar additional entrances behind AP check rewards ("Key to
  the Lava Maze") — the `gates` schema above already accommodates it via a future
  `{ "unlock": "key_lava_maze" }` require form reading ap-unlocks.json.
- Feed gated-area denials into the browser tracker ("you found a locked way to
  somewhere...").
- Simulator (`tools/sim`) adopting the region graph for true seed-aware travel.
