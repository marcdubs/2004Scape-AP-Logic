# 2004Scape player YAML reference

Every option you can put in a `Players/<name>.yaml` for the 2004Scape
Archipelago world. A minimal working YAML is in the README quickstart; this is
the full menu. (General Archipelago YAML mechanics - weighted values, triggers,
multiple games per file - are covered by the
[official options guide](https://archipelago.gg/tutorial/Archipelago/advanced_settings/en).)

## Top-level fields

```yaml
name: Marcus          # your SLOT name in the multiworld (max 16 chars).
                      # Does NOT need to match your in-game character name -
                      # the whole game server plays as this one slot.
description: optional free text shown in the spoiler/host log
game: 2004Scape
2004Scape:
  # ...options below...
```

## 2004Scape-specific options

### `goal`

Victory condition. The game server reports it automatically the moment the
condition is met in-game.

| value | wins by | logic expects |
|---|---|---|
| `dragon_slayer` (default) | completing Dragon Slayer (kill Elvarg) | 32 QP to start the quest |
| `barcrawl` | signing all 10 bars of Alfred Grimhand's Barcrawl | nothing - a sphere-0 travel checklist |
| `kbd` | slaying the King Black Dragon | 50 Attack/Strength/Defence caps received (i.e. 2 cap copies each) |
| `heroes` | completing Heroes' Quest | 55 QP + its Shield of Arrav / Lost City / Merlin's Crystal / Dragon Slayer prereq chain |
| `legends` | completing Legends' Quest | 107 QP + its five-quest prereq chain and ten 42-56 skill caps |

### `extra_goals`

A list of additional goals that must ALL also be completed (on top of `goal`)
before the server reports victory. Same five values as `goal`. Example - "kill
the KBD *and* finish Legends' Quest":

```yaml
  goal: kbd
  extra_goals: ["legends"]
```

### `progressive_quests`

`false` (default) / `true`. Replaces the 61 individual `Quest Unlock: <name>`
items with 61 copies of one **`Progressive Quest Unlock`** item. Your Nth copy
unlocks the Nth quest in a difficulty-ordered list - trivial errands (Clock
Tower, Cook's Assistant...) surface first, the long masters (Family Crest,
Heroes' Quest, Underground Pass, Regicide, Legends' Quest) come last, and a
prerequisite always unlocks before anything that needs it. The order is fixed
per apworld build (it's a curated difficulty matrix, not seeded); the exact
sequence is `questUnlockOrder` in `rs2004scape/data/rs2004_data.json`.

### Item-category toggles: `gear_progression` / `tool_progression` / `skill_caps` / `quest_unlocks`

All `true` by default - each one removes a whole item family from the pool and
leaves that system unrestricted from the start of the run. The game server
adopts these from slot_data on connect (a disabled family's unlock counts
report as maxed; `quest_unlocks: false` also empties the quest-gate list).

| option | items removed when `false` | effect when `false` |
|---|---|---|
| `gear_progression` | Progressive Melee/Armour/Ranged/Magic (7 copies each) | every equipment tier usable immediately |
| `tool_progression` | Progressive Pickaxe (5) + Progressive Axe (6) | every pickaxe/axe usable immediately |
| `skill_caps` | all `Progressive <Skill> Cap` items (72 copies) | no skill is ever capped |
| `quest_unlocks` | all `Quest Unlock: <name>` items / `Progressive Quest Unlock` | every quest startable immediately; `progressive_quests` is ignored |

Turning families off shrinks the progression pool (filler pads the difference),
so leave at least one meaningful family on unless you want a pure-filler world.

### `relics`

Which relic reward items are allowed to roll from `Mystery Reward` filler.
Default: all four. A relic keeps working once delivered - removing one from the
list only stops it *rolling*. The game server adopts this on connect (the
`addon*` keys in `ap-options.json`).

```yaml
  relics: ["bank_box", "tree_compass", "teleporting_focus", "npc_teleport"]
```

| relic | what it does |
|---|---|
| `bank_box` | open your bank from anywhere |
| `tree_compass` | teleport to the four spirit tree sites (bypasses the vanilla talk-gates - the compass IS the unlock) |
| `teleporting_focus` | rune-free teleports; a Greater upgrade can roll later |
| `npc_teleport` | teleport to a previously-met NPC |

### `filler_weights`

Relative weights for the filler items the pool is padded with. Every location
your other options leave unfilled by progression gets one of these, so this sets
the **mix**, not the count - the count is derived (`locations - progression
items`, roughly **115** filler slots at default options, **~345** with
`music_checks: true`, and up to *every* location if you turn the four
item-category toggles off).

```yaml
  filler_weights:
    mystery_reward: 40
    ore_pack: 15
    bar_pack: 15
    herb_pack: 10
    rune_pack: 10
```

| filler | what you get |
|---|---|
| `mystery_reward` | one roll from a weighted random category - gear, XP, cash, food, potions, supplies, caskets, a relic, anything |
| `ore_pack` | 3 rolls from the ore table, biased on **Smithing** (clay/copper/tin -> coal -> mithril -> adamantite -> runite) |
| `bar_pack` | 3 rolls from the bar table, biased on **Smithing** |
| `herb_pack` | 3 rolls from the herb table (unidentified herbs, secondaries, vials), biased on **Herblore** |
| `rune_pack` | 3 rolls from the rune table, biased on **Magic** |

Weights are relative and need not sum to anything; `0` removes that filler
entirely. Setting all five to `0` falls back to the defaults (the pool still has
to be paddable).

The packs exist because raw materials - coal above all - are the real bottleneck
in a randomized world: `gathering_randomization` can take coal rocks away from
you, `processing_randomization` can make smelting produce something other than
the bar the recipe names, and `drop_randomization` moves the rest. A bar pack is
worth more than an ore pack in a default seed for exactly that reason.

**The level bias is a bias, not a rule.** Each roll weights tiers around your
current level in the governing skill, but nothing is ever excluded: at 40
Smithing an ore pack is mostly coal/gold/iron, ~4% mithril, ~1% adamantite and
~0.3% runite. You can always be handed something you cannot use yet - just
rarely. Tune the curve with `rewardAspirationLevels` / `rewardObsolescence`
below.

### `region_logic`

`true` (default) / `false`. Reason about where things physically **are**.

On, the world's access rules run the full region/gate/quest/item fixpoint - the
same one `tools/logic/ValidateSeed.ts` runs for solo seeds, ported to Python in
`apworld/rs2004scape/logic.py` - so the multiworld's fill can never hide
progression behind a door this seed leaves shut. Two consequences:

- **Archipelago builds the entrance layout**, not the game server. It uses a
  reachability-preserving frontier (the same idea as AP's own
  `randomize_entrances`), so the map is sound by construction and nothing is
  rerolled. The finished table ships in `slot_data.entranceOverrides`, the
  client writes it to `data/config/ap-entrances.json`, and
  `seedOptions.entrances` is pinned to `off` so a later `new-run` cannot
  reshuffle the map the fill reasoned over. `entrance_randomization` still
  chooses the *style* (`off` / `on` / `mixed`).
- **Checks the region model cannot justify are not created.** If no reachable
  path to a quest exists even with every item collected, its check would never
  fire in game either, so nothing is placed there. A configured *goal* being
  unreachable is a generation error instead.

- **Archipelago also rolls the rest of the world.** Gathersanity, processsanity,
  shopsanity, drop randomization and spawn all change what is obtainable and
  where you start, so they are rolled during generation too. Only entrances ship
  as a finished table; the others ship as one shared **seed**
  (`seedOptions.seed`), which the server's own deterministic tools replay into
  the identical tables.
- **If a goal turns out unreachable, the world is re-rolled** (up to 8 times)
  before generation gives up. With every randomizer on and drops on `mimic`,
  roughly 1 roll in 5 needs a second attempt.

Off, the older travel-agnostic rules apply (skills, quest prerequisites and QP
only) and the game server rolls its own entrance table again - in which case
that roll must pass `--require-perfect`, as described below.

### Seed randomizer options (adopted at the next seed roll)

Every server-side randomizer is configurable from the YAML. These can't apply
live (several need a content pack rebuild): on connect the server writes them
to `data/config/ap-seed-options.json`, and `scripts/new-run.sh` adopts that
file - overriding its own knobs - the next time you roll a seed (both
`new-run.sh` and `new-run.bat`, via `scripts/seed-options-to-env.cjs`). Flow:
connect once, then run `new-run`. To fall back to the script knobs instead:
`AP_SEED_OPTIONS=ignore bash scripts/new-run.sh` (Windows:
`set AP_SEED_OPTIONS=ignore` first), or delete the file.

Adoption also adds `--require-perfect` to the entrance roll **when the server
is the one rolling entrances** (`region_logic: false`, or a run predating it):
an AP run must
never accept an entrance table that strands a quest (solo runs may - their
stranded checks just become filler), because the multiworld's fill was
computed before the table existed and a stranded check may hold another
player's progression. If the roll fails with "no table stranding zero
quests", just re-run for a fresh seed.

| option | values (default first) | controls |
|---|---|---|
| `entrance_randomization` | `on` / `off` / `mixed` | ladder/stair/trapdoor shuffle; `mixed` merges both gate pools. With `region_logic: true` the apworld performs this shuffle itself and ships the table (see above) - the server's copy of this knob is forced to `off` |
| `npc_drip` | `true` / `false` | NPC outfit/cosmetic shuffle |
| `shop_randomization` | `true` / `false` | which NPC has which shop |
| `teleport_randomization` | `true` / `false` | the 7 spellbook teleports land at each other's destinations (always a vanilla landmark, never wilderness; casting quest-gates stay put) |
| `drop_randomization` | `mimic` / `off` / `tiered` / `chaos` | monster loot: rarity-banded, full chaos, or whole-table mimicry |
| `gathering_randomization` | `shuffle` / `off` / `tiered` / `chaos` | what mining/fishing/woodcutting yield; `tiered` shuffles only within a level band, so a level-1 fish becomes a level-1 ore or log |
| `processing_randomization` | `shuffle` / `off` / `tiered` / `chaos` | what cooking/smithing/crafting/fletching produce; `tiered` as above |
| `spawn_randomization` | `city` / `off` / `chunk` | home/respawn point: spellbook landmark or random map square |

### `infinite_run`

`false` (default) / `true`. Run energy never depletes. Unlike the seed options
above this applies **live** on connect (same effect as the server operator's
`infiniteRun` world.json flag - either source enables it).

### `progressive_xp_rate`

`true` (default) / `false`. XP rate scales with the trained skill's level: 5x
at level 1, doubling every 15 levels (10x at 15, 20x at 30, 40x at 45, 80x at
60, 160x at 75, 320x at 90+). While on it **replaces** the server's flat
`xpRate`; turning it off restores flat-rate behavior. Applies **live** on
connect, no reseed needed. Strongly recommended on - late-game 2004Scape
levels are far too slow for a multiworld at any flat rate that isn't absurd
at level 1. The 15-level doubling deliberately trails the XP curve's own
~7-level doubling so high levels stay meaningful (level 98->99 is still a few
minutes of play, not one action). (AP reward XP is unaffected - those amounts
are always absolute.)

### `gather_speed`

`200` (default), range `25`-`1000`. Mining / Woodcutting / Fishing success rate
as a **percentage of vanilla**: `100` is untouched 2004 behavior, `200` means
roughly twice as many swings pay out. It scales the level-interpolated success
roll rather than forcing a success, so tool tier and level still matter - a
rune pickaxe on a level-1 rock is still visibly better than bronze, the whole
curve just shifts up. Applies **live** on connect, no reseed needed.

The default is deliberately not vanilla, for the same reason
`progressive_xp_rate` defaults on: with progressive XP the levels arrive fast
but 2004 gathering hands you resources at 2004 speed, and the raw materials
become the bottleneck for every downstream skill. The **per-swing action delay
is untouched**, so one resource per swing/cast is still the ceiling no matter
how high you set this - going past ~400 mostly just removes the last failed
cycles at low levels. Set `100` for authentic rates.

Nothing else that rolls against a skill moves: cooking burn chance, fletching,
thieving and friends all keep vanilla odds (they share the vanilla
`stat_random` command; only the three gathering skills call the AP one).

### `music_checks`

`false` (default) / `true`. Adds 230 "first visit to each music-track region"
locations - exploration checks that fire the first time you set foot in each
map region. They're filler-only (never hold progression) and roughly double the
location count, so leave off unless you want a long world-tour game. The game
server adopts this setting automatically from the multiworld when it connects -
no server-side config needed.

## Standard Archipelago options

These come with every AP world; values shown are the defaults. The interesting
ones take **item or location names** - see the reference lists at the bottom.

```yaml
2004Scape:
  progression_balancing: 50    # 0-99; how early the fill pushes your progression
  accessibility: full          # "full" = every location reachable; "minimal" = only the goal guaranteed
  local_items: []              # item names forced into YOUR OWN world
  non_local_items: []          # item names forced into OTHER players' worlds
  start_inventory: {}          # items granted at the start, e.g. {Progressive Pickaxe: 1}
  start_hints: []              # item names whose location is revealed at start
  start_location_hints: []     # location names whose item is revealed at start
  exclude_locations: []        # locations that must hold filler
  priority_locations: []       # locations that must hold progression
  item_links: []               # shared item pools across players (see AP docs)
  plando_items: []             # hand-placed items (host must enable plando)
```

Notes for this world specifically:

- `start_inventory` is great for softening the early game:
  `{Progressive Pickaxe: 1, Progressive Axe: 1}` starts you with iron tools;
  `{Progressive Attack Cap: 1}` starts Attack capped at 40 instead of 20.
- `exclude_locations` on kill/level checks you never want to matter, e.g.
  `[First Kill Green Dragon, Level 90 Runecraft]`. Clue-trail and music
  locations are already filler-only, no need to exclude them.
- `accessibility: minimal` is honored but rarely worth it here - the world's
  own logic is already travel-agnostic and permissive.

## Item name reference (for `local_items`, `start_inventory`, hints...)

- **Progressive gear** (7 copies each): `Progressive Melee`,
  `Progressive Armour`, `Progressive Ranged`, `Progressive Magic` - each copy
  unlocks the next equipment tier (see the tracker's Unlocks tab for the
  per-family tier ladder).
- **Progressive tools**: `Progressive Pickaxe` (5 copies, iron -> rune),
  `Progressive Axe` (6 copies, iron -> rune).
- **Skill caps** (4 copies per skill, +20 levels each, all start at 20):
  `Progressive <Skill> Cap` for Attack, Strength, Defence, Ranged, Prayer,
  Magic, Cooking, Woodcutting, Fletching, Fishing, Firemaking, Crafting,
  Smithing, Mining, Herblore, Agility, Thieving, Runecraft. (Hitpoints is
  never capped.)
- **Quest unlocks** (1 copy each; the quest can't be *started* until received):
  `Quest Unlock: <name>` for: Big Chompy Bird Hunting, Biohazard, Black
  Knights' Fortress, Clock Tower, Cook's Assistant, Death Plateau, Demon
  Slayer, Doric's Quest, Druidic Ritual, Dwarf Cannon, Eadgar's Ruse,
  Elemental Workshop, Ernest the Chicken, Family Crest, Fight Arena, Fishing
  Contest, Gertrude's Cat, Goblin Diplomacy, Hazeel Cult, Heroes' Quest, Holy
  Grail, Imp Catcher, Jungle Potion, Knight's Sword, Legends' Quest, Lost
  City, Merlin's Crystal, Monk's Friend, Murder Mystery, Nature Spirit,
  Observatory Quest, Pirate's Treasure, Plague City, Priest in Peril, Prince
  Ali Rescue, Regicide, Restless Ghost, Romeo & Juliet, Rune Mysteries,
  Scorpion Catcher, Sea Slug, Shades of Mort'ton, Sheep Herder, Sheep
  Shearer, Shield of Arrav, Shilo Village, Tai Bwo Wannai Trio, Temple of
  Ikov, The Digsite, The Grand Tree, Tourist Trap, Tree Gnome Village, Trials
  of the Fremmenik, Tribal Totem, Troll Stronghold, Underground Pass, Vampire
  Slayer, Watchtower, Waterfall Quest, Witch's House, Witch's Potion.
- **`Progressive Quest Unlock`** (61 copies, only with
  `progressive_quests: true` - replaces every `Quest Unlock: <name>` above;
  copy N unlocks the Nth quest in the difficulty order).
  (Dragon Slayer and Horror from the Deep are never gated.)
- **Filler** (see `filler_weights`): `Mystery Reward` (weighted random
  category), `Ore Pack`, `Bar Pack`, `Herb Pack`, `Rune Pack` (3 level-biased
  rolls from that one resource table). All are `filler` classification; the
  contents are rolled game-side when the item lands, against the stats you have
  at that moment. Item groups: `Filler` (all five), `Resource Packs` (the four
  packs).

## Location name reference (for `exclude_locations`, `priority_locations`, hints...)

- **Quests** (63): `Quest: <name>` - completing the quest is the check.
- **Dragon Slayer stages** (6): `Dragon Slayer: Started / Oziach / Ship Ready /
  Map Complete / Sailed / Complete`.
- **Barcrawl bars** (10): `Barcrawl: Barcrawl Bar 1`..`10`.
- **First XP** (18): `First <Skill> XP` - first ever xp in each skill.
- **First kills** (15): `First Kill` plus `First Kill <Monster>` for Goblin,
  Cow, Chicken, Rat, Guard, Dwarf, Skeleton, Zombie, Ghost, Moss Giant, Ice
  Giant, Lesser Demon, Black Knight, Green Dragon.
- **Level milestones** (162): `Level <10..90 by 10> <Skill>` - reaching that
  base level (gated by the skill's received caps).
- **Activities** (13): `Agility Gnome Course`, `Agility Barbarian Course`,
  `Agility Wilderness Course`, `Agility Arena Ticket`, `Gnomeball Goal`,
  `Ranging Guild Ticket`, `Mage Arena Kolodion`, `Mage Arena God Cape`,
  `Mage Arena God Staff`, `Trawler Win`, `Trail Easy/Medium/Hard Complete`
  (trails are filler-only).
- **Music** (230, only with `music_checks: true`): `Music: <Track Name>`.

The authoritative machine-readable list (names + ids) is
[apworld/rs2004scape/data/rs2004_data.json](../apworld/rs2004scape/data/rs2004_data.json).

## Game-server tweaks (outside the YAML)

A few settings that shape the run live on the game server rather than in the
player YAML (making them proper YAML slot options is on the roadmap in
[archipelago-integration.md](archipelago-integration.md)). All of these are in
`Server/engine/data/config/world.json` under `"node"` and need a server
restart (env-var overrides `NODE_XPRATE` etc. also exist):

### `xpRate` - the XP multiplier (the big one)

The 2004-era game at `1` is *slow* - a single mid-level milestone check like
`Level 60 Woodcutting` is hours of grinding. Since level milestones, first-XP
checks, and every skill-gated quest pace your check flow, `xpRate` is
effectively this game's "how often do I send items to everyone else" dial.

**Recommendation: scale it to the other games in the multiworld.** In a synced
multiworld session, other players' games typically produce a check every few
minutes; a 1x-era grind starves the whole group of whatever progression
sits on your locations. Rough guide:

| setting | feels like |
|---|---|
| `1` | authentic 2004 - solo marathons only, expect to be the multiworld's bottleneck |
| `5`-`10` | long campaign pace - multi-evening multiworlds with patient friends |
| `25`-`50` | evening-scale multiworld pace - milestones fall at roughly board-game cadence |

Two interactions worth knowing: XP past a still-locked skill cap is **banked,
not lost** - it auto-applies the moment the cap item arrives, so a high
`xpRate` makes cap unlocks feel instant rather than wasting grind. And combat
floors in the logic (e.g. the KBD goal) only check received *caps*, so raising
`xpRate` never breaks logic - it just shortens the distance between receiving
a cap and actually reaching it.

### Other `world.json` flags

- `apSkipTutorial: true` - new accounts skip Tutorial Island with the starter
  kit and a random look. Strongly recommended for AP runs (the tutorial is
  outside logic and just delays sphere 0).
- `infiniteRun: true` - never run out of run energy. Pure QoL; the logic
  ignores travel cost either way.
- `web.port` - tracker/game-client port.

### Reward-pool addons (`Server/engine/data/config/ap-options.json`)

Boolean toggles for the custom QoL items that `Mystery Reward` can roll:
`addonBankBox` (portable bank), `addonTreeCompass` (4-destination teleport),
`addonTeleportingFocus` (store/rub location teleports), `addonNpcTeleport`
(teleport-to-last-talked-NPC writ). All default `true`; turn one off if you'd
rather not see it this run. (`musicChecks` also lives in this file but is
overridden by the YAML's `music_checks` on connect - the YAML wins.)

### Reward roll tuning (`Server/engine/data/config/ap-options.json`)

The YAML picks *which* filler item lands (`filler_weights`); these decide what a
roll actually pays. Server-side only - edit the file and restart. They apply in
both AP and solo mode.

| key | default | what it does |
|---|---|---|
| `rewardPackRolls` | `3` | items per resource pack. `1` makes packs single-item like every other category |
| `rewardAspirationLevels` | `8` | levels **above** yours a tier needs for its odds to halve. Lower = you almost only get what you can use; higher = high tiers show up early as "someday" prizes |
| `rewardObsolescence` | `8` | weight lost (per 1000) for each level you are **above** a tier, floored at 120. Low tiers never stop coming - you always want coal |
| `rewardWeight<Category>` | see below | relative odds of each category for a `Mystery Reward` roll. `0` disables that category |

`rewardWeight*` keys and defaults: `Ores` 110, `Bars` 100, `Herbs` 85, `Runes`
85, `Xp` 85, `Cash` 65, `Food` 55, `Potions` 55, `Crafting` 45, `Tools` 45,
`Runecraft` 40, `Addons` 40, `Armour` 40, `Weapons` 40, `Arrows` 35,
`RangedGear` 30, `Caskets` 30, `Keepsakes` 25. (This replaced a flat
`random(16)` that gave the 3-row casket category exactly as much airtime as the
27-row armour category, and put ~19% of every reward into melee/ranged gear you
had almost certainly already out-tiered.)

The reward table itself is `overlays/content/scripts/ap/configs/ap_rewards.dbrow`
(201 rows / 16 categories), generated by `scripts/gen-rewards.py` - edit the
generator, re-run it, then rebuild the pack. Test any bracket in game with
`::apreward <category> <level>` (e.g. `::apreward ores 40`).

### Seed-roll knobs (`scripts/new-run.sh`)

The world randomization itself - entrance shuffle (incl. `--mixed`), drop
randomization mode (`tiered`/`chaos`/`mimic`), gathering/processing shuffles,
random spawn (`city`/`chunk`) - is configured per run at the top of
`new-run.sh`, with every tool's full parameter list documented next to its
knob. These change the *world*; the YAML changes the *item game* on top of it.
