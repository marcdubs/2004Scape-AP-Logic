import fs from 'fs';
import path from 'path';

import { BACKUP_ROOT, SCRIPTS_ROOT, readNpcSource } from '../npc/NpcDripParser.js';

// Parses content/scripts/drop tables/scripts/*.rs2 for weighted loot-drop cascades. See
// docs/archipelago-ideas.md #2 ("NPC drop randomization") and the "Domain knowledge:
// drop randomization" section of docs/lessons-learned.md for the full design reasoning.
//
// The shape (confirmed by reading ~20 of the 73 files before writing any parsing code,
// same "check the data first" discipline as drip/shops): each `[ai_queue3,name]` /
// `[label,name]` block optionally contains ONE weighted cascade -
// `def_int $var = random(total);` followed by a chain of
// `if ($var < N) BODY` / `} else if ($var < N) BODY` - where BODY is either a single
// bare statement (no braces, e.g. werewolf.rs2) or a brace-delimited block that may
// itself contain nested conditionals (e.g. `if (map_members = ^true) {...} else {...}`
// gating two alternate obj_add calls at the same weight). `total` varies per cascade
// (128 is by far the most common, but 6/8/65/138/512 all occur), so **probability is
// weight/total, never a raw weight number** - a raw weight of 100 means very different
// things in a /128 vs a /512 cascade. Getting this normalization right matters for the
// tiered swap mode in RandomizeDrops.ts.
//
// Parsing strategy: rather than tracking brace depth character-by-character (fragile
// across both body styles above), find every branch header's *text position* via regex
// and treat the span between consecutive headers as that branch's body, scanning
// obj_add(...) calls within the span regardless of how it's bracketed. This uniformly
// handles braced/brace-less/nested-conditional bodies. Verified against all 73 files via
// a throwaway survey script before writing this: 1127 slots, 243 distinct items, 63
// cascades across 119 blocks - matches manual eyeballing of a dozen sample files.
//
// Only obj_add(npc_coord, ITEM, QTY, ^lootdrop_duration) calls with a bare-identifier
// ITEM and literal-int QTY are captured. This deliberately excludes, with no per-file
// exclusion list needed:
// - `~procname` calls (shared reward sub-tables like ~randomherb/~randomjewel - out of
//   scope per the user's own scoping decision, left as opaque calls).
// - `npc_param(death_drop)` (the guaranteed-drop line always precedes the cascade, so
//   it's outside any cascade span - handled as a separate axis, see parseDeathDropSlots
//   below).
// - non-literal quantities like `add(random(335), 1)` (one occurrence, kalphite_queen's
//   iron_arrow slot) - the regex just doesn't match, so that line is silently left
//   vanilla rather than guessed at.
// - anything outside a `def_int $var = random(...)` cascade entirely, e.g. rat.rs2's
//   quest-gated rats_tail drop or jailer.rs2's fixed jail_key drop - both are guaranteed
//   drops with their own conditions, not part of a weighted table.

export const DROP_SCRIPTS_DIR = path.join(SCRIPTS_ROOT, 'drop tables', 'scripts');
export const DROP_BACKUP_DIR = path.join(BACKUP_ROOT, 'drop tables', 'scripts');
const QUESTS_DIR = path.join(SCRIPTS_ROOT, 'quests');

export type DropSlot = {
    file: string; // relative to the root passed to parseDropSlots (backup root or DROP_SCRIPTS_DIR)
    block: string; // npc debugname, e.g. "bandit"
    line: number; // 0-based line index of the obj_add(...) call, for exact in-place replacement
    raw: string; // the exact matched "obj_add(npc_coord, item, qty, ^lootdrop_duration)" substring -
    // lines here carry arbitrary surrounding code (if/else-if prefixes, trailing
    // comments, brace-less single-line branches), so edits do a targeted substring
    // replace of this text within the line rather than a whole-line replace (unlike
    // .npc config lines, which ARE safe to replace wholesale - see NpcDripParser.ts).
    item: string;
    qty: number;
    weight: number; // threshold[i] - threshold[i-1] within its own cascade
    total: number; // the cascade's random(total) denominator
    probability: number; // weight / total - the number that's actually comparable across cascades
    bucket: string;
};

