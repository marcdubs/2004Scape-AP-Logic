# Progression simulator — design, model, and roadmap

Status: **built 2026-07-15**, offline-verified (typecheck + vanilla run + current-seed
run + synthetic blocked run, see "Verification" below). Not yet wired into any CI gate
or the browser tracker. Answers the design questions the user locked in via
`AskUserQuestion` (see `docs/lessons-learned.md`'s "skip-tutorial + random spawn"
addendum): a real reachability engine over the ACTUAL seed state, with a narrative
renderer on top, built so the core (state / rules data / expansion engine / renderers)
ports cleanly into the Archipelago apworld's logic later.

## Where it lives

- `overlays/engine/tools/sim/` — the tool. Deploys like every other tool in this repo
  (`node scripts/install.js` copies it to `../Server/engine/tools/sim/`), and runs from
  `Server/engine` with `tsx`, same as `RandomizeGathering.ts` / `RandomizeProcessing.ts`.
  It only reads `data/config/ap-*.json` and writes its own `--json` output file — no
  content/engine coupling, no pack rebuild ever needed.
- `overlays/engine/tools/sim/data/quests.json` — the hand-authored, script-verified
  requirements database (schema below).
- `overlays/engine/tools/sim/data/goals.json` — the three win conditions.
- This doc.

```
tools/sim/
  types.ts               shared schema (QuestReq, Goal, StatName, ...)
  ConfigLoader.ts         reads ap-spawn/ap-unlocks/ap-gather/ap-process.json
  ObjNames.ts             lazy obj.pack id->name lookup (narration flavor only)
  Engine.ts               the fixpoint expansion engine + blocker diagnosis
  Narrate.ts              -v0/-v1/-v2 renderers + JSON emit
  SimulateProgression.ts  CLI entrypoint
  data/quests.json        63 quest requirement entries
  data/goals.json         barcrawl / dragon_slayer / kbd goal definitions
```

## Usage

```
cd Server/engine
npx tsx tools/sim/SimulateProgression.ts [--verbosity 0|1|2] [--json out.json] [--config-dir data/config]
```

Exit code **0** = every goal reachable this seed, **1** = at least one goal blocked
(future CI hook: fail seed generation before a player ever gets a dead seed).
`--config-dir` lets you point at a scratch directory instead of the live
`data/config` — use this for any experiment that would otherwise require overwriting a
real `ap-unlocks.json`/`ap-spawn.json` that might already exist.

## The model

**Player state** = base skill levels (start 1, hitpoints 10) + completed quests + quest
points + the seed's fixed unlock counts + spawn/region context. **Expansion loop**:
repeatedly scan every quest not yet completed; any whose skill/QP/quest-chain
requirements are now satisfied gets completed simultaneously; add their QP; repeat until
a full pass adds nothing (fixpoint). Each pass is a **sphere**. Goals are checked after
every sphere and stamped with the sphere they first became reachable in. If the
fixpoint arrives without every goal satisfied, every unmet goal (and every quest that
never became reachable) gets a **recursive blocker diagnosis**: the exact unsatisfiable
leaf requirement (a stat capped below what's needed, a QP shortfall, or a prerequisite
quest that is itself blocked — walked all the way down).

### The central simplification: skill training has no time cost

A skill is modeled as instantly trainable to any level **up to its seed-fixed cap**
(missing `ap-unlocks.json` = uncapped/99). There is no xp-rate or grind-time
model. This is deliberate, not an oversight: Archipelago logic cares about
*reachability*, not real-time pacing (the same way OSRS-apworld logic doesn't simulate
how many hours 99 Woodcutting takes) — and it collapses "sphere" down to its real meaning
here: **a sphere is a wave of quest unlocks**, not a skill-training milestone. The
practical effect: given the current live seed (no `ap-unlocks.json` = uncapped), every
quest is reachable in sphere 1 except the ones gated by *other quests* (Dragon Slayer's
32 QP, and the Heroes'/Legends'/Underground Pass/Regicide/Nature Spirit chains) — see
the current-seed run below.

### Where the caps come from: end-of-run, not the file on disk

The vanilla (no-`ap-placements.json`) path answers a **beatability** question — "is this
seed finishable" — so the counts it reasons about are the ones a *finished* run holds:
the entire progression pool collected (`PlacementEngine.endOfRunCounts`, built by applying
`buildItemPool` itself so it can never drift from the real pool). Caps therefore top out
at 99 for every cappable skill, and a blocker in this mode always means a genuine
quest-graph problem (a QP wall, a prerequisite chain), never "you haven't found the item
yet".

