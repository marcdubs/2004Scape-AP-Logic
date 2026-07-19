# Contributing

Thanks for your interest! This project is an Archipelago randomizer for
2004scape (LostCity rev 274). Before anything else, read the
[README](README.md) for the architecture and
[docs/lessons-learned.md](docs/lessons-learned.md) for the domain knowledge -
most "why is it done this way?" questions are answered there.

## Ground rules

- **Open an issue first** for anything beyond a small fix, so we can agree on
  the approach before you invest time.
- **PRs target `main`.** Keep them focused; one topic per PR.
- **Never commit only to `../Server`.** Overlay files live in THIS repo under
  `overlays/` and are deployed with `node scripts/install.js` - edits made
  directly in a LostCity checkout get overwritten.
- **Preserve line endings.** Some content files are CRLF and the parsers
  require byte-identical round-trips (`.gitattributes` disables normalization -
  leave it be).
- **IDs are append-only.** Never renumber anything in
  `apworld/rs2004scape/data/rs2004_data.json`; regenerate it with
  `ExportApWorldData.ts`, which preserves existing ids.

## Testing

- Engine typecheck: `cd ../Server/engine && npx tsc --noEmit -p .`
- apworld tests (from an [Archipelago](https://github.com/ArchipelagoMW/Archipelago)
  source checkout): see "Running the tests" in [apworld/README.md](apworld/README.md).
- Randomizer/parser changes: re-run the verification steps in
  docs/lessons-learned.md ("Testing & verification").

## Conduct

Be kind. This is a small hobby project about a 20-year-old video game.
