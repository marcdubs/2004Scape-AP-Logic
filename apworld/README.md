# 2004Scape apworld

The Archipelago generation-side package for 2004scape. Full design:
[../docs/archipelago-integration.md](../docs/archipelago-integration.md).

## Layout

- `rs2004scape/__init__.py` - the `World` subclass (locations, items, rules,
  slot_data).
- `rs2004scape/options.py` - YAML options (`goal`, `music_checks`).
- `rs2004scape/data/rs2004_data.json` - GENERATED datapackage (ids, catalogs,
  quest requirements). Regenerate with
  `cd ../Server/engine && npx tsx tools/ap/ExportApWorldData.ts`, then copy the
  output here AND to `overlays/engine/data/config/ap-archipelago-data.json`
  (the engine client reads the same file). Ids are append-only - never
  hand-edit.

## Packaging

```
cd apworld && zip -r rs2004scape.apworld rs2004scape
```

Drop `rs2004scape.apworld` into an Archipelago installation's `custom_worlds/`
folder. Example player YAML:

```yaml
name: Marcus
game: 2004Scape
2004Scape:
  goal: dragon_slayer
  music_checks: false
```

## Game-server side

`data/config/ap-archipelago.json` in Server/engine:

```json
{ "enabled": true, "host": "archipelago.gg", "port": 38281, "slot": "Marcus", "password": null }
```

Start from a fresh run state (zeroed ap-unlocks.json, cleared fired/tracker
ledgers, validated entrance table) - the AP server owns all placements; the
local GenerateSeed fill must NOT be active (ap-placements.json is written by
the client with quest gates only).
