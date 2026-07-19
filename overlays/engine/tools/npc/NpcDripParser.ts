import fs from 'fs';
import path from 'path';

// Parses content/scripts/**/*.npc config files for cosmetic model# lines. Not a
// general .npc parser - it only looks for `[block]` headers (to tag each occurrence
// with its owning npc debugname) and `model<N>=<value>` lines.
//
// A model value is only a shuffle candidate if it matches the composable human body
// part naming convention (`man_<part>_<detail>` / `woman_<part>_<detail>`, e.g.
// `man_torso_basic`, `woman_hat_witch`) - confirmed against every .npc in the content
// tree (see session notes). Creature-specific models (`npc_troll_head`,
// `model_2909_npc`, ...) don't match and are left untouched, which is what keeps
// monsters and quest NPCs with bespoke models from being corrupted into nonsense.
//
// Held-item models (`human_weapons_*` / `human_weaponsextra_*`) are handled
// separately by parseWeaponGroups()/loadWeaponUniverse() below - they need
// group-level (per-NPC) reasoning to keep two-handed weapons out of shield slots,
// unlike body parts which are fully independent per occurrence.
//
// Every .npc file is CRLF (see readNpcSource) and each config line is a bare
// `key=value` - no inline comments, no inheritance (`readConfigs` in the engine's own
// pack tooling treats duplicate block names as a hard build error), so a line-indexed
// read-modify-write is safe and exact.
//
// This file also hosts the file-discovery/backup helpers shared by every .npc-config
// randomizer (currently RandomizeDrip.ts and RandomizeShops.ts) - CONTENT_ROOT,
// SCRIPTS_ROOT, BACKUP_ROOT, findNpcFiles(), readNpcSource(), ensureNpcBackup(). All
// of them touch the same underlying .npc files, so they share ONE backup convention
// and ONE "write onto the current live file, not a fresh copy of the backup" rule -
// see ensureNpcBackup()'s comment for why the latter matters.

export const CONTENT_ROOT = path.resolve(process.cwd(), '../content');
export const SCRIPTS_ROOT = path.join(CONTENT_ROOT, 'scripts');
export const BACKUP_ROOT = path.join(CONTENT_ROOT, '.ap-backup', 'scripts');
const MODEL_PACK_PATH = path.join(CONTENT_ROOT, 'pack', 'model.pack');
const MODELS_ROOT = path.join(CONTENT_ROOT, 'models');

export type Gender = 'man' | 'woman';

// one `model<N>=<value>` occurrence in a .npc file.
export type ModelSlot = {
    file: string; // relative to the root passed to parseSlots (backup root or SCRIPTS_ROOT)
    line: number; // 0-based line index, for exact in-place replacement
    block: string; // npc debugname, e.g. "banker1"
    field: string; // "model3"
    gender: Gender;
    category: string; // "torso", "hat", "jaw", ...
    value: string; // "man_torso_basic"
};

const MODEL_LINE_RE = /^model(\d+)=(.+)$/;
const SWAPPABLE_RE = /^(man|woman)_([a-z]+)_.+$/;

