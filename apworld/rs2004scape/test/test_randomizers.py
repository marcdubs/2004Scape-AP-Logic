# The apworld rolls gathering, processing, shopsanity and spawn itself, so its fill can
# reason about the world the player will actually get. That only works if the rolls are
# IDENTICAL to what the TypeScript tools produce server-side from the same seed - the
# apworld ships the seed, not (for shopsanity, cannot ship) the table.
#
# Two layers of pinning, both against vectors captured from the real TS implementations:
#
#   prng_vectors.json  - raw mulberry32 / shuffle / derangement output. If prng.py drifts
#                        from tools/shared/Prng.ts, every table below silently diverges.
#   roll_vectors.json  - the actual ap-gather.json / ap-process.json / ap-spawn.json /
#                        shop-seed.json the tools wrote for seed 424242.
#
# Regenerate both from a live engine checkout with scripts/parity-check.py --write-fixture
# (see its --rolls section) whenever a pool or a tool's shuffle changes.

import collections
import json
import pkgutil
import unittest

from ..logic import load_bundle
from ..prng import derangement, mulberry32, shuffle
from ..randomizers import (relocate_buy_sources, relocate_drop_sources, roll_all, roll_drops,
                           roll_shops, roll_skill_swaps, roll_spawn)

_PKG = __package__.rsplit(".", 1)[0]
PRNG_VECTORS = json.loads(pkgutil.get_data(__package__, "data/prng_vectors.json").decode("utf-8"))
ROLLS = json.loads(pkgutil.get_data(__package__, "data/roll_vectors.json").decode("utf-8"))
DROPS = json.loads(pkgutil.get_data(__package__, "data/drop_vectors.json").decode("utf-8"))
BUNDLE = load_bundle(_PKG)
POOLS = BUNDLE["randomizerPools"]


class TestPrngPort(unittest.TestCase):
    """prng.py must be byte-exact with tools/shared/Prng.ts."""

    def test_mulberry32_streams(self) -> None:
        for key, expected in PRNG_VECTORS.items():
            if not key.startswith("rand_"):
                continue
            seed = int(key.split("_", 1)[1])
            with self.subTest(seed=seed):
                rand = mulberry32(seed)
                self.assertEqual([rand() for _ in expected], expected)

    def test_derangements(self) -> None:
        for key, expected in PRNG_VECTORS.items():
            if not key.startswith("der_"):
                continue
            _, seed, n = key.split("_")
            with self.subTest(seed=seed, n=n):
                self.assertEqual(derangement(int(n), mulberry32(int(seed))), expected)
                # a derangement moves everything, by definition
                self.assertTrue(all(v != i for i, v in enumerate(expected)))

    def test_shuffle(self) -> None:
        self.assertEqual(shuffle(list(range(7)), mulberry32(9)), PRNG_VECTORS["shuf_9_7"])


class TestRollsMatchTheGameServer(unittest.TestCase):
    """The rolled tables must equal what the TS tools write for the same seed."""

    def test_gathering_table(self) -> None:
        roll = roll_skill_swaps(POOLS["gather"], ROLLS["seed"], ROLLS["gather"]["mode"])
        self.assertEqual(roll.table, ROLLS["gather"]["table"])

    def test_processing_table(self) -> None:
        roll = roll_skill_swaps(POOLS["process"], ROLLS["seed"], ROLLS["process"]["mode"])
        self.assertEqual(roll.table, ROLLS["process"]["table"])

    def test_spawn_pick(self) -> None:
        roll = roll_spawn(POOLS["spawn"], ROLLS["seed"], ROLLS["spawn"]["mode"])
        self.assertEqual(roll.coord, ROLLS["spawn"]["home"])
        self.assertNotEqual(roll.region, 0)

    def test_shop_ownership(self) -> None:
        """The TS spoiler says what each shopkeeper stocks after the shuffle."""
        roll = roll_shops(POOLS["shops"], ROLLS["seed"], True)
        for entry in ROLLS["shops"]:
            with self.subTest(npc=entry["npc"]):
                self.assertEqual(roll.stocks_now.get(entry["npc"]), entry["now"])


