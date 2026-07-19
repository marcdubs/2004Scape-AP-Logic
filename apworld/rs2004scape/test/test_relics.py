# Relics config: which addon reward items may roll from Mystery Reward filler.
# Pure slot_data plumbing - relics never enter the item pool or the logic.
from . import RS2004TestBase

ALL_RELICS = ["bank_box", "npc_teleport", "teleporting_focus", "tree_compass"]


class TestRelicsDefault(RS2004TestBase):
    def test_all_relics_enabled_by_default(self) -> None:
        self.assertEqual(self.world.fill_slot_data()["relics"], ALL_RELICS)


class TestRelicsSubset(RS2004TestBase):
    options = {"relics": ["bank_box"]}

    def test_slot_data_carries_subset(self) -> None:
        self.assertEqual(self.world.fill_slot_data()["relics"], ["bank_box"])
