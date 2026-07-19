# Test base for the 2004Scape world. Runs under Archipelago's world test
# framework - copy (or symlink) rs2004scape/ into an Archipelago checkout's
# worlds/ folder and run:  python -m pytest worlds/rs2004scape/test
# (see apworld/README.md; remove any rs2004scape.apworld from custom_worlds
# first or the duplicate game name will fail world loading).
from test.bases import WorldTestBase


class RS2004TestBase(WorldTestBase):
    game = "2004Scape"
