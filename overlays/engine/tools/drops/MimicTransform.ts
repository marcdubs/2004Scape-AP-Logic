import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

import { BACKUP_ROOT, SCRIPTS_ROOT, findNpcFiles, readNpcSource } from '../npc/NpcDripParser.js';
import { DROP_BACKUP_DIR, DROP_SCRIPTS_DIR, findDropScriptFiles } from './DropTableParser.js';

// Mimic-mode plumbing for RandomizeDrops.ts (--mode mimic): instead of reassigning
// items WITHIN each monster's loot table (tiered/chaos), mimic shuffles which monster
// runs which ENTIRE loot table - "chicken mimics green dragon" swaps the chicken's
// complete drop profile (guaranteed drops, weighted cascade, clue-table calls, and the
// bones - see the death_drop inlining note below) for the dragon's.
//
// Unlike tiered/chaos (pure script mutation, rebuild per reseed), mimic uses the
// runtime-override pattern from entrance randomization (see ApEntranceOverrides.ts /
// docs/lessons-learned.md "Runtime override table instead of script rewriting"):
//
// 1. Every eligible [ai_queue3,...] death handler in the drop-table corpus gets a
//    seed-independent preamble injected right before its vanilla loot:
//        def_int $ap_group = ap_drop_group(<slot index>);
//        if ($ap_group >= 0) {
//            gosub(npc_death);
//            if (npc_findhero = ^false) {
//                return;
//            }
//            @ap_drops_go($ap_group);
//        }
//    ap_drop_group is a custom engine command (ScriptOpcode.AP_DROP_GROUP) reading
//    engine/data/config/ap-drops.json at runtime; it returns -1 (miss) when the slot
//    is unmapped, so the handler falls through to its untouched vanilla loot. The
//    preamble runs the standard death prologue itself before jumping because the
//    jump target is loot-only (and for jump-style handlers the vanilla prologue lives
//    inside the label we're bypassing).
// 2. Each unit's post-prologue loot text is extracted (from the pristine backup) into
//    a [label,ap_drops_<unit index>] block in one GENERATED file,
//    content/scripts/drop tables/ap_mimic.rs2, alongside the [label,ap_drops_go]
//    dispatch chain. The file sits NEXT TO the scripts/ subtree deliberately, so
//    ensureDropScriptBackup()/restoreDropScriptBackup() (which walk only scripts/)
//    can never mistake generated output for vanilla content.
// 3. The seed only decides the slot->unit mapping written to ap-drops.json. Preambles,
//    dispatch, and loot labels are all deterministic functions of the vanilla backup,
//    so reseeding mimic = rewrite the JSON + restart. One pack rebuild ever (when the
//    transform first lands, or after this tool's own logic changes).
//
// death_drop travels WITH the table: the loot labels' `npc_param(death_drop)` reads
// would otherwise resolve against the DYING npc's config (a green dragon running
// chicken loot would still drop dragon bones), so extraction inlines each unit's own
// uniform death_drop value as a literal (verified uniform across every handler's
// category members before inlining; non-uniform units keep npc_param and are logged).
//
// Structural pins (never mapped, always vanilla - these are about code that can't
// survive running on a different npc, NOT about quest-item availability; quest-gated
// drops whose conditions only read the KILLER's quest state travel fine and stay
// obtainable via the spoiler):
// - handlers with no standard `gosub(npc_death); if (npc_findhero = ^false) {return;}`
//   prologue (grip.rs2: bespoke Heroes' Quest kill-credit logic).
// - jump-style handlers whose target label has logic BEFORE the prologue
//   (mountain_troll.rs2: npc_type-gated Trollheim prison keys - bypassing the label
//   would skip them; the label is also jumped to from outside the corpus).
// Inline handlers with pre-prologue logic (guard/guard_dog clue-trail checks,
// troll_commander's prison keys) keep that logic in place - the preamble is inserted
// AFTER it, immediately before the prologue - so they stay mappable.

