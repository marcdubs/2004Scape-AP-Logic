import fs from 'fs';
import path from 'path';

import { CONTENT_ROOT, SCRIPTS_ROOT } from '../npc/NpcDripParser.js';
import { loadQuestCriticalItems } from '../drops/DropTableParser.js';
import { derangement, mulberry32 } from '../shared/Prng.js';
import { LEVEL_BANDS, type ProductLevel, bandFor, minLevels, readDbrowProducts, tieredSwaps } from '../shared/SkillTiers.js';

// Thieving randomization (GitHub #6): shuffles what pickpocketing, market stalls and
// trapped chests actually hand the player - pick a man's pocket and get an uncut ruby,
// rob the gem stall and get a cup of tea.
//
// SURVEY RESULT (the step the issue asked for first): all three thieving surfaces are
// dbtable-driven and the reward is a plain scalar item lookup, not an inline
// `if ($random < N) obj_add(...)` cascade. Every loot row is
// `data=loot,<obj>,<min>,<max>,<rarity_numerator>[,<message>]` in one of three dbrows,
// and all three reward cascades live in ONE file - skill_thieving/scripts/thieving.rs2,
// procs pick_pocket_check_for_reward / stealing_check_for_reward /
// trapped_chest_check_for_reward - each ending in a single `inv_add(inv, $reward, n)`.
// That is exactly the shape gathering/processing randomization already handles, so this
// is a runtime-override table (the issue's stated preference), not a config mutation.
//
// Design, therefore identical to RandomizeGathering.ts / RandomizeProcessing.ts (read
// RandomizeGathering's header for the fuller writeup of the shared architecture): the
// three delivery points are wrapped ONCE in the overlay (one pack rebuild ever) with
// inv_add(inv, ap_thieving_swap($reward), n), and the engine command reads the obj-id ->
// obj-id table this tool writes to engine/data/config/ap-thieving.json at runtime.
// Reseeding = rewrite the JSON + restart the server; deleting the JSON restores vanilla
// thieving with no rebuild. A miss returns the input id unchanged, so anything NOT in
// the table - quest-pinned items, unselected surfaces - simply behaves vanilla.
//
// What stays vanilla by design (only the item IDENTITY moves):
// - The rarity rolls. Each wrap sits INSIDE the `if ($roll >= $denominator)` branch, so
//   the vanilla drop rate still decides IF you get something; only what lands in your
//   inventory changes. Nothing is revealed for loot the player never actually received.
// - The XP, stun/failure rolls, guard aggro, respawn timers and chest teleport traps.
// - The stall "You steal some silk." message and its bread-only sound check, which both
//   still read the pre-swap $reward on purpose: the vanilla line plus a surprise item is
//   the mimic-style reveal, exactly like gathering's "You manage to mine some coal."
//   followed by a raw shark. (This is the "Steals like <x>" presentation decision from
//   the issue - the tracker names it explicitly, the game hints it.)
// - Quantity. A row that hands out 1000 coins still hands out 1000 of whatever it got
//   swapped to (inv_add simply fills what space there is for a non-stackable). Same
//   "structure stays put, content moves" philosophy RandomizeProcessing documents for
//   its 5x-knives rows - deliberately NOT clamped to the target item's native quantity.
//   `--exclude coins` is the escape hatch if a run wants the big-money rows left alone.
//
// Item pools come from the game's own dbtable data - same "sample what the corpus
// actually contains" discipline as drop/gathering/processing randomization.
//
// Deliberately NOT randomized: `locked_door.dbrow` (thieving doors have no loot at all,
// they only open) and the `chest_steel_arrowtips` lockpick gate (a requirement, not a
// reward - its loot row IS in the pool via trapped_chest.dbrow like every other chest).
//
// Usage (run from ../Server/engine):
//   npx tsx tools/thieving/RandomizeThieving.ts [--seed <n>] [--mode shuffle|tiered|chaos]
//       [--surfaces pickpocket,stalls,chests] [--exclude <item,item,...>]
//       [--pin-quest-items] [--no-quest-pins] [--dry-run] [--quiet]
//       [--export-pool <path>]
//
// - shuffle (default): one derangement across the combined loot pool - a bijection, so
//   every item is still stealable from exactly one source, and nothing maps to itself.
// - tiered: the same derangement, but run separately inside each PROGRESSION BAND (see
//   tools/shared/SkillTiers.ts) - a level-1 pocket yields another level-1 item, a
//   level-75 stall another level-75 one. All three dbrows carry their own `level`
//   column, so the bands are read straight out of the game's data.
// - chaos: every item independently resamples from the whole pool - duplicates allowed,
//   so some items can become unstealable entirely.
// - --surfaces: restrict which surfaces join the pool; items only reachable through an
//   unselected surface stay vanilla (they're simply never written into the table).
//
// Quest-critical pinning is MODE-AWARE, same reasoning as gathering/processing: shuffle
// and tiered are bijections (everything stays obtainable, a quest just needs its item
// stolen from a different source - the spoiler says which), so they don't pin by
// default; chaos genuinely can orphan an item, so it does. --pin-quest-items /
// --no-quest-pins override either way. Pinned items are also removed as REPLACEMENT
// values (shuffle is a bijection, so handing a pinned item out elsewhere would double it
// up and orphan whatever lost its slot).

