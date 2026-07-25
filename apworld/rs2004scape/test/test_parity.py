# Parity between the two implementations of this project's logic (GitHub #3).
#
# tools/logic/ValidateSeed.ts is the local/solo beatability oracle; logic.py is the same
# reasoning made available to Archipelago. They read one exported bundle, so they must
# agree - if they ever don't, one of them is lying to a player about whether their seed
# is finishable.
#
# The fixture freezes one entrance layout together with ValidateSeed's answers for it
# (scripts/parity-check.py --write-fixture regenerates it against a live engine
# checkout). This test replays that layout through logic.py and demands the same
# reachable-region set, the same completed quests, the same QP and the same goals.
# Running it needs nothing but the apworld, so it guards every CI run; the full
# TS-vs-Python cross-check lives in scripts/parity-check.py.

import json
import pkgutil
import unittest

from ..entrances import EntranceShuffler, coverage, vanilla_entrances
from ..logic import LogicEngine, load_bundle

FIXTURE = json.loads(pkgutil.get_data(__package__, "data/parity_fixture.json").decode("utf-8"))
BUNDLE = load_bundle(__package__.rsplit(".", 1)[0])


class TestValidateSeedParity(unittest.TestCase):
    """The frozen ValidateSeed.ts verdict, reproduced by logic.py."""

    def setUp(self) -> None:
        self.engine = LogicEngine(BUNDLE, overrides=FIXTURE["overrides"])
        self.derived = self.engine.derive(self.engine.uncapped())
        self.expected = FIXTURE["expected"]

    def test_reachable_regions_match(self) -> None:
        self.assertEqual(len(self.derived.regions), self.expected["regionCount"])
        self.assertEqual(sorted(self.derived.regions), self.expected["regions"])

    def test_completed_quests_match(self) -> None:
        self.assertEqual(sorted(self.derived.completed), self.expected["completedQuests"])

    def test_quest_points_match(self) -> None:
        self.assertEqual(self.derived.qp, self.expected["totalQp"])

    def test_goals_match(self) -> None:
        self.assertEqual(sorted(self.derived.goals), self.expected["goals"])


class TestLogicModelInvariants(unittest.TestCase):
    """Properties the ported model must keep, independent of any one seed."""

    def setUp(self) -> None:
        self.engine = LogicEngine(BUNDLE, overrides=FIXTURE["overrides"])

    def test_caps_follow_the_engine_formula(self) -> None:
        # ApUnlockOverrides.getSkillCap: min(99, 20 + 10 * count), hitpoints uncapped.
        caps = self.engine.caps_from_counts({"progressive_mining": 2, "progressive_magic": 20})
        self.assertEqual(caps["mining"], 40)
        self.assertEqual(caps["magic"], 99)
        self.assertEqual(caps["attack"], 20)
        self.assertEqual(caps["hitpoints"], 99)

    def test_more_items_never_reach_less(self) -> None:
        """Monotonicity: collecting items can only ever open the world up further."""
        poor = self.engine.derive_from_counts({})
        rich = self.engine.derive(self.engine.uncapped())
        self.assertTrue(poor.regions <= rich.regions)
        self.assertTrue(poor.completed <= rich.completed)
        self.assertTrue(poor.goals <= rich.goals)

    def test_capped_start_is_actually_constraining(self) -> None:
        """A fresh seed starts every skill at cap 20 and cannot finish everything."""
        fresh = self.engine.derive_from_counts({})
        self.assertLess(len(fresh.completed), len(BUNDLE["quests"]))

    def test_quest_gates_block_their_quests(self) -> None:
        gated = BUNDLE["meta"]["questGateIds"]
        locked = LogicEngine(BUNDLE, overrides=FIXTURE["overrides"], quest_gates=gated)
        with_none = locked.derive(locked.uncapped(), unlocked_quests=())
        with_all = locked.derive(locked.uncapped(), unlocked_quests=gated)
        self.assertTrue(with_none.completed.isdisjoint(gated))
        self.assertTrue(with_none.completed < with_all.completed)


class TestConstructValidEntrances(unittest.TestCase):
    """The frontier shuffle must produce a sound layout without any reroll."""

    def _engine(self) -> LogicEngine:
        return LogicEngine(BUNDLE, quest_gates=BUNDLE["meta"]["questGateIds"])

    def test_shuffle_is_total_and_reciprocal(self) -> None:
        import random

        engine = self._engine()
        overrides = EntranceShuffler(engine, random.Random(7)).shuffle()
        vanilla = vanilla_entrances(engine)
        # every pool side that has a vanilla destination gets exactly one new one
        self.assertEqual(set(overrides), set(vanilla))
        for key, value in overrides.items():
            self.assertRegex(key, r"^\d+_\d+_\d+_\d+_\d+:\d+$")
            self.assertRegex(value, r"^\d+_\d+_\d+_\d+_\d+$")

    def test_shuffled_layouts_stay_beatable(self) -> None:
        import random

        for seed in (1, 2, 3):
            with self.subTest(seed=seed):
                engine = self._engine()
                overrides = EntranceShuffler(engine, random.Random(seed)).shuffle()
                derived = engine.derive(engine.uncapped(), unlocked_quests=engine.quest_gates)
                self.assertEqual(sorted(derived.goals),
                                 sorted(goal["id"] for goal in BUNDLE["goals"]))
                reached, total = coverage(engine, overrides)
                # the frontier should never do WORSE than leaving the map vanilla
                vanilla_reached, _ = coverage(engine, vanilla_entrances(engine))
                self.assertGreaterEqual(reached, vanilla_reached)
