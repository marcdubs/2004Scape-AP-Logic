# Filler mix: the pool is padded with NAMED filler items (Mystery Reward + the
# four resource packs) whose relative frequency the `filler_weights` option sets.
# The COUNT stays derived (locations - progression items); only the mix is
# configurable, which is what a multiworld can actually act on.
import collections

from BaseClasses import ItemClassification

from . import RS2004TestBase
from .. import FILLER_NAMES
from ..options import DEFAULT_FILLER_WEIGHTS, FILLER_ITEM_BY_WEIGHT_KEY


class TestDefaultFillerMix(RS2004TestBase):
    options = {"goal": "legends"}

    def test_every_filler_kind_appears(self) -> None:
        """Default weights are all non-zero, and there are ~115 filler slots at
        default options, so every kind should show up. If this ever fails on a
        seed, the filler count collapsed - that is the interesting failure, not
        the sampling."""
        counts = collections.Counter(
            item.name for item in self.multiworld.itempool if item.name in FILLER_NAMES
        )
        self.assertGreater(sum(counts.values()), 20, "expected a meaningful number of filler slots")
        for name in FILLER_ITEM_BY_WEIGHT_KEY.values():
            self.assertIn(name, counts, f"{name} never rolled out of {sum(counts.values())} filler slots")

    def test_filler_is_classified_filler(self) -> None:
        # ItemClassification.filler is the zero flag, so this has to be an
        # equality check - `classification.filler` is falsy for every item.
        for item in self.multiworld.itempool:
            if item.name in FILLER_NAMES:
                self.assertEqual(item.classification, ItemClassification.filler, item.name)

    def test_mystery_reward_is_the_plurality(self) -> None:
        """mystery_reward carries 40 of the 90 default weight, so it should be the
        most common filler by a clear margin - a guard against a future default
        edit quietly turning the pool into all ore packs."""
        counts = collections.Counter(
            item.name for item in self.multiworld.itempool if item.name in FILLER_NAMES
        )
        self.assertEqual(counts.most_common(1)[0][0], "Mystery Reward")


class TestFillerWeightsHonored(RS2004TestBase):
    # Only ore packs allowed: every filler slot must be an Ore Pack.
    options = {
        "goal": "legends",
        "filler_weights": {"mystery_reward": 0, "ore_pack": 1, "bar_pack": 0,
                           "herb_pack": 0, "rune_pack": 0},
    }

    def test_only_ore_packs(self) -> None:
        filler = [item.name for item in self.multiworld.itempool if item.name in FILLER_NAMES]
        self.assertTrue(filler, "no filler in the pool to check")
        self.assertEqual(set(filler), {"Ore Pack"})


class TestFillerWeightsAllZero(RS2004TestBase):
    # Degenerate config: the pool still has to be paddable, so an all-zero dict
    # falls back to the defaults rather than failing generation.
    options = {
        "goal": "legends",
        "filler_weights": {key: 0 for key in DEFAULT_FILLER_WEIGHTS},
    }

    def test_falls_back_to_defaults(self) -> None:
        filler = {item.name for item in self.multiworld.itempool if item.name in FILLER_NAMES}
        self.assertTrue(filler)
        self.assertTrue(filler <= set(FILLER_ITEM_BY_WEIGHT_KEY.values()))
