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
        self.assertEqual(slot_data["seedOptions"], {
            "entrances": "off",
            "npcDrip": True,
            "shops": True,
            "teleports": True,
            "drops": "mimic",
            "gathering": "shuffle",
            "processing": "shuffle",
            "spawn": "city",
        })

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
    }

    def test_custom_values(self) -> None:
        slot_data = self.world.fill_slot_data()
        self.assertTrue(slot_data["infiniteRun"])
        self.assertFalse(slot_data["progressiveXpRate"])
        seed = slot_data["seedOptions"]
        self.assertEqual(seed["entrances"], "off")  # region_logic ships the table itself
        self.assertFalse(seed["npcDrip"])
        self.assertFalse(seed["teleports"])
        self.assertEqual(seed["drops"], "off")
        self.assertEqual(seed["gathering"], "chaos")
        self.assertEqual(seed["processing"], "shuffle")
        self.assertEqual(seed["spawn"], "chunk")