// rarity tiers by probability, derived from the actual corpus distribution (not
// guessed): 1127 slots bucketed into roughly 300/550/170/80/30 across these five bands,
// which reads as a sane common/uncommon/rare/ultra-rare curve when spot-checked against
// familiar drops (coins slots land in verycommon/common, rune sets in
// rare/uncommon, dragon-tier one-offs in ultra).
export const BUCKETS: { name: string; max: number }[] = [
    { name: 'ultra', max: 0.01 },
    { name: 'rare', max: 0.04 },
    { name: 'uncommon', max: 0.1 },
    { name: 'common', max: 0.25 },
    { name: 'verycommon', max: Infinity }
];

export function bucketFor(probability: number): string {
    for (const b of BUCKETS) {
        if (probability <= b.max) {
            return b.name;
        }
    }
    return BUCKETS[BUCKETS.length - 1].name;
}

const BLOCK_HEADER_RE = /^\[(ai_queue[0-9]|label|proc),([a-zA-Z0-9_]+)\]/;
const DEF_RANDOM_RE = /def_int \$([a-zA-Z_0-9]+) = random\((\d+)\);/g;
const OBJ_ADD_RE = /obj_add\(npc_coord,\s*([a-zA-Z0-9_~]+),\s*([0-9]+),\s*\^lootdrop_duration\)/g;
const OBJ_ADD_LINE_RE = /obj_add\(npc_coord,\s*[a-zA-Z0-9_~]+,\s*[0-9]+,\s*\^lootdrop_duration\)/;

// finds the CURRENT obj_add(...) call text on a single line, whatever it currently
// holds - vanilla or already reassigned by a prior run. DropSlot.raw (captured at
// PARSE time from the pristine backup) must NOT be used to locate the text to replace
// at edit time: on the very first run the live file still matches the backup so it
// works, but on any reseed the live line already contains the PREVIOUS run's shuffled
// text, so searching for the stale vanilla substring finds nothing and the edit
// silently no-ops. Found via a real reseed (tiered -> chaos, same seed) where the
// spoiler showed correctly-computed new values that never actually reached the live
// `.rs2` file.
export function findObjAddCall(lineText: string): string | null {
    const m = lineText.match(OBJ_ADD_LINE_RE);
    return m ? m[0] : null;
}

function walkRs2(dir: string, out: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkRs2(full, out);
        } else if (entry.name.endsWith('.rs2')) {
            out.push(full);
        }
    }
}

export function findDropScriptFiles(root: string): string[] {
    const out: string[] = [];
    if (fs.existsSync(root)) {
        walkRs2(root, out);
    }
    return out.sort();
}

// same per-file backup convention as ensureNpcBackup() in NpcDripParser.ts, but scoped
// to the drop-table script directory only (a different file extension/subtree, so it
// gets its own backup helper - the .npc side reuses ensureNpcBackup() directly, see
// parseDeathDropSlots below).
export function ensureDropScriptBackup(): number {
    let created = 0;
    for (const file of findDropScriptFiles(DROP_SCRIPTS_DIR)) {
        const rel = path.relative(DROP_SCRIPTS_DIR, file);
        const backupPath = path.join(DROP_BACKUP_DIR, rel);
        if (fs.existsSync(backupPath)) {
            continue;
        }
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(file, backupPath);
        created++;
    }
    return created;
}

// copies every backed-up drop-table script back onto its live path - see
// restoreNpcBackup() in NpcDripParser.ts for why this is deliberately not called
// automatically by RandomizeDrops.ts itself, only by RegenerateAll.ts.
export function restoreDropScriptBackup(): number {
    let restored = 0;
    for (const file of findDropScriptFiles(DROP_BACKUP_DIR)) {
        const rel = path.relative(DROP_BACKUP_DIR, file);
        const livePath = path.join(DROP_SCRIPTS_DIR, rel);
        fs.copyFileSync(file, livePath);
        restored++;
    }
    return restored;
}

