# 2004Scape apworld

The Archipelago generation-side package for 2004scape. Full design:
[../docs/archipelago-integration.md](../docs/archipelago-integration.md).

## Layout

- `rs2004scape/__init__.py` - the `World` subclass (locations, items, rules,
  slot_data) plus the `WebWorld` (webhost docs/tutorial wiring, item and
  location name groups).
- `rs2004scape/options.py` - YAML options (`goal`, `music_checks`).
- `rs2004scape/docs/` - webhost pages in AP's standard format: `en_2004Scape.md`
  (game info) and `setup_en.md` (setup tutorial, referenced by the `WebWorld`).
- `rs2004scape/test/` - unit tests on AP's world test framework: datapackage
  invariants, per-goal fill/reachability, and quest-gate item logic.
- `rs2004scape/data/rs2004_data.json` - GENERATED datapackage (ids, catalogs,
  quest requirements). Regenerate with
  `cd ../Server/engine && npx tsx tools/ap/ExportApWorldData.ts`, then copy the
  output here AND to `overlays/engine/data/config/ap-archipelago-data.json`
  (the engine client reads the same file). Ids are append-only - never
  hand-edit.

## Running the tests

The tests use Archipelago's world test framework, so they run from inside an
Archipelago source checkout:

```
cp -r rs2004scape /path/to/Archipelago/worlds/
cd /path/to/Archipelago && python -m pytest worlds/rs2004scape/test -q
rm -rf /path/to/Archipelago/worlds/rs2004scape   # clean up when done
```

If that checkout also has `custom_worlds/rs2004scape.apworld` installed, move
it aside first - two copies of the same game name fail world loading.

## Packaging

```
cd apworld && python3 build.py
```

`build.py` zips the folder AND injects the APContainer packaging fields
(`version`/`compatible_version` = 7) into the zipped `archipelago.json` - a
plain `zip -r` produces an apworld that AP 0.6.8 warns about and 0.7.0 will
refuse. Drop `rs2004scape.apworld` into an Archipelago installation's
`custom_worlds/` folder. Example player YAML:

```yaml
name: Marcus
game: 2004Scape
2004Scape:
  goal: dragon_slayer
  music_checks: false
```

Full YAML option reference (including the standard AP options and item/location
name lists): [../docs/ap-yaml-options.md](../docs/ap-yaml-options.md).

## Game-server side

`data/config/ap-archipelago.json` in Server/engine:

```json
{ "enabled": true, "host": "archipelago.gg", "port": 38281, "slot": "Marcus", "password": null }
```

Start from a fresh run state (zeroed ap-unlocks.json, cleared fired/tracker
ledgers, validated entrance table) - the AP server owns all placements; the
local GenerateSeed fill must NOT be active (ap-placements.json is written by
the client with quest gates only).

## Local test server (set up 2026-07-19, lives in WSL at ~/Archipelago)

A source checkout of Archipelago 0.6.8 (main @ depth-1) with a venv:

```
cd ~/Archipelago
./venv/bin/python Generate.py --player_files_path Players --outputpath output [--seed N] [--spoiler 2]
# unzip the .archipelago out of output/AP_<id>.zip, then:
./venv/bin/python MultiServer.py --host 0.0.0.0 --port 38281 output/AP_<id>.archipelago
```

- `Players/Marcus.yaml` holds the test slot; `custom_worlds/rs2004scape.apworld`
  is the packaged world (re-copy after `build.py` when the world changes).
- Server state persists in `output/AP_<id>.apsave` next to the multidata -
  delete it to reset a run.
- The Windows game server reaches it as `localhost:38281` (WSL2 localhost
  forwarding); WSL-side tests use `127.0.0.1:38281`.
