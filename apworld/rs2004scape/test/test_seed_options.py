# Seed randomizer options + infinite run: pure slot_data plumbing (the game
# server adopts seedOptions at its next seed roll; infiniteRun applies live).
#
# Entrances are the exception: with region_logic on (the default) THIS WORLD builds
# the layout and ships it as `entranceOverrides`, so `seedOptions.entrances` is pinned
# to "off" - re-rolling entrances server-side would invalidate the rules the fill just
# used. See __init__.fill_slot_data.
from . import RS2004TestBase


class TestSeedOptionsDefaults(RS2004TestBase):
    def test_defaults(self) -> None:
        slot_data = self.world.fill_slot_data()
        self.assertFalse(slot_data["infiniteRun"])
        self.assertTrue(slot_data["progressiveXpRate"])
        # percentage, live server-side knob - 100 would be vanilla 2004 rates
        self.assertEqual(slot_data["gatherSpeed"], 200)
        # likewise: mined-rock respawn as a percentage, 300 = a third of the wait
        self.assertEqual(slot_data["rockRespawnSpeed"], 300)
        seed_options = slot_data["seedOptions"]
        # the shared seed is rolled per generation, so only its shape is fixed here -
        # test_ships_its_own_seed below is what pins its meaning
        self.assertIsInstance(seed_options.pop("seed"), int)
        self.assertEqual(seed_options, {
            "entrances": "off",
            "npcDrip": True,
            "shops": True,
            "teleports": True,
            "drops": "mimic",
            "gathering": "shuffle",
            "processing": "shuffle",
            "spawn": "city",
        })

    def test_ships_its_own_seed(self) -> None:
        """The seed the world rolled its gathering/processing/shop/spawn tables from.

        The game server re-rolls those tools from this exact number, so the world the
        fill reasoned about is the world the player gets.
        """
        seed = self.world.fill_slot_data()["seedOptions"]["seed"]
        self.assertEqual(seed, self.world.run_seed)
        self.assertTrue(0 <= seed < 2 ** 32)
        # and the rolls the world is actually using came from it
        from ..randomizers import roll_all
        replay = roll_all(
            self.world.engine.bundle, seed,
            gathering=self.world.options.gathering_randomization.current_key,
            processing=self.world.options.processing_randomization.current_key,
            shops=bool(self.world.options.shop_randomization),
            spawn=self.world.options.spawn_randomization.current_key,
        )
        self.assertEqual(replay.item_swaps(), self.world.roll.item_swaps())
        self.assertEqual(replay.spawn.coord, self.world.roll.spawn.coord)

    def test_ships_its_own_entrance_table(self) -> None:
        slot_data = self.world.fill_slot_data()
        self.assertTrue(slot_data["regionLogic"])
        overrides = slot_data["entranceOverrides"]
        self.assertGreater(len(overrides), 700)
        # every key is "<raw coord>:<op>" and every value a raw coord
        for key, value in overrides.items():
            coord, _, op = key.partition(":")
            self.assertEqual(len(coord.split("_")), 5)
            self.assertTrue(op.isdigit())
            self.assertEqual(len(value.split("_")), 5)


class TestSeedOptionsNoRegionLogic(RS2004TestBase):
    options = {"region_logic": False, "entrance_randomization": "mixed"}

    def test_server_keeps_rolling_entrances(self) -> None:
        slot_data = self.world.fill_slot_data()
        self.assertFalse(slot_data["regionLogic"])
        self.assertEqual(slot_data["seedOptions"]["entrances"], "mixed")
        self.assertEqual(slot_data["entranceOverrides"], {})


class TestSeedOptionsCustom(RS2004TestBase):
    options = {
        "entrance_randomization": "mixed",
        "npc_drip": False,
        "teleport_randomization": False,
        "drop_randomization": "off",
        "gathering_randomization": "chaos",
        "spawn_randomization": "chunk",
        "infinite_run": True,
        "progressive_xp_rate": False,
        "gather_speed": 500,
        "rock_respawn_speed": 100,
    }

    def test_custom_values(self) -> None:
        slot_data = self.world.fill_slot_data()
        self.assertTrue(slot_data["infiniteRun"])
        self.assertFalse(slot_data["progressiveXpRate"])
        self.assertEqual(slot_data["gatherSpeed"], 500)
        self.assertEqual(slot_data["rockRespawnSpeed"], 100)  # opted back to vanilla timers
        seed = slot_data["seedOptions"]
        self.assertEqual(seed["entrances"], "off")  # region_logic ships the table itself
        self.assertFalse(seed["npcDrip"])
        self.assertFalse(seed["teleports"])
        self.assertEqual(seed["drops"], "off")
        self.assertEqual(seed["gathering"], "chaos")
        self.assertEqual(seed["processing"], "shuffle")
        self.assertEqual(seed["spawn"], "chunk")
