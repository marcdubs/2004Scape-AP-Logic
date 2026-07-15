# Goals, checks & rewards — the decided plan

Status: **decided with the user 2026-07-13**. Test-command infrastructure +
Feature 1 (goals system) built 2026-07-14 — see the "Session-end addendum:
test-command dispatcher + goals" section in lessons-learned.md. Features 2-5
still unbuilt. Every factual claim below (file paths, line numbers, varp names,
hook points) was verified against the live `../Server` checkout on 2026-07-13 —
re-verify line numbers if upstream has moved, but the mechanisms are stable.

## Decisions (user-approved scope)

**Goals** (win conditions for solo play, later AP goal options):
1. **Alfred Grimhand's Barcrawl**
2. **Dragon Slayer**
3. **Kill the King Black Dragon**

**Checks & rewards:**
- Every quest completion is a check location.
- Completing a quest (a check, pre-AP) triggers a **random level-based reward** —
  e.g. with 40 Defence you might get a rune armour piece. Categories: runes,
  ranged gear, arrows, weapons, armour, cash, potions, food. This same system
  becomes the AP "junk/filler item" handler later.

**New randomizers approved:** groundsanity (world item spawns), random
respawn/home point (constrained to the standard-spellbook teleport locations so
it stays sensible), teleport spell destination shuffle.

**Explicitly rejected — do not build:** shop *stock* shuffle, NPC recolors,
NPC spawn shuffle ("enemizer"). Shopsanity (shop *location*) stays as shipped.

