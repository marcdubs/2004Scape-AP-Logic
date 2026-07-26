import fs from 'fs';
import path from 'path';

import { CONTENT_ROOT, SCRIPTS_ROOT } from '../npc/NpcDripParser.js';
import { loadQuestCriticalItems } from '../drops/DropTableParser.js';
import { derangement, mulberry32 } from '../shared/Prng.js';
import { LEVEL_BANDS, type ProductLevel, bandFor, minLevels, readDbrowProducts, tieredSwaps } from '../shared/SkillTiers.js';

// Processing-skill randomization: shuffles which item each Cooking / Smithing /
// Crafting / Fletching recipe actually hands the player - smith some ore and get a
// cooked fish, cook some meat and get leather chaps. Same runtime-override design as
// RandomizeGathering.ts (its header comment is the fuller writeup of the shared
// architecture - read that first): the vanilla recipe scripts' FINAL delivery points
// are wrapped ONCE (in the overlay, one pack rebuild ever) with
// inv_add(inv, ap_process_swap($product), n), and the engine command reads the obj-id
// -> obj-id table this tool writes to engine/data/config/ap-process.json at runtime.
// Reseeding = rewrite the JSON + restart the server; deleting the JSON restores
// vanilla processing with no rebuild. A miss returns the input id unchanged (vanilla
// passthrough), so anything NOT in the table - quest-pinned products, unselected
// skills, every composite recipe below - simply behaves vanilla.
//
// Scope, decided with the user 2026-07-15 (fletching added same day per follow-up
// request): only DBTABLE-driven recipe systems are wrapped in this pass -
// cooking_generic (the bulk of Cooking: raw food -> cooked food), smithing.dbtable
// (bar -> weapon/armor), crafting's leather.dbtable + gem.dbtable (leather goods, gem
// cutting), and fletching's fletching_table (arrows/bolts/darts/bow-stringing, shared
// by 4 dbrow files) + fletch_bow_table (log -> unstrung bow, cut_logs.dbrow). Each has
// one or two clean chokepoints - the fletching wraps needed 2 sites (bolts.rs2) or a
// tiny destructure-first rewrite (bolts.rs2/bows.rs2 originally spliced
// db_getfield(...)'s two return values straight into inv_add's item+qty params;
// ap_process_swap only takes one obj, so those two sites now assign to local vars
// first, then wrap) - same shape as gathering's 12 wraps otherwise.
// Deliberately NOT wrapped (composite/multi-step recipes - the "product" is built
// across several intermediate items, e.g. pie_shell -> filled pie, so swapping an
// intermediate would corrupt the recipe rather than just reveal a surprise): cooking's
// pies/pizza/cakes/dough/stew/kebab/wine/oomlie/gnome specialties, crafting's
// jewellery/glass/pottery/spinning/snelm/studded/battlestaves/dye_cape, and
// fletching's ogre_arrows.rs2 (hardcoded shaft/headless/tip chain, no dbtable) and
// arrows.rs2's headless_arrow intermediate. A future pass could hand-wrap just the
// true FINAL inv_add in each of those files.
//
// What stays vanilla by design (only the PRIMARY successful product is wrapped):
// - cooking's burnt-item delivery (the burn roll, message, and burnt item are all
//   still vanilla - only what you get when you DON'T burn it is randomized, matching
//   gathering's "junk/failure outcomes stay vanilla" precedent (big-net junk catches,
//   the gem-cutting mis-hit's crushed_gemstone). This is enforced by only ever reading
//   the `burnt` field (never wrapped) - EXCEPT `cooking_burn_meat`, a standalone row
//   that models the deliberate "burn your own cooked meat" action (uncooked=
//   cooked_meat, its OWN `cooked` field is burnt_meat - the burn outcome delivered
//   through the normal product chokepoint because it's the row's only successful
//   path). Structurally excluded below (STRUCTURAL_POOL_EXCLUSIONS) so burnt_meat
//   never enters the pool as a key OR a replacement value, in every mode - it's also
//   a Witch's Potion ingredient (hetty_journal.rs2's inv_total gate) and correctly
//   flagged quest-critical, but quest-critical pins are mode-aware (see below) and
//   shuffle mode doesn't pin by default; this row needs to ALWAYS stay vanilla
//   because "burn cooked meat -> burnt meat" is the action itself, not just one of
//   several ways to obtain the item.
// - cooking's $additional_item (tins etc.), gnome half-baked reassignment (those
//   items aren't cooking_generic rows, so they're never in the pool - vanilla for
//   free, no special-casing needed)
// - every quantity expression is untouched - only the item identity is wrapped. A
//   recipe slot that hands out 5 of its product (bronze/iron/steel/mithril/adamant/
//   rune knives, nails x2) still hands out that many of whatever it got swapped to.
//   Same "structure stays put, content moves" philosophy as tiered drop
//   randomization's probability bands - accepted as part of the feature, not a bug.
//
// Item pools come from the game's own dbtable data - same "sample what the corpus
// actually contains" discipline as drop/gathering randomization.
//
// Usage (run from ../Server/engine):
//   npx tsx tools/process/RandomizeProcessing.ts [--seed <n>] [--mode shuffle|tiered|chaos]
//       [--skills cooking,smithing,crafting,fletching] [--exclude <item,item,...>]
//       [--pin-quest-items] [--no-quest-pins] [--dry-run]
//
// - shuffle (default): one derangement across the combined product pool - a bijection,
//   so every product is still obtainable from exactly one processing action, and no
//   product maps to itself.
// - tiered: the same derangement, but run separately inside each PROGRESSION BAND (see
//   tools/shared/SkillTiers.ts) - a level-1 recipe yields another level-1 product, a
//   level-85 one another level-85 product. Still cross-skill, still a bijection (per
//   band). Every recipe table here already carries its own level requirement
//   (levelrequired on cooking/smithing/leather, level on gem/fletching, and the level
//   embedded in fletch_bow_table's shortbow/longbow tuple), so the bands are read
//   straight out of the game's data.
// - chaos: every product independently resamples from the whole pool - duplicates
//   allowed, so some products can become unobtainable from processing entirely.
// - --skills: restrict which skills join the pool; products of unselected skills stay
//   vanilla (they're simply never written into the table).
// All three modes are kept behind --mode (rather than picking one) for the same reason
// as drops/gathering: they're Archipelago slot options.
//
// Quest-critical pinning is MODE-AWARE, same reasoning as gathering: shuffle and tiered
// are bijections (everything stays obtainable, a quest just needs its item made by a
// different recipe - the spoiler says which), so they don't pin by default. Chaos
// genuinely can orphan a product via independent resampling, so it pins by default.
// --pin-quest-items / --no-quest-pins override either way. Pinned products are also
// removed as REPLACEMENT values in shuffle mode (same reasoning as gathering: shuffle
// is a bijection, so keeping a pinned item's source vanilla while also handing it out
// elsewhere would double it up and orphan whatever product lost its slot).

