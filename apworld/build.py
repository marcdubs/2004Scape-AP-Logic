#!/usr/bin/env python3
"""Packages rs2004scape/ as rs2004scape.apworld.

Mirrors what Archipelago's "Build APWorlds" launcher component does: copies the
world folder into the zip and injects the APContainer packaging-scheme fields
("version"/"compatible_version", worlds/Files.py container_version = 7 as of AP
0.6.8) into the zipped copy of archipelago.json. The source archipelago.json
stays clean - the apworld spec says those two fields belong to the packager,
not the world folder.

Usage: python3 build.py  (from this directory; writes ./rs2004scape.apworld)
"""

import json
import os
import zipfile

CONTAINER_VERSION = 7
WORLD = "rs2004scape"


def main() -> None:
    out = f"{WORLD}.apworld"
    if os.path.exists(out):
        os.remove(out)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(WORLD):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for f in files:
                p = os.path.join(root, f)
                if f == "archipelago.json" and root == WORLD:
                    manifest = json.load(open(p))
                    manifest["version"] = CONTAINER_VERSION
                    manifest["compatible_version"] = CONTAINER_VERSION
                    z.writestr(p, json.dumps(manifest))
                else:
                    z.write(p, p)

    print(f"wrote {out} ({os.path.getsize(out)} bytes, container v{CONTAINER_VERSION})")


if __name__ == "__main__":
    main()
