# 2004Scape

## Where is the options page?

The [player options page for this game](../player-options) contains all the options you need to configure and export a
config file. (When playing with the standalone apworld, set the same options in your player YAML instead - see the
setup guide.)

## What is 2004Scape?

2004Scape is November-2004-era RuneScape, as recreated by the open-source
[Lost City](https://github.com/LostCityRS) project (revision 274). It is a self-hosted game server, playable in a
browser. This world connects the **game server itself** to Archipelago: the server fires checks as you play and
applies received items live, so no client mod or download patch is involved.

One game server plays **one slot**. Checks, received items, and unlock state are server-wide, so you can log in with
any character on that server - or share the slot with friends on the same server.

## What does randomization do to this game?

Progression is rebuilt around Archipelago items - and each family below has its own on/off option
(`gear_progression`, `tool_progression`, `skill_caps`, `quest_unlocks`), so you can play with any subset; a disabled
family's items stay out of the pool and that system is unrestricted from the start:

- **Skill caps**: every skill starts capped at level 20. "Progressive &lt;Skill&gt; Cap" items raise a skill's cap by
  20 each, up to 99 (Hitpoints is never capped).
- **Gear and tool tiers**: "Progressive Melee", "Progressive Armour", "Progressive Ranged", and "Progressive Magic"
  gate which equipment tiers you may use; "Progressive Pickaxe" and "Progressive Axe" gate your tools.
- **Quest gates**: most quests cannot be started until you receive that quest's "Quest Unlock" item. With the
  `progressive_quests` option, those are replaced by copies of a single "Progressive Quest Unlock" item that reveals
  quests in difficulty order - short errands first, the long master quests last.

On top of that, the game server can randomize the world itself per seed - entrances, monster drop tables (including a
"mimic" mode where monsters run each other's entire loot tables), shop locations, gathering and processing outputs,
and NPC appearances. Those are configured server-side when rolling the seed.

## What is the goal?

Chosen per slot:

- **Dragon Slayer**: complete the Dragon Slayer quest (defeat Elvarg on Crandor).
- **Barcrawl**: complete all ten bars of Alfred Grimhand's Barcrawl.
- **King Black Dragon**: slay the King Black Dragon in the deep Wilderness.
- **Heroes' Quest**: complete Heroes' Quest (55 QP and a long prerequisite chain).
- **Legends' Quest**: complete Legends' Quest (107 QP - effectively "finish the quest game").

The `extra_goals` option can require several of these at once - victory is only reported when every configured goal
is done.

## What items and locations get shuffled?

**Locations** (517 total): every quest completion, Dragon Slayer's individual stages, the ten barcrawl bars,
first-time XP and first-kill milestones, skill level milestones, activity/minigame checks, and (optionally, via the
`music_checks` option) 230 "first visit to each music region" checks.

**Items** (86 distinct): the progressive gear/tool tiers, per-skill cap raises, quest unlock gates, and "Mystery
Reward" filler (a random in-game reward - supplies, gear, or XP). Mystery Rewards can also roll **relics** - custom
convenience items (Bank Box, Tree Compass, Teleporting Focus, NPC Teleport) - selectable per slot via the `relics`
option.

## Which items can be in another player's world?

Any of them. There are no local-only items.

## What does another world's item look like in 2004Scape?

Checks in 2004Scape are accomplishments (completing a quest, reaching a milestone), not physical item pickups - when
you complete one, the server announces in your chat what was found and who it was for.

## When the player receives an item, what happens?

It applies immediately, server-wide, with an announcement in game chat - a gear tier unlocks, a skill cap rises, or a
quest becomes startable. No restart or relog is needed.

## Anything else?

The game server ships a browser tracker (world map, discovered entrances/swaps, unlock state, and the Archipelago
connection panel) at `/ap/` on the server's web port.
