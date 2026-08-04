# In-game testing checklist (2026-07-15 build)

Everything below was built and offline-verified this session (typecheck, pack
build, bytecode decompile checks, unit tests) but **nothing has been played**.
Ordered so early items don't disturb later ones: smoke tests first, config-flag
tests second, fresh-account tests last. Restart the Windows server first — the
pack is already rebuilt and the seed regenerated.

The progression path is generated on demand, not stored:
`npx tsx tools/sim/SimulateProgression.ts --verbosity 2 [--json path.json]`
(from `Server/engine`). Seed data lives in `Server/engine/data/config/ap-*.json`.

## 1. Smoke tests (no config changes, 10 minutes)

- [ ] `::home` still works (regression — every session checks this)
- [ ] `::apgoals` — QP, barcrawl bars, Dragon Slayer, KBD status render
- [ ] `::apchecks` — kill bits / barcrawl count / dragonquest readout
- [ ] `::apcheckfire test_check` — expect an "AP check" announcement + a random
      reward delivered (inventory, or bank with a message when full)
- [ ] `::apreward` bare — random category roll
- [ ] `::apreward xp` — **verify the amount is 10k–50k, NOT multiplied by your
      30x rate** (this is the raw-XP opcode's whole job)
- [ ] `::apreward keepsakes 1` — Excalibur/gauntlets/cape-tier items appear
- [ ] `::apreward herb_supplies 40`, `::apreward runecraft_supplies 40`,
      `::apreward crafting_supplies 40` — era-correct items (unidentified herbs,
      blankrune essence), no invalid-obj errors
- [ ] `::apreward crafting_runecraft 1` — three rolls prefixed
      "Crafting & Runecrafting Pack", only flax / leather / rune essence
- [ ] Mine a gem rock (Shilo Village) — it should be back in ~40s, not 2 minutes;
      set `rockRespawnSpeed` to 100 in `data/config/ap-options.json`, restart, and
      confirm the 2-minute vanilla wait returns
- [ ] Fill inventory, roll again — bank-fallback message fires
- [ ] `::apunlock` — all counts read 99 (no unlock table = vanilla)
- [ ] `::apspawn` — prints home coord + teleports there (vanilla Lumbridge until
      you roll a spawn seed)
- [ ] `::apgates` — prints your coordinate (gate checks themselves are engine-side)
- [ ] `::apnewlook` — your appearance rerolls randomly
- [ ] `::apkit` — tutorial starter kit granted
- [ ] `::aptracker gather test test` — confirms tracker write path

## 2. Checks firing naturally (first play session)

- [ ] Kill a chicken — expect TWO checks: `first_kill` and `first_kill_chicken`,
      each with announcement + reward
- [ ] Kill a second chicken — nothing fires (once-ever dedupe)
- [ ] Restart the server, kill a goblin — `first_kill_goblin` fires but
      `first_kill` does NOT (fired-set survives restarts)
- [ ] Kill a skeleton the OLD chains missed — the Stronghold of Security
      `giantskeleton`, Draynor manor's `skull_skeleton` or a Melzar's Maze one —
      `first_kill_skeleton` must fire (variant coverage, scripts/gen-kill-groups.py)
- [ ] Gain first XP in an untouched skill (light a fire) — `first_xp_firemaking`
- [ ] Cross a multiple-of-10 level — `level_<skill>_<N>` (a big `::apreward xp`
      roll can cross several at once — all of them should fire)
- [ ] Sign a Barcrawl bar — `barcrawl_bar_N`
- [ ] Kill ~30 of one monster with the rarity cap on (GitHub #11) — every entry in
      that monster's table should show up at least once or twice; nothing in the
      corpus is rarer than 1/32 any more. Coins/junk drops should feel slightly
      less frequent (they pay for the boost)
- [ ] Complete a quick quest (Sheep Shearer) — vanilla completion + the
      quest-check reward (regression: Feature 2 path still works)
- [ ] Start Dragon Slayer (needs 32 QP) — `ds_started` stage check

## 3. Browser tracker

- [ ] Open `http://localhost:8080/ap/` (or `:80` if that's your Windows port) —
      world map renders, all tabs present, per-category "0 / M discovered" counters
- [ ] Use a shuffled ladder/stair — within ~5s a marker + connection line appears
- [ ] Mine/chop a shuffled resource — Gathering tab row ("Tree → Raw mackerel")
- [ ] Cook/smith a shuffled product — Recipes tab row
- [ ] Pick a pocket / rob a stall / loot a trapped chest — Thieving tab row
      ("Coins → steals like → Adamantite ore"). The stall still narrates the
      vanilla line; the item that lands in your pack is the reveal.
- [ ] Kill a mimicked monster (cows mimic paladins this seed; also listen for the
      "Smells like..." chat line) — Bestiary row
- [ ] Cast any teleport spell — Teleports tab row
- [ ] Surface/underground toggle; pan + zoom feel OK
- [ ] Append `?spoiler=1` — everything revealed (dev/spoiler mode)

## 4. Area gates (the Champions' Guild fix)

- [ ] Below 32 QP, use the entrance that leads INTO the Champions' Guild (find
      the trigger in `ap-entrances.json`'s spoiler or the tracker's `?spoiler=1`
      map) — expect "A strange force bars your way..." and NO movement
- [ ] At/above 32 QP (or after `::max`-style testing if you have one): same
      entrance now works
- [ ] Walk in the guild's front door legitimately, use its interior staircase —
      works regardless (same-area transit rule)
- [ ] Optional: repeat for Wizards' Guild (66 magic) / Crafting Guild (40
      crafting + worn brown apron — the apron matters)

## 5. Gated entrances in the shuffle

- [ ] Zanaris shed door WITHOUT a worn dramen staff — vanilla refusal
- [ ] WITH the staff worn — it leads wherever the seed says (check the spoiler);
      and something else now leads INTO Zanaris (its old exit ladder's pairing)
- [ ] Dwarf guard-tower ladder before the Dwarf Cannon quest stage — dwarf
      refuses; after — it climbs to its shuffled destination

## 6. Unlock system (config-flag tests — changes live state)

From `Server/engine`:
- [ ] `npx tsx tools/ap/SetUnlock.ts progressive_melee 0` → wait ~2s (mid-session
      reload, no restart needed) → try equipping a STEEL weapon (blocked with the
      Progressive message), bronze still fine
- [ ] `npx tsx tools/ap/SetUnlock.ts progressive_pickaxe 0` → mining with a
      steel+ pickaxe behaves as if you have no pickaxe; bronze works
- [ ] `npx tsx tools/ap/SetUnlock.ts progressive_mining 1` → Mining now caps at
      30: train up to it and confirm XP stops at the boundary (message shown)
- [ ] Hitpoints is never capped regardless of table state
- [ ] `npx tsx tools/ap/SetUnlock.ts --clear` → everything back to vanilla ~2s later

## 6b. Two-fish spots vs gatherSpeed (the shrimp fix)

Needs a high Fishing level, so easiest with `::setlevel fishing 99` on a test
account. The old bug was 0% shrimp at 99 with the default `gatherSpeed: 200`.

- [ ] At 99 Fishing, net a Lumbridge/Draynor shrimp spot for ~30 casts — expect a
      roughly even shrimp/anchovies split (vanilla ratio is 50/50 at 99), NOT
      anchovies every single cast
- [ ] Same at a sardine/herring rod spot — sardines must still appear
- [ ] Set `gatherSpeed` to 100 in `data/config/ap-options.json`, restart, and
      confirm the split is unchanged but failed casts come back
- [ ] Single-fish spots (lobster, shark) are untouched by this change

## 7. Random spawn (reseed test)

- [ ] `npx tsx tools/spawn/RandomizeSpawn.ts --seed 5 --mode city` → restart →
      `::apspawn`, then die on purpose — both land at the rolled city
- [ ] `--mode chunk` → restart → confirm the spot isn't enclosed/absurd (spoiler
      prints the mapsquare; reroll if bad — this is the known heuristic risk)
- [ ] `::home` goes to the same home point

## 8. Skip tutorial (fresh-account test — do LAST)

- [ ] Set `"apSkipTutorial": true` in `Server/engine/data/config/world.json`,
      restart
- [ ] Create a brand-new account — expect: NO Tutorial Island, NO design screen,
      spawn at the home point, randomized appearance, tutorial kit in inventory,
      25 coins banked. **This is the one flow with a flagged structural risk
      (position/vars mutated pre-login) — if login hangs or the client desyncs
      here, that's the assumption to report.**
- [ ] Log that account out and back in — everything persists, no tutorial pull
- [ ] An account that was mid-tutorial logs in — gets skipped out too (flag on)

## 9. Offline tools (runnable anytime, no server)

- [ ] `npx tsx tools/sim/SimulateProgression.ts --verbosity 2` — read your seed's
      walkthrough; sanity-check it against what you actually experience
- [ ] `npx tsx tools/logic/ValidateSeed.ts` — exit 0, all goals reachable
- [ ] `npx tsx tools/map/RandomizeEntrances.ts --seed <n>` — watch it validate
      (or reroll) automatically at the end
- [ ] `npx tsx tools/drops/CapDropRarity.ts --dry-run` — on the vanilla corpus expect
      "721 drop branch(es) raised across 62 cascade(s)"; the counts are higher once
      `ap_mimic.rs2` exists (mimic mode caps those tables too)
- [ ] `npx tsx tools/drops/SimulateDrops.ts werewolf --kills 5000` — rarest drop
      1/512 → 1/32, "drops rarer than 1/32: 9 → 0", and each `sim` column tracking
      its own `rate` column (that agreement is the sim validating itself)
- [ ] `npx tsx tools/drops/SimulateDrops.ts <npc> --live` after installing the cap —
      the AS INSTALLED column should already show the capped rates

### Drop rarity cap offline checks (GitHub #11)

These run against a throwaway COPY of the corpus — never the live tree. Copy
`content/.ap-backup/scripts/drop tables/scripts` somewhere temporary, then drive
`capFile()` (exported from `tools/drops/CapDropRarity.ts`) over the copy with
`npx tsx --input-type=module -e "..."` and assert:

- [ ] every `isDrop` branch ends at `weight/total >= 1/32`, thresholds stay monotonic
      and never exceed the denominator
- [ ] the only characters that differ from the original are threshold digits — line
      count unchanged, CRLF intact, every `obj_add(...)` call byte-identical
- [ ] `parseDropSlots()` returns the same 1127 slots (item, qty, line) before and after
      — the cap must never move loot
- [ ] a second pass over its own output reports 0 changed files (idempotent, so a
      reseed can't compound the boost)
- [ ] `parseDropSlots()` output is byte-identical to the pre-#11 parser on both the
      backup and live trees (the cascade refactor's regression gate)

## Known risks to watch (from agent reports)

1. Fresh-account login under apSkipTutorial (section 8) — the one structural
   assumption without vanilla precedent this session.
2. Chunk-mode spawn reachability is heuristic — spoiler prints the square.
3. Gated-area boxes are hand-derived — walk each guild's perimeter once at low
   stats and report any leak (box too small) or over-block (box too big).
4. Menu-label paths near gated arrivals: the denial message is throttled to
   ~1/600ms — if you see message spam when opening stair menus, report it.
5. The stair/ladder OPTION MENUS on multi-destination tiles (Lumbridge castle
   spiral stairs) — long-standing untested edge from the entrance randomizer;
   check climb-up/down/menu all agree.

## 10. Placement mode (added later on 2026-07-15 — the "make it a game" round)

Setup once: `npx tsx tools/ap/GenerateSeed.ts --seed 777 --pool per-skill` (from
Server/engine — already run; regenerating clears fired-checks + tracker = new run).

- [ ] `::apunlock` — gear/tool families read 0 (bronze-only), skill caps active at 20
- [ ] Try to equip a STEEL weapon — blocked (bronze fine) with no SetUnlock needed
- [ ] Train any skill toward 20 — XP truncates at the cap boundary
- [ ] Kill your first cow — expect "AP check ...: received Progressive Pickaxe
      (adamant)!" (per the seed-777 spoiler) and the unlock usable within ~2s
- [ ] A filler-placed check (e.g. first rat kill... check the spoiler) — normal
      random reward instead
- [ ] Complete Sheep Shearer — the quest CHECK announcement fires exactly once
      (watcher path; the old direct quest reward must NOT double-pay)
- [ ] `npx tsx tools/sim/SimulateProgression.ts --verbosity 2` — narration now
      references actual finds per sphere
- [ ] Browser tracker "checks" category populates as you collect