// Some model.pack values pass the (man|woman)_<part>_<detail> naming convention but
// are NOT safe general-purpose replacements for that slot - found from real in-game
// reports, not guessed, same "check the data" discipline as bodySetFor() below. Used
// by both parseSlots() (so an NPC's OWN occurrence of one of these is never treated as
// a swappable slot - left vanilla, same treatment as the human_weaponsextra_* companion
// pieces) and loadModelUniverse() (so it can never be sampled INTO any other slot
// either):
// - `*_torso_backpack`: vanilla's only occurrence (quest_death.npc's death_sherpa /
//   Tenzing) uses it ALONGSIDE a separate real torso value in the same block
//   (model3=man_torso_basic, model9=man_torso_backpack) - it's a layered accessory, not
//   a substitute for full torso coverage. Landing it in an NPC's primary (and only)
//   torso slot leaves them with no actual body mesh - reported as "no torso" on the
//   Tanner NPC.
// - `*_<part>_demon` (arms/legs/feet/hands all have one): zero vanilla NPC uses ANY of
//   these, in ANY category - checked all of them before excluding anything. Unlike the
//   ~120 OTHER never-worn model.pack values (mostly unused holiday hats/hairstyles,
//   exactly the kind of extra variety this tool is supposed to surface), a detail
//   that's unused across EVERY category it appears in is a strong signal it's a
//   reserved, unvalidated asset for an actual Demon-type creature rather than generic
//   human wear. Reported as "everyone has demon hands" once it started appearing at
//   its ordinary ~1/7 share of the (small, 7-value) hands pool - not a sampling-bias
//   bug, just a visually jarring value that shouldn't have been in the pool at all.
// - `*_model_<id>` placeholder names (man_legs_model_270, man_arms_model_168, ...):
//   the name literally embeds the model id, i.e. nobody ever identified what the
//   asset IS - it only pattern-matched into a category because someone prefixed it
//   with one. The ones that turn out to have geometry are bespoke one-off pieces, not
//   general-purpose body kit: man_legs_model_270 is the Genie's floating smoke-tail,
//   layered in vanilla as a SECOND legs value on macro_geni (model7=man_legs_crossed +
//   model8=man_legs_model_270 - the exact torso_backpack shape again). Standing alone
//   as an NPC's only legs model it renders as nothing - reported as "Monks of Entrana
//   have invisible legs". We can't visually vet the rest of the family, and a name
//   that says "unidentified model" is the same un-vetted-asset signal as the demon
//   family, so the whole family is excluded - from parseSlots() too, which usefully
//   keeps the Genie's own tail slot permanently vanilla. This also covers weapons
//   (human_weapons_model_526 is one half of vanilla's two-piece excalibur, see
//   loadWeaponUniverse) - hasPlaceholderName() is checked there separately since
//   isNeverSwappable() only sees (man|woman)_* values.
// - `man_legs_stitches`: same torso_backpack shape again - vanilla's only occurrences
//   (quest_viking.npc, viking_olaf and 4 other blocks) all use it as a high-numbered
//   accessory slot layered ALONGSIDE a real legs value (model6=man_legs_viking +
//   model9=man_legs_stitches, same pattern as model8=man_torsoextra_shirt2 /
//   model11=man_torsoextra_cloak_plain in that same block) - it's a decorative patch,
//   not full leg coverage. Landing it in an NPC's primary (and only) legs slot leaves
//   them with no leg mesh - reported as "Lowe has invisible legs" (Varrock archery shop
//   owner, drip-seed.json shows model6 man_legs_elfbootsbasic -> man_legs_stitches).
//   Only one model.pack entry has this name (no siblings to check across categories).
export function hasPlaceholderName(value: string): boolean {
    return /_model_\d+$/.test(value);
}

function isNeverSwappable(value: string): boolean {
    if (value === 'man_torso_backpack' || value === 'woman_torso_backpack') {
        return true;
    }
    if (value === 'man_legs_stitches' || value === 'woman_legs_stitches') {
        return true;
    }
    if (hasPlaceholderName(value)) {
        return true;
    }
    const detail = value.replace(/^(man|woman)_[a-z]+_/, '');
    return detail === 'demon';
}

// model.pack is only an id=name CATALOG - having an entry there does not mean the
// model's geometry exists. 34 of its (man|woman)_* names plus one human_weapons_* name
// have no .ob2 source anywhere under content/models: mostly placeholder names
// (man_torso_model_300, woman_head_model_402, ...) but also a few real-looking ones
// (woman_torso_leatherfat, woman_legs_crossed, woman_feet_spurboots,
// man_torsoextra_spotty_cloak, woman_necklaces_style2) that slipped past the
// isNeverSwappable() curation above. The pack build resolves the name to its id fine
// and only prints a buried "missing model" warning (tools/pack/graphics/pack.ts), but
// the client then can't build the NPC's composed model at all - the whole NPC renders
// as nothing while its server-side yellow minimap dot survives. Found via user report
// ("Betty in Port Sarim is completely invisible"); the same seed had assigned dataless
// models to 272 slots across ~200 NPC blocks. No vanilla NPC wears any of these, so
// gating the sample-INTO pools (loadModelUniverse/loadWeaponUniverse) is sufficient -
// parseSlots() doesn't need it.
let modelDataNames: Set<string> | null = null;
function hasModelData(value: string): boolean {
    if (!modelDataNames) {
        modelDataNames = new Set();
        const stack = [MODELS_ROOT];
        while (stack.length) {
            const dir = stack.pop()!;
            if (!fs.existsSync(dir)) {
                continue;
            }
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    stack.push(path.join(dir, entry.name));
                } else if (entry.name.endsWith('.ob2')) {
                    modelDataNames.add(entry.name.slice(0, -'.ob2'.length));
                }
            }
        }
    }
    return modelDataNames.has(value);
}

