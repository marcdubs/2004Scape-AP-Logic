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
        from .. import LOCATIONS
        real = [loc for loc in self.multiworld.get_locations(self.player) if loc.address is not None]
        self.assertEqual(len(real), len(LOCATIONS))
