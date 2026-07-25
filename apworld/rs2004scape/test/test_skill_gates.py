# Some skills cannot be trained until a quest is done, so every check on them - even
# "first XP" - has to wait for that quest. Without this the fill happily hides
# progression behind XP the player cannot earn yet (reported 2026-07-25: a seed wanted
# 20 Runecrafting before Rune Mysteries).
#
# Two kinds of gate, see types.ts SKILL_QUEST_GATES:
#   runecraft -> runemysteries : hard script gate (essence_mine.rs2 refuses the teleport)
#   herblore  -> druid         : deliberate balance choice (trainable in-game, brutal
#                                without the quest)

from BaseClasses import CollectionState

from . import RS2004TestBase
from .. import LOCATIONS, SKILL_QUEST_GATES


class TestSkillQuestGates(RS2004TestBase):
    def test_gates_are_present(self) -> None:
        self.assertEqual(SKILL_QUEST_GATES.get("runecraft"), "runemysteries")
        self.assertEqual(SKILL_QUEST_GATES.get("herblore"), "druid")

    def test_checks_on_a_gated_skill_need_its_quest(self) -> None:
        """With nothing collected, no check on a gated skill may be reachable."""
        empty = CollectionState(self.multiworld)
        for skill, quest in SKILL_QUEST_GATES.items():
            gated = [check_id for check_id, loc in LOCATIONS.items() if loc.get("skill") == skill]
            self.assertTrue(gated, f"no checks found for {skill}")
            for check_id in gated:
                with self.subTest(skill=skill, quest=quest, check=check_id):
                    self.assertFalse(
                        empty.has(f"Completed: {quest}", self.player),
                        "precondition: the gating quest must not be pre-completed")
                    self.assertFalse(
                        self.world._location_rule(empty, check_id),
                        f"{check_id} reachable without {quest}")

    def test_ungated_first_xp_is_still_free(self) -> None:
        """The gate must not leak onto skills that really are trainable from scratch."""
        empty = CollectionState(self.multiworld)
        for check_id, loc in LOCATIONS.items():
            if loc["kind"] != "first_xp" or loc.get("skill") in SKILL_QUEST_GATES:
                continue
            with self.subTest(check=check_id):
                self.assertTrue(self.world._location_rule(empty, check_id))

    def test_gated_skill_opens_once_the_quest_is_done(self) -> None:
        """Collecting everything must make the gated checks reachable again - otherwise
        the gate would strand its own checks."""
        full = CollectionState(self.multiworld)
        for item in self.multiworld.itempool:
            full.collect(item, prevent_sweep=True)
        full.sweep_for_advancements()
        infeasible = getattr(self.world, "infeasible_quests", frozenset())
        for skill, quest in SKILL_QUEST_GATES.items():
            if quest in infeasible:
                continue  # this rolled world cannot do the quest at all; checks were excluded
            with self.subTest(skill=skill):
                self.assertTrue(full.has(f"Completed: {quest}", self.player))
                first_xp = f"first_xp_{skill}"
                if first_xp in LOCATIONS:
                    self.assertTrue(self.world._location_rule(full, first_xp))