export const AP_DROPS_JSON = path.join('data', 'config', 'ap-drops.json');
export const MIMIC_GENERATED_FILE = path.join(SCRIPTS_ROOT, 'drop tables', 'ap_mimic.rs2');
// presence of this text in a live corpus file means the mimic transform is applied
// (tiered/chaos must restore from backup before editing lines by index).
export const MIMIC_MARKER = 'ap_drop_group(';

const HEADER_RE = /^\[([a-zA-Z_0-9]+),([a-zA-Z0-9_]+)\](.*)$/;
const PROLOGUE_RE = /gosub\(npc_death\);\s*\n\s*if ?\(npc_findhero = \^false\) ?\{\s*\n\s*return;\s*\n\s*\}/;
const JUMP_ONLY_RE = /^@([a-zA-Z0-9_]+);$/;

export type MimicUnit = {
    index: number;
    name: string; // label name (jump-style) or handler name (inline)
    file: string;
    loot: string; // post-prologue loot text, death_drop already inlined
    deathDrop: string | null; // the inlined literal, or null if npc_param was kept
    handlers: string[]; // corpus ai_queue3 handlers bound to this unit
};

export type MimicSlot = {
    index: number; // dense index over ELIGIBLE slots only; -1 when pinned
    handler: string;
    file: string;
    unitKey: string; // key into the unit map (its own vanilla table)
    pinned: string | null; // reason, or null when eligible
};

type Block = {
    trigger: string;
    name: string;
    headerIdx: number; // line index of the [trigger,name] header
    rest: string; // same-line code after the header, e.g. " @goblin_drop_table; //lvl 2"
    bodyStart: number; // first line after the header
    bodyEnd: number; // exclusive
};

function parseBlocks(lines: string[]): Block[] {
    const blocks: Block[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(HEADER_RE);
        if (!m) {
            continue;
        }
        if (blocks.length) {
            blocks[blocks.length - 1].bodyEnd = i;
        }
        blocks.push({ trigger: m[1], name: m[2], headerIdx: i, rest: m[3], bodyStart: i + 1, bodyEnd: lines.length });
    }
    return blocks;
}

function blockBody(lines: string[], b: Block): string {
    const rest = b.rest.trim();
    const tail = lines.slice(b.bodyStart, b.bodyEnd).join('\n');
    return rest ? `${rest}\n${tail}` : tail;
}

function isOnlyCommentsAndBlank(text: string): boolean {
    return text.split('\n').every(l => !l.trim() || l.trim().startsWith('//'));
}

// --- death_drop resolution: unit loot must carry its OWN monster's death drop when it
// runs on someone else's corpse, so npc_param(death_drop) gets inlined to a literal.
// A handler named "_x" is bound to every npc with category=x; a plain name is one npc.
// The default when no explicit param exists is `bones` (npc_combat.param's declared
// default - the reason most monsters have no death_drop line at all).

type NpcInfo = { category: string | null; deathDrop: string | null };

function loadNpcInfo(): { byName: Map<string, NpcInfo>; byCategory: Map<string, string[]> } {
    const byName = new Map<string, NpcInfo>();
    const byCategory = new Map<string, string[]>();
    for (const file of findNpcFiles(BACKUP_ROOT)) {
        const lines = readNpcSource(file).split('\n');
        let cur: NpcInfo | null = null;
        for (const line of lines) {
            if (line.startsWith('[')) {
                cur = { category: null, deathDrop: null };
                byName.set(line.slice(1, line.lastIndexOf(']')), cur);
                continue;
            }
            if (!cur) {
                continue;
            }
            if (line.startsWith('param=death_drop,')) {
                cur.deathDrop = line.slice('param=death_drop,'.length).trim();
            } else if (line.startsWith('category=')) {
                cur.category = line.slice('category='.length).trim();
            }
        }
    }
    for (const [name, info] of byName) {
        if (info.category) {
            const members = byCategory.get(info.category) ?? [];
            members.push(name);
            byCategory.set(info.category, members);
        }
    }
    return { byName, byCategory };
}

type DeathDropResolution = { kind: 'literal'; value: string } | { kind: 'none' } | { kind: 'unresolvable' };

