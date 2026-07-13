import fs from 'fs';
import path from 'path';

// Parses content/scripts/**/*.npc config files for cosmetic model# lines. Not a
// general .npc parser - it only looks for `[block]` headers (to tag each occurrence
// with its owning npc debugname) and `model<N>=<value>` lines. See
// docs/archipelago-ideas.md #3 ("NPC drip randomization").
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

export const CONTENT_ROOT = path.resolve(process.cwd(), '../content');
export const SCRIPTS_ROOT = path.join(CONTENT_ROOT, 'scripts');
const MODEL_PACK_PATH = path.join(CONTENT_ROOT, 'pack', 'model.pack');

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
        if (!swapMatch) {
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
        if (!swapMatch) {
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
        if (!value.startsWith('human_weapons_') || seen.has(value)) {
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