function walk(dir: string, out: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, out);
        } else if (entry.name.endsWith('.npc')) {
            out.push(full);
        }
    }
}

// recursively finds every .npc file under root, sorted for deterministic ordering
// (the seed only reproduces the same layout if file discovery order is stable).
export function findNpcFiles(root: string): string[] {
    const out: string[] = [];
    if (fs.existsSync(root)) {
        walk(root, out);
    }
    return out.sort();
}

// backs up every live .npc file the first time it's touched, so any randomizer's
// output always derives from pristine vanilla instead of compounding onto a previous
// run's output. Per-file (not per-directory) since these files are scattered across
// the whole content tree - a partial/interrupted first run still leaves every
// untouched file's backup intact. Shared across every .npc-config tool (drip,
// shops, ...) so they all agree on one pristine baseline.
export function ensureNpcBackup(): number {
    let created = 0;
    for (const file of findNpcFiles(SCRIPTS_ROOT)) {
        const rel = path.relative(SCRIPTS_ROOT, file);
        const backupPath = path.join(BACKUP_ROOT, rel);
        if (fs.existsSync(backupPath)) {
            continue;
        }
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(file, backupPath);
        created++;
    }
    return created;
}

// copies every backed-up .npc file back onto its live path, undoing every randomizer's
// output. NOT called by any individual tool automatically - see RegenerateAll.ts for
// why a per-tool "restore before I run" would reintroduce the exact cross-tool
// data-loss bug ensureNpcBackup()'s "derive values from backup, write onto live"
// convention was built to prevent (running drip after shops would erase shops' edits,
// and vice versa, if each tool wiped to pristine on its own before doing its own
// thing). Restoring is only safe as a step in a pipeline that then re-runs every tool
// that should be part of the seed, atomically.
export function restoreNpcBackup(): number {
    let restored = 0;
    for (const file of findNpcFiles(BACKUP_ROOT)) {
        const rel = path.relative(BACKUP_ROOT, file);
        const livePath = path.join(SCRIPTS_ROOT, rel);
        fs.copyFileSync(file, livePath);
        restored++;
    }
    return restored;
}

// content files are CRLF - normalize on read, caller restores CRLF on write (see the
// same convention in EntranceParser.ts's readSource).
export function readNpcSource(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

export function parseSlots(filePath: string, relFile: string): ModelSlot[] {
    const lines = readNpcSource(filePath).split('\n');
    const slots: ModelSlot[] = [];
    let block = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // block headers are always literal `[name]` at line start - same detection the
        // engine's own config crawler uses (see tools/pack/Parse.ts:readConfigs).
        if (line.startsWith('[')) {
            block = line.slice(1, line.lastIndexOf(']'));
            continue;
        }

        const modelMatch = line.match(MODEL_LINE_RE);
        if (!modelMatch) {
            continue;
        }

        const value = modelMatch[2];
        const swapMatch = value.match(SWAPPABLE_RE);
        if (!swapMatch || isNeverSwappable(value)) {
            continue;
        }

        slots.push({
            file: relFile,
            line: i,
            block,
            field: `model${modelMatch[1]}`,
            gender: swapMatch[1] as Gender,
            category: swapMatch[2],
            value
        });
    }

    return slots;
}