function resolveDeathDrop(handlers: string[], npcs: ReturnType<typeof loadNpcInfo>): DeathDropResolution {
    const values = new Set<string>();
    for (const handler of handlers) {
        const members = handler.startsWith('_') ? (npcs.byCategory.get(handler.slice(1)) ?? []) : [handler];
        if (!members.length || (members.length === 1 && !handler.startsWith('_') && !npcs.byName.has(handler))) {
            return { kind: 'unresolvable' }; // unknown npc/category - keep npc_param, don't guess
        }
        for (const m of members) {
            values.add(npcs.byName.get(m)?.deathDrop ?? 'bones');
        }
    }
    if (values.size !== 1) {
        return { kind: 'unresolvable' };
    }
    const value = [...values][0];
    // an EXPLICIT param=death_drop,null (otherworldly_being) means "drops nothing on
    // death" - the faithful extraction removes the death-drop line entirely rather
    // than inlining anything.
    return value === 'null' ? { kind: 'none' } : { kind: 'literal', value };
}

export type MimicParse = {
    slots: MimicSlot[]; // every ai_queue3 handler in the corpus, pinned or not
    units: MimicUnit[]; // indexed source tables
    unitByKey: Map<string, MimicUnit>;
    transformed: Map<string, string>; // rel file -> full transformed text (LF)
    generatedText: string; // ap_mimic.rs2 content (LF)
};