export function parseDropSlots(filePath: string, relFile: string): DropSlot[] {
    const lines = readNpcSource(filePath).split('\n');

    const blocks: { name: string; startLine: number; endLine: number }[] = [];
    let curName: string | null = null;
    let curStart = 0;
    for (let i = 0; i < lines.length; i++) {
        const hm = lines[i].match(BLOCK_HEADER_RE);
        if (hm) {
            if (curName !== null) {
                blocks.push({ name: curName, startLine: curStart, endLine: i });
            }
            curName = hm[2];
            curStart = i + 1;
        }
    }
    if (curName !== null) {
        blocks.push({ name: curName, startLine: curStart, endLine: lines.length });
    }

    const slots: DropSlot[] = [];

    for (const block of blocks) {
        const blockText = lines.slice(block.startLine, block.endLine).join('\n');
        const defMatches = [...blockText.matchAll(DEF_RANDOM_RE)];

        for (let ci = 0; ci < defMatches.length; ci++) {
            const dm = defMatches[ci];
            const varName = dm[1];
            const total = parseInt(dm[2], 10);
            const cascadeStart = dm.index! + dm[0].length;
            const cascadeEnd = ci + 1 < defMatches.length ? defMatches[ci + 1].index! : blockText.length;
            const cascadeText = blockText.slice(cascadeStart, cascadeEnd);

            const branchRe = new RegExp(`(?:if|else if)\\s*\\(\\s*\\$${varName}\\s*<\\s*(\\d+)\\s*\\)`, 'g');
            const branches = [...cascadeText.matchAll(branchRe)];

            let prevThreshold = 0;
            for (let bi = 0; bi < branches.length; bi++) {
                const bm = branches[bi];
                const threshold = parseInt(bm[1], 10);
                const weight = threshold - prevThreshold;
                prevThreshold = threshold;

                const bodyStart = bm.index! + bm[0].length;
                const bodyEnd = bi + 1 < branches.length ? branches[bi + 1].index! : cascadeText.length;
                const bodyText = cascadeText.slice(bodyStart, bodyEnd);

                OBJ_ADD_RE.lastIndex = 0;
                let om: RegExpExecArray | null;
                while ((om = OBJ_ADD_RE.exec(bodyText))) {
                    const item = om[1];
                    if (item.startsWith('~')) {
                        continue;
                    }
                    const qty = parseInt(om[2], 10);
                    const absoluteOffset = cascadeStart + bodyStart + om.index;
                    const upToMatch = blockText.slice(0, absoluteOffset);
                    const lineNumber = block.startLine + (upToMatch.match(/\n/g)?.length ?? 0);
                    const probability = weight / total;

                    slots.push({
                        file: relFile,
                        block: block.name,
                        line: lineNumber,
                        raw: om[0],
                        item,
                        qty,
                        weight,
                        total,
                        probability,
                        bucket: bucketFor(probability)
                    });
                }
            }
        }
    }

    return slots;
}

