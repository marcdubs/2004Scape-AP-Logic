# Checks, rewards & unlocks — the full-game expansion (proposal)

Status: **researched 2026-07-15, awaiting user decisions** (see "Decisions needed"
at the bottom). This expands [goals-and-checks.md](goals-and-checks.md) — the goals
system and quest-completion checks/rewards from that doc are **built** (Features
1-2); this doc designs everything that turns the project from "a stack of
randomizers" into a real Archipelago progression game. Every hook point below was
verified against the live `../Server` checkout on 2026-07-15.

## Why this works without region locks (the core insight)

The user doesn't want region locking (logic complexity). We don't need it,
because **the quest system IS the region system**:

- Dragon Slayer's start is gated on `%qp >= 32` — verified at
  `quests/quest_dragon/scripts/dragon_journal.rs2:7` (`if (%qp < 32)`). There are
  65 quests in this content set worth ~large QP total; a player must complete
  roughly a third to half of the quest list to even start the goal quest.
- Each prerequisite quest has its own skill requirements, item needs, and kill
  requirements, spread across the whole map.
- So: make quest completions checks (done), gate *progression capability* (gear
  tiers, skill caps, quest availability — see Unlocks below) behind AP items,
  and sphere-by-sphere logic emerges naturally. The map stays fully open; what's
  locked is what you can *do*, not where you can *walk*. Entrance randomization
  keeps travel spicy without ever being a logic dependency.

**Prior art:** the official OSRS Archipelago world's goal is also Dragon Slayer;
its items are region ("chunk") unlocks + progressive gear-tier unlocks, and its
locations are skill tasks + quest steps. We deliberately drop its chunk system
and keep the rest of its shape — gear tiers and skill tasks are proven fun in AP.
(https://archipelago.gg/games/Old%20School%20Runescape/info/en)

---

## Check catalog (AP locations)

Pre-AP semantics: every check that fires runs the same payoff path as quest
completions do today — announce it + roll a reward (see Rewards). AP phase: the
same emitter sends a location-checked packet instead, and rewards move to the
item-received path. Build ONE shared proc `~ap_check_fired(<check id>)` so the
swap happens in exactly one place.

| # | Check surface | Count | Hook (verified) | Status / effort |
|---|---|---|---|---|
| 1 | Quest completions | ~64 | `~ap_quest_complete` in `send_quest_complete` | **DONE** (Feature 2) |
| 2 | Barcrawl bars signed | 10 | varp watcher on `%barcrawl` bits 3–12 | small (rides on #3) |
| 3 | Quest progression stages | curated ~30–60 | engine varp watcher (below) | medium |
| 4 | First XP in each skill | up to 19 | engine `Player.addXp` hook | small |
| 5 | First kill (+ curated notable kills) | 1 + ~15 | `[proc,npc_death]` overlay | small–medium |
| 6 | Skill level milestones | option-scaled, ~50–190 | `advancestat` / `addXp` level-crossing | small |
| 7 | Music/clue/minigame surfaces | future | varbits (surveyed 2026-07-13, present in rev 274) | not now |

That's a pool of **~150–300 locations** at defaults — a healthy AP world size.
Details per surface:

### 3. Quest progression stages + 2. barcrawl bars — the varp watcher

One engine mechanism serves both: `Player.setVar(id, value)`
(`engine/src/engine/entity/Player.ts:1767`) is the single write chokepoint for
every varp (all script writes route through `POP_VARP` → `setVar`). Add a hook
there that consults a static JSON table `engine/data/config/ap-checks.json`:

```json
{ "watches": [
  { "varp": "dragonquest", "op": "gte", "value": 2, "check": "ds_lozar_map_started" },
  { "varp": "barcrawl",    "op": "bit", "value": 3, "check": "barcrawl_bar_1" }
] }
```

On a threshold crossing / bit set, enqueue the player script
`[queue,ap_check_fired]` with the check id (queue scripts always run with
protected access — the Feature-2 lesson — so the reward/bank path just works).
This is the entrance-override pattern applied to quest state: **new checks are
data edits, never code edits**, and the table ships once (it's static per game
version, not per seed).

Curation beats completeness here: don't emit every varp increment (65 quests ×
~10 stages = noise, and many stages are dialogue ticks). Pick the memorable
beats — each Dragon Slayer map piece, each Barcrawl bar, "reached Melzar's
Maze", freeing the goblins' argument, etc. Start with Dragon Slayer's chain +
Barcrawl fully mapped, grow from there.

Note: `setVar` is also called by engine internals (e.g. `RUN` toggling at
`Player.ts:724`) — the watcher must be a cheap map lookup keyed by varp id so
un-watched varps cost nothing per write.

### 4. First-time skill XP — one hook covers the user's whole list

"First time mining, woodcutting, fishing, crafting, fletching, thieving,
runecrafting, herblore..." — every one of these grants XP on first success, so
**one engine hook covers all 19 skills**: in `Player.addXp`
(`Player.ts:1821`), if `this.stats[stat] === 0` before the add, fire
`ap_first_xp_<statname>`. No per-skill content edits (thieving, herblore,
runecraft, agility, prayer scripts all stay vanilla).

Caveats verified:
- Hitpoints starts at 1,154×10 XP (level 10), never 0 → naturally never fires;
  exclude HP from the check list (18 real checks + first-kill covers combat).
- Combat stats (attack/strength/defence/ranged/magic) DO start at 0, so "first
  melee XP" etc. all work — but they overlap with first-kill; keep both, they
  fire at slightly different moments and it's more checks.
- Engine-side firing needs to reach script-land: enqueue the same
  `[queue,ap_check_fired]` queue script (engine can enqueue player queue
  scripts — this is how `advancestat` style triggers already work).

### 5. First kill + curated notable kills

`[proc,npc_death]` (`skill_combat/scripts/npc/npc_death.rs2:10`) is the global
death chokepoint for every NPC, and it already does
`finduid(%npc_aggressive_player)` to find the killer. Overlay it:

- **First kill ever**: one new varp bit; fire `ap_first_kill`.
- **Curated notable kills** (~15, one varp bitfield holds 32 flags): first
  goblin, first guard, first hill giant, first moss giant, first lesser demon,
  first green dragon, each Melzar's Maze boss class, Elvarg (redundant with
  quest but thematic), etc. Match on `npc_category` where possible so "goblin"
  covers all goblin variants.
