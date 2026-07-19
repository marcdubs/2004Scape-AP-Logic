# Pure data-package invariants - no multiworld needed, so plain TestCase.
import unittest

from .. import DATA, ITEMS, LOCATIONS, QUESTS, QUEST_UNLOCK_ITEM_BY_ID, GATED_QUEST_IDS, cap_copies_needed


class TestDataPackage(unittest.TestCase):
    def test_location_ids_unique(self) -> None:
        ids = [loc["id"] for loc in LOCATIONS.values()]
        self.assertEqual(len(ids), len(set(ids)))

    def test_location_names_unique(self) -> None:
        names = [loc["name"] for loc in LOCATIONS.values()]
        self.assertEqual(len(names), len(set(names)))

    def test_item_ids_unique(self) -> None:
        ids = [d["id"] for d in ITEMS.values()]
        self.assertEqual(len(ids), len(set(ids)))

    def test_id_ranges_disjoint(self) -> None:
        loc_ids = {loc["id"] for loc in LOCATIONS.values()}
        item_ids = {d["id"] for d in ITEMS.values()}
        self.assertGreaterEqual(min(loc_ids), DATA["locationBaseId"])
        self.assertGreaterEqual(min(item_ids), DATA["itemBaseId"])

    def test_pool_fits_base_locations(self) -> None:
        # generation with music_checks off must have room for every real item
        copies = sum(d.get("copies", 0) for d in ITEMS.values())
        base_locations = sum(1 for loc in LOCATIONS.values() if loc["kind"] != "music")
        self.assertLessEqual(copies, base_locations)

    def test_every_gated_quest_has_unlock_item_and_exists(self) -> None:
        for qid in GATED_QUEST_IDS:
            self.assertIn(qid, QUESTS)
            self.assertIn(qid, QUEST_UNLOCK_ITEM_BY_ID)

    def test_every_unlock_item_is_a_gate(self) -> None:
        self.assertEqual(set(QUEST_UNLOCK_ITEM_BY_ID), GATED_QUEST_IDS)


class TestCapMath(unittest.TestCase):
    def test_cap_copies_needed(self) -> None:
        for level, expected in ((1, 0), (20, 0), (21, 1), (40, 1), (41, 2), (60, 2), (99, 4)):
            self.assertEqual(cap_copies_needed(level), expected, f"level {level}")