// parses the pristine backup corpus and derives every seed-independent artifact:
// per-file preamble-injected text, the extracted loot labels, and the dispatch chain.
export function parseMimic(): MimicParse {
    const npcs = loadNpcInfo();
    const slots: MimicSlot[] = [];
    const unitByKey = new Map<string, MimicUnit>();

    type PendingEdit = { kind: 'insert-before'; lineIdx: number; slot: MimicSlot } | { kind: 'expand-header'; lineIdx: number; slot: MimicSlot };
    const editsByFile = new Map<string, { lines: string[]; edits: PendingEdit[] }>();

    for (const file of findDropScriptFiles(DROP_BACKUP_DIR)) {
        const rel = path.relative(DROP_BACKUP_DIR, file);
        const lines = readNpcSource(file).split('\n');
        const blocks = parseBlocks(lines);
        const labels = new Map(blocks.filter(b => b.trigger === 'label').map(b => [b.name, b]));
        const edits: PendingEdit[] = [];

        for (const b of blocks) {
            if (b.trigger !== 'ai_queue3') {
                continue;
            }
            const body = blockBody(lines, b);
            const slot: MimicSlot = { index: -1, handler: b.name, file: rel, unitKey: '', pinned: null };
            slots.push(slot);

            const strippedBody = body
                .split('\n')
                .map(l => l.replace(/\/\/.*$/, '').trim())
                .filter(Boolean)
                .join('\n');
            const jump = strippedBody.match(JUMP_ONLY_RE);

            if (jump) {
                const label = labels.get(jump[1]);
                if (!label) {
                    slot.pinned = `jump target @${jump[1]} not found in file`;
                    continue;
                }
                const labelBody = blockBody(lines, label);
                const pm = labelBody.match(PROLOGUE_RE);
                if (!pm) {
                    slot.pinned = `label ${jump[1]} has no standard death prologue`;
                    continue;
                }
                if (!isOnlyCommentsAndBlank(labelBody.slice(0, pm.index))) {
                    // e.g. troll_drop_table's npc_type-gated prison keys sit BEFORE the
                    // prologue; jumping past the label would skip them, so this slot
                    // stays vanilla. The label's post-prologue loot is still usable as
                    // a SOURCE for other slots.
                    slot.pinned = `label ${jump[1]} has logic before the prologue`;
                }
                slot.unitKey = `${rel}:${jump[1]}`;
                if (!unitByKey.has(slot.unitKey)) {
                    unitByKey.set(slot.unitKey, { index: -1, name: jump[1], file: rel, loot: labelBody.slice(pm.index! + pm[0].length).replace(/^\n+/, ''), deathDrop: null, handlers: [] });
                }
                unitByKey.get(slot.unitKey)!.handlers.push(b.name);
                if (!slot.pinned) {
                    edits.push({ kind: 'expand-header', lineIdx: b.headerIdx, slot });
                }
                continue;
            }

            const pm = body.match(PROLOGUE_RE);
            if (!pm) {
                slot.pinned = 'no standard death prologue (bespoke handler)';
                continue;
            }
            // insertion point: the handler's own gosub(npc_death); line - anything
            // before it (clue-trail checks, quest-key logic) deliberately stays put
            // and still runs before the preamble decides whether to redirect.
            let gosubIdx = -1;
            for (let i = b.bodyStart; i < b.bodyEnd; i++) {
                if (lines[i].trim().startsWith('gosub(npc_death);')) {
                    gosubIdx = i;
                    break;
                }
            }
            if (gosubIdx === -1) {
                // prologue matched the body text but not on its own line (e.g. code on
                // the header line) - nothing in the corpus does this; pin defensively.
                slot.pinned = 'prologue not on its own line';
                continue;
            }
            slot.unitKey = `${rel}:${b.name}`;
            unitByKey.set(slot.unitKey, { index: -1, name: b.name, file: rel, loot: body.slice(pm.index! + pm[0].length).replace(/^\n+/, ''), deathDrop: null, handlers: [b.name] });
            edits.push({ kind: 'insert-before', lineIdx: gosubIdx, slot });
        }

        editsByFile.set(rel, { lines, edits });
    }

    // identity-dependent code must never run on the wrong npc: a unit whose LOOT still
    // checks npc_type would silently skip those branches on a mimicking monster.
    // Nothing in the corpus has post-prologue npc_type checks today - this is the
    // defensive gate in case content changes.
    for (const [key, unit] of unitByKey) {
        if (unit.loot.includes('npc_type')) {
            printWarning(`mimic: unit ${key} has npc_type checks in its loot - removed from sources, its slots pinned`);
            unitByKey.delete(key);
            for (const slot of slots) {
                if (slot.unitKey === key && !slot.pinned) {
                    slot.pinned = 'unit loot has npc_type checks';
                }
            }
        }
    }

    // inline each unit's own death drop (see file header). Keep npc_param on the rare
    // non-uniform/unresolvable unit - the mimicking monster then drops ITS OWN bones,
    // a graceful degradation rather than a wrong literal.
    for (const unit of unitByKey.values()) {
        if (!unit.loot.includes('npc_param(death_drop)')) {
            continue;
        }
        const resolved = resolveDeathDrop(unit.handlers, npcs);
        if (resolved.kind === 'unresolvable') {
            printWarning(`mimic: unit ${unit.file}:${unit.name} death_drop not uniform/resolvable - keeping npc_param(death_drop)`);
            continue;
        }
        if (resolved.kind === 'none') {
            unit.deathDrop = 'none';
            unit.loot = unit.loot
                .split('\n')
                .filter(l => !l.includes('npc_param(death_drop)'))
                .join('\n');
            continue;
        }
        unit.deathDrop = resolved.value;
        unit.loot = unit.loot.replace(/npc_param\(death_drop\)/g, resolved.value);
    }

    // stable, seed-independent indices (baked into compiled preambles - they must not
    // change across reseeds, only across tool-logic changes, which need a rebuild
    // anyway).
    const units = [...unitByKey.values()].sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
    units.forEach((u, i) => (u.index = i));
    const eligible = slots.filter(s => !s.pinned).sort((a, b) => a.file.localeCompare(b.file) || a.handler.localeCompare(b.handler));
    eligible.forEach((s, i) => (s.index = i));

    // per-file transformed text: preambles injected bottom-up so line indices stay valid.
    const transformed = new Map<string, string>();
    for (const [rel, { lines, edits }] of editsByFile) {
        const out = [...lines];
        for (const edit of [...edits].sort((a, b) => b.lineIdx - a.lineIdx)) {
            if (edit.kind === 'insert-before') {
                const indent = out[edit.lineIdx].match(/^\s*/)?.[0] ?? '';
                out.splice(edit.lineIdx, 0, ...preambleLines(edit.slot.index, indent));
            } else {
                const m = out[edit.lineIdx].match(HEADER_RE)!;
                out.splice(edit.lineIdx, 1, `[${m[1]},${m[2]}]`, ...preambleLines(edit.slot.index, ''), m[3].trim());
            }
        }
        transformed.set(rel, out.join('\n'));
    }

    return { slots, units, unitByKey, transformed, generatedText: generateMimicFile(units) };
}