- Varp writes from an NPC-death context need the `if_close` / `p_finduid(uid)` /
  `queue(...)` retry dance (the Feature-1 KBD lesson, precedented in
  `khazard_ogre.rs2` etc.) — or sidestep it entirely by having the overlay only
  `queue` the check script, since queue scripts get protected access for free.
- KBD's own script keeps its bespoke hook (it's a goal, not just a check).

Mimic-mode interaction: under `--mode mimic` the *drop table* lies about the
monster, but `npc_death`/`npc_category` still see the real NPC — kill checks
are shuffle-proof. Groundsanity/gathersanity don't touch kills at all.

### 6. Skill level milestones — the big scalable pool

Two equivalent hooks, pick one:
- Content: `[advancestat,<stat>]` triggers (all 19 exist,
  `levelup/scripts/levelup.rs2:3-21`) funnel into one `@levelup` label — overlay
  the file and call `~ap_level_check($stat)` first.
- Engine: `addXp` already computes `before`/`after` base levels — fire there.

Content-side is better (no engine touch, and `stat_base($stat)` + a dbtable of
milestone levels keeps it data-driven). Milestone density should be an option:
- **sparse**: levels 20/40/60 per skill (~57 checks)
- **normal**: every 10 levels (~130 checks, memorable OSRS milestones)
- **dense**: every 5 levels (~250 checks, filler-heavy multiworlds)

These are exactly the OSRS apworld's "tasks by skill" shape, and they interact
beautifully with skill-cap unlocks (below): a capped skill's milestones are
out-of-logic until its cap items arrive.

---

## Rewards (the filler pool)

