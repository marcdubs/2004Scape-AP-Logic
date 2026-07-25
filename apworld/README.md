# 2004Scape apworld

The Archipelago generation-side package for 2004scape. Full design:
[../docs/archipelago-integration.md](../docs/archipelago-integration.md).

## Layout

- `rs2004scape/__init__.py` - the `World` subclass (locations, items, rules,
  slot_data) plus the `WebWorld` (webhost docs/tutorial wiring, item and
  location name groups).
- `rs2004scape/options.py` - YAML options (`goal`, `region_logic`,
  `entrance_randomization`, `music_checks`, ...).
- `rs2004scape/logic.py` - the region/gate/quest/item fixpoint, a faithful port
  of `tools/logic/ValidateSeed.ts`. Imports nothing from Archipelago, so it also
  runs standalone (that is how `scripts/parity-check.py` drives it).
- `rs2004scape/entrances.py` - construct-valid entrance randomization: a
  reachability-preserving frontier over the exported entrance pool. AP cannot
  reroll, so the layout is sound by construction; the finished table ships to
  the game server in `slot_data.entranceOverrides`.
- `rs2004scape/randomizers.py` + `prng.py` - the other four randomizers
  (gathering, processing, shopsanity, spawn), rolled during generation so the
  fill knows what each action yields, where each shop moved and where you
  start. They ship as one shared **seed**, which the server's deterministic
  tools replay into identical tables; `prng.py` is a byte-exact port of
  `tools/shared/Prng.ts`, pinned by test vectors.
- `rs2004scape/docs/` - webhost pages in AP's standard format: `en_2004Scape.md`
  (game info) and `setup_en.md` (setup tutorial, referenced by the `WebWorld`).
- `rs2004scape/test/` - unit tests on AP's world test framework: datapackage
  invariants, per-goal fill/reachability, quest-gate item logic, and
  `test_parity.py` (the frozen ValidateSeed.ts cross-check).
- `rs2004scape/data/rs2004_data.json` - GENERATED datapackage (ids, catalogs,
  quest requirements). Regenerate with
  `cd ../Server/engine && npx tsx tools/ap/ExportApWorldData.ts`, then copy the
  output here AND to `overlays/engine/data/config/ap-archipelago-data.json`
  (the engine client reads the same file). Ids are append-only - never
  hand-edit.
- `rs2004scape/data/rs2004_logic.json` - GENERATED logic bundle (regions,
  gated areas, entrance pool, item graph, varp model). Regenerate with
  `cd ../Server/engine && npx tsx tools/ap/ExportLogicBundle.ts --copy <here>`,
  then refresh the parity fixture:
  `python3 scripts/parity-check.py --write-fixture`.

## Two randomizers, one logic

Local/solo seeds are made by generate-and-test (`RandomizeEntrances.ts` +
`ValidateSeed.ts`'s reroll loop, `--require-perfect`) and that stays exactly as
it is. Archipelago's fill runs once and cannot reroll, so AP mode is
construct-valid instead. Both read the same exported bundle, and
`scripts/parity-check.py` + `test_parity.py` fail if the two implementations
ever disagree. See [../docs/archipelago-integration.md](../docs/archipelago-integration.md).

## Running the tests

The tests use Archipelago's world test framework, so they run from inside an
Archipelago source checkout:

```
cp -r rs2004scape /path/to/Archipelago/worlds/
cd /path/to/Archipelago && python -m pytest worlds/rs2004scape/test -q
rm -rf /path/to/Archipelago/worlds/rs2004scape   # clean up when done
```

If that checkout also has `custom_worlds/rs2004scape.apworld` installed, move
it aside first - two copies of the same game name fail world loading. Use the
checkout's own interpreter (`./venv/bin/python`) if the system one is missing
AP's dependencies (`schema`, `jinja2`, ...).

The TS-vs-Python cross-check runs from THIS repo instead, against a live engine
checkout (it shells `ValidateSeed.ts`):

```
python3 scripts/parity-check.py                  # ../Server/engine by default
python3 scripts/parity-check.py --write-fixture  # refresh the frozen fixture too
```

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
  region_logic: true          # default; AP owns entrance layout + spatial logic
  entrance_randomization: on  # off | on | mixed
```

Full YAML option reference (including the standard AP options and item/location
name lists): [../docs/ap-yaml-options.md](../docs/ap-yaml-options.md).

## Game-server side

`data/config/ap-archipelago.json` in Server/engine:

```json
{ "enabled": true, "host": "archipelago.gg", "port": 38281, "slot": "Marcus", "password": null }
```

Start from a fresh run state (zeroed ap-unlocks.json, cleared fired/tracker
ledgers) - the AP server owns all placements; the local GenerateSeed fill must
NOT be active (ap-placements.json is written by the client with quest gates
only).

With `region_logic: true` the entrance table comes from Archipelago: the client
writes `slot_data.entranceOverrides` into `data/config/ap-entrances.json` on
connect and hot-reloads it, and `seedOptions.entrances` arrives as `"off"` so
the next `scripts/new-run` leaves that map alone. With `region_logic: false`
the old contract applies instead - roll the table locally and make sure it
validates green (`RandomizeEntrances --require-perfect`).

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