// the full universe of swappable model values, keyed by "gender_category" (e.g.
// "man_hat") - every entry the cache actually has, not just the ones some NPC happens
// to already be wearing. content/pack/model.pack is a static id=name catalog checked
// into vanilla content (unlike script.pack/map.pack, it's not build-generated and not
// gitignored), so this is safe to read directly.
//
// This is deliberately a *bigger* pool than parseSlots() finds across .npc files -
// e.g. woman_hat has 23 valid models in the cache but vanilla NPCs only ever wear 8 of
// them. Sampling from here instead of just deranging what's already in use is what
// makes previously-unseen combinations possible.
export function loadModelUniverse(): Map<string, string[]> {
    const bySwapKey = new Map<string, Set<string>>();
    if (!fs.existsSync(MODEL_PACK_PATH)) {
        return new Map();
    }

    const lines = fs.readFileSync(MODEL_PACK_PATH, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq === -1) {
            continue;
        }
        const value = line.slice(eq + 1).trim();
        const swapMatch = value.match(SWAPPABLE_RE);
        if (!swapMatch || isNeverSwappable(value) || !hasModelData(value)) {
            continue;
        }
        const key = `${swapMatch[1]}_${swapMatch[2]}`;
        (bySwapKey.get(key) ?? bySwapKey.set(key, new Set()).get(key)!).add(value);
    }

    const out = new Map<string, string[]>();
    for (const [key, values] of bySwapKey) {
        out.set(key, [...values].sort());
    }
    return out;
}

// one held-item `model<N>=<value>` occurrence in a .npc file - same shape as
// ModelSlot but without gender/category, since weapons/props don't follow that
// naming convention.
export type WeaponSlot = {
    file: string;
    line: number;
    block: string;
    field: string;
    value: string;
};

// every weapon-slot occurrence within one npc block, kept together because deciding
// what each slot becomes needs to know about the others (e.g. "this is the shield
// half of a weapon+shield pair").
export type WeaponGroup = {
    file: string;
    block: string;
    slots: WeaponSlot[];
};

const WEAPON_LINE_RE = /^model(\d+)=(human_weapons_.+|human_weaponsextra_.+)$/;

export function parseWeaponGroups(filePath: string, relFile: string): WeaponGroup[] {
    const lines = readNpcSource(filePath).split('\n');
    const groups: WeaponGroup[] = [];
    let block = '';
    let current: WeaponGroup | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('[')) {
            block = line.slice(1, line.lastIndexOf(']'));
            current = null;
            continue;
        }

        const match = line.match(WEAPON_LINE_RE);
        if (!match) {
            continue;
        }

        if (!current) {
            current = { file: relFile, block, slots: [] };
            groups.push(current);
        }
        current.slots.push({ file: relFile, line: i, block, field: `model${match[1]}`, value: match[2] });
    }

    return groups;
}

// classification is by substring on the value's own name, validated against every
// weapon+shield pairing vanilla actually uses (see session notes) - e.g. "spear"
// pairs with "viking_shield" in vanilla, so spear is NOT in the two-handed set here
// even though it reads as two-handed in plain English; "warhammer" likewise pairs
// with a shield in vanilla despite real-RS warhammers being 2h weapons - this is a
// purely cosmetic model system, not the real equipment/combat rules, so vanilla's own
// precedent wins over genre convention wherever they'd disagree.
const SHIELD_NAME_RE = /shield/;
const TWO_HANDED_NAME_RE = /bow|staff|halberd|scythe|harpoon/;

export function isShieldName(value: string): boolean {
    return SHIELD_NAME_RE.test(value);
}

export function isTwoHandedName(value: string): boolean {
    return !isShieldName(value) && TWO_HANDED_NAME_RE.test(value);
}

export type WeaponUniverse = { shield: string[]; twoHand: string[]; oneHand: string[] };

