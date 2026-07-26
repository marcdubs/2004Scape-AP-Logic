import fs from 'fs';
import path from 'path';

import { CONTENT_ROOT, SCRIPTS_ROOT } from '../npc/NpcDripParser.js';
import { loadQuestCriticalItems } from '../drops/DropTableParser.js';
import { derangement, mulberry32 } from '../shared/Prng.js';
import { LEVEL_BANDS, type ProductLevel, bandFor, minLevels, readDbrowProducts, tieredSwaps } from '../shared/SkillTiers.js';
import { loadFishingProductLevels } from './FishingLevels.js';

// Gathering-skill randomization: shuffles which item each Mining / Fishing /
// Woodcutting action actually hands the player - cut a tree and get a fish, fish and
// get a log, mine and get anything. Runtime-override design, same plumbing as
// entrance randomization and drops --mode mimic: the vanilla skill scripts' delivery
// points are wrapped ONCE (in the overlay, one pack rebuild ever) with
// inv_add(inv, ap_gather_swap($product), 1), and the engine command reads the
// obj-id -> obj-id table this tool writes to engine/data/config/ap-gather.json at
// runtime. Reseeding = rewrite the JSON + restart the server; deleting the JSON
// restores vanilla gathering with no rebuild. A miss returns the input id unchanged
// (vanilla passthrough), so anything NOT in the table - quest-pinned products,
// perfect_gold_ore, unselected skills - simply behaves vanilla.
//
// What stays vanilla by design (the wraps only cover PRIMARY product delivery):
// - the mining gem bonus roll (glory-amulet 1/256 chance) and Shilo gem rocks
// - big-net junk catches (boots/seaweed/gloves/oyster/casket) - only the actual fish
//   (mackerel/cod/bass) are wrapped in memberfish.rs2
// - the Tai Bwo Wannai karambwan/karambwanji minigame (quest content)
// - success chances, xp, level requirements, bait consumption, and catch/mine
//   messages - only the item that lands in the inventory changes, which is the point:
//   the action still LOOKS vanilla until you check what you were given.
//
// Everything in the pool comes from the game's own data (mine.dbrow rock_output,
// trees.dbrow product, ~fish_roll/~fish_roll_loc call-site literals plus the
// big-net ap_gather_swap wraps) - same "sample what the corpus actually contains"
// discipline as drop randomization; there's no safe way to widen item pools from
// obj.pack alone.
//
// Usage (run from ../Server/engine):
//   npx tsx tools/gather/RandomizeGathering.ts [--seed <n>] [--mode shuffle|tiered|chaos]
//       [--skills mining,fishing,woodcutting] [--exclude <item,item,...>]
//       [--pin-quest-items] [--no-quest-pins] [--dry-run] [--quiet]
//
// - shuffle (default): one derangement across the combined product pool - a bijection,
//   so every product is still obtainable from exactly one gathering action, and no
//   product maps to itself.
// - tiered: the same derangement, but run separately inside each PROGRESSION BAND (see
//   tools/shared/SkillTiers.ts) - a level-1 fish becomes a level-1 ore or log, a
//   level-75 one becomes another level-75 product. Still cross-skill, still a bijection
//   (per band), just no longer able to put rune ore behind a level-1 rock or shrimp
//   behind Runite. Levels come from the content itself: mine.dbrow's rock_level,
//   trees.dbrow's levelrequired, and - fishing having no product dbtable - the
//   stat(fishing) guards in the spot scripts (FishingLevels.ts).
// - chaos: every product independently resamples from the whole pool - duplicates
//   allowed, so some products can become unobtainable from gathering entirely.
// - --skills: restrict which skills join the pool; products of unselected skills stay
//   vanilla (they're simply never written into the table).
// All three modes are kept behind --mode (rather than picking one) for the same reason
// as drop randomization: they're Archipelago slot options.
//
// Quest-critical pinning is MODE-AWARE, unlike drop randomization's always-on pin.
// (tiered behaves like shuffle here: it's a bijection inside every band, so nothing
// becomes unobtainable and it actually REDUCES the quest-item risk by keeping a
// low-level quest ingredient low-level.)
// The scan (same inv_total/inv_del gating idiom) flags 16 of the 39 products here -
// including every log type and most basic ores - because common gathering products
// gate quests constantly. Pinning all of them in shuffle mode would gut the feature
// (woodcutting would be left with hollow_bark alone), and shuffle doesn't need the
// protection: it's a bijection, so every product stays obtainable, a quest just needs
// its item gathered from a different action (the spoiler says which). Chaos genuinely
// CAN orphan a product, so it pins by default. --pin-quest-items forces pinning on in
// shuffle; --no-quest-pins forces it off in chaos.