// items a quest script actually GATES on - i.e. appears as the item argument to
// inv_total(inv|bank, ITEM) or inv_del(inv|bank, ITEM), the RS2 idiom for "does the
// player have this" / "consume this" used throughout quest logic (verified against
// real quest scripts before picking this pattern - e.g. quest_imp/imp_journal.rs2's
// `inv_total(inv, black_bead) > 0`). Used to pin any drop slot whose current item might
// gate quest progress.
//
// An EARLIER version of this function tokenized every identifier appearing ANYWHERE in
// quest scripts (any mention at all) and intersected with the candidate set - it pinned
// 131 of 243 corpus items (922 of 1127 slots!), because common items like coins, ores,
// bars, and basic food are mentioned constantly in quest dialogue/rewards without ever
// being a requirement check. The inv_total/inv_del-argument pattern narrows that to 53
// items while still catching every genuinely quest-gated item found by manual spot-check
// (black_bead/red_bead/white_bead/yellow_bead, unholy_symbol_mould, ...). It correctly
// DROPS false positives the broad version had - e.g. unidentified_rogues_purse is
// handed to the player directly via inv_add() in every quest that uses it (mortton's
// search-box, junglepotion's herb-pick), never gated by an inv_total check, so losing
// its drop-table slot wouldn't actually block anything.
const QUEST_ITEM_REQUIREMENT_RE = /inv_(?:total|del)\(\s*(?:inv|bank)\s*,\s*([a-zA-Z0-9_]+)/g;

export function loadQuestCriticalItems(candidates: Set<string>): Set<string> {
    if (!fs.existsSync(QUESTS_DIR)) {
        return new Set();
    }
    const files: string[] = [];
    walkRs2(QUESTS_DIR, files);

    const required = new Set<string>();
    for (const file of files) {
        const text = readNpcSource(file);
        for (const m of text.matchAll(QUEST_ITEM_REQUIREMENT_RE)) {
            required.add(m[1]);
        }
    }

    const hits = new Set<string>();
    for (const item of candidates) {
        if (required.has(item)) {
            hits.add(item);
        }
    }
    return hits;
}

const OBJ_STACKABLE_RE = /^stackable=yes$/;

function walkObjConfigs(dir: string, out: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkObjConfigs(full, out);
        } else if (entry.name.endsWith('.obj')) {
            out.push(full);
        }
    }
}

// every item name with `stackable=yes` in its .obj config, across the whole content
// tree (same "[name]" block convention as .npc - see ShopParser.ts's header handling).
// Used to decide whether a reassigned slot keeps its original quantity (stackable -
// e.g. swapping a "60 coins" slot for "60 chaosrune" still makes sense) or gets forced
// to 1 (not stackable - a slot that used to be "1 iron_dagger" landing on "35 whip"
// would be nonsense).
export function loadStackableItems(): Set<string> {
    const files: string[] = [];
    if (fs.existsSync(SCRIPTS_ROOT)) {
        walkObjConfigs(SCRIPTS_ROOT, files);
    }

    const stackable = new Set<string>();
    for (const file of files) {
        const lines = readNpcSource(file).split('\n');
        let block = '';
        for (const line of lines) {
            if (line.startsWith('[')) {
                block = line.slice(1, line.lastIndexOf(']'));
                continue;
            }
            if (OBJ_STACKABLE_RE.test(line)) {
                stackable.add(block);
            }
        }
    }
    return stackable;
}

// --- death_drop: a separate, much simpler axis - a single guaranteed-on-death namedobj
// param (e.g. big_bones/dragon_bones/ashes) set on ~30 .npc config files, read via
// npc_param(death_drop) in the very first obj_add(...) of most drop-table blocks (see
// the file header comment above for why that line is never mistaken for a cascade
// slot). Structurally identical to shopsanity's owned_shop - a lone pointer field, safe
// to shuffle via a straight derangement. Deliberately excludes quests/ and tutorial/
// (Tutorial Island is protected the same way entrance randomization protects it, and
// quest-NPC death drops - while not found to be quest-critical items themselves - are
// left alone for the same "don't touch quest logic" caution the user asked for on the
// main cascade scope).

export type DeathDropSlot = {
    file: string;
    block: string;
    line: number;
    value: string;
};

const DEATH_DROP_RE = /^param=death_drop,(.+)$/;
const DEATH_DROP_EXCLUDED_PREFIXES = [`quests${path.sep}`, `tutorial${path.sep}`];

export function parseDeathDropSlots(filePath: string, relFile: string): DeathDropSlot[] {
    if (DEATH_DROP_EXCLUDED_PREFIXES.some(p => relFile.startsWith(p))) {
        return [];
    }

    const lines = readNpcSource(filePath).split('\n');
    const slots: DeathDropSlot[] = [];
    let block = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('[')) {
            block = line.slice(1, line.lastIndexOf(']'));
            continue;
        }
        const dm = line.match(DEATH_DROP_RE);
        if (dm && dm[1] !== 'null') {
            slots.push({ file: relFile, block, line: i, value: dm[1] });
        }
    }

    return slots;
}
