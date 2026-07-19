# Progressive quests mode: one "Progressive Quest Unlock" item, difficulty-
# ordered reveal. Copy N unlocks QUEST_ORDER[N-1].
import unittest

from BaseClasses import CollectionState

from . import RS2004TestBase
from .. import GATED_QUEST_IDS, PROGRESSIVE_QUEST_NAME, QUEST_ORDER, QUEST_UNLOCK_ITEM_BY_ID, QUESTS


class TestProgressiveQuests(RS2004TestBase):
    options = {"progressive_quests": True}

    def test_pool_swaps_unlock_items(self) -> None:
        names = [item.name for item in self.multiworld.itempool]
        self.assertEqual(names.count(PROGRESSIVE_QUEST_NAME), len(QUEST_ORDER))
        for per_quest in QUEST_UNLOCK_ITEM_BY_ID.values():
            self.assertNotIn(per_quest, names)

    def test_last_quest_needs_every_copy(self) -> None:
        last = QUEST_ORDER[-1]
        state = CollectionState(self.multiworld)
        withheld = None
        for item in self.multiworld.itempool:
            if item.name == PROGRESSIVE_QUEST_NAME and withheld is None:
                withheld = item
                continue
            state.collect(item, prevent_sweep=True)
        state.sweep_for_advancements()
        self.assertFalse(state.has(f"Completed: {last}", self.player),
                         f"{last} completable with only {len(QUEST_ORDER) - 1} copies")
        state.collect(withheld, prevent_sweep=True)
        state.sweep_for_advancements()
        self.assertTrue(state.has(f"Completed: {last}", self.player))


class TestQuestOrderData(unittest.TestCase):
    def test_order_is_permutation_of_gates(self) -> None:
        self.assertEqual(sorted(QUEST_ORDER), sorted(GATED_QUEST_IDS))

    def test_prereqs_precede_dependents(self) -> None:
        index = {qid: i for i, qid in enumerate(QUEST_ORDER)}
        for qid in QUEST_ORDER:
            quest = QUESTS[qid]
            prereqs = list(quest.get("quests") or [])
            for group in quest.get("questsAny") or []:
                prereqs.extend(group)
            for prereq in prereqs:
                if prereq in index:
                    self.assertLess(index[prereq], index[qid],
                                    f"{prereq} ordered after its dependent {qid}")
