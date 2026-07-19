# Options for the 2004Scape Archipelago world (docs/archipelago-integration.md).
from dataclasses import dataclass

from Options import Choice, PerGameCommonOptions, Toggle


class Goal(Choice):
    """Victory condition.
    Dragon Slayer: complete the Dragon Slayer quest (32 QP to start).
    Barcrawl: sign all 10 bars of Alfred Grimhand's Barcrawl.
    KBD: slay the King Black Dragon (logic expects 50 attack/strength/defence caps)."""

    display_name = "Goal"
    option_dragon_slayer = 0
    option_barcrawl = 1
    option_kbd = 2
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
    music_checks: MusicChecks