This is a **correction, not a new model**: the doc always described `ap-unlocks.json` as
"the counts an AP client would have delivered by the end", but placement mode changed what
the file actually contains. `GenerateSeed.ts` writes a *locked, all-zero starting* table,
and during a live AP run the file holds only what the multiworld has delivered so far.
Reading a starting table as an end state made the tool report every skill capped at 20
forever and diagnose essentially the whole quest graph as blocked (`attack capped at 20 by
unlocks; needs 40`, ×N) on seeds that `GenerateSeed`'s own fill and `ValidateSeed` both
call beatable — a pure false negative, and a confusing one because the blocker text looked
so specific.

Two escape hatches, both explicit in the header line the run prints:

- `--current-unlocks` — reason about the raw on-disk snapshot instead. This is the right
  mode when you're poking at a live run with `tools/ap/SetUnlock.ts` and the question is
  "what can I do **right now**". Blockers there mean "not yet", not "never".
- An `ap-placements.json` that holds *no item placements* (the AP-multiworld shape: the
  room owns placement, so `new-run` deletes the local file and `ApClient` rewrites it with
  the seed's `questGates` only) falls back to this same vanilla report with a printed note,
  rather than running the placement sphere loop over an empty item map and "proving" every
  goal unreachable. Family-D quest gates are deliberately not applied in that fallback: at
  end-of-run every `quest_<id>` item the room holds has arrived, so gating on them would
  re-introduce the same false-blocker class.

Solo (locally-filled) seeds are unaffected by any of this — a populated
`ap-placements.json` takes the placement-aware sphere loop, which has always collected
items as it walks and never used the disk snapshot as a ceiling.

### What's NOT modeled yet (noted per the design brief, not silently dropped)

- **AP item receipt ORDER.** The unlock counts are fixed for the whole run (end-of-run by
  default, the disk snapshot under `--current-unlocks`). Simulating
  "you have 2 Progressive Mining out of 7, in THIS order relative to quest completions"
  is a real feature gap for the eventual apworld port — the engine's sphere loop is
  already structured to support it (an outer loop re-running `runSimulation` with
  successively larger unlock counts drawn from an item-placement order would work with
  no architecture change), it just isn't wired up.
- **Tool unlocks (`progressive_axe`/`progressive_pickaxe`) are not gating.** Verified
  against the live overlay (`levelrequire.rs2`, `mining.rs2`, `woodcut.rs2`): tier 0
  (bronze) is *always* free for both tools, and a locked higher tier either falls back
  to the best *unlocked* axe tier (woodcutting) or is treated as "no pickaxe" for that
  swing only (mining) — neither path makes the skill itself untrainable. So tool
  unlocks affect efficiency/flavor, never reachability, and the engine doesn't model
  them as a gate. Documented here so a future session doesn't "fix" this as a bug.
- **Gathered/processed item name-gates.** The design brief asks for: when a quest needs
  a specific gathered/processed *item* (not just a skill level), resolve it through
  `ap-gather.json`/`ap-process.json`'s swap tables (bijective under `shuffle` mode) and
  report orphans as blockers under `chaos` mode. The mechanism is built
  (`Engine.ts`'s `findGatherOrProcessSource`) but **no entry in `quests.json` currently
  needs it** — every item fetch across all 63 quests turned out to be an NPC
  drop/dialogue/fixed-chest pickup, not a gathersanity/processsanity product (verified
  while building the database, not assumed). It's a ready extension point, not dead
  code: the day a quest requirement needs it, wire an `items: [{ objId, ... }]` shape
  onto that quest entry and call the existing function.
- **Region locks beyond the three documented judgment calls** (Crandor, Karamja,
  deep Wilderness) — per the user's explicit design decision, the mainland is one
  connected region because entrance randomization guarantees bidirectional gate pairing
  and `::home` always exists. See "Travel modeling" below.

## Travel modeling

The mainland is modeled as **one connected walkable region** — not a simplification of
convenience, but a direct consequence of two verified engine facts (see
`docs/lessons-learned.md` "Domain knowledge: entrances"): every shuffled entrance pairs
bidirectionally, and `::home` is an unconditional safety valve. Three places get
explicit region tags instead, matching the design brief exactly:

- **`karamja`** — gated by the 30gp Port Sarim boat fare in vanilla, but that's a
  trivial amount of starting gold/any early drop, so it's tagged on the relevant
  quests/goals (Goblin Diplomacy, Pirate's Treasure, Jungle Potion, Tribal Totem, Tai
  Bwo Wannai Trio, Legends' Quest, and the Barcrawl goal — two of its ten bars, the Dead
  Man's Chest in Brimhaven and Karamja Spirits, sit on the island) purely for **-v1/-v2
  narration**, never as a hard gate.
- **`crandor`** — Dragon Slayer's own progression (map pieces, ship, or the secret
  passage found mid-quest). Nothing else in the 63-quest set touches Crandor, so it's
  narrative-only, folded entirely into the `dragon` quest entry rather than a standalone
  region gate.
- **`zanaris`** (fairy realm) — reached via the dramen tree once Lost City hands you the
  dramen staff. Same treatment: folded into the `zanaris` quest entry, nothing else
  depends on it.
- **`wilderness_deep`** (King Black Dragon's lair, past the Lava Maze) — reachable by
  walking under the connected-mainland model, so it carries **no region gate at all**;
  the "gear-gated in practice" caveat from the design brief is instead encoded as the
  KBD goal's skill-level judgment call (next section), which is the honest place to put
  it: the map doesn't stop you, your combat stats should.

`ap-entrances.json` is loaded (`SeedConfig.entrancesPresent`) but not yet mined for
per-seed flavor lines ("the Lumbridge kitchen trapdoor now leads to the Falador smith")
— that's a small, contained follow-up noted in the roadmap, not a blocker for this pass.

## The KBD gate: the judgment call

`goals.json`'s `kbd` entry requires `attack/strength/defence/hitpoints >= 40`. This is
**not** vanilla-script-enforced — verified directly against
`areas/area_wilderness/scripts/king_black_dragon.rs2`: the kill hook has no coded level
or quest gate, and Dragon Slayer completion is explicitly NOT required (called out in
the original design brief). The 40/40/40/40 floor is a stand-in for "can plausibly
survive a multi-headed, poison-capable, dragonfire-breathing boss alone in deep
Wilderness with nothing else blocking you." It is deliberately conservative and
deliberately easy to relitigate — change the numbers in `goals.json`, or swap the
`skills` block for an `ap_unlock_count('progressive_melee') >= N` style gear-tier check,
without touching `Engine.ts` at all. Hitpoints is included in the requirement object but
never actually binds (hitpoints is never capped by the unlock system — see
`ApUnlockOverrides.ts` — so it's always at least whatever the caps allow, which is
always ≥40 once *any* other combat stat can reach 40 under a real unlock table); kept in
the data for documentation clarity even though it's redundant in practice.

## Schema

`data/quests.json` (`QuestReq[]`, see `types.ts` for the authoritative TS shape):

```jsonc
{
  "id": "zanaris",                 // matches the quest's varp/questlist prefix
  "name": "Lost City",
  "qp": 3,                          // QP AWARDED on completion
  "requiredQp": 32,                 // QP REQUIRED to start (omit if none) - only "dragon" and "legends"/"hero" use this
  "skills": { "woodcutting": 36, "crafting": 31 },  // base levels REQUIRED to complete
  "quests": ["biohazard"],          // ALL of these must be complete first
  "questsAny": [["blackarmgang"]],  // at least one id from EACH inner array (OR-groups)
  "items": ["..."],                 // narrative only - see "not modeled yet" above
  "kills": ["..."],                 // narrative only
  "regions": ["karamja"],           // narrative/logic tag, see "Travel modeling"
  "notes": "...",                   // caveats, script line references, alternate paths
  "verified": "script"              // "script" (grepped/read this session) | "knowledge" (era knowledge only)
}
```

`data/goals.json` (`Goal[]`) mirrors the requirement fields (`requiredQp`/`skills`/
`quests`/`regions`) minus `qp`/`items`/`kills`/`verified` — goals are the fixpoint's
target, nothing depends on them, and every goal's `notes` field is mandatory (goals lean
on judgment calls more often than quests do — see KBD above — so every one gets its
reasoning written down inline).

## Verification (2026-07-15 session)

**Coverage.** 63/63 quests entered (the 65 directories under
`Server/content/scripts/quests/` minus the non-quest `interfaces` dir and `barcrawl`,
which is modeled as a goal). QP values are 100% script-verified against
`general/configs/quest.constant` (sum = 135 across all 63; matches the file's own
`^*_questpoints` constants exactly, machine-checked). 62/63 entries are fully
`verified: "script"`; the 1 `"knowledge"` entry (`druidspirit`/Nature Spirit) has a
script-verified skill requirement (crafting 18) but an era-knowledge-only quest-chain
note (Priest/Priest in Peril aren't coded gates in this script set). 21 quests carry
skill gates, 5 carry quest-chain prerequisites — every one of those 26 relationships was
established by grepping the actual `.rs2` scripts (`stat_base`/`stat(`/`_complete`
comparisons), not assumed from era knowledge; **absence** of a hit was itself verified
by a full-directory grep per quest, not left as an assumption.

**Dragon Slayer chain (priority-verified per the design brief).** `dragon_journal.rs2:7`
gates the quest start on `%qp >= 32` alone (no skill/quest prereqs). The 62 non-DS
quests sum to 133 QP, so 32 is trivially reachable — confirmed by the vanilla run
completing Dragon Slayer in **sphere 2** (right after the sphere-1 wave of ungated
quests). The feeder chain toward the two harder goals was also traced end to end:
Underground Pass requires Biohazard (`quest_upass.rs2:81`); Regicide requires
Underground Pass (`regicide_kings_messenger.rs2:2`); Heroes' Quest requires 55 QP +
Lost City + Dragon Slayer + Merlin's Crystal + Shield of Arrav
(`quest_hero.rs2:1-6`); Legends' Quest requires 107 QP + Family Crest + Heroes' Quest +
Shilo Village + Underground Pass + Waterfall Quest (`legends_guard.rs2:50-53`) plus ten
individual skill gates (the most skill-demanding quest in the set, deliberately used as
the capstone reachability proof).

**Typecheck**: `cd Server/engine && npx tsc --noEmit -p .` — clean, no errors.

**(a) Current live seed** (`Server/engine/data/config/` as of this session: no
`ap-unlocks.json`, no `ap-spawn.json` — so unlocks are uncapped and spawn is vanilla
Lumbridge; `ap-gather.json`/`ap-process.json`/`ap-entrances.json` ARE present, seed 777
shuffle). `-v0` output:

```
=== Progression Simulation (spheres -> goals) ===
Spawn: Lumbridge (vanilla)
Skill caps: uncapped (vanilla - no ap-unlocks.json)

Sphere 1: Fight Arena, Merlin's Crystal, Witch's House, Biohazard, Shield of Arrav, Black Knights' Fortress, Big Chompy Bird Hunting, Clock Tower, Cook's Assistant, Family Crest, Death Plateau, Demon Slayer, Tourist Trap, Doric's Quest, Druidic Ritual, Monk's Friend, Eadgar's Ruse, Elemental Workshop, Plague City, Fishing Contest, Gertrude's Cat, Goblin Diplomacy, Holy Grail, The Grand Tree, Ernest the Chicken, Hazeel Cult, Witch's Potion, Horror from the Deep, Pirate's Treasure, Temple of Ikov, Imp Catcher, The Digsite, Observatory Quest, Watchtower, Jungle Potion, Dwarf Cannon, Shades of Mort'ton, Murder Mystery, Restless Ghost, Priest in Peril, Prince Ali Rescue, Romeo & Juliet, Rune Mysteries, Scorpion Catcher, Sea Slug, Sheep Shearer, Sheep Herder, Knight's Sword, Tai Bwo Wannai Trio, Tribal Totem, Tree Gnome Village, Troll Stronghold, Vampire Slayer, Trials of the Fremmenik, Waterfall Quest, Lost City, Shilo Village
Sphere 2: Dragon Slayer, Nature Spirit, Underground Pass -- GOAL REACHED: Kill Elvarg (Dragon Slayer)
Sphere 3: Heroes' Quest, Regicide
Sphere 4: Legends' Quest

Total quests completed: 63/63 (135 QP)

Goals:
  [x] Alfred Grimhand's Barcrawl - reached at sphere 0
  [x] Kill Elvarg (Dragon Slayer) - reached at sphere 2
  [x] Kill the King Black Dragon - reached at sphere 0

RESULT: all goals reachable.
```

Exit code 0. A `-v2` excerpt (full walkthrough narration references the actual spawn
label, notes the live seed's gather/process shuffle by seed number, and narrates each
sphere's quest unlocks in prose with their script-verified gate reasoning inline) is in
the session transcript; not reproduced in full here for length.

**(b) No-files vanilla run** (`--config-dir` pointed at an empty scratch directory —
no `ap-unlocks.json`/`ap-spawn.json`/`ap-gather.json`/`ap-process.json` at all).
Identical result to (a): 63/63 quests, all 3 goals reachable, exit 0 — expected, since
the current live seed already has uncapped unlocks/vanilla spawn; this run additionally
confirms the requirements database has no internal bug that would make a genuinely
untouched vanilla game unwinnable.

**(c) Synthetic blocked run.** Wrote a scratch `ap-unlocks.json` (`{"unlocks": {}}` —
file present but empty, so every stat defaults to 0 received = capped at the 20 floor)
to a scratch `--config-dir` (never touched the real `data/config/`, which currently has
no unlocks file to protect anyway — confirmed absent before running). Result: 48/63
quests reachable (96 QP), Barcrawl and Dragon Slayer still reachable (neither needs a
capped skill), **Kill the King Black Dragon blocked** with the exact diagnosis:

```
  [ ] Kill the King Black Dragon - BLOCKED
        - attack: attack capped at 20 by unlocks; needs 40
        - strength: strength capped at 20 by unlocks; needs 40
        - defence: defence capped at 20 by unlocks; needs 40
```

And the recursive diagnosis correctly walks a real multi-hop chain — Heroes' Quest is
blocked because Lost City never completed, and Lost City itself is blocked on two capped
skills:

```jsonc
{
  "id": "hero", "name": "Heroes' Quest",
  "blockers": [{
    "subject": "quest:zanaris", "subjectName": "Lost City",
    "reason": "not completed - blocked itself",
    "children": [
      { "subjectName": "woodcutting", "reason": "woodcutting capped at 20 by unlocks; needs 36" },
      { "subjectName": "crafting", "reason": "crafting capped at 20 by unlocks; needs 31" }
    ]
  }]
}
```

Exit code 1, confirming the CI-gate contract. `--json` output round-tripped through
`JSON.parse` cleanly (no `Map`/circular-reference leakage from the config loader types).

## Roadmap (what a future session should extend first)

1. **AP item receipt order simulation.** The biggest real gap vs. the eventual
   apworld — run the engine incrementally as unlock counts grow from an item-placement
   order (fed by the apworld's own item pool), not just "everything the run will ever
   have, all at once." Architecture is ready (see "not modeled yet" above); this is a
   loop around `runSimulation`, not a rewrite.
2. **`ap-entrances.json` flavor mining for -v2.** Currently loaded but unused beyond a
   presence flag. Pick a handful of notable near-spawn redirects and surface them in the
   opening narration paragraph, per the original design brief's example
   ("the Lumbridge kitchen trapdoor now leads to the Falador smith").
3. **Wire a real gather/process item-name gate the day one is needed.** The mechanism
   (`findGatherOrProcessSource`) exists and is unit-testable in isolation; it just has no
   caller yet because no quest in this 63-entry database needs it. If a future
   quests.json entry (or a newly added minigame/activity) does need a specific gathered
   item, this is where it plugs in.
4. **CI gate.** `SimulateProgression.ts`'s exit code is already CI-shaped (0/1). Wire it
   into whatever seed-generation pipeline eventually exists so a genuinely unwinnable
   seed never reaches a player - the natural trigger is "after `RandomizeSpawn.ts` /
   unlock-table generation, before handing the seed to the AP client."
5. **Feed the browser tracker.** `--json` output is already the shape
   `docs/tracker-map.md`'s SPA would want for a "what's left" panel - a small `/ap/sim`
   web.ts route reading a pre-computed `--json` file is the natural bridge, not a new
   engine.
6. **Widen the requirements database beyond quests** if the goal roster ever grows
   (music/clue/minigame surfaces mentioned in `checks-and-unlocks.md` catalog item #7) -
   the `QuestReq`/`Goal` schema already generalizes to "any completable thing with
   skill/quest/QP prerequisites," so a `data/activities.json` sibling file would slot in
   with a one-line change to `SimulateProgression.ts`'s loaders, not a schema change.
