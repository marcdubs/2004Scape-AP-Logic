import fs from 'fs';
import path from 'path';

import { SCRIPTS_ROOT } from '../npc/NpcDripParser.js';
import type { ProductLevel } from '../shared/SkillTiers.js';

// Fishing is the one gathering skill with no product dbtable: the fish are literal
// arguments at ~fish_roll / ~fish_roll_loc call sites, and the big-net catches are
// ap_gather_swap(<literal>) wraps inside a proc. Their LEVEL requirements have no config
// home either - they're plain guards in the spot scripts:
//
//     [label,fish_sardine]
//     if (stat(fishing) < 5) { ... return; }       // <- floor for the rest of the label
//     ...
//     if (stat(fishing) >= 10) {                   // <- only inside this branch
//         ~fish_roll(raw_sardine, raw_herring, fishing_rod, fishing_bait);
//     } else {
//         ~fish_roll(raw_sardine, null, fishing_rod, fishing_bait);
//     }
//
// so `--mode tiered` (GitHub #15) parses them. Same discipline as everywhere else in
// this repo: read the level out of the game's own content rather than hardcoding a
// table of "what the wiki says", so a content bump can't leave the bands describing a
// world the server isn't running.
//
// The scan tracks two things per block:
//   - a FLOOR, raised by every `stat(fishing) < N` (or `$level < N`, where $level was
//     assigned stat(fishing)) early-return gate, applying to the rest of the block;
//   - a per-brace-depth BRANCH level from `stat(fishing) >= N`, applying only inside
//     that block - which is how the second fish of a two-fish spot gets its own level,
//     and why `} else {` correctly drops back to the floor.
// A fish seen at several sites takes the LOWEST level it was ever reachable at.
//
// One indirection is followed: fish_roll_big_net holds its fish as literals but is
// itself only called from labels gated at `stat(fishing) < 16`, so a proc inherits the
// lowest level any of its call sites was reachable at. That is one hop, not a transitive
// closure - the corpus has exactly one such proc and pretending otherwise would be
// untested code.

const BLOCK_HEADER_RE = /^\[([a-z_0-9]+),([a-zA-Z0-9_]+)\]/;
const STAT_VAR_RE = /def_int (\$[a-zA-Z0-9_]+) = stat\(fishing\)/;
const FISH_ROLL_RE = /~fish_roll(?:_loc)?\(\s*([a-zA-Z0-9_$]+)\s*,\s*([a-zA-Z0-9_$]+)/g;
const GATHER_WRAP_RE = /ap_gather_swap\(([a-zA-Z_][a-zA-Z0-9_]*)\)/g;
const PROC_CALL_RE = /~([a-zA-Z0-9_]+)/g;

interface Occurrence {
    item: string;
    level: number;
    /** the `[proc,x]` this sat in, if any - used for the one call-site inheritance hop. */
    proc: string | null;
}

function findRsFiles(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.name.endsWith('.rs2')) {
                out.push(full);
            }
        }
    }
    return out.sort();
}

/**
 * Scans the (overlaid) fishing scripts and returns every wrapped fish with the Fishing
 * level it first becomes catchable at. Products come out in file order, deduped by the
 * caller via minLevels().
 */
interface ScanResult {
    occurrences: Occurrence[];
    /** lowest level any call site of `~name` was reachable at. */
    procEntryLevel: Map<string, number>;
    /** the floor a `[proc,name]` block leaves behind, i.e. what its own gates demand. */
    procExitFloor: Map<string, number>;
}

