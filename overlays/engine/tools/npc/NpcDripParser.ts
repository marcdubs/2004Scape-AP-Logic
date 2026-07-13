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
// `model_2909_npc`, ...) and held-item models (`human_weapons_*`) don't match and are
// left untouched, which is what keeps monsters and quest NPCs with bespoke models from
// being corrupted into nonsense.
//
// Every .npc file is CRLF (see readNpcSource) and each config line is a bare
// `key=value` - no inline comments, no inheritance (`readConfigs` in the engine's own
// pack tooling treats duplicate block names as a hard build error), so a line-indexed
// read-modify-write is safe and exact.

export const CONTENT_ROOT = path.resolve(process.cwd(), '../content');
export const SCRIPTS_ROOT = path.join(CONTENT_ROOT, 'scripts');

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
