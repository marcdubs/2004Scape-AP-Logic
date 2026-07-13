# 2004Scape-AP-Logic

Archipelago randomizer for 2004scape (LostCityRS rev 274). **Before doing anything,
read `docs/lessons-learned.md`** - it has the architecture rationale, engine/rs2
recipes, environment gotchas, and the roadmap. `README.md` covers layout and usage.
`docs/archipelago-ideas.md` is the original design brainstorm.

## The one-paragraph mental model

This repo holds everything custom. The vanilla LostCityRS checkout lives at
`../Server` (engine/content/webclient/javaclient inside it). `node scripts/install.js`
copies `overlays/<target>/...` on top of it. Entrance randomization works via a
runtime JSON table (`../Server/engine/data/config/ap-entrances.json`) consulted by a
custom script command - reseeding never needs a content rebuild, only a server
restart. Content/engine overlay changes DO need `npx tsx tools/pack/Build.ts` (run in
`../Server/engine`, ~1-2 min) plus a restart.

## Commands you'll actually run

```
node scripts/install.js                                  # deploy overlays -> ../Server
cd ../Server/engine && npx tsx tools/pack/Build.ts       # rebuild pack (after overlay changes only)
cd ../Server/engine && npx tsx tools/map/RandomizeEntrances.ts [--seed N] [--mixed] [--dry-run]
cd ../Server/engine && npx tsc --noEmit -p .              # typecheck engine
```

## Hard-won rules (details in lessons-learned)

- The user runs the game server on **Windows**; you are in WSL. Do NOT try to fully
  boot the server yourself - hand testing to the user.
- If `tsx` dies with an esbuild platform error:
  `cd ../Server/engine && npm install && npm install --no-save --force @esbuild/win32-x64`
- Content `.rs2`/config files are CRLF - preserve line endings when writing.
- Edit overlay files in THIS repo, then `install.js` - never only the copies in
  `../Server` (they get overwritten on the next install).
- After any pairing/parser change, re-run the verification trio: parser regression
  (byte-identical on patched files), loader unit test, machine round-trip check
  (see lessons-learned "Testing & verification").
- At session end: update `docs/lessons-learned.md` with anything a future session
  would need, then commit + push (the user expects this).
