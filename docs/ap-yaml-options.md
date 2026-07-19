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
- **Filler**: `Mystery Reward` - rolls the in-game random reward
  (runes/gear/supplies/cash/caskets/addons) when received.

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

2004-era RuneScape at `1` is *slow* - a single mid-level milestone check like
`Level 60 Woodcutting` is hours of grinding. Since level milestones, first-XP
checks, and every skill-gated quest pace your check flow, `xpRate` is
effectively this game's "how often do I send items to everyone else" dial.

**Recommendation: scale it to the other games in the multiworld.** In a synced
multiworld session, other players' games typically produce a check every few
minutes; a 1x RuneScape grind starves the whole group of whatever progression
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

### Seed-roll knobs (`scripts/new-run.sh`)

The world randomization itself - entrance shuffle (incl. `--mixed`), drop
randomization mode (`tiered`/`chaos`/`mimic`), gathering/processing shuffles,
random spawn (`city`/`chunk`) - is configured per run at the top of
`new-run.sh`, with every tool's full parameter list documented next to its
knob. These change the *world*; the YAML changes the *item game* on top of it.
