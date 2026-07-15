import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

import { CONTENT_ROOT } from '../map/EntranceParser.js';
import { mulberry32 } from '../shared/Prng.js';

// Archipelago random spawn/home point (2004Scape-AP-Logic docs/goals-and-checks.md
// Feature 3, expanded with a second "chunk" mode). Picks one seeded home coordinate
// and writes engine/data/config/ap-spawn.json, read at runtime by
// src/engine/ApSpawnOverrides.ts (ap_home_coord command, death respawn, ::home).
// Reseed = re-run + restart the server - no content rebuild, same pattern as
// RandomizeEntrances.ts.
//
// Usage: npx tsx tools/spawn/RandomizeSpawn.ts [--seed <number>] [--mode city|chunk] [--dry-run]
// Run from Server/engine (same convention as every other AP tool - CONTENT_ROOT
// resolves '../content' relative to process.cwd()).

const OUTPUT_PATH = path.resolve('data/config/ap-spawn.json');

// ---------------------------------------------------------------------------
// city mode - one of the 7 standard-spellbook teleport landmarks
// ---------------------------------------------------------------------------

// Vanilla coords from docs/goals-and-checks.md Feature 3, sourced from
// content/scripts/skill_magic/configs/magic_spells.dbrow's tele_coord fields as they
// exist BEFORE any teleport-destination shuffle (Feature 4, RandomizeTeleports.ts)
// runs. Deliberately hardcoded rather than read live: Feature 4 deranges that dbrow
// in place, and home should stay a real, unshuffled town landmark regardless of
// where the teleport spells currently land (docs/goals-and-checks.md: "Keep Feature
// 3 reading the vanilla coord list, not this shuffled table"). No content/.ap-backup
// copy of magic_spells.dbrow exists to fall back to (only ladders+stairs scripts are
// backed up there), so this hardcoded table IS the source of truth.
const CITY_LANDMARKS: { label: string; coord: string }[] = [
    { label: 'Varrock', coord: '0_50_53_13_32' },
    { label: 'Lumbridge', coord: '0_50_50_21_18' },
    { label: 'Falador', coord: '0_46_52_21_50' },
    { label: 'Camelot', coord: '0_43_54_5_22' },
    { label: 'Ardougne', coord: '0_41_51_37_37' },
    { label: 'Watchtower', coord: '2_45_73_53_41' },
    { label: 'Trollheim', coord: '0_45_57_10_31' }
];

const MAGIC_SPELLS_DBROW = path.join(CONTENT_ROOT, 'scripts/skill_magic/configs/magic_spells.dbrow');

// dbrow section name -> the label above, so a live cross-check can be keyed by name
// rather than position (dbrow row order isn't guaranteed to match this table).
const SPELL_ROW_LABEL: Record<string, string> = {
    magic_spell_teleport_varrock: 'Varrock',
    magic_spell_teleport_lumbridge: 'Lumbridge',
    magic_spell_teleport_falador: 'Falador',
    magic_spell_teleport_camelot: 'Camelot',
    magic_spell_teleport_ardougne: 'Ardougne',
    magic_spell_teleport_watchtower: 'Watchtower',
    magic_spell_teleport_trollheim: 'Trollheim'
};

