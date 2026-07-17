# Leagues relics for rev 274 — researched proposal

Status: **researched 2026-07-17 (web survey of OSRS wiki), awaiting user decisions.**
Surveyed Demonic Pacts (per problems.txt), Trailblazer Reloaded, Raging Echoes, and
Twisted League (~70 relics); Shattered Relics' fragment system doesn't translate to
a curated list and was excluded. Near-duplicate relics across leagues are merged.
Each entry: what it becomes in rev 274, effort (easy = config/script tweak on
existing infra; medium = new scripts/items; hard = engine work), and AP-logic risk.
All of these would ride the `ap-options.json` toggle system built 2026-07-17 (the
addon-items pattern), and most reuse hooks this project already has (XP
multipliers, drop/gather/process randomization, custom items).

## Recommended (fun × feasibility order)

1. **Endless Harvest** (Demonic Pacts T1) — 2x resources from
   mining/woodcutting/fishing. *Easy* (yield hook exists in the gather
   randomizer). No AP risk. **Top pick.**
2. **Skill-group XP doublers** — Eye of the Artisan / Gift of the Gatherer / Way
   of the Warrior (Twisted) — 2x XP for production / gathering / combat skill
   clusters. *Easy* (scoped xpRate). AP risk: mild — accelerates level-milestone
   checks; fine with progressive caps since caps, not levels, gate logic here.
3. **Abyssal Accumulator** (Twisted) — 85% chance ammo/runes not consumed.
   *Easy*. No AP risk.
4. **Dark Altar Devotion** (Twisted) — auto-bury bones at 4x prayer XP. *Medium*
   (inventory-add hook). No AP risk.
5. **Corner Cutter** (Raging Echoes) — passive Agility XP while running. *Easy*.
   No AP risk; synergizes with the agility course/arena checks.
6. **Banker's Note** (Trailblazer Reloaded) — note/unnote anywhere. *Medium*.
   No AP risk (bank trips stay relevant via entrance rando anyway). Partially
   supersedes the Bank Box addon — pick one or tier them.
7. **Production Prodigy** (Trailblazer Reloaded) — batch/instant processing.
   *Medium* (batch loops per processing skill). No AP risk.
8. **Golden God** (Raging Echoes) — free rune-less High/Low Alchemy. *Easy*. No
   AP risk (economy only).
9. **Eternal Sustenance** (Demonic Pacts) — food not consumed on eat. *Easy*.
   No AP risk; softens combat checks (balance note only).
10. **Specialist** (Raging Echoes) — special attacks cost 20% energy. *Medium*
    (spec energy is an engine value). Very on-theme for the dragon-weapon era.
11. **Endless Endurance** (Twisted) — unlimited run energy. *Easy* — **already
    exists** as `node.infiniteRun` in this repo's WorldConfig; exposing it as a
    "relic" is packaging, not code.
12. **Treasure Seeker** (multiple leagues) — boosted clue drop rate / reward
    rolls. *Easy-medium* (drop-table weighting infra exists). Synergizes with
    the new trail checks + casket rewards.
13. **Friendly Forager** (Demonic Pacts) — passive herb pickups while
    gathering. *Medium*. No AP risk.
14. **Reloaded** (Demonic Pacts) — pick an extra relic. *Free once a relic
    system exists.*
15. **Xeric's Wisdom** (Twisted) — 2x all XP. *Easy* but power-capstone; same
    mild AP note as #2.
16. **Undying Retribution** (Trailblazer Reloaded) — survive lethal damage once
    per cooldown. *Medium-hard* (damage-pipeline hook). Softens boss-kill
    checks — deliberate design choice.

## Flagged — real AP conflicts, decide before building

- **Bank Heist / Fairy's Flight** (bank-teleport network) — undercuts entrance
  randomization. Workable compromise: teleport only to banks already physically
  visited (ties into the tracker-map discovery data). *Medium.*
- **Grimoire** (ignore spell/prayer level reqs) — directly bypasses level-gated
  checks and progressive-cap logic. Only as "-X levels", never "ignore".
- **Larcenist/Trickster** (guaranteed thieving) — fine now (no success-roll
  thieving checks exist), revisit if any are added.
- **Flow State** (flat 2-tick actions) — *hard*, engine action-timing surgery;
  roadmap-later at best.

## Skipped

~20–25 relics need content rev 274 lacks: Farming, Slayer, Hunter, Construction/POH,
Ruinous Powers, fairy rings/STASH/Wintertodt-era systems, collection log.

## Top-5 if building a first "relic tier"

Endless Harvest, the skill-group XP doubler trio, Abyssal Accumulator, Treasure
Seeker, Specialist. Hold Bank Heist/Grimoire until the discovery tracker can gate
them behind "already visited/known".