const AP_PROCESS_JSON = path.join('data', 'config', 'ap-process.json');
const SPOILER_PATH = path.join('tools', 'process', 'process-seed.json');
const OBJ_PACK_PATH = path.join(CONTENT_ROOT, 'pack', 'obj.pack');

const SKILLS = ['cooking', 'smithing', 'crafting', 'fletching'] as const;
type Skill = (typeof SKILLS)[number];

function readLines(file: string): string[] {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

// Every loader returns the product AND the skill level its recipe demands - what
// `--mode tiered` buckets on. readDbrowProducts (tools/shared/SkillTiers.ts) does the
// block walking, skips the "null" sentinel products (e.g. cooking_generic_raw_oomlie's
// cooked=null - a "you can't cook this directly" row that always hits the
// cantcookmessage branch before any inv_add), and throws rather than silently
// defaulting a level it can't find.

// cooking_burn_meat is the deliberate "burn your own cooked meat" action, not a
// normal raw->cooked recipe - see the header comment. Excluding its BLOCK (rather
// than the item name burnt_meat) is deliberately narrow: it doesn't accidentally
// exclude some other future row that happens to also produce burnt_meat.
const COOKING_BLOCK_EXCLUSIONS = new Set(['cooking_burn_meat']);

function loadCookingProducts(): ProductLevel[] {
    return readDbrowProducts(path.join(SCRIPTS_ROOT, 'skill_cooking', 'configs', 'cooking_source', 'cooking_generic.dbrow'), {
        product: 'cooked',
        level: 'levelrequired',
        excludeBlocks: COOKING_BLOCK_EXCLUSIONS
    });
}

function loadSmithingProducts(): ProductLevel[] {
    return readDbrowProducts(path.join(SCRIPTS_ROOT, 'skill_smithing', 'configs', 'smithing', 'smithing.dbrow'), {
        product: 'product',
        level: 'levelrequired'
    });
}

function loadCraftingProducts(): ProductLevel[] {
    const leather = readDbrowProducts(path.join(SCRIPTS_ROOT, 'skill_crafting', 'configs', 'leather', 'leather.dbrow'), {
        product: 'product',
        level: 'levelrequired'
    });
    const gem = readDbrowProducts(path.join(SCRIPTS_ROOT, 'skill_crafting', 'configs', 'gem', 'gem.dbrow'), {
        product: 'cut_gem',
        level: 'level'
    });
    return [...leather, ...gem];
}

// fletching_table is shared by 4 dbrow files (arrows, bolts - both bolt-tip cutting
// AND bolt tipping share one table/file, darts, bows/stringing), all keyed off the
// same "product" column. fletch_bow_table (cut_logs.dbrow) is separate - log cutting
// produces an UNSTRUNG bow via its own shortbow/longbow columns, which is itself the
// "item" a fletching_table row later strings into a finished bow - two independent
// pool entries at two different script chokepoints, not a conflict.
function loadFletchingProducts(): ProductLevel[] {
    const configs = path.join(SCRIPTS_ROOT, 'skill_fletching', 'configs');
    const fletchingTable = ['arrows/arrows.dbrow', 'bolts/bolts.dbrow', 'darts/darts.dbrow', 'stringing/bows.dbrow'].flatMap(rel =>
        readDbrowProducts(path.join(configs, ...rel.split('/')), { product: 'product', level: 'level' })
    );
    // fletch_bow_table has no `level` column: each bow's requirement rides on the
    // product tuple itself (`data=shortbow,unstrung_oak_shortbow,20,165` = obj, level,
    // exp), so the level is read at tuple index 1.
    const cutLogs = path.join(configs, 'cut_logs', 'cut_logs.dbrow');
    const bowTable = [
        ...readDbrowProducts(cutLogs, { product: 'shortbow', level: 1 }),
        ...readDbrowProducts(cutLogs, { product: 'longbow', level: 1 })
    ];
    return [...fletchingTable, ...bowTable];
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
            const picked = (argv[++i] ?? '')
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);
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
        } else if (arg === '--export-pool') {
            args.exportPool = argv[++i] ?? 'data/config/ap-process-pool.json';
        } else {
            throw new Error(`unknown argument ${arg}`);
        }
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv);

    const bySkill: Record<Skill, ProductLevel[]> = {
        cooking: loadCookingProducts(),
        smithing: loadSmithingProducts(),
        crafting: loadCraftingProducts(),
        fletching: loadFletchingProducts()
    };

    // dedupe into one ordered pool (deterministic: skill order, then first occurrence).
    // A product made by several recipes (pearl bolt tips from small OR big oyster
    // pearls) takes the LOWEST level that makes it - the level it first becomes
    // reachable at, which is what a progression band models.
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
    // list, so it knows what every processing action will hand out while its fill is still
    // running - which is what lets item obtainability be real logic in AP mode.
    // Deterministic and mode-independent: pins are exported as data, not applied here.
    if (args.exportPool) {
        const questCriticalAll = loadQuestCriticalItems(new Set(skillOf.keys()));
        const poolOut = {
            _generated: 'tools/process/RandomizeProcessing.ts --export-pool - the UNSHUFFLED candidate pool',
            generatedAt: new Date().toISOString(),
            skills: args.skills,
            // `bands` ships alongside the per-product `band` so the apworld groups by the
            // string it was handed, in the order it was handed - the only way tiered mode
            // can be guaranteed not to drift between the two implementations.
            bands: LEVEL_BANDS.map(b => b.name),
            products: [...skillOf.entries()].map(([item, skill]) => ({
                item,
                skill,
                objId: objIds.get(item)!,
                level: levelOf.get(item)!,
                band: bandFor(levelOf.get(item)!)
            })),
            hardExcluded: {} as Record<string, string>,
            questCritical: [...questCriticalAll].sort()
        };
        fs.mkdirSync(path.dirname(path.resolve(args.exportPool)), { recursive: true });
        fs.writeFileSync(path.resolve(args.exportPool), JSON.stringify(poolOut, null, 2) + '\n');
        console.log(`wrote ${poolOut.products.length} product(s) to ${args.exportPool} (pool only - no table written)`);
        return;
    }

    // pins: quest-critical products (mode-aware - see the header comment) and
    // --exclude extras. Pinned products are left out of the table entirely = vanilla
    // passthrough, and removed as replacement values too (shuffle is a bijection).
    const pinQuestItems = args.questPins ?? args.mode === 'chaos';
    const questCritical = pinQuestItems ? loadQuestCriticalItems(new Set(skillOf.keys())) : new Set<string>();
    const pins = new Map<string, string>();
    for (const item of questCritical) {
        pins.set(item, 'quest-critical (inv_total/inv_del gate in a quest script)');
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
        // convention as drip/gathering) so no product keeps its own value by accident.
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

    console.log(`processing randomizer: seed ${args.seed}, mode ${args.mode}, skills ${args.skills.join(',')}, quest pins ${pinQuestItems ? 'on' : 'off'}`);
    console.log(`pool: ${skillOf.size} distinct products (${args.skills.map(s => `${s} ${new Set(bySkill[s].map(p => p.item)).size}`).join(', ')}), ${pins.size} pinned vanilla, ${pool.length} shuffled`);
    for (const note of bandNotes) {
        console.log(`  ${note}`);
    }
    for (const s of swaps) {
        console.log(`  ${s.wasSkill.padEnd(9)} ${s.was} (lvl ${s.wasLevel}) -> ${s.now} (lvl ${s.nowLevel})${s.wasSkill !== s.nowSkill ? ` [${s.nowSkill}]` : ''}`);
    }
    for (const [item, reason] of pins) {
        console.log(`  pinned    ${item} (${reason})`);
    }
    console.log(`${crossSkill}/${swaps.length} swaps land cross-skill`);

    if (args.dryRun) {
        console.log('dry run - nothing written');
        return;
    }

    fs.mkdirSync(path.dirname(AP_PROCESS_JSON), { recursive: true });
    const map: Record<string, number> = {};
    for (const s of swaps) {
        map[String(s.wasId)] = s.nowId;
    }
    fs.writeFileSync(AP_PROCESS_JSON, JSON.stringify({ seed: args.seed, mode: args.mode, skills: args.skills, map }, null, 2) + '\n');

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

    console.log(`wrote ${AP_PROCESS_JSON} (${swaps.length} swaps) and ${SPOILER_PATH}`);
    console.log('reseed = re-run this tool + restart the server (no pack rebuild); delete the JSON to restore vanilla processing');
}

main();
