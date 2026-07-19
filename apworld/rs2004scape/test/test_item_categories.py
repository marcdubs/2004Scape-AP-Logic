# Item-category toggles: each family can be removed from the pool, with the
# matching system unrestricted (rules bypassed, slot_data flags the server).
from BaseClasses import CollectionState

from . import RS2004TestBase
from .. import (CAP_ITEM_BY_SKILL, GEAR_ITEM_NAMES, PROGRESSIVE_QUEST_NAME, QUEST_UNLOCK_ITEM_BY_ID,
                TOOL_ITEM_NAMES, GATED_QUEST_IDS)


class TestNoGearNoTools(RS2004TestBase):
    options = {"gear_progression": False, "tool_progression": False}

    def test_pool_has_no_gear_or_tools(self) -> None:
        names = {item.name for item in self.multiworld.itempool}
        self.assertFalse(names & (GEAR_ITEM_NAMES | TOOL_ITEM_NAMES))


class TestNoSkillCaps(RS2004TestBase):
    options = {"skill_caps": False}

    def test_pool_has_no_caps(self) -> None:
        names = {item.name for item in self.multiworld.itempool}
        self.assertFalse(names & set(CAP_ITEM_BY_SKILL.values()))

    def test_slot_data_flag(self) -> None:
        self.assertFalse(self.world.fill_slot_data()["skillCaps"])


class TestNoQuestUnlocks(RS2004TestBase):
    options = {"quest_unlocks": False, "progressive_quests": True}

    def test_pool_has_no_quest_items(self) -> None:
        names = {item.name for item in self.multiworld.itempool}
        self.assertFalse(names & set(QUEST_UNLOCK_ITEM_BY_ID.values()))
        self.assertNotIn(PROGRESSIVE_QUEST_NAME, names)

    def test_slot_data_has_no_gates(self) -> None:
        slot_data = self.world.fill_slot_data()
        self.assertEqual(slot_data["questGates"], [])
        self.assertFalse(slot_data["progressiveQuests"])

    def test_gated_quest_needs_no_unlock(self) -> None:
        # every quest completable from items-only state (no unlock items exist)
        state = CollectionState(self.multiworld)
        for item in self.multiworld.itempool:
            state.collect(item, prevent_sweep=True)
        state.sweep_for_advancements()
        for qid in sorted(GATED_QUEST_IDS):
            self.assertTrue(state.has(f"Completed: {qid}", self.player), qid)


class TestAllCategoriesOff(RS2004TestBase):
    options = {"gear_progression": False, "tool_progression": False,
               "skill_caps": False, "quest_unlocks": False, "goal": "legends"}

    def test_pool_is_all_filler_and_beatable(self) -> None:
        self.assertTrue(all(item.name == "Mystery Reward" for item in self.multiworld.itempool))
        state = self.multiworld.get_all_state()
        self.assertTrue(self.multiworld.completion_condition[self.player](state))