function preambleLines(slotIndex: number, indent: string): string[] {
    return [
        `${indent}def_int $ap_group = ap_drop_group(${slotIndex});`,
        `${indent}if ($ap_group >= 0) {`,
        `${indent}    gosub(npc_death);`,
        `${indent}    if (npc_findhero = ^false) {`,
        `${indent}        return;`,
        `${indent}    }`,
        `${indent}    @ap_drops_go($ap_group);`,
        `${indent}}`
    ];
}

function generateMimicFile(units: MimicUnit[]): string {
    const out: string[] = [
        '// GENERATED by tools/drops/RandomizeDrops.ts --mode mimic - DO NOT EDIT.',
        '// Regenerated (from the pristine .ap-backup corpus) on every mimic run.',
        '//',
        '// One loot-only label per drop-table unit (prologue stripped, death_drop inlined',
        '// as a literal so bones travel with their table), plus the dispatch label the',
        '// injected handler preambles jump to. Which monster runs which unit is decided at',
        '// RUNTIME by engine/data/config/ap-drops.json via the ap_drop_group command -',
        '// reseeding rewrites that JSON only; this file and the preambles are',
        '// seed-independent.',
        '',
        '[label,ap_drops_go](int $ap_group)'
    ];
    for (const u of units) {
        out.push(`if ($ap_group = ${u.index}) @ap_drops_${u.index};`);
    }
    for (const u of units) {
        out.push('');
        out.push(`// unit ${u.index}: ${u.file} "${u.name}" (handlers: ${u.handlers.join(', ')})${u.deathDrop ? ` death_drop=${u.deathDrop}` : ''}`);
        out.push(`[label,ap_drops_${u.index}]`);
        out.push(u.loot.replace(/\s+$/, ''));
    }
    out.push('');
    return out.join('\n');
}

// writes the transformed corpus + generated file. Returns whether anything on disk
// actually changed (i.e. whether a pack rebuild is needed) - a mimic RESEED over an
// already-transformed corpus is a byte-level no-op here and only touches the JSON.
export function applyMimicTransform(parse: MimicParse, dryRun: boolean): { changedFiles: number; rebuildNeeded: boolean } {
    let changedFiles = 0;

    const writeIfChanged = (livePath: string, textLf: string): void => {
        const next = textLf.replace(/\n/g, '\r\n');
        const current = fs.existsSync(livePath) ? fs.readFileSync(livePath, 'utf8') : null;
        if (current === next) {
            return;
        }
        changedFiles++;
        if (!dryRun) {
            fs.writeFileSync(livePath, next);
        }
    };

    for (const [rel, text] of parse.transformed) {
        writeIfChanged(path.join(DROP_SCRIPTS_DIR, rel), text);
    }
    writeIfChanged(MIMIC_GENERATED_FILE, parse.generatedText);

    return { changedFiles, rebuildNeeded: changedFiles > 0 };
}

// removes every mimic artifact that ISN'T part of the backed-up corpus (the corpus
// files themselves are handled by restoreDropScriptBackup). Called when switching back
// to tiered/chaos so a stale dispatch file/JSON can't confuse the next build or boot.
export function removeMimicArtifacts(): string[] {
    const removed: string[] = [];
    for (const p of [MIMIC_GENERATED_FILE, AP_DROPS_JSON]) {
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            removed.push(p);
        }
    }
    return removed;
}

// true when the live corpus already carries mimic preambles - tiered/chaos edit live
// lines by BACKUP line index, so they must restore first (see RandomizeDrops.ts).
export function liveCorpusIsMimicTransformed(): boolean {
    for (const file of findDropScriptFiles(DROP_SCRIPTS_DIR)) {
        if (fs.readFileSync(file, 'utf8').includes(MIMIC_MARKER)) {
            return true;
        }
    }
    return false;
}