Keep the existing level-based goods roll (built: 94 rows across 8 categories in
`ap_rewards.dbtable`/`.dbrow`, weighted reservoir sampling by governing stat).
Three additions:

### XP drops — 10k–50k in a random skill

- Random skill: `enum(int, stat, stats, calc(random(19) + 1))` — the `[stats]`
  enum (`player/configs/stat.enum`, vals 1–19) already maps int→stat; it's what
  `levelup.rs2` uses.
- Amount: `calc(random(400001) + 100000)` — **engine XP units are tenths of a
  point** (`addXp` caps at 2,000,000,000 = 200M; mining's copper row is 175 =
  17.5xp), so 100,000–500,000 units = 10k–50k XP.
- **The multiplier trap**: `stat_advance` (`PlayerOps.ts:801`) calls
  `addXp(stat, xp)` with `allowMulti` defaulted true → the user's `xpRate: 30`
  world would turn a "10k XP" drop into 300k. Add a new engine command
  `ap_stat_advance_raw(stat, xp)` → `addXp(stat, xp, false)` — **opcode 1904**
  (1900 entrance, 1901 drop group, 1902 gather swap are taken; standard
  4-touch-point recipe). XP drops should feel identical on a 1x and a 30x world.
- Weighting within the roll: flat random across all 19 skills including HP —
  landing 30k Smithing XP you didn't ask for is the fun.

### New supply categories: herblore, runecraft, crafting

Straight extension of `ap_rewards.dbtable` — new `category` values + rows, tiers
by the governing stat like the existing 8:

- `herb_supplies` (governing stat: herblore): vials of water, eyes of newt,
  limpwurt roots, then herbs laddering up (guam → ranarr → kwuarm → torstol by
  min_level), secondaries (snape grass, white berries, wine of zamorak).
- `runecraft_supplies` (governing stat: runecraft): rune essence stacks
  (quantity scales with level), talismans laddering by altar level (air/mind →
  chaos → nature → law... whatever rev 274 actually has).
- `crafting_supplies` (governing stat: crafting): thread + needle + soft
  leather, molds, uncut gems laddering (sapphire → diamond), flax/bowstring,
  silver/gold bars.

**Verify every item name against `content/pack/obj.pack` while writing rows**
(the `3dose1strength` lesson — this content set has gaps in "obvious" item
lists). Quantity column matters more here than for gear (essence wants to come
in 15–30s, herbs in 3–5s).

### Quest keepsakes & quest-gated gear (researched 2026-07-15)

Two distinct classes, both verified against `obj.pack` and the quest scripts:

**Quest-gated-wield gear — add to the existing weapons/armour pools, it's
free synergy.** This content set enforces quest completion at *wear* time
through the same `levelrequire` file the gear-tier unlocks will overlay:

| Item(s) | Wield gate (verified in `levelrequire/scripts/tier*.rs2`) |
|---|---|
| `dragon_dagger(_p)`, `dragon_longsword` | 60 atk + **Lost City** (`levelrequire_zanaris_quest_attack`) |
| `dragon_mace`, `dragon_battleaxe` | 60 atk + **Heroes** (`levelrequire_heroes_quest_attack`) |
| `dragon_halberd` | 60 atk/30 str + **Regicide** |
| `dragon_sq_shield` | 60 def + **Legends** |
| `ibanstaff` | its own `levelrequire_iban_staff` label (**Underground Pass**) |
| `rune_platebody` (+trim/gold/god), `dragonhide_body` | 40 def + **Dragon Slayer** |
| `viking_helmet_crush/slash/magic/range` | 45 def + **Fremennik Trials** |