/** One pass over the corpus. `guardFloor` is empty on the first pass (see below). */
function scan(files: string[], guardFloor: ReadonlyMap<string, number>): ScanResult {
    const occurrences: Occurrence[] = [];
    const procEntryLevel = new Map<string, number>();
    const procExitFloor = new Map<string, number>();

    for (const file of files) {
        const statVars = new Set<string>();
        let block: { kind: string; name: string } | null = null;
        let floor = 1;
        let depth = 0;
        const levelAtDepth = new Map<number, number>();

        for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const line = raw.trim();

            const header = line.match(BLOCK_HEADER_RE);
            if (header) {
                if (block?.kind === 'proc') {
                    procExitFloor.set(block.name, floor);
                }
                block = { kind: header[1], name: header[2] };
                floor = 1;
                depth = 0;
                levelAtDepth.clear();
                continue;
            }
            if (block === null || line.startsWith('//')) {
                continue;
            }

            const statVar = line.match(STAT_VAR_RE);
            if (statVar) {
                statVars.add(statVar[1]);
            }

            // a level test reads either stat(fishing) directly or a local that was
            // assigned from it; anything else is some unrelated comparison.
            const subject = (token: string) => token === 'stat(fishing)' || statVars.has(token);
            const lt = line.match(/(stat\(fishing\)|\$[a-zA-Z0-9_]+)\s*<\s*(\d+)/);
            if (lt && subject(lt[1])) {
                floor = Math.max(floor, parseInt(lt[2], 10));
            }
            // `if (~some_check = false) { return; }` - a requirement proc used as a gate.
            // Whatever level ITS own guards demand becomes this block's floor too (that
            // is where the lava eel's level 53 lives: the label never mentions
            // stat(fishing), it early-returns on ~oil_rod_fishing_check_requirements).
            const guard = line.match(/if\s*\(~([a-zA-Z0-9_]+)[^)]*\)?\s*=\s*false\)/);
            if (guard) {
                floor = Math.max(floor, guardFloor.get(guard[1]) ?? 1);
            }
            const ge = line.match(/(stat\(fishing\)|\$[a-zA-Z0-9_]+)\s*>=\s*(\d+)/);
            let pendingBranch = ge && subject(ge[1]) ? parseInt(ge[2], 10) : null;

            for (const char of line) {
                if (char === '{') {
                    depth++;
                    if (pendingBranch !== null) {
                        levelAtDepth.set(depth, pendingBranch);
                        pendingBranch = null;
                    }
                } else if (char === '}') {
                    levelAtDepth.delete(depth);
                    depth = Math.max(0, depth - 1);
                }
            }
            // scored AFTER this line's braces: in this corpus a brace line never also
            // carries a fish, and scoring after is what makes `} else {` drop the `>= N`
            // it just closed instead of leaking it into the else branch.
            const effective = Math.max(floor, ...levelAtDepth.values());

            for (const m of line.matchAll(FISH_ROLL_RE)) {
                for (const arg of [m[1], m[2]]) {
                    if (arg !== 'null' && !arg.startsWith('$')) {
                        occurrences.push({ item: arg, level: effective, proc: block.kind === 'proc' ? block.name : null });
                    }
                }
            }
            for (const m of line.matchAll(GATHER_WRAP_RE)) {
                occurrences.push({ item: m[1], level: effective, proc: block.kind === 'proc' ? block.name : null });
            }
            for (const m of line.matchAll(PROC_CALL_RE)) {
                const seen = procEntryLevel.get(m[1]);
                if (seen === undefined || effective < seen) {
                    procEntryLevel.set(m[1], effective);
                }
            }
        }
        if (block?.kind === 'proc') {
            procExitFloor.set(block.name, floor);
        }
    }

    return { occurrences, procEntryLevel, procExitFloor };
}

/**
 * Scans the (overlaid) fishing scripts and returns every wrapped fish with the Fishing
 * level it first becomes catchable at. Products come out in file order, deduped by the
 * caller via minLevels().
 *
 * Two passes, because the level a fish sits behind can live on either side of a call:
 *   1. the first pass learns what each requirement proc's own guards demand
 *      (procExitFloor), with no knowledge of callers;
 *   2. the second re-scans with that in hand, so `if (~oil_rod_fishing_check_requirements
 *      = false) { return; }` raises its caller's floor to 53.
 * Then the OTHER direction is applied: a fish that sits inside a proc as a literal
 * (only fish_roll_big_net does) inherits the lowest level its call sites were reachable
 * at. Both hops are single-step on purpose - the corpus has exactly one proc of each
 * shape, and a transitive closure would be untested code.
 */
export function loadFishingProductLevels(): ProductLevel[] {
    const files = findRsFiles(path.join(SCRIPTS_ROOT, 'skill_fishing', 'scripts'));
    const firstPass = scan(files, new Map());
    const { occurrences, procEntryLevel } = scan(files, firstPass.procExitFloor);

    return occurrences.map(o => ({
        item: o.item,
        level: o.proc === null ? o.level : Math.max(o.level, procEntryLevel.get(o.proc) ?? 1)
    }));
}
