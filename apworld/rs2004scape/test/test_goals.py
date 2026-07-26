# Each class runs the framework's default tests (fill, all-state reachability,
# empty-state sanity) against one goal, plus an explicit completion check.
from . import RS2004TestBase


class GoalTestMixin:
    def test_goal_reachable_with_everything(self) -> None:
        state = self.multiworld.get_all_state()
        self.assertTrue(self.multiworld.completion_condition[self.player](state))


class TestDragonSlayerGoal(GoalTestMixin, RS2004TestBase):
    options = {"goal": "dragon_slayer"}


class TestBarcrawlGoal(GoalTestMixin, RS2004TestBase):
    options = {"goal": "barcrawl"}


class TestKbdGoal(GoalTestMixin, RS2004TestBase):
    options = {"goal": "kbd"}


class TestHeroesGoal(GoalTestMixin, RS2004TestBase):
    options = {"goal": "heroes"}


class TestLegendsGoal(GoalTestMixin, RS2004TestBase):
    options = {"goal": "legends"}


class TestMultiGoal(GoalTestMixin, RS2004TestBase):
    options = {"goal": "kbd", "extra_goals": ["legends", "barcrawl"]}

    def test_slot_data_lists_all_goals(self) -> None:
        slot_data = self.world.fill_slot_data()
        self.assertEqual(slot_data["goal"], "kbd")
        self.assertEqual(set(slot_data["goals"]), {"kbd", "legends", "barcrawl"})


class TestMusicChecks(GoalTestMixin, RS2004TestBase):
    options = {"music_checks": True}

    def test_all_locations_present(self) -> None:
        """With music on, every catalog check exists - except the ones this rolled world
        can never reach, which are deliberately not created (see the feasibility
        exclusion in create_regions: a location nothing can ever check would swallow
        whatever was placed there)."""
        from .. import LOCATIONS
        real = [loc for loc in self.multiworld.get_locations(self.player) if loc.address is not None]
        excluded = self.world._infeasible_checks(self.world.infeasible_quests)
        self.assertEqual(len(real), len(LOCATIONS) - len(excluded))
        # the exclusion is a safety net, not the normal case - it must stay small
        self.assertLess(len(excluded), len(LOCATIONS) // 10)