const AP_THIEVING_JSON = path.join('data', 'config', 'ap-thieving.json');
const SPOILER_PATH = path.join('tools', 'thieving', 'thieving-seed.json');
const OBJ_PACK_PATH = path.join(CONTENT_ROOT, 'pack', 'obj.pack');
const THIEVING_CONFIGS = path.join(SCRIPTS_ROOT, 'skill_thieving', 'configs');

const SURFACES = ['pickpocket', 'stalls', 'chests'] as const;
type Surface = (typeof SURFACES)[number];

// Every surface's loot column is `data=loot,<obj>,<min>,<max>,<rarity>[,<message>]` and
// every surface's requirement is a sibling `data=level,<n>` - readDbrowProducts takes the
// leading namedobj of the tuple and ignores the trailing values, so one spec fits all
// three. (Note the folder typo `pickpocking` - that's upstream vanilla, not a mistake here.)
const SURFACE_DBROWS: Record<Surface, string> = {
    pickpocket: path.join(THIEVING_CONFIGS, 'pickpocking', 'pickpocket.dbrow'),
    stalls: path.join(THIEVING_CONFIGS, 'stalls', 'stealing.dbrow'),
    chests: path.join(THIEVING_CONFIGS, 'chests', 'trapped_chest.dbrow')
};

function loadSurfaceProducts(surface: Surface): ProductLevel[] {
    return readDbrowProducts(SURFACE_DBROWS[surface], { product: 'loot', level: 'level' });
}

