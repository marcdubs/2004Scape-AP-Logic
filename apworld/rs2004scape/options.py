# Options for the 2004Scape Archipelago world (docs/archipelago-integration.md).
from dataclasses import dataclass

from Options import Choice, DefaultOnToggle, OptionSet, PerGameCommonOptions, Toggle

GOAL_NAMES = ("dragon_slayer", "barcrawl", "kbd", "heroes", "legends")


class Goal(Choice):
    """Victory condition.
    Dragon Slayer: complete the Dragon Slayer quest (32 QP to start).
    Barcrawl: sign all 10 bars of Alfred Grimhand's Barcrawl.
    KBD: slay the King Black Dragon (logic expects 50 attack/strength/defence caps).
    Heroes: complete Heroes' Quest (55 QP, long prereq chain).
    Legends: complete Legends' Quest (107 QP, the longest goal available)."""

    display_name = "Goal"
    option_dragon_slayer = 0
    option_barcrawl = 1
    option_kbd = 2
    option_heroes = 3
    option_legends = 4
    default = 0


class ExtraGoals(OptionSet):
    """Additional goals that must ALL also be completed (on top of `goal`)
    before victory is reported. Any of: dragon_slayer, barcrawl, kbd, heroes,
    legends. Listing the same goal as `goal` is harmless."""

    display_name = "Extra Goals"
    valid_keys = frozenset(GOAL_NAMES)


class ProgressiveQuests(Toggle):
    """Replace the individual per-quest unlock items with copies of a single
    "Progressive Quest Unlock" item. Your Nth copy unlocks the Nth quest in a
    difficulty-ordered list - short, easy quests surface first and the long
    masters (Underground Pass, Regicide, Heroes', Legends') come last."""

    display_name = "Progressive Quests"
    default = 0


class GearProgression(DefaultOnToggle):
    """Include the Progressive Melee / Armour / Ranged / Magic items - each copy
    unlocks the next equipment tier. Off: those items are removed from the pool
    and every equipment tier is usable from the start."""

    display_name = "Gear Progression"


class ToolProgression(DefaultOnToggle):
    """Include the Progressive Pickaxe and Progressive Axe items - each copy
    unlocks the next tool tier. Off: those items are removed from the pool and
    every pickaxe/axe is usable from the start."""

    display_name = "Tool Progression"


class SkillCaps(DefaultOnToggle):
    """Include the Progressive <Skill> Cap items - every skill starts capped at
    level 20 and each copy raises that skill's cap by 20. Off: those items are
    removed from the pool and no skill is ever capped."""

    display_name = "Skill Caps"


class QuestUnlocks(DefaultOnToggle):
    """Include the quest unlock items - most quests can't be started until
    their unlock arrives. Off: quest unlock items are removed from the pool,
    every quest is startable from the start, and progressive_quests is
    ignored."""

    display_name = "Quest Unlocks"


class EntranceRandomization(Choice):
    """Shuffle ladder/stair/trapdoor destinations. on: connector and
    floor-shift pools shuffle separately; mixed: one chaos pool.
    (seed option*: all options marked this way are adopted by the game server
    on connect and applied the next time it rolls a seed - scripts/new-run -
    not live mid-run.)"""

    display_name = "Entrance Randomization"
    option_off = 0
    option_on = 1
    option_mixed = 2
    default = 1


class NpcDrip(DefaultOnToggle):
    """Shuffle NPC outfits/cosmetics (seed option*)."""

    display_name = "NPC Drip Randomization"


class TeleportRandomization(DefaultOnToggle):
    """Derange the 7 standard-spellbook teleport destinations among
    themselves (seed option*): every spell lands at a different city than
    its name says, but always at one of the 7 vanilla landmarks - never
    the wilderness. Quest gates on casting (Ardougne/Watchtower/Trollheim)
    stay on the spell, not the destination."""

    display_name = "Teleport Randomization"


class ShopRandomization(DefaultOnToggle):
    """Shuffle which NPC has which shop (seed option*)."""

    display_name = "Shop Randomization"


class DropRandomization(Choice):
    """Monster drop randomization (seed option*). tiered: items move within
    their rarity band; chaos: any item anywhere; mimic: each monster runs
    another monster's ENTIRE loot table."""

    display_name = "Drop Randomization"
    option_off = 0
    option_tiered = 1
    option_chaos = 2
    option_mimic = 3
    default = 3


class GatheringRandomization(Choice):
    """What mining/fishing/woodcutting actually yield (seed option*).
    shuffle: bijective - everything stays obtainable; chaos: independent
    resampling, duplicates allowed."""

    display_name = "Gathering Randomization"
    option_off = 0
    option_shuffle = 1
    option_chaos = 2
    default = 1


class ProcessingRandomization(Choice):
    """What cooking/smithing/crafting/fletching produce (seed option*).
    Same shuffle/chaos semantics as gathering."""

    display_name = "Processing Randomization"
    option_off = 0
    option_shuffle = 1
    option_chaos = 2
    default = 1


class SpawnRandomization(Choice):
    """Random home/respawn point (seed option*). city: one of 7 spellbook
    landmarks; chunk: a random mainland map square."""

    display_name = "Spawn Randomization"
    option_off = 0
    option_city = 1
    option_chunk = 2
    default = 1


class InfiniteRun(Toggle):
    """Run energy never depletes. Applies live on connect (server-side
    toggle, no reseed needed)."""

    display_name = "Infinite Run"
    default = 0


class ProgressiveXpRate(DefaultOnToggle):
    """XP rate scales with the trained skill's level: 5x at level 1,
    doubling every 15 levels (10x at 15, 20x at 30, 40x at 45, 80x at 60,
    160x at 75, 320x at 90+). Replaces the server's flat xpRate while on.
    Applies live on connect (server-side toggle, no reseed needed).
    Strongly recommended - keeps late-game skill pacing in step with the
    multiworld."""

    display_name = "Progressive XP Rate Multiplier"


class Relics(OptionSet):
    """Which relic reward items are allowed to roll from "Mystery Reward"
    filler. A relic keeps working once delivered; unticking one only stops it
    from rolling.
    bank_box: open your bank from anywhere.
    tree_compass: teleport to the four spirit tree sites.
    teleporting_focus: rune-free teleports (and its Greater upgrade).
    npc_teleport: teleport to a previously-met NPC."""

    display_name = "Relics"
    valid_keys = frozenset({"bank_box", "tree_compass", "teleporting_focus", "npc_teleport"})
    default = frozenset({"bank_box", "tree_compass", "teleporting_focus", "npc_teleport"})


class MusicChecks(Toggle):
    """Include the 230 music-track discovery checks (first visit to each music
    region) as filler locations. The game server adopts this automatically on
    connect (via slot_data)."""

    display_name = "Music Checks"
    default = 0


@dataclass
class RS2004Options(PerGameCommonOptions):
    goal: Goal
    extra_goals: ExtraGoals
    gear_progression: GearProgression
    tool_progression: ToolProgression
    skill_caps: SkillCaps
    quest_unlocks: QuestUnlocks
    progressive_quests: ProgressiveQuests
    relics: Relics
    music_checks: MusicChecks
    entrance_randomization: EntranceRandomization
    npc_drip: NpcDrip
    shop_randomization: ShopRandomization
    teleport_randomization: TeleportRandomization
    drop_randomization: DropRandomization
    gathering_randomization: GatheringRandomization
    processing_randomization: ProcessingRandomization
    spawn_randomization: SpawnRandomization
    infinite_run: InfiniteRun
    progressive_xp_rate: ProgressiveXpRate
