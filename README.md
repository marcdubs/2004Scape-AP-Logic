# 2004Scape-AP-Logic

Archipelago randomizer logic and tooling for [2004scape](https://github.com/LostCityRS) (Server/Engine-TS/Content).

This repo does **not** fork LostCityRS. `Server`, `engine`, `content`, `webclient`, and
`javaclient` stay plain, unmodified LostCityRS checkouts (a sibling directory, set up
the normal way via `Server/start.sh`). Everything Archipelago-specific lives here
instead, and gets deployed on top via `scripts/install.js`.

## Layout

- `docs/` - design notes.
- `overlays/<target>/...` - files to be copied on top of the matching directory in the
  `Server` checkout. `overlays/engine/tools/map/ExportEntrances.ts` deploys to
  `Server/engine/tools/map/ExportEntrances.ts`, and so on. Directory name under
  `overlays/` must match the target folder name inside `Server/` (`engine`, `content`,
  `webclient`, `javaclient`, or `server` for the top-level repo itself).
- `scripts/install.js` - copies everything under `overlays/` into place.

## Usage

```
node scripts/install.js
```

Assumes `Server/` is a sibling directory (`../Server` relative to this repo). Override
with `node scripts/install.js --server-root /path/to/Server`.

## Adding something new

Drop the file under `overlays/<target>/<path it should land at>`, then re-run
`node scripts/install.js`. No manifest to update. This works for edits to *existing*
vanilla files too (e.g. `ClientCheatHandler.ts`) - just keep a full copy of the edited
file under the overlay and it replaces the vanilla one wholesale on install.

## Entrance randomization

`overlays/engine/tools/map/`:

- `EntranceParser.ts` - shared parser for `content/scripts/ladders+stairs/scripts/*.rs2`
  (ladder/stair oploc handlers). Not reused directly; imported by the two tools below.
- `ExportEntrances.ts` - dumps the parsed entrance edge list to
  `engine/tools/map/entrances.json`. Read-only, no content changes.
  ```
  cd Server/engine && npx tsx tools/map/ExportEntrances.ts
  ```
- `RandomizeEntrances.ts` - shuffles the `cross-map` entrances (real dungeon/area
  connectors - same-building floor shifts are left alone) and rewrites the destination
  coordinates directly in `content/scripts/ladders+stairs/scripts/*.rs2`.
  ```
  cd Server/engine && npx tsx tools/map/RandomizeEntrances.ts [--seed <number>] [--dry-run]
  ```
  Always regenerates from `content/.ap-backup/` (created automatically on first run, a
  straight copy of the untouched vanilla scripts), so re-running with a new seed never
  compounds onto a previous shuffle. Writes a spoiler log to
  `engine/tools/map/entrance-seed.json`.

Extras that don't have a fixed source/destination we can enumerate from script analysis
alone (generic `any`-source cellar ladders, `phoenixladder`) are left untouched and
listed in the spoiler's `excluded` array.