Rolling a dragon longsword you *can't wield yet* is a proper AP tease: the
quest-completion check that unlocks it is itself a location. Add these as
top-tier rows (min_level 60/40/45 per the table) — the quest gate needs zero
extra work because vanilla already enforces it on wear. (The current 94-row
table's rune platebody rows already behave this way today.)

**Post-quest keepsakes — new low-frequency `keepsakes` category.** Iconic
quest rewards that are normally one-per-account, safe to duplicate:

- `excalibur` (20 atk wield, no quest gate) — the user's own example. Caveat:
  `arthur_journal.rs2:55` checks `inv_total(inv, excalibur)`, so granting it
  early can sequence-skip Merlin's Crystal's fetch steps — additive-only
  (can't brick, the quest still completes), but it IS flagged by the
  quest-critical scan; ship behind the same judgment as the rest of this list.
- `silverlight` (Demon Slayer's sword — the quest gates on
  `silverlight_key_*`, not the sword itself, so it's clean).
- `gauntlets_of_cooking` / `gauntlets_of_goldsmithing` / `gauntlets_of_chaos`
  / `steel_gauntlets` (Family Crest — vanilla forces ONE choice per account;
  handing out the others is a randomizer-only treat you can't get any other
  way).
- `ice_gloves` (Heroes step item; extra copies only help).
- `klanks_gauntlets` (Underground Pass keepsake).
- `amulet_of_ghostspeak` (Restless Ghost; also useful toward Priest in Peril).
- `amulet_of_accuracy` (Imp Catcher), `gnome_amulet` (Tree Gnome Village).
- `cape_of_legends` (the flex item of the era).
- `ice_arrow` stacks (Temple of Ikov's bespoke ammo — fun ranged filler).
- `antidragonbreathshield` + the `*dose1antidragon` potions — survival filler
  that's thematically perfect for a Dragon Slayer/KBD-goal game (shield also
  belongs in the armour pool proper).

**Excluded on purpose**: `dramen_staff` (it IS Lost City's completion
mechanic — handing it out deletes the quest), `silverlight_key_*` /
`ibandoll`-family / any mid-quest plumbing items. Mechanically: when writing
the dbrow file, run the candidates through the drops tool's
`loadQuestCriticalItems()` scan (`DropTableParser.ts`) and consciously
sign off on every flagged item (excalibur will flag; dramen will flag and
stay out) rather than trusting either the scan or this list alone.

Category selection stays uniform-random across what becomes ~13 categories
(8 + xp + 3 supplies + keepsakes) — dilution of any one category is fine,
variety is the point. If the user wants XP drops or keepsakes more/less often
than 1-in-13, add a weight column to the category pick then.

---

## Unlocks (AP items) — the menu

Design constraints, in priority order: (1) never brick a seed — `::home`, bank
access, and basic survival stay unconditional; (2) hooks must be cheap and
chokepointed (this content set is very good about funneling); (3) each family
should be independently toggleable, because they become AP yaml options.

### A. Progressive equipment tiers — RECOMMENDED, the flagship

**The hook is a gift**: every tiered piece of gear routes its wear-op through
one file — `levelrequire/scripts/levelrequire.rs2` (17 `levelrequire_*` labels:
attack/defence/ranged/magic + combos; the per-item trigger lists live in
`tier1/5/10/20/30/40/45/50/60/70.rs2` mapping every item to
`@levelrequire_attack(40, ...)` etc.). Overlay the ONE labels file, add an AP
gate alongside the stat check: melee tier N wearable only when
`ap_unlock_count("progressive_melee") >= N`.

- Items: **Progressive Melee Weapons**, **Progressive Armour**, **Progressive
  Ranged**, **Progressive Magic gear** — 7 tiers each (bronze→iron→steel→black→
  mithril→adamant→rune; dragon exists at the top for weapons).
- Bronze (tier 1) starts unlocked so sphere 0 always has combat.
- Nothing retro-unequips: the gate is on the *wear* action only, which is the
  natural and safe semantics.
- This is the single highest fun-per-effort unlock: it's the OSRS apworld's
  proven core loop, and it makes gear reward rolls / drops *mean something*
  ("I got a rune scim... and can't wield it yet").

### B. Progressive tools (axes/pickaxes) — RECOMMENDED

Wielding a mithril axe is already gated by A, but axes/pickaxes *work from the
inventory* without wielding. `mining.rs2` / `woodcut.rs2` are **already
whole-file overlays in this repo** (gathersanity) and both resolve the player's
best tool through their dbtable lookups — add the AP tier gate right there.
Items: **Progressive Axe**, **Progressive Pickaxe** (bronze free, then
steel/mithril/adamant/rune). Fishing gear could join later (harpoon/lobster pot
as one-shot unlocks) — the fishing scripts are also already overlaid.

### C. Skill caps (progressive) — RECOMMENDED, the logic backbone

In `Player.addXp`: clamp each skill's XP so its base level can't exceed
`base_cap + 10 × ap_unlock_count("progressive_<skill>")`. One engine touch
point, reading the same runtime unlock table. Suggested shape:

- All skills start capped at **20** (enough for every early quest and to feel
  alive), each "Progressive <Skill>" raises +10 to a max of 7 per skill.
- XP that would cross the cap is truncated (stop just below the next level's
  threshold), with a throttled "your <skill> feels limited..." message.
- Combat safety: caps never *lower* current levels, and HP is either uncapped
  or starts at 30 — dying more is fun, being unable to survive Melzar's Maze
  at all is not.
- **This is what creates real AP logic**: quest requirements (Lost City needs
  31 Crafting/36 Woodcutting, Heroes needs a pile, Dragon Slayer's 32 QP pulls
  in dozens of skill-gated quests) become item-gated spheres. The level
  milestone checks (#6) also become logic-relevant instead of free.
- Granularity option: 19 skills × 7 = 133 items is a lot; a coarser variant is
  per-skill-*group* items (Progressive Gathering / Artisan / Combat / Support).
  Ship fine-grained, offer grouping as a yaml option later.

### D. Quest availability unlocks — RECOMMENDED as a curated subset

"Quest: Dragon Slayer" as a findable item is extremely AP. But gating all 65
quest starts means touching ~65 dialogue files. Curate instead:

- Gate **the big QP / chain quests** (~15–20): Dragon Slayer itself, Lost City,
  Heroes (and its Shield-of-Arrav + Dragon-Slayer-adjacent chain), Legends
  chain, Waterfall, Fight Arena, Tree Gnome Village, Grand Tree, Underground
  Pass, Regicide, Barcrawl's Alfred Grimhand start, etc.
- Hook per quest: its start-NPC's dialogue file (the `%questvar = 0` → `1`
  branch) gets a 3-line preamble — if not unlocked, the NPC brushes you off.
  Whole-file overlays, same convention as everything else.
- Every *ungated* quest is sphere-0 filler logic (their completions are checks
  reachable from the start given skill caps), which keeps early game rich.
- Do NOT gate via a generic varp-write blocker — quest starts don't uniformly
  write `0→1` and silently swallowing varp writes is a horror-movie bug farm.

### E. Teleport spell unlocks — nice-to-have

Individual items ("Varrock Teleport", ... 7 total). The cast path funnels
through `skill_magic/scripts/spells/teleport.rs2` → one gate. Pairs
hilariously with the teleport-destination shuffle (Feature 4: you unlock
"Ardougne Teleport" and it lands in Varrock). Cheap, flavorful, mildly
logic-relevant (post-quest teleports are convenience, not requirements).

### F. XP-rate boosters — nice-to-have filler-adjacent

"XP Tome (+5x rate)" items: start at 1–5x, stack toward the user's beloved 30x.
Needs `xpRate` to move from static `Environment` into the runtime unlock table
(small `addXp` change reading the same JSON). Turns pacing itself into a
reward. (Infinite run is already a world flag — could likewise become an AP
item instead of always-on, if the user wants to feel it as a drop.)

### G. Considered and NOT recommended

- **Region locks** — rejected by the user; also unnecessary (see top).
- **Bank lock / run-energy lock / ::home lock** — safety valves stay
  unconditional; bricking-adjacent misery, not fun.
- **Prayer unlocks** — implementable (prayer scripts funnel fine) but low
  impact at this era's content; revisit if the pool needs padding.
- **Shop access unlocks** — overlaps confusingly with shopsanity's relocation;
  skip.

### Unlock plumbing (shared by A–F)

Runtime-override pattern, exactly like entrances/mimic — unlocks change
mid-*session* in AP (items arrive while playing), so this must be runtime-
readable and ideally runtime-*re*-readable:

- `engine/data/config/ap-unlocks.json`: `{ "progressive_melee": 3,
  "progressive_mining": 2, "quest_dragon_slayer": 1, ... }`.
- Engine module `ApUnlockOverrides.ts` (clone the entrance loader) — but unlike
  entrances it needs a **reload path** (file-watch or a reload on each AP item
  receipt) since the AP client will rewrite it while the server runs. Pre-AP
  testing: `::apunlock <name> <count>` writes the file and reloads.
- Script command `ap_unlock_count(string)(int)` — **opcode 1905**. Content-side
  gates (A/B/D/E) call it; engine-side consumers (C/F) read the module
  directly.
- Missing file = everything unlocked (vanilla behavior preserved, same
  fail-open convention as every other override table).

---

## AP-phase mapping

- **Locations**: catalog #1–6 → the location table in the apworld package.
  Location count scales with yaml options (milestone density, notable-kill
  list, stage curation).
- **Items**: unlock families A–F (progression), XP drops + supply/gear reward
  rolls (filler), maybe a couple of "useful" mid-items (traps: nothing that
  gates goal completion may live only in filler).
- **Logic**: per-quest requirement data (skill levels, prereq quests, QP
  totals) needs transcribing into the apworld — that's a data-entry pass over
  the 65 quests' wiki-era requirements, validated against what this content
  set actually enforces. The varp watcher's stage checks inherit their quest's
  logic + earlier stages.
- **Goal options**: Barcrawl / Dragon Slayer / KBD (built) map to yaml goal
  choices; "all three" as a bonus mode.
- The `~ap_check_fired` proc is the single seam where "announce + reward"
  becomes "send location"; the reward roll moves to the item-received handler.

## Suggested build order (each step independently shippable & testable)

1. **`~ap_check_fired` + varp watcher engine module** (+ `::apchecks` listing
   fired/unfired, `::apcheckfire <id>` force-fire) — Barcrawl bars + a starter
   Dragon Slayer stage table proves it end-to-end.
2. **First-XP + first-kill checks** (addXp hook, npc_death overlay,
   `::apfirstxp` status printout).
3. **Reward expansion**: XP drops (opcode 1904) + 3 supply categories
   (`::apreward xp`, `::apreward herb_supplies 40` etc. already fit the
   existing test command's arg shape).
4. **Level milestone checks** (levelup.rs2 overlay + milestone dbtable).
5. **Unlock plumbing** (JSON + module + opcode 1905 + `::apunlock`), then in
   value order: **A gear tiers → B tools → C skill caps → D quest gates →
   E teleports → F xp tomes**.
6. AP protocol integration (the apworld package + a bridge client) — after the
   above, the game side is done; everything else is Python.

Standing rules apply: overlays in this repo then `install.js`; CRLF for
content; explicit opcodes; pack rebuild after content/engine changes; every
feature ships with its test command; hand in-game testing to the user;
update lessons-learned at session end.

## Decisions needed from the user

1. **Unlock families**: build all of A–F, or start with A+B+C (gear, tools,
   skill caps) and add D–F after a playtest? (Recommendation: A+B+C first —
   they're the loop; D is the best second wave.)
2. **Skill-cap shape** (C): starting cap 20? +10 per item? per-skill items or
   coarser skill-group items?
3. **Milestone density** (#6): sparse / normal / dense as the pre-AP default?
4. **Notable-kill list** (#5): happy with a curated ~15, and any must-haves?
5. **Quest-gate list** (D): curated ~15–20 OK, and should Dragon Slayer itself
   be gated (the classic "goal quest is itself an unlock" AP move) or always
   open once 32 QP is met?
6. **XP drops**: confirm raw (multiplier-free) 10k–50k; flat-random across all
   19 skills including HP?
