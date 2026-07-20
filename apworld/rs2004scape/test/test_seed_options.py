# Seed randomizer options + infinite run: pure slot_data plumbing (the game
# server adopts seedOptions at its next seed roll; infiniteRun applies live).
from . import RS2004TestBase


class TestSeedOptionsDefaults(RS2004TestBase):
    def test_defaults(self) -> None:
        slot_data = self.world.fill_slot_data()
        self.assertFalse(slot_data["infiniteRun"])
        self.assertEqual(slot_data["seedOptions"], {
            "entrances": "on",
            "npcDrip": True,
            "shops": True,
            "teleports": True,
            "drops": "mimic",
            "gathering": "shuffle",
            "processing": "shuffle",
            "spawn": "city",
        })


class TestSeedOptionsCustom(RS2004TestBase):
    options = {
        "entrance_randomization": "mixed",
        "npc_drip": False,
        "teleport_randomization": False,
        "drop_randomization": "off",
        "gathering_randomization": "chaos",
        "spawn_randomization": "chunk",
        "infinite_run": True,
    }

    def test_custom_values(self) -> None:
        slot_data = self.world.fill_slot_data()
        self.assertTrue(slot_data["infiniteRun"])
        seed = slot_data["seedOptions"]
        self.assertEqual(seed["entrances"], "mixed")
        self.assertFalse(seed["npcDrip"])
        self.assertFalse(seed["teleports"])
        self.assertEqual(seed["drops"], "off")
        self.assertEqual(seed["gathering"], "chaos")
        self.assertEqual(seed["processing"], "shuffle")
        self.assertEqual(seed["spawn"], "chunk")