**Every feature below must ship with test commands** (see "Test command
infrastructure") so each piece can be exercised in seconds without playing to it.

---

## Test command infrastructure (build this first) — DONE 2026-07-14

Production mode blocks debugprocs: `ClientCheatHandler.ts` only dispatches
`[debugproc,...]` scripts when `!Environment.node.production && staffModLevel >= 4`
(vanilla `handle()`, the block commented "debugprocs are NOT allowed on live"), and
the user runs `node.production: true`. The `::home` command already added to the
overlaid `ClientCheatHandler.ts` shows the working pattern: an ungated block in the
engine handler.

Rather than one engine block per test command, add **one ungated dispatcher**:
any cheat starting with `ap` looks up `[debugproc,ap_<rest>]` via
`ScriptProvider.getByName` and runs it regardless of production/staff gates
(reuse the vanilla debugproc arg-parsing right above it). Then every test command
is a content-side rs2 script in `overlays/content/scripts/ap/`, and adding one
never touches the engine again. Keep `::home` as-is.

Required test commands (each feature section references these):

| Command | Feature under test | What it does |
|---|---|---|
| `::apgoals` | goals | print progress on all 3 goals + QP |
| `::apreward [category] [level]` | reward system | roll & grant a reward; args force category/tier |
| `::apquestcheck` | quest checks | fire the quest-completion check+reward path without completing a quest |
| `::apspawn` | home point | print the seeded home coord, then teleport there (exercises the same lookup death uses) |
| `::aptele <spellname>` | teleport shuffle | teleport to a spell's current (possibly shuffled) destination, no runes/level needed |
| `::apground` | groundsanity | print vanilla-vs-shuffled obj for ground spawns in the current zone |
| `::apkbd` | KBD goal | toggle the KBD-kill flag (to test `::apgoals` rendering both ways) |

---

## Feature 1 — Goals system — DONE 2026-07-14 (offline-verified only, see lessons-learned)

Three goals, tracked per-player, displayed via `::apgoals`. New varps go in
`overlays/content/scripts/ap/configs/ap.varp` (format verified:
`[varpname]` + `scope=perm`, same as `quest_barcrawl.varp`).

**Barcrawl** — already fully tracked by vanilla. `%barcrawl` is a bitfield
(`quests/quest_barcrawl/scripts/quest_barcrawl.rs2`); the 10 bars are bits 3–12
and completion is `getbit_range(%barcrawl, 3, 12) = calc(pow(2,10) - 1)` (that
exact expression appears at line 13 of the script). `::apgoals` can render "bars
visited: N/10" from those bits. **No new tracking needed.**

**Dragon Slayer** — already tracked: complete when
`%dragonquest >= ^dragon_complete` (`^dragon_complete = 10`,
`general/configs/quest.constant:18`). **No new tracking needed.**

**King Black Dragon** — needs one new varp (`%ap_kbd_killed`, scope=perm). Hook
point verified: `areas/area_wilderness/scripts/king_black_dragon.rs2` starts
`[ai_queue3,king_dragon]` with `gosub(npc_death)` then
`if (npc_findhero = ^false) { return; }` — `npc_findhero` sets the active player
to the kill's hero, so immediately after that check is the right place to set
`%ap_kbd_killed = 1` (and `mes` a congratulation). Overlay a full modified copy of
that file (whole-file replacement, per repo convention). Needs a pack rebuild.

KBD access context for players: his lair is deep-Wilderness, reached through the
Lava Maze dungeon ladder — under entrance randomization that route may be wildly
different, which is the point. He's also poison-capable and multi-headed; dying
to him with a randomized respawn point is part of the fun.

**AP phase:** each goal maps to an AP goal/victory condition; barcrawl bar-bits
and quest state are also candidate location checks.

## Feature 2 — Quest-completion checks + level-based random rewards — DONE 2026-07-14 (offline-verified only, see lessons-learned)

**The hook (verified single choke point):** `[proc,send_quest_complete]` in
`general/scripts/quests.rs2:15` is called by all ~64 quest completion scripts
(65 files reference it, including the custom-scroll quests like Observatory and
Gertrude's Cat — they go through the same proc). Overlay that file and append a
call to a new `~ap_quest_complete` proc at the end. That proc:

1. (pre-AP) rolls a random reward — see below — and announces it.
2. (AP phase) becomes the "location checked" emitter; the reward roll moves to
   the item-received path as the junk/filler handler.

**Reward roll design:**
- Pick a category uniformly at random: `runes`, `ranged_gear`, `arrows`,
  `weapons`, `armour`, `cash`, `potions`, `food`, `tools`.
- Pick the item within the category by the governing stat, checked with
  `stat(...)` at roll time: armour→defence, weapons→attack, ranged gear &
  arrows→ranged, runes→magic, potions & food→hitpoints (or combat level),
  tools→min(woodcutting, mining) (so a lopsided gatherer can't roll a top-tier
  tool for the skill they haven't trained), cash→scale with quest points
  (`%qp`).
- Tier tables: give each pool entry a `min_level`; roll among entries the player
  qualifies for, weighted toward the top of their range so a 40-Defence player
  actually sees rune, not an even chance of bronze. Example the user gave:
  40 Defence → eligible for a rune armour piece.
- **Data lives in a dbtable** (`overlays/content/scripts/ap/configs/
  ap_rewards.dbtable` + `.dbrow`, modeled on `drop tables/configs/
  drop_table.dbtable`'s `column=drop,namedobj,int,int,LIST` shape, plus a
  min-level column). The pools are static (randomness is at roll time, not seed
  time), so this ships once in the overlay — no per-seed mutation, one pack
  rebuild when the tables change.
- **Delivery:** try `inv_add(inv, ...)`; on full inventory fall back to
  `inv_add(bank, ...)` with a "sent to your bank" message — this is
  archipelago-ideas.md #6's pattern, already used by e.g. `quest_legends.rs2`.
  Never drop rewards on the ground.

**Test commands:** `::apreward` (bare = fully random roll; `::apreward armour 40`
forces category+level to eyeball each tier), `::apquestcheck` (runs
`~ap_quest_complete` directly, so the whole path can be tested without finishing
a quest).

**Verification:** typecheck + pack build + in-game: force every category at
levels 1/20/40/60/99 via `::apreward` and confirm no invalid-obj errors and
sensible tiers; fill inventory and confirm bank fallback fires.

## Feature 3 — Random respawn/home point

One seed-chosen **home coordinate**, drawn from the 7 standard-spellbook teleport
destinations (the user's "somewhat sensible" constraint — verified vanilla coords
from `skill_magic/configs/magic_spells.dbrow`):

| Spell | Coord |
|---|---|
| Varrock | `0_50_53_13_32` |
| Lumbridge | `0_50_50_21_18` |
| Falador | `0_46_52_21_50` |
| Camelot | `0_43_54_5_22` |
| Ardougne | `0_41_51_37_37` |
| Watchtower | `2_45_73_53_41` |
| Trollheim | `0_45_57_10_31` |

Use the **vanilla** list above (not the shuffled teleport table from Feature 4) —
home should be a real town-ish landmark regardless of where spells go.

Applies to:
- **Death respawn** — verified single hardcoded site:
  `player/scripts/death.rs2:32`,
  `p_teleport(map_findsquare(0_50_50_21_18, 0, 2, ...))`. Overlay the file with a
  preamble consulting the override.
- **`::home`** — the overlaid `ClientCheatHandler.ts` block (currently hardcoded
  Lumbridge); read the same override engine-side.
- New-account spawn stays untouched — `Player.ts` constructor spawns at
  (3094, 3106) Tutorial Island, and Tutorial Island is protected everywhere else
  too. Optionally re-point the tutorial-completion exit teleport at the home
  coord (locate it in `content/scripts/tutorial/` first — not yet verified).

**Plumbing:** runtime-override pattern (this IS a single scalar — exactly the
case lessons-learned says the pattern is for): `engine/data/config/ap-spawn.json`
holding one coord, loaded by a small engine module (clone `ApEntranceOverrides.ts`),
exposed to rs2 via a new script command `ap_home_coord()()(coord)` (opcode 1901,
next in the 1900 block; follow the 4-touch-point recipe in lessons-learned).
Missing file = vanilla Lumbridge. Seed tool: pick 1 of 7 in
`RandomizeEntrances.ts` or a tiny `RandomizeSpawn.ts`; reseed = rewrite JSON +
restart, no rebuild (after the one-time preamble/command pack rebuild).

**Test command:** `::apspawn` (print + teleport). Also verify by dying on purpose.

## Feature 4 — Teleport spell destination shuffle

All 7 standard teleports read their landing coord from dbtable field
`magic_spell_table:tele_coord` (`skill_magic/scripts/spells/teleport.rs2`,
`~player_teleport_normal(map_findsquare(db_getfield($spell_data, ...)))`). The
values live in `skill_magic/configs/magic_spells.dbrow` (7 `data=tele_coord,...`
lines — see table above).

**Approach:** config mutation (dbrows compile into the pack; same class as
drip/shops): a `RandomizeTeleports.ts` tool that backs up the `.dbrow` file
(reuse the `content/.ap-backup` convention), **deranges the 7 coords among
themselves** (`derangement()` from `shared/Prng.ts`), writes back CRLF-intact,
then pack rebuild. Deranging within the vanilla set automatically keeps every
destination out of 20+ Wilderness and on safe landmarks. Spoiler to
`engine/tools/map/teleport-seed.json`.

Notes:
- The quest gates on casting (Ardougne/Watchtower/Trollheim spells require their
  quests) stay put — they gate the *spell*, not the destination. That's fine and
  funny: completing Plague City might unlock "Ardougne Teleport" that lands in
  Varrock.
- Keep Feature 3 reading the vanilla coord list, not this shuffled table.

**Test command:** `::aptele <spellname>` — jump to a spell's current table
destination without runes/level, so all 7 can be checked in one minute.

**Verification:** derangement property (no spell maps to itself), all outputs
∈ the vanilla 7-coord set, byte-diff of the `.dbrow` shows only `tele_coord`
lines changed, pack build clean.

## Feature 5 — Groundsanity (world item spawn shuffle)

Ground item spawns are `==== OBJ ====` sections in `content/maps/m<X>_<Z>.jm2`:
`level localX localZ: objId count` (verified in `m50_50.jm2`; expect optional
fields like the LOC section had — count may be omitted, default 1 — confirm
while building the parser).

**Recommended approach — runtime remap at map-load, not map mutation:** the
engine loads OBJ spawns from the map files at boot. Add an engine-side hook in
that loader (find it via the `.jm2`/map loading path in `engine/src`) that
consults `engine/data/config/ap-objspawns.json` — a global `objId -> objId`
remap table — when spawning world objs. Reseed = rewrite JSON + restart, **no
pack rebuild ever**, and the maps stay pristine. This is the entrance-override
pattern applied at load time instead of interaction time. (Fallback if the
loader turns out to be awkward: mutate the jm2 OBJ lines like drip mutates
`.npc` files, with the same backup convention — but that costs a map repack per
reseed and touches ~hundreds of files. Try the loader hook first.)

**Shuffle tool** (`RandomizeGroundSpawns.ts`): scan all jm2 OBJ sections (extend
`LocPlacementScanner.ts` — it already parses this file format's LOC sections),
build the multiset of spawned objIds, derange **identities globally** (every
bucket-of-water spawn becomes X everywhere, preserving counts/placements). A
per-placement shuffle is also possible via keying the JSON by
`mapsquare:level:x:z` instead — decide when building; identity-remap is smaller
and funnier ("all logs in the world are now lobsters"), per-placement is more
AP-check-shaped. Start with identity-remap.

**Pin list (required before it's fair):** quest-critical ground spawns must stay
vanilla. Known class of risk, not yet enumerated — build the pin list by
grepping quest scripts for objs they expect players to pick up from the world
(e.g. Dragon Slayer's map pieces are chest/drop-based, but verify; Crandor,
Karamja, and dungeon spawns feed several quests). Ship with a conservative
default pin list and grow it from playtesting, same discipline as drip's
`--exclude`.

**Test command:** `::apground` — for the player's current zone, list each OBJ
spawn's vanilla obj and its remapped obj.

**Verification:** parser round-trip on jm2 (byte-identical re-emit if using the
mutation fallback), remap table covers 100% of scanned objIds, loader unit test
(same style as the entrance loader test), in-game spot check of a known spawn
(Lumbridge kitchen's bucket/knife area is a 30-second walk from spawn... unless
the entrances moved).

---

## Suggested build order (each step independently shippable)

1. **Test-command dispatcher** (engine, small) + `::apgoals` + KBD flag hook —
   makes goals playable immediately; everything later plugs into the same
   dispatcher.
2. **Quest-check hook + reward system** + `::apreward`/`::apquestcheck` — the
   core new system, and the biggest "every quest now feels like a check" payoff.
3. **Random home point** + `::apspawn` (small; reuses the opcode recipe).
4. **Teleport shuffle** + `::aptele` (small; reuses Prng + backup conventions).
5. **Groundsanity** + `::apground` (medium; the engine loader hook is the one
   real unknown — timebox it and fall back to jm2 mutation if needed).

Standing rules from lessons-learned still apply to all of the above: edit
overlays in this repo then `install.js`; CRLF for content files; explicit opcode
numbers; pack rebuild after content/engine changes; hand in-game testing to the
user; update lessons-learned at session end.

## AP-phase mapping (so none of this is throwaway)

- Goals 1–3 → AP victory conditions (slot option picks which).
- Quest completions (~64) → AP location checks; `~ap_quest_complete` becomes the
  check emitter.
- Reward roll → the junk/filler item handler (AP sends "filler", we roll
  level-appropriate loot; bank-fallback delivery already matches ideas #6).
- Music unlock varbits, levelup unlocks, clue/minigame completions → additional
  check surfaces, still unbuilt, still documented in git history of this file
  (they were surveyed 2026-07-13 and confirmed present in rev 274).
- Groundsanity per-placement keying → "obj spawn = location check" if wanted.