function readLines(file: string): string[] {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

function loadObjIds(): Map<string, number> {
    const ids = new Map<string, number>();
    for (const line of readLines(OBJ_PACK_PATH)) {
        const eq = line.indexOf('=');
        if (eq > 0) {
            ids.set(line.slice(eq + 1).trim(), parseInt(line.slice(0, eq), 10));
        }
    }
    return ids;
}

function parseArgs(argv: string[]) {
    const args = {
        seed: (Date.now() / 1000) | 0,
        mode: 'shuffle' as 'shuffle' | 'tiered' | 'chaos',
        surfaces: [...SURFACES] as Surface[],
        exclude: new Set<string>(),
        questPins: null as boolean | null, // null = decide by mode (shuffle/tiered off, chaos on)
        dryRun: false,
        // --quiet suppresses the per-swap listing (the spoiler) and keeps the counts.
        // The full table always lands in the spoiler JSON either way, so nothing is
        // lost - this only decides whether it scrolls past the player rolling a seed.
        quiet: false,
        // GitHub #3 convention: dump the candidate pool and exit, so an Archipelago
        // apworld port can replay the same roll before the server ever runs this tool.
        exportPool: null as string | null
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--seed') {
            args.seed = parseInt(argv[++i], 10);
            if (!Number.isInteger(args.seed)) {
                throw new Error('--seed requires an integer');
            }
        } else if (arg === '--mode') {
            const mode = argv[++i];
            if (mode !== 'shuffle' && mode !== 'tiered' && mode !== 'chaos') {
                throw new Error(`unknown --mode ${mode} (expected shuffle|tiered|chaos)`);
            }
            args.mode = mode;
        } else if (arg === '--surfaces') {
            const picked = (argv[++i] ?? '')
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            for (const s of picked) {
                if (!SURFACES.includes(s as Surface)) {
                    throw new Error(`unknown surface ${s} (expected any of: ${SURFACES.join(',')})`);
                }
            }
            if (picked.length === 0) {
                throw new Error('--surfaces requires at least one surface');
            }
            args.surfaces = picked as Surface[];
        } else if (arg === '--exclude') {
            for (const item of (argv[++i] ?? '').split(',')) {
                if (item.trim().length > 0) {
                    args.exclude.add(item.trim());
                }
            }
        } else if (arg === '--pin-quest-items') {
            if (args.questPins === false) {
                throw new Error('--pin-quest-items and --no-quest-pins are mutually exclusive');
            }
            args.questPins = true;
        } else if (arg === '--no-quest-pins') {
            if (args.questPins === true) {
                throw new Error('--pin-quest-items and --no-quest-pins are mutually exclusive');
            }
            args.questPins = false;
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg === '--quiet') {
            args.quiet = true;
        } else if (arg === '--export-pool') {
            args.exportPool = argv[++i] ?? 'data/config/ap-thieving-pool.json';
        } else {
            throw new Error(`unknown argument ${arg}`);
        }
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv);

    const bySurface: Record<Surface, ProductLevel[]> = {
        pickpocket: loadSurfaceProducts('pickpocket'),
        stalls: loadSurfaceProducts('stalls'),
        chests: loadSurfaceProducts('chests')
    };

    // dedupe into one ordered pool (deterministic: surface order, then first occurrence).
    // An item stealable from several sources (coins from nearly every pocket AND two
    // chests, bread from the baker's stall AND the Yanille watchman) takes the LOWEST
    // level that yields it - the level it first becomes reachable at, which is what a
    // progression band models.
    const surfaceOf = new Map<string, Surface>();
    for (const surface of args.surfaces) {
        for (const { item } of bySurface[surface]) {
            if (!surfaceOf.has(item)) {
                surfaceOf.set(item, surface);
            }
        }
    }
    const levelOf = minLevels(args.surfaces.flatMap(surface => bySurface[surface]));
    if (surfaceOf.size === 0) {
        throw new Error('empty loot pool - are the overlays installed? (run from ../Server/engine)');
    }

    // every pool member must resolve against obj.pack - a miss means a parser
    // regression (or a renamed item), not something to silently drop.
    const objIds = loadObjIds();
    for (const item of surfaceOf.keys()) {
        if (!objIds.has(item)) {
            throw new Error(`thieving loot ${item} not found in obj.pack - parser drift?`);
        }
    }

    // --export-pool writes the roll's INPUT (the ordered loot pool, each item's surface,
    // obj id, level and band) and stops - deterministic and mode-independent, pins
    // exported as data rather than applied. Same contract as the gather/process pools:
    // the band is EXPORTED, never re-derived downstream, so a port can't drift.
    if (args.exportPool) {
        const questCriticalAll = loadQuestCriticalItems(new Set(surfaceOf.keys()));
        const poolOut = {
            _generated: 'tools/thieving/RandomizeThieving.ts --export-pool - the UNSHUFFLED candidate pool',
            generatedAt: new Date().toISOString(),
            surfaces: args.surfaces,
            bands: LEVEL_BANDS.map(b => b.name),
            products: [...surfaceOf.entries()].map(([item, surface]) => ({
                item,
                surface,
                objId: objIds.get(item)!,
                level: levelOf.get(item)!,
                band: bandFor(levelOf.get(item)!)
            })),
            hardExcluded: {} as Record<string, string>,
            questCritical: [...questCriticalAll].sort()
        };
        fs.mkdirSync(path.dirname(path.resolve(args.exportPool)), { recursive: true });
        fs.writeFileSync(path.resolve(args.exportPool), JSON.stringify(poolOut, null, 2) + '\n');
        console.log(`wrote ${poolOut.products.length} loot item(s) to ${args.exportPool} (pool only - no table written)`);
        return;
    }

    const pinQuestItems = args.questPins ?? args.mode === 'chaos';
    const questCritical = pinQuestItems ? loadQuestCriticalItems(new Set(surfaceOf.keys())) : new Set<string>();
    const pins = new Map<string, string>();
    for (const item of questCritical) {
        pins.set(item, 'quest-critical (inv_total/inv_del gate in a quest script)');
    }
    for (const item of args.exclude) {
        if (!pins.has(item)) {
            pins.set(item, '--exclude');
        }
    }

    const pool = [...surfaceOf.keys()].filter(item => !pins.has(item));
    if (pool.length < 2) {
        throw new Error(`only ${pool.length} unpinned loot item(s) - nothing to shuffle`);
    }

    const mapping = new Map<string, string>();
    let bandNotes: string[] = [];
    if (args.mode === 'tiered') {
        // one derangement per progression band, each on its own PRNG stream (salted by
        // band name) - so widening a band later doesn't reshuffle the others.
        const tiered = tieredSwaps(pool, levelOf, args.seed);
        for (const [was, now] of tiered.mapping) {
            mapping.set(was, now);
        }
        bandNotes = [...tiered.bands.map(b => `band ${b.band}: ${b.members.length} item(s) deranged among themselves`), ...tiered.warnings];
    } else if (args.mode === 'shuffle') {
        const rand = mulberry32(args.seed);
        const perm = derangement(pool.length, rand);
        for (let i = 0; i < pool.length; i++) {
            mapping.set(pool[i], pool[perm[i]]);
        }
    } else {
        // chaos: independent uniform resample per item; resample (up to 50x, same
        // convention as drip/gathering/processing) so nothing keeps its own value.
        const rand = mulberry32(args.seed);
        for (const item of pool) {
            let picked = item;
            for (let i = 0; i < 50 && picked === item; i++) {
                picked = pool[Math.floor(rand() * pool.length)];
            }
            mapping.set(item, picked);
        }
    }

    if (mapping.size === 0) {
        throw new Error(`mode ${args.mode} produced no swaps - every progression band holds fewer than 2 eligible items (widen --surfaces or drop some --exclude)`);
    }

    const swaps = [...mapping.entries()].map(([was, now]) => ({
        was,
        wasSurface: surfaceOf.get(was)!,
        wasLevel: levelOf.get(was)!,
        wasId: objIds.get(was)!,
        now,
        nowSurface: surfaceOf.get(now)!,
        nowLevel: levelOf.get(now)!,
        nowId: objIds.get(now)!
    }));
    const crossSurface = swaps.filter(s => s.wasSurface !== s.nowSurface).length;

    console.log(`thieving randomizer: seed ${args.seed}, mode ${args.mode}, surfaces ${args.surfaces.join(',')}, quest pins ${pinQuestItems ? 'on' : 'off'}`);
    console.log(
        `pool: ${surfaceOf.size} distinct loot items (${args.surfaces.map(s => `${s} ${new Set(bySurface[s].map(p => p.item)).size}`).join(', ')}), ${pins.size} pinned vanilla, ${pool.length} shuffled`
    );
    for (const note of bandNotes) {
        console.log(`  ${note}`);
    }
    if (args.quiet) {
        console.log(`  (${swaps.length} swap(s) + ${pins.size} pin(s) not printed - --quiet; full table in ${SPOILER_PATH})`);
    } else {
        for (const s of swaps) {
            console.log(`  ${s.wasSurface.padEnd(10)} ${s.was} (lvl ${s.wasLevel}) -> ${s.now} (lvl ${s.nowLevel})${s.wasSurface !== s.nowSurface ? ` [${s.nowSurface}]` : ''}`);
        }
        for (const [item, reason] of pins) {
            console.log(`  pinned     ${item} (${reason})`);
        }
    }
    console.log(`${crossSurface}/${swaps.length} swaps land cross-surface`);

    if (args.dryRun) {
        console.log('dry run - nothing written');
        return;
    }

    fs.mkdirSync(path.dirname(AP_THIEVING_JSON), { recursive: true });
    const map: Record<string, number> = {};
    for (const s of swaps) {
        map[String(s.wasId)] = s.nowId;
    }
    fs.writeFileSync(AP_THIEVING_JSON, JSON.stringify({ seed: args.seed, mode: args.mode, surfaces: args.surfaces, map }, null, 2) + '\n');

    fs.mkdirSync(path.dirname(SPOILER_PATH), { recursive: true });
    fs.writeFileSync(
        SPOILER_PATH,
        JSON.stringify(
            {
                seed: args.seed,
                mode: args.mode,
                surfaces: args.surfaces,
                bandNotes,
                pinned: [...pins.entries()].map(([item, reason]) => ({ item, reason })),
                swaps
            },
            null,
            2
        ) + '\n'
    );

    console.log(`wrote ${AP_THIEVING_JSON} (${swaps.length} swaps) and ${SPOILER_PATH}`);
    console.log('reseed = re-run this tool + restart the server (no pack rebuild); delete the JSON to restore vanilla thieving');
}

main();
