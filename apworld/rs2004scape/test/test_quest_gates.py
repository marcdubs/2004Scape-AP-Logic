# Every gated quest must be incompletable without its Quest Unlock item and
# completable with it (given everything else).
from BaseClasses import CollectionState

from . import RS2004TestBase
from .. import QUESTS, QUEST_UNLOCK_ITEM_BY_ID


class TestQuestGates(RS2004TestBase):
    def test_unlock_item_gates_quest(self) -> None:
        for qid, item_name in sorted(QUEST_UNLOCK_ITEM_BY_ID.items()):
            if qid not in QUESTS:
                continue
            with self.subTest(quest=qid, item=item_name):
                state = CollectionState(self.multiworld)
                for item in self.multiworld.itempool:
                    if item.name != item_name:
                        state.collect(item, prevent_sweep=True)
                state.sweep_for_advancements()
                self.assertFalse(
                    state.has(f"Completed: {qid}", self.player),
                    f"{qid} completable without {item_name}")

                for item in self.multiworld.itempool:
                    if item.name == item_name:
                        state.collect(item, prevent_sweep=True)
                state.sweep_for_advancements()
                self.assertTrue(
                    state.has(f"Completed: {qid}", self.player),
                    f"{qid} not completable even with {item_name}")