class TestDropRollsMatchTheGameServer(unittest.TestCase):
    """Drop randomization moves items between monsters - i.e. between REGIONS - so the
    fill has to know the rolled tables too. All three modes are pinned."""

    POOL = BUNDLE["randomizerPools"]["drops"]

    def test_mimic_map(self) -> None:
        """Mimic points each death handler at another monster's whole loot table."""
        roll = roll_drops(self.POOL, DROPS["seed"], "mimic")
        handler = {s["index"]: s["handler"] for s in self.POOL["mimic"]["slots"]}
        unit_key = {u["index"]: u["key"] for u in self.POOL["mimic"]["units"]}
        rolled = [{"handler": handler[i], "nowUnit": unit_key[u]} for i, u in sorted(roll.mimic_map.items())]
        self.assertEqual(rolled, DROPS["mimic"])

    def test_death_drops(self) -> None:
        roll = roll_drops(self.POOL, DROPS["seed"], "tiered")
        for entry in DROPS["deathDrops"]:
            with self.subTest(npc=entry["npc"]):
                self.assertEqual(roll.death_drops.get(entry["npc"]), entry["now"])

    def test_tiered_and_chaos_slot_items(self) -> None:
        """The captured spoiler is a verified subset (see the fixture's _comment), so
        every entry it does carry must appear in the rolled mapping."""
        slots = self.POOL["slots"]
        for mode in ("tiered", "chaos"):
            with self.subTest(mode=mode):
                roll = roll_drops(self.POOL, DROPS["seed"], mode)
                rolled = collections.Counter(
                    (slots[ref]["npc"], slots[ref]["item"], item) for ref, item in roll.new_item.items())
                expected = collections.Counter(
                    (e["npc"], e["was"], e["now"]) for e in DROPS[mode])
                self.assertFalse(expected - rolled, "spoiler entries missing from the rolled mapping")
                self.assertGreater(len(roll.new_item), len(DROPS[mode]))

    def test_quest_critical_slots_stay_vanilla(self) -> None:
        """A quest-critical item is never reassigned AWAY from its own slot."""
        slots = self.POOL["slots"]
        critical = set(self.POOL["questCritical"])
        self.assertTrue(critical)
        for mode in ("tiered", "chaos"):
            with self.subTest(mode=mode):
                roll = roll_drops(self.POOL, DROPS["seed"], mode)
                for ref in roll.new_item:
                    self.assertNotIn(slots[ref]["item"], critical)

    def test_off_is_the_identity(self) -> None:
        roll = roll_drops(self.POOL, DROPS["seed"], "off")
        self.assertFalse(roll.enabled)
        relocated = relocate_drop_sources(BUNDLE["itemSources"], self.POOL, roll)
        for item, sources in BUNDLE["itemSources"].items():
            with self.subTest(item=item):
                self.assertEqual(sorted(map(repr, relocated.get(item, []))), sorted(map(repr, sources)))

    def test_rolled_drops_move_regions(self) -> None:
        for mode in ("tiered", "chaos", "mimic"):
            with self.subTest(mode=mode):
                roll = roll_drops(self.POOL, 4242, mode)
                self.assertTrue(roll.enabled)
                relocated = relocate_drop_sources(BUNDLE["itemSources"], self.POOL, roll)
                moved = 0
                for item, sources in BUNDLE["itemSources"].items():
                    before = {s["region"] for s in sources if s.get("via") == "drop"}
                    after = {s["region"] for s in relocated.get(item, []) if s.get("via") == "drop"}
                    if before != after:
                        moved += 1
                self.assertGreater(moved, 0)

    def test_unexplained_drop_regions_survive(self) -> None:
        """drop-sources.json is broader than the slot corpus (bespoke handlers, gives).
        A region the corpus cannot account for must never be taken away."""
        roll = roll_drops(self.POOL, 4242, "mimic")
        npc_regions = self.POOL["npcRegions"]
        relocated = relocate_drop_sources(BUNDLE["itemSources"], self.POOL, roll)
        checked = 0
        for item, sources in BUNDLE["itemSources"].items():
            vanilla = {s["region"] for s in sources if s.get("via") == "drop"}
            explained = {npc_regions[n] for n in roll.drops_was.get(item, ()) if n in npc_regions}
            unexplained = vanilla - explained
            if not unexplained:
                continue
            checked += 1
            after = {s["region"] for s in relocated.get(item, []) if s.get("via") == "drop"}
            self.assertTrue(unexplained <= after, item)
        self.assertGreater(checked, 0)

    def test_relocation_never_touches_non_drop_sources(self) -> None:
        """Gather/process/buy sources are other randomizers' business."""
        roll = roll_drops(self.POOL, 4242, "chaos")
        relocated = relocate_drop_sources(BUNDLE["itemSources"], self.POOL, roll)
        for item, sources in BUNDLE["itemSources"].items():
            before = [s for s in sources if s.get("via") != "drop"]
            after = [s for s in relocated.get(item, []) if s.get("via") != "drop"]
            with self.subTest(item=item):
                self.assertEqual(sorted(map(repr, before)), sorted(map(repr, after)))