// Cross-checks CITY_LANDMARKS against the live dbrow and warns LOUDLY (but does not
// abort) on any mismatch - a mismatch means RandomizeTeleports.ts has already run and
// deranged the destinations. Home intentionally keeps using the hardcoded vanilla
// table regardless (see comment above), so this is a visibility check, not a
// dependency: continuing is always correct.
function verifyCityCoordsAgainstDbrow(): void {
    if (!fs.existsSync(MAGIC_SPELLS_DBROW)) {
        printWarning(`RandomizeSpawn: ${MAGIC_SPELLS_DBROW} not found - cannot cross-check the vanilla city table, proceeding with it blind`);
        return;
    }

    const found = new Map<string, string>();
    let currentRow: string | null = null;
    for (const rawLine of fs.readFileSync(MAGIC_SPELLS_DBROW, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        const rowMatch = line.match(/^\[(.+)\]$/);
        if (rowMatch) {
            currentRow = rowMatch[1];
            continue;
        }
        const dataMatch = line.match(/^data=tele_coord,(\S+)$/);
        if (dataMatch && currentRow && SPELL_ROW_LABEL[currentRow]) {
            found.set(SPELL_ROW_LABEL[currentRow], dataMatch[1]);
        }
    }

    let mismatches = 0;
    for (const { label, coord } of CITY_LANDMARKS) {
        const live = found.get(label);
        if (live === undefined) {
            printWarning(`RandomizeSpawn: could not find tele_coord for ${label} in magic_spells.dbrow (row renamed?) - using hardcoded coord ${coord}`);
        } else if (live !== coord) {
            mismatches++;
            printWarning(`RandomizeSpawn: *** MISMATCH *** ${label} tele_coord is ${live} live but the vanilla table says ${coord}.`);
        }
    }

    if (mismatches > 0) {
        printWarning(`RandomizeSpawn: *** ${mismatches}/7 landmark coord(s) diverge from the live dbrow - RandomizeTeleports.ts has probably run. City-mode home STILL uses the vanilla table above on purpose (see docs/goals-and-checks.md Feature 3). ***`);
    } else {
        printInfo('RandomizeSpawn: all 7 city landmark coords verified against magic_spells.dbrow (vanilla, unshuffled).');
    }
}

// ---------------------------------------------------------------------------
// chunk mode - a random safe mainland surface mapsquare
// ---------------------------------------------------------------------------

const MAPS_DIR = path.join(CONTENT_ROOT, 'maps');

// Verified 2026-07-15 against Player.ts's isInWilderness() (engine/src/engine/entity/
// Player.ts): wilderness is x in [2944,3392) & z in [3520,6400) on the surface (a
// second copy exists underground at z+6400, irrelevant here since we only look at
// mapZ<100). 2944>>6=46, 3392>>6=53 (exclusive) -> mapX 46..52 inclusive;
// 3520>>6=55 exactly (an exact mapsquare boundary, confirmed by content/scripts/
// music/scripts/move.rs2's `[mapzone,0_46_55] ~wilderness_enter`) -> mapZ >= 55.
const WILDERNESS_MAPX_MIN = 46;
const WILDERNESS_MAPX_MAX = 52;
const WILDERNESS_MAPZ_MIN = 55;

// Tutorial Island - same protected-mapsquare convention as RandomizeEntrances.ts.
const PROTECTED_MAPSQUARES: [number, number][] = [[48, 48]];

// Surveyed the full content/maps/*.jm2 file list (483 files) 2026-07-15: mapZ is
// bimodal - surface mapZ 20 (one outlier, a 4-section-only stub map, not real
// mainland) and 44-77, underground mapZ+100 (144-161, mirrors 44-61). Within the
// surface band there's a real gap at mapZ 63-69 (no files - open sea) separating two
// landmasses: the well-connected core continent at mapZ 44-62 (Misthalin/Asgarnia/
// Kandarin/Fremennik - everything reachable by the vanilla road/dungeon network) from
// a second cluster at mapZ 70-77 (mapX 29-47, no wilderness overlap - plausibly
// Karamja/Crandor/the south coast, reachable mainly by boat/quest gate in vanilla).
// Reachability can't be solved offline (see docs/goals-and-checks.md's note that
// ::home is the escape hatch, which makes an unreachable HOME itself the real risk) -
// mitigate conservatively by defaulting chunk-mode candidates to the core band only.
// Pass --include-islands to widen the pool to mapZ 44-77 once this has been
// playtested.
const CORE_MAPZ_MAX = 62;
const ISLAND_MAPZ_MIN = 70;
const ISLAND_MAPZ_MAX = 77;

// IMPORTANT CAVEAT (found while spot-checking chunk-mode output, 2026-07-15): the
// mapZ 63-69 gap does NOT catch every boat-only island - Karamja sits INSIDE the core
// band's mapZ range, at mapX 43-46/mapZ 45-49 (verified two ways: (1) the amulet of
// glory's literal Karamja destination is 0_45_49_38_40 - general/scripts/
// enchanted_jewellry/amulet_of_glory.rs2 - and (2) content/scripts/music/configs/
// musicregion.dbrow tags exactly that box with jungle/tribal/reggae tracks, sharply
// bounded by ordinary mainland tracks one square outside it in every direction, e.g.
// (46,52)="Fanfare" (Falador) vs (46,45)="Reggae"). A --dry-run without this
// exclusion actually produced mapsquare 33,50 for one seed, which is also
// Karamja-adjacent going by the same music-region data - so the wider south-west
// cluster (roughly mapX 29-42, mapZ 44-51) likely has more undocumented island/
// boat-only pockets mixed in with genuine mainland (Tree Gnome Stronghold's
// mapX36-38/mapZ53-54 is walkable and NOT excluded). Only the tightly-verified
// Karamja box is excluded below; the rest of that south-west area is a KNOWN GAP in
// this offline heuristic (mitigated by CORE_MAPX_MIN below, at the cost of some
// genuine mainland). map_findsquare + ::home remain the runtime safety net regardless.
const KARAMJA_MAPX_MIN = 43;
const KARAMJA_MAPX_MAX = 46;
const KARAMJA_MAPZ_MIN = 45;
const KARAMJA_MAPZ_MAX = 49;

// Belt-and-suspenders on top of the Karamja box above: mapsquare 33,50 (part of the
// mapX 29-39 south-west cluster) came out of an early --dry-run and is NOT covered by
// the Karamja box, yet musicregion.dbrow tags its whole neighborhood (mapX 29-39,
// mapZ 44-51: "Riverside"/"Meridian"/"Woodland"/"Everywhere"/"Iban"/"Trawler" tracks)
// as the same jungle/boat-access theme family as the confirmed Karamja dock square,
// not the "Newbie_Melody"/"Fanfare"/"Al_Kharid"/city-named tracks seen on confirmed
// mainland squares (Falador=46,52 "Fanfare", Camelot=43,54 "music_Camelot"). This
// could not be fully confirmed offline (no second literal teleport destination found
// in that range), so the conservative choice is to drop mapX<40 from the pool
// entirely rather than risk more undetected islands - this does cost some genuine
// mainland (e.g. Tree Gnome Stronghold around 36-38,53-54), a deliberate trade for
// safety per docs/goals-and-checks.md's "keep a conservative allowlist bias"
// guidance. Revisit with --include-far-west once someone has walked the results.
const CORE_MAPX_MIN = 40;

// "does this mapsquare look like authored, walkable land" signal: bare ocean/empty
// squares have few or no LOC placements and no NPCs. The runtime map_findsquare call
// at every use site (death.rs2, ::apspawn) is the final safety net regardless - this
// is just a pre-filter so the seed tool doesn't even offer an obviously-empty square.
const MIN_LOC_PLACEMENTS = 8;

type ChunkCandidate = { mapX: number; mapZ: number; locCount: number; npcCount: number };

// counts non-blank lines in a `==== HEADER ====` section up to the next `====` line
// (or EOF) - same section-boundary convention as LocPlacementScanner.ts, but here we
// only need a population count, not per-line parsing.
function countSectionLines(text: string, header: string): number {
    const start = text.indexOf(header);
    if (start === -1) {
        return 0;
    }
    let count = 0;
    for (const line of text.slice(start).split(/\r?\n/).slice(1)) {
        if (line.startsWith('====')) {
            break;
        }
        if (line.trim().length > 0) {
            count++;
        }
    }
    return count;
}

function enumerateChunkCandidates(includeIslands: boolean, includeFarWest: boolean): ChunkCandidate[] {
    const out: ChunkCandidate[] = [];

    for (const file of fs.readdirSync(MAPS_DIR)) {
        const nameMatch = file.match(/^m(\d+)_(\d+)\.jm2$/);
        if (!nameMatch) {
            continue;
        }
        const mapX = parseInt(nameMatch[1], 10);
        const mapZ = parseInt(nameMatch[2], 10);

        if (mapZ >= 100) {
            continue; // underground layer (mapZ+100 convention)
        }
        const inCoreBand = mapZ <= CORE_MAPZ_MAX;
        const inIslandBand = includeIslands && mapZ >= ISLAND_MAPZ_MIN && mapZ <= ISLAND_MAPZ_MAX;
        if (!inCoreBand && !inIslandBand) {
            continue; // the mapZ 20 outlier, the 63-69 sea gap, or an excluded island
        }
        if (!includeFarWest && mapX < CORE_MAPX_MIN) {
            continue; // south-west cluster, likely Karamja-adjacent - see caveat above
        }
        if (mapX >= WILDERNESS_MAPX_MIN && mapX <= WILDERNESS_MAPX_MAX && mapZ >= WILDERNESS_MAPZ_MIN) {
            continue; // wilderness
        }
        if (PROTECTED_MAPSQUARES.some(([px, pz]) => px === mapX && pz === mapZ)) {
            continue; // Tutorial Island
        }
        if (mapX >= KARAMJA_MAPX_MIN && mapX <= KARAMJA_MAPX_MAX && mapZ >= KARAMJA_MAPZ_MIN && mapZ <= KARAMJA_MAPZ_MAX) {
            continue; // Karamja (boat-only) - see the caveat comment above
        }

        const text = fs.readFileSync(path.join(MAPS_DIR, file), 'utf8');
        const locCount = countSectionLines(text, '==== LOC ====');
        const npcCount = countSectionLines(text, '==== NPC ====');
        if (locCount < MIN_LOC_PLACEMENTS && npcCount === 0) {
            continue; // looks like bare ocean/empty
        }

        out.push({ mapX, mapZ, locCount, npcCount });
    }

    return out;
}

// ---------------------------------------------------------------------------

function parseArgs() {
    const args = process.argv.slice(2);
    const seedIdx = args.indexOf('--seed');
    const seed = seedIdx !== -1 ? parseInt(args[seedIdx + 1], 10) : Math.floor(Math.random() * 0xffffffff);
    const modeIdx = args.indexOf('--mode');
    const modeArg = modeIdx !== -1 ? args[modeIdx + 1] : 'city';
    if (modeArg !== 'city' && modeArg !== 'chunk') {
        printWarning(`RandomizeSpawn: unrecognized --mode "${modeArg}", expected "city" or "chunk"`);
        process.exit(1);
    }
    return {
        seed,
        mode: modeArg as 'city' | 'chunk',
        dryRun: args.includes('--dry-run'),
        includeIslands: args.includes('--include-islands'),
        includeFarWest: args.includes('--include-far-west')
    };
}

function main() {
    const { seed, mode, dryRun, includeIslands, includeFarWest } = parseArgs();
    const rand = mulberry32(seed);

    let home: string;
    let label: string;
    const extra: Record<string, unknown> = {};

    if (mode === 'city') {
        verifyCityCoordsAgainstDbrow();
        const pick = CITY_LANDMARKS[Math.floor(rand() * CITY_LANDMARKS.length)];
        home = pick.coord;
        label = pick.label;
        printInfo(`seed ${seed}: city mode picked ${label} (${home})`);
    } else {
        if (!fs.existsSync(MAPS_DIR)) {
            printWarning(`RandomizeSpawn: maps directory not found: ${MAPS_DIR}`);
            process.exit(1);
        }
        const candidates = enumerateChunkCandidates(includeIslands, includeFarWest);
        extra.chunkCandidateCount = candidates.length;
        printInfo(
            `chunk mode: ${candidates.length} qualifying mainland mapsquare(s) found` +
                `${includeIslands ? ' (islands included)' : ''}${includeFarWest ? ' (far-west included)' : ''}` +
                `${!includeIslands && !includeFarWest ? ' (core band only)' : ''}`
        );

        if (candidates.length === 0) {
            printWarning('RandomizeSpawn: no chunk-mode candidates found - falling back to vanilla Lumbridge');
            home = '0_50_50_21_18';
            label = 'Lumbridge (vanilla, no chunk candidates found)';
        } else {
            const pick = candidates[Math.floor(rand() * candidates.length)];
            // square center tile - the runtime map_findsquare call at every use site
            // (death.rs2, ::apspawn) is the final walkability safety net.
            home = `0_${pick.mapX}_${pick.mapZ}_32_32`;
            label = `mapsquare ${pick.mapX},${pick.mapZ}`;
            printInfo(`seed ${seed}: chunk mode picked ${label} (${home}) - ${pick.locCount} LOC placement(s), ${pick.npcCount} NPC(s)`);
        }
    }

    const output = { home, mode, seed, label, generatedAt: new Date().toISOString(), ...extra };

    // spoiler line, printed prominently regardless of --dry-run - home matters more
    // than any other single seed choice (it's where death sends you, repeatedly).
    printInfo('================================================================');
    printInfo(`AP HOME: ${label}  (${home})  [mode=${mode} seed=${seed}]`);
    printInfo('================================================================');

    if (!dryRun) {
        fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
        printInfo(`wrote ${OUTPUT_PATH} - restart the server to load the new home (no content rebuild needed)`);
    } else {
        printInfo('[dry run] nothing written');
    }
}

main();