// every human_weapons_* value in the cache (weapons AND generic held props like
// human_weapons_tankard/human_weapons_fishingrod - they occupy the same slot and
// vanilla already mixes them, e.g. a farmer holding a chicken drumstick), split into
// shield / two-handed / one-handed pools. human_weaponsextra_* (the staff-orb
// companion piece) is deliberately excluded - see RandomizeDrip.ts for why groups
// containing one are left vanilla entirely rather than handled here.
export function loadWeaponUniverse(): WeaponUniverse {
    const universe: WeaponUniverse = { shield: [], twoHand: [], oneHand: [] };
    if (!fs.existsSync(MODEL_PACK_PATH)) {
        return universe;
    }

    const seen = new Set<string>();
    const lines = fs.readFileSync(MODEL_PACK_PATH, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq === -1) {
            continue;
        }
        const value = line.slice(eq + 1).trim();
        if (!value.startsWith('human_weapons_') || seen.has(value) || !hasModelData(value) || hasPlaceholderName(value)) {
            continue;
        }
        seen.add(value);

        if (isShieldName(value)) {
            universe.shield.push(value);
        } else if (isTwoHandedName(value)) {
            universe.twoHand.push(value);
        } else {
            universe.oneHand.push(value);
        }
    }

    universe.shield.sort();
    universe.twoHand.sort();
    universe.oneHand.sort();
    return universe;
}

// torso/arms/legs pieces are sculpted as matched pairs per armor "set" - the client's
// Model.combineForAnim() has no positional/hiding logic (confirmed by reading
// webclient/src/dash3d/Model.ts and NpcType.ts directly - it's a pure unordered vertex/
// face concatenation), so this isn't an engine bug, it's a geometry-authoring fact the
// swap pools didn't originally account for. Found by counting every torso<->arms
// pairing that exists anywhere in vanilla .npc content before writing any
// classification code (same discipline as the weapon/shield check above): every one of
// the 34 vanilla `man_arms_platemail` occurrences pairs with a plate-family torso
// (`platemail`/`platemail_trim`/`platemailfat`/`paladin`), zero pair with a generic one
// (chainmail, leather, basic, ...); conversely `man_torso_chainmail` pairs with
// bare/basic/buff/leather/longsleeves arms in every one of its 17 occurrences and NEVER
// with platemail arms. torso<->legs shows the same pattern (38/49 platemail-torso
// occurrences pair with platemail legs). feet/hands were checked too and do NOT need
// this treatment - boots/gloves/basic dominate regardless of torso material in vanilla,
// the only "set" variant either category has is split_bark_armour's own dedicated
// piece, and that's a single vanilla occurrence, low-stakes either way.
//
// "forplate" arms values (bareforplate/basicforplate/fatforplate/longsleevesforplate/
// longsleevesforplate2) are their own self-documenting signal - the name literally says
// what they're for - and vanilla data confirms it: they only ever appear alongside
// plate-family torsos, same as literal `arms_platemail`. `paladin` torso and
// `armouredskirt`(_trim) legs don't share the "platemail" substring with their category
// siblings, but the pairing data puts them in the same family (paladin torso: 11/19
// occurrences pair with platemail-family arms; armouredskirt legs pairs with
// platemail torso in vanilla) - included on data, not on the name alone.
//
// Returns null for "generic" values (the vast majority - bare/basic/buff/leather/tatty/
// fat/chainmail/...), which vanilla mixes freely with each other and which must never
// be paired with a protected-set value from a different category (that's exactly the
// combination the user found broken: chainmail torso + platemail arms).
export function bodySetFor(value: string): string | null {
    const detail = value.replace(/^(man|woman)_[a-z]+_/, '');
    if (detail.startsWith('plaguesuit')) {
        return 'plaguesuit';
    }
    if (detail.startsWith('split_bark_armour')) {
        return 'split_bark_armour';
    }
    if (detail.startsWith('platemail') || detail === 'paladin' || detail.startsWith('armouredskirt') || detail.includes('forplate')) {
        return 'platemail';
    }
    return null;
}

// the three categories where set-mismatch is an actual visual problem (see
// bodySetFor's comment) - hat/jaw/head/feet/hands/torsoextra/necklaces/etc. keep the
// existing fully-independent per-category sampling in RandomizeDrip.ts.
export const BODY_SET_CATEGORIES = new Set(['torso', 'arms', 'legs']);