const AP_GATHER_JSON = path.join('data', 'config', 'ap-gather.json');
const SPOILER_PATH = path.join('tools', 'gather', 'gather-seed.json');
const OBJ_PACK_PATH = path.join(CONTENT_ROOT, 'pack', 'obj.pack');

const SKILLS = ['mining', 'fishing', 'woodcutting'] as const;
type Skill = (typeof SKILLS)[number];

// Products that must stay vanilla even though they sit in the source data, and the
// quest-critical inv_total/inv_del scan can't be relied on to catch them:
// - thpunishrock: the Tourist Trap punishment-rock task "ore" - quest minigame
//   plumbing, not a real gathering product.
const HARD_EXCLUDED: Record<string, string> = {
    thpunishrock: 'Tourist Trap punishment-rock quest task, not a real product'
};

function readLines(file: string): string[] {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

// Each loader returns the product AND the skill level it first becomes gatherable at -
// the level is what `--mode tiered` buckets on, and it costs nothing to parse it in
// every mode (a missing one is parser drift either way, and readDbrowProducts throws).
function loadMiningProducts(): ProductLevel[] {
    return readDbrowProducts(path.join(SCRIPTS_ROOT, 'skill_mining', 'configs', 'mine.dbrow'), {
        product: 'rock_output',
        level: 'rock_level'
    });
}

function loadWoodcuttingProducts(): ProductLevel[] {
    return readDbrowProducts(path.join(SCRIPTS_ROOT, 'skill_woodcutting', 'configs', 'trees.dbrow'), {
        product: 'product',
        level: 'levelrequired'
    });
}

// fishing has no product dbtable - fish are literal args at ~fish_roll/~fish_roll_loc
// call sites (args 1+2; arg 3+ is equipment/bait), plus the big-net fish that
// memberfish.rs2's overlay wraps directly in ap_gather_swap(<literal>). Parsed from
// the LIVE (overlaid) fishing scripts, which is also a nice property: the pool is by
// construction "whatever delivery points are actually wrapped". FishingLevels.ts does
// that scan and carries the stat(fishing) guards out with it.
function loadFishingProducts(): ProductLevel[] {
    return loadFishingProductLevels();
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
        skills: [...SKILLS] as Skill[],
        exclude: new Set<string>(),
        questPins: null as boolean | null, // null = decide by mode (shuffle off, chaos on)
        dryRun: false,
        // --quiet suppresses the per-swap listing (the spoiler) and keeps the counts.
        // The full table always lands in the spoiler JSON either way, so nothing is
        // lost - this only decides whether it scrolls past the player rolling a seed.
        quiet: false,
        // GitHub #3: dump the candidate pool and exit, so the Archipelago apworld can
        // roll the same table itself (it needs the mapping to reason about item
        // obtainability BEFORE the server ever runs this tool).
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
        } else if (arg === '--skills') {
            const picked = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0);
            for (const s of picked) {
                if (!SKILLS.includes(s as Skill)) {
                    throw new Error(`unknown skill ${s} (expected any of: ${SKILLS.join(',')})`);
                }
            }
            if (picked.length === 0) {
                throw new Error('--skills requires at least one skill');
            }
            args.skills = picked as Skill[];
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
            args.exportPool = argv[++i] ?? 'data/config/ap-gather-pool.json';
        } else {
            throw new Error(`unknown argument ${arg}`);
        }
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv);

    const bySkill: Record<Skill, ProductLevel[]> = {
        mining: loadMiningProducts(),
        fishing: loadFishingProducts(),
        woodcutting: loadWoodcuttingProducts()
    };

    // dedupe into one ordered pool (deterministic: skill order, then first occurrence -
    // limestone appears on 3 rocks, logs on 2 trees, mackerel at 2 big-net slots).
    // The LEVEL of a duplicated product is the lowest one that yields it (minLevels),
    // i.e. the level it first becomes reachable at - limestone is a level-1 product even
    // though one of its three rocks sits higher.
    const skillOf = new Map<string, Skill>();
    for (const skill of args.skills) {
        for (const { item } of bySkill[skill]) {
            if (!skillOf.has(item)) {
                skillOf.set(item, skill);
            }
        }
    }
    const levelOf = minLevels(args.skills.flatMap(skill => bySkill[skill]));
    if (skillOf.size === 0) {
        throw new Error('empty product pool - are the overlays installed? (run from ../Server/engine)');
    }

    // every pool member must resolve against obj.pack - a miss means a parser
    // regression (or a renamed item), not something to silently drop.
    const objIds = loadObjIds();
    for (const item of skillOf.keys()) {
        if (!objIds.has(item)) {
            throw new Error(`product ${item} not found in obj.pack - parser drift?`);
        }
    }

    // GitHub #3: --export-pool writes the shuffle's INPUT (the ordered product pool,
    // each product's skill and obj id, and the pin sets that decide who is eligible)
    // and stops. The Archipelago apworld replays the exact same derangement over this
    // list, so it knows what every gathering action will hand out while its fill is still
    // running - which is what lets item obtainability be real logic in AP mode.
    // Deterministic and mode-independent: pins are exported as data, not applied here.
    if (args.exportPool) {
        const questCriticalAll = loadQuestCriticalItems(new Set(skillOf.keys()));
        const poolOut = {
            _generated: 'tools/gather/RandomizeGathering.ts --export-pool - the UNSHUFFLED candidate pool',
            generatedAt: new Date().toISOString(),
            skills: args.skills,
            // `bands` is exported alongside the per-product `band` so the apworld never
            // has to re-derive the boundaries: it groups by the string it was handed, in
            // the order it was handed, which is the only way tiered mode can be
            // guaranteed not to drift between the two implementations.
            bands: LEVEL_BANDS.map(b => b.name),
            products: [...skillOf.entries()].map(([item, skill]) => ({
                item,
                skill,
                objId: objIds.get(item)!,
                level: levelOf.get(item)!,
                band: bandFor(levelOf.get(item)!)
            })),
            hardExcluded: Object.fromEntries(Object.entries(HARD_EXCLUDED).filter(([item]) => skillOf.has(item))),
            questCritical: [...questCriticalAll].sort()
        };
        fs.mkdirSync(path.dirname(path.resolve(args.exportPool)), { recursive: true });
        fs.writeFileSync(path.resolve(args.exportPool), JSON.stringify(poolOut, null, 2) + '\n');
        console.log(`wrote ${poolOut.products.length} product(s) to ${args.exportPool} (pool only - no table written)`);
        return;
    }

    // pins: hard exclusions, quest-critical products (mode-aware - see the header
    // comment), and --exclude extras. Pinned products are left out of the table
    // entirely = vanilla passthrough. Unlike drops, being pinned here also removes
    // the item as a REPLACEMENT value: shuffle mode is a bijection, so keeping a
    // pinned item's own source vanilla while also handing it out elsewhere would
    // double it up and orphan whatever product lost its slot.
    const pinQuestItems = args.questPins ?? args.mode === 'chaos';
    const questCritical = pinQuestItems ? loadQuestCriticalItems(new Set(skillOf.keys())) : new Set<string>();
    const pins = new Map<string, string>();
    for (const [item, reason] of Object.entries(HARD_EXCLUDED)) {
        if (skillOf.has(item)) {
            pins.set(item, reason);
        }
    }
    for (const item of questCritical) {
        if (!pins.has(item)) {
            pins.set(item, 'quest-critical (inv_total/inv_del gate in a quest script)');
        }
    }
    for (const item of args.exclude) {
        if (!pins.has(item)) {
            pins.set(item, '--exclude');
        }
    }

    const pool = [...skillOf.keys()].filter(item => !pins.has(item));
    if (pool.length < 2) {
        throw new Error(`only ${pool.length} unpinned product(s) - nothing to shuffle`);
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
        bandNotes = [
            ...tiered.bands.map(b => `band ${b.band}: ${b.members.length} product(s) deranged among themselves`),
            ...tiered.warnings
        ];
    } else if (args.mode === 'shuffle') {
        const rand = mulberry32(args.seed);
        const perm = derangement(pool.length, rand);
        for (let i = 0; i < pool.length; i++) {
            mapping.set(pool[i], pool[perm[i]]);
        }
    } else {
        // chaos: independent uniform resample per product; resample (up to 50x, same
        // convention as drip) so no product keeps its own value by accident.
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
        throw new Error(`mode ${args.mode} produced no swaps - every progression band holds fewer than 2 eligible products (widen --skills or drop some --exclude)`);
    }

    const swaps = [...mapping.entries()].map(([was, now]) => ({
        was,
        wasSkill: skillOf.get(was)!,
        wasLevel: levelOf.get(was)!,
        wasId: objIds.get(was)!,
        now,
        nowSkill: skillOf.get(now)!,
        nowLevel: levelOf.get(now)!,
        nowId: objIds.get(now)!
    }));
    const crossSkill = swaps.filter(s => s.wasSkill !== s.nowSkill).length;

    console.log(`gathering randomizer: seed ${args.seed}, mode ${args.mode}, skills ${args.skills.join(',')}, quest pins ${pinQuestItems ? 'on' : 'off'}`);
    console.log(`pool: ${skillOf.size} distinct products (${args.skills.map(s => `${s} ${new Set(bySkill[s].map(p => p.item)).size}`).join(', ')}), ${pins.size} pinned vanilla, ${pool.length} shuffled`);
    for (const note of bandNotes) {
        console.log(`  ${note}`);
    }
    if (args.quiet) {
        console.log(`  (${swaps.length} swap(s) + ${pins.size} pin(s) not printed - --quiet; full table in ${SPOILER_PATH})`);
    } else {
        for (const s of swaps) {
            console.log(`  ${s.wasSkill.padEnd(11)} ${s.was} (lvl ${s.wasLevel}) -> ${s.now} (lvl ${s.nowLevel})${s.wasSkill !== s.nowSkill ? ` [${s.nowSkill}]` : ''}`);
        }
        for (const [item, reason] of pins) {
            console.log(`  pinned      ${item} (${reason})`);
        }
    }
    console.log(`${crossSkill}/${swaps.length} swaps land cross-skill`);

    if (args.dryRun) {
        console.log('dry run - nothing written');
        return;
    }

    fs.mkdirSync(path.dirname(AP_GATHER_JSON), { recursive: true });
    const map: Record<string, number> = {};
    for (const s of swaps) {
        map[String(s.wasId)] = s.nowId;
    }
    fs.writeFileSync(AP_GATHER_JSON, JSON.stringify({ seed: args.seed, mode: args.mode, skills: args.skills, map }, null, 2) + '\n');

    fs.mkdirSync(path.dirname(SPOILER_PATH), { recursive: true });
    fs.writeFileSync(
        SPOILER_PATH,
        JSON.stringify(
            {
                seed: args.seed,
                mode: args.mode,
                skills: args.skills,
                bandNotes,
                pinned: [...pins.entries()].map(([item, reason]) => ({ item, reason })),
                swaps
            },
            null,
            2
        ) + '\n'
    );

    console.log(`wrote ${AP_GATHER_JSON} (${swaps.length} swaps) and ${SPOILER_PATH}`);
    console.log('reseed = re-run this tool + restart the server (no pack rebuild); delete the JSON to restore vanilla gathering');
}

main();