class TestRollSemantics(unittest.TestCase):
    def test_shuffle_mode_keeps_everything_obtainable(self) -> None:
        """A bijection: every product is still delivered by exactly one action."""
        roll = roll_skill_swaps(POOLS["gather"], 99, "shuffle")
        self.assertEqual(sorted(roll.swaps), sorted(roll.swaps.values()))
        self.assertTrue(all(was != now for was, now in roll.swaps.items()))

    def test_chaos_mode_pins_quest_critical_products(self) -> None:
        """Chaos can orphan a product, so quest-critical ones stay vanilla."""
        chaos = roll_skill_swaps(POOLS["gather"], 99, "chaos")
        quest_critical = set(POOLS["gather"]["questCritical"])
        self.assertTrue(quest_critical)
        self.assertTrue(quest_critical.isdisjoint(chaos.swaps))
        # ...and shuffle mode does not need that protection
        self.assertFalse(quest_critical.isdisjoint(roll_skill_swaps(POOLS["gather"], 99, "shuffle").swaps))

    def test_off_rolls_nothing(self) -> None:
        for mode in ("off", "", None):
            self.assertEqual(roll_skill_swaps(POOLS["gather"], 99, mode).swaps, {})

    def test_buy_relocation_is_identity_when_shops_are_off(self) -> None:
        """The shopsanity-off path skips relocation; prove that is the same answer."""
        identity = roll_shops(POOLS["shops"], 99, False)
        relocated = relocate_buy_sources(BUNDLE["itemSources"], POOLS["shops"], identity)
        for item, sources in BUNDLE["itemSources"].items():
            with self.subTest(item=item):
                self.assertEqual(sorted(map(repr, relocated.get(item, []))), sorted(map(repr, sources)))

    def test_shopsanity_actually_moves_buy_regions(self) -> None:
        rolled = roll_shops(POOLS["shops"], 4242, True)
        relocated = relocate_buy_sources(BUNDLE["itemSources"], POOLS["shops"], rolled)
        moved = 0
        for item, sources in BUNDLE["itemSources"].items():
            before = {s["region"] for s in sources if s.get("via") == "buy"}
            after = {s["region"] for s in relocated.get(item, []) if s.get("via") == "buy"}
            if before != after:
                moved += 1
        self.assertGreater(moved, 0, "shopsanity should relocate at least some buy sources")

    def test_roll_all_is_deterministic(self) -> None:
        kwargs = dict(gathering="shuffle", processing="chaos", shops=True, spawn="city")
        first = roll_all(BUNDLE, 31337, **kwargs)
        second = roll_all(BUNDLE, 31337, **kwargs)
        self.assertEqual(first.item_swaps(), second.item_swaps())
        self.assertEqual(first.spawn.coord, second.spawn.coord)
        self.assertEqual(first.shops.stocks_now, second.shops.stocks_now)
