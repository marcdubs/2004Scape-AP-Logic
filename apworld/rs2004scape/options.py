# Options for the 2004Scape Archipelago world (docs/archipelago-integration.md).
from dataclasses import dataclass

from Options import Choice, OptionSet, PerGameCommonOptions, Toggle

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
    progressive_quests: ProgressiveQuests
    music_checks: MusicChecks
