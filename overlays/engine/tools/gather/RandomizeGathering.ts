import fs from 'fs';
import path from 'path';

import { CONTENT_ROOT, SCRIPTS_ROOT } from '../npc/NpcDripParser.js';
import { loadQuestCriticalItems } from '../drops/DropTableParser.js';
import { derangement, mulberry32 } from '../shared/Prng.js';

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
//   npx tsx tools/gather/RandomizeGathering.ts [--seed <n>] [--mode shuffle|chaos]
//       [--skills mining,fishing,woodcutting] [--exclude <item,item,...>]
//       [--pin-quest-items] [--no-quest-pins] [--dry-run]
//
// - shuffle (default): one derangement across the combined product pool - a bijection,
//   so every product is still obtainable from exactly one gathering action, and no
//   product maps to itself.
// - chaos: every product independently resamples from the whole pool - duplicates
//   allowed, so some products can become unobtainable from gathering entirely.
// - --skills: restrict which skills join the pool; products of unselected skills stay
//   vanilla (they're simply never written into the table).
// Both modes are kept behind --mode (rather than picking one) for the same reason as
// drop randomization: the user wants these as Archipelago slot options eventually.
//
// Quest-critical pinning is MODE-AWARE, unlike drop randomization's always-on pin.
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

function loadMiningProducts(): string[] {
    const out: string[] = [];
    for (const line of readLines(path.join(SCRIPTS_ROOT, 'skill_mining', 'configs', 'mine.dbrow'))) {
        const m = line.trim().match(/^data=rock_output,([a-zA-Z0-9_]+)$/);
        if (m) {
            out.push(m[1]);
        }
    }
    return out;
}

function loadWoodcuttingProducts(): string[] {
    const out: string[] = [];
    for (const line of readLines(path.join(SCRIPTS_ROOT, 'skill_woodcutting', 'configs', 'trees.dbrow'))) {
        const m = line.trim().match(/^data=product,([a-zA-Z0-9_]+)$/);
        if (m) {
            out.push(m[1]);
        }
    }
    return out;
}

// fishing has no product dbtable - fish are literal args at ~fish_roll/~fish_roll_loc
// call sites (args 1+2; arg 3+ is equipment/bait), plus the big-net fish that
// memberfish.rs2's overlay wraps directly in ap_gather_swap(<literal>). Parsed from
// the LIVE (overlaid) fishing scripts, which is also a nice property: the pool is by
// construction "whatever delivery points are actually wrapped".
const FISH_ROLL_RE = /~fish_roll(?:_loc)?\(\s*([a-zA-Z0-9_$]+)\s*,\s*([a-zA-Z0-9_$]+)/g;
const GATHER_WRAP_RE = /ap_gather_swap\(([a-zA-Z_][a-zA-Z0-9_]*)\)/g;

function loadFishingProducts(): string[] {
    const out: string[] = [];
    const root = path.join(SCRIPTS_ROOT, 'skill_fishing', 'scripts');
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.name.endsWith('.rs2')) {
                const text = fs.readFileSync(full, 'utf8');
                for (const m of text.matchAll(FISH_ROLL_RE)) {
                    for (const arg of [m[1], m[2]]) {
                        if (arg !== 'null' && !arg.startsWith('$')) {
                            out.push(arg);
                        }
                    }
                }
                for (const m of text.matchAll(GATHER_WRAP_RE)) {
                    out.push(m[1]);
                }
            }
        }
    }
    return out;
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
        mode: 'shuffle' as 'shuffle' | 'chaos',
        skills: [...SKILLS] as Skill[],
        exclude: new Set<string>(),
        questPins: null as boolean | null, // null = decide by mode (shuffle off, chaos on)
        dryRun: false
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
            if (mode !== 'shuffle' && mode !== 'chaos') {
                throw new Error(`unknown --mode ${mode} (expected shuffle|chaos)`);
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
        } else {
            throw new Error(`unknown argument ${arg}`);
        }
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv);

    const bySkill: Record<Skill, string[]> = {
        mining: loadMiningProducts(),
        fishing: loadFishingProducts(),
        woodcutting: loadWoodcuttingProducts()
    };

    // dedupe into one ordered pool (deterministic: skill order, then first occurrence -
    // limestone appears on 3 rocks, logs on 2 trees, mackerel at 2 big-net slots).
    const skillOf = new Map<string, Skill>();
    for (const skill of args.skills) {
        for (const item of bySkill[skill]) {
            if (!skillOf.has(item)) {
                skillOf.set(item, skill);
            }
        }
    }
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

    const rand = mulberry32(args.seed);
    const mapping = new Map<string, string>();
    if (args.mode === 'shuffle') {
        const perm = derangement(pool.length, rand);
        for (let i = 0; i < pool.length; i++) {
            mapping.set(pool[i], pool[perm[i]]);
        }
    } else {
        // chaos: independent uniform resample per product; resample (up to 50x, same
        // convention as drip) so no product keeps its own value by accident.
        for (const item of pool) {
            let picked = item;
            for (let i = 0; i < 50 && picked === item; i++) {
                picked = pool[Math.floor(rand() * pool.length)];
            }
            mapping.set(item, picked);
        }
    }

    const swaps = [...mapping.entries()].map(([was, now]) => ({
        was,
        wasSkill: skillOf.get(was)!,
        wasId: objIds.get(was)!,
        now,
        nowSkill: skillOf.get(now)!,
        nowId: objIds.get(now)!
    }));
    const crossSkill = swaps.filter(s => s.wasSkill !== s.nowSkill).length;

    console.log(`gathering randomizer: seed ${args.seed}, mode ${args.mode}, skills ${args.skills.join(',')}, quest pins ${pinQuestItems ? 'on' : 'off'}`);
    console.log(`pool: ${skillOf.size} distinct products (${args.skills.map(s => `${s} ${new Set(bySkill[s]).size}`).join(', ')}), ${pins.size} pinned vanilla, ${pool.length} shuffled`);
    for (const s of swaps) {
        console.log(`  ${s.wasSkill.padEnd(11)} ${s.was} -> ${s.now}${s.wasSkill !== s.nowSkill ? ` (${s.nowSkill})` : ''}`);
    }
    for (const [item, reason] of pins) {
        console.log(`  pinned      ${item} (${reason})`);
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
