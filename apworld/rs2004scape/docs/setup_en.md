# 2004Scape Randomizer Setup Guide

## Required Software

- [Node.js](https://nodejs.org/) 20+
- A [Lost City](https://github.com/LostCityRS) server checkout, **revision 274** (the only revision this world is
  tested against - other revisions at your own risk)
- The [2004Scape-AP-Logic](https://github.com/marcdubs/2004Scape-AP-Logic) repository (the randomizer overlays, tools,
  and this apworld)
- An [Archipelago](https://github.com/ArchipelagoMW/Archipelago) installation. Note: as long as this is a custom
  apworld, the archipelago.gg website cannot generate games for it - someone in the multiworld must generate (and
  usually host) from a local Archipelago install with the apworld in `custom_worlds/`.

## One-time: game-server setup

1. Set up the Lost City `Server/` checkout the normal Lost City way, as a **sibling directory** of the
   `2004Scape-AP-Logic` checkout.
2. From `2004Scape-AP-Logic`: `node scripts/install.js` (deploys the randomizer overlays into `../Server`).
3. `cd ../Server/engine && npx tsx tools/pack/Build.ts` (one content pack build, ~2 minutes).

The [repository README](https://github.com/marcdubs/2004Scape-AP-Logic#readme) covers optional server flags
(`apSkipTutorial`, `xpRate`, web port) and troubleshooting.

## Create a YAML

```yaml
name: YourSlotName
game: 2004Scape
2004Scape:
  goal: dragon_slayer      # or barcrawl / kbd
  music_checks: false      # 230 extra "first visit to each music region" checks
```

`name` is your slot name in the multiworld. It does **not** need to match your in-game character name: the whole game
server plays as this one slot, so you can log in with any account.

## Per run: roll a seed and generate

1. From `2004Scape-AP-Logic`: `bash scripts/new-run.sh` (Windows: `scripts\new-run.bat`) - rolls the game-server side
   of the seed (entrances, drops, and every other enabled randomizer).
2. Delete `Server/engine/data/config/ap-placements.json` - in an Archipelago run the multiworld owns item placements.
3. Generate and host the multiworld from your Archipelago install as usual (with `rs2004scape.apworld` in
   `custom_worlds/` and your YAML in `Players/`).

## Connect and play

1. Start the game server (`cd Server/engine && npx tsx src/app.ts`, wait for `World ready`).
2. Open the tracker at `http://localhost:8080/ap/` and switch to the **Archipelago** tab.
3. Enter the Archipelago server's host, port, slot name (and password if any), hit **Test connection**, then
   **Save & Connect**. The status panel flips to *connected* - no restart needed.
4. Play at `http://localhost:8080/rs2.cgi`. Checks announce in chat as you complete them, received items apply and
   announce immediately, and reaching your goal reports victory to the multiworld automatically.
