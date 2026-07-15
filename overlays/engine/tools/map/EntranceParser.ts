import fs from 'fs';
import path from 'path';

// Parses content/scripts/ladders+stairs/*.rs2 (the ladder/stair oploc handlers) into a
// structured edge list. Not a general rs2 parser - it only understands the handful of
// constructs actually used in that folder (switch_coord, switch_int, if/else coord
// checks, p_telejump/p_teleport/~climb_ladder calls, and the @stair_options/
// @ladder_options two-way choice labels). See ARCHIPELAGO_IDEAS.md #1.
//
// Shared by ExportEntrances.ts (read-only JSON dump) and RandomizeEntrances.ts (which
// also needs to locate + rewrite destination coordinates in the source text).

export const CONTENT_ROOT = path.resolve(process.cwd(), '../content');
export const ENTRANCE_DIR = path.join(CONTENT_ROOT, 'scripts/ladders+stairs/scripts');
export const SCRIPTS_ROOT = path.join(CONTENT_ROOT, 'scripts');

// distance (in tiles) beyond which a "relative" movecoord offset is treated as jumping
// to a different part of the map (e.g. the +6400 dungeon-layer offset) rather than just
// shifting a floor within the same building.
const RELATIVE_JUMP_THRESHOLD = 16;

export type CoordLiteral = {
    type: 'literal';
    raw: string;
    plane: number;
    mapX: number;
    mapZ: number;
    localX: number;
    localZ: number;
    worldX: number;
    worldZ: number;
};

export type CoordRelative = {
    type: 'relative';
    raw: string;
    base: string;
    dx: string;
    dy: string;
    dz: string;
};

export type CoordUnknown = {
    type: 'unknown';
    raw: string;
};

export type CoordExpr = CoordLiteral | CoordRelative | CoordUnknown;

export type SourceSpec = { type: 'literal'; coord: CoordLiteral } | { type: 'angle'; angle: number } | { type: 'any' };

export type Entrance = {
    file: string;
    line: number;
    category: string;
    op: string;
    source: SourceSpec;
    method: 'p_telejump' | 'p_teleport' | 'climb_ladder' | 'unhandled' | 'gosub';
    destination: CoordExpr | null;
    up: boolean | null;
    description: string | null;
    gosubTarget?: string;
    resolvedFrom?: string;
    gated?: boolean;
    kind: 'floor-shift' | 'cross-map' | 'unresolved' | 'no-transition';
};

export const COORD_RE = /^\d+_\d+_\d+_\d+_\d+$/;

export function decodeCoord(raw: string): CoordLiteral {
    const [plane, mapX, mapZ, localX, localZ] = raw.split('_').map(Number);
    return {
        type: 'literal',
        raw,
        plane,
        mapX,
        mapZ,
        localX,
        localZ,
        worldX: mapX * 64 + localX,
        worldZ: mapZ * 64 + localZ
    };
}

// grabs the balanced-paren argument list following `name(` starting at `openIdx`
// (index of the opening paren), returns the raw inner text and the index just past
// the matching close paren.
function readBalanced(text: string, openIdx: number): { inner: string; endIdx: number } {
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
        if (text[i] === '(') {
            depth++;
        } else if (text[i] === ')') {
            depth--;
            if (depth === 0) {
                return { inner: text.slice(openIdx + 1, i), endIdx: i + 1 };
            }
        }
    }
    return { inner: text.slice(openIdx + 1), endIdx: text.length };
}

function splitTopLevelArgs(inner: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '(') {
            depth++;
        } else if (inner[i] === ')') {
            depth--;
        } else if (inner[i] === ',' && depth === 0) {
            args.push(inner.slice(start, i).trim());
            start = i + 1;
        }
    }
    args.push(inner.slice(start).trim());
    return args;
}

export function parseCoordExpr(raw: string): CoordExpr {
    const trimmed = raw.trim();
    if (COORD_RE.test(trimmed)) {
        return decodeCoord(trimmed);
    }

    const call = trimmed.match(/^movecoord\(/);
    if (call) {
        const { inner } = readBalanced(trimmed, trimmed.indexOf('('));
        const args = splitTopLevelArgs(inner);
        if (args.length === 4) {
            return { type: 'relative', raw: trimmed, base: args[0], dx: args[1], dy: args[2], dz: args[3] };
        }
    }

    return { type: 'unknown', raw: trimmed };
}

function extractComment(chunk: string): string | null {
    // only look at `//` that isn't inside the statement's own coord literal (there are
    // none in practice), so a plain search for the first `//` on the chunk is fine.
    const idx = chunk.indexOf('//');
    if (idx === -1) {
        return null;
    }
    return chunk
        .slice(idx + 2)
        .split('\n')[0]
        .trim();
}

function findCall(chunk: string, name: string): { inner: string; args: string[] } | null {
    const re = new RegExp(`(?:^|[^a-zA-Z0-9_])${name}\\(`);
    const match = chunk.match(re);
    if (!match || match.index === undefined) {
        return null;
    }
    const openIdx = match.index + match[0].length - 1;
    const { inner } = readBalanced(chunk, openIdx);
    return { inner, args: splitTopLevelArgs(inner) };
}

function findBareGosub(chunk: string): string | null {
    // a standalone `@label;` or `@label(...)` call with no coord math of its own -
    // used for things like @ladder_to_dwarf_remains that live outside this folder.
    const match = chunk.match(/@([a-zA-Z0-9_]+)\s*(?:\(([^)]*)\))?\s*;/);
    if (!match) {
        return null;
    }
    return match[1];
}

function classify(source: SourceSpec, destination: CoordExpr | null): Entrance['kind'] {
    if (!destination) {
        return 'no-transition';
    }

    if (destination.type === 'unknown') {
        return 'unresolved';
    }

    if (destination.type === 'relative') {
        const nums = [destination.dx, destination.dz].map(v => parseInt(v, 10));
        if (nums.some(n => Number.isFinite(n) && Math.abs(n) >= RELATIVE_JUMP_THRESHOLD)) {
            return 'cross-map';
        }
        return 'floor-shift';
    }

    // destination is a literal coord
    if (source.type === 'literal') {
        const src = source.coord;
        if (src.mapX === destination.mapX && src.mapZ === destination.mapZ) {
            return 'floor-shift';
        }
        return 'cross-map';
    }

    // angle-based or "any" source with a literal destination (rare, e.g. phoenixladder) -
    // can't compare against a fixed source, so treat any literal jump as cross-map.
    return 'cross-map';
}

// source files use CRLF; normalize so line-based regex ($/^) and split('\n') work.
export function readSource(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

// best-effort resolution of a gosub target that isn't one of the local flow-control
// labels (stair_options/ladder_options/unhandled_*) - searches the whole content tree
// for `[label,name]` and pulls the first transition call out of its body.
function resolveExternalLabel(name: string): { body: string; file: string } | null {
    const stack: string[] = [SCRIPTS_ROOT];
    while (stack.length) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!entry.name.endsWith('.rs2')) {
                continue;
            }
            const text = readSource(full);
            const marker = `[label,${name}]`;
            const idx = text.indexOf(marker);
            if (idx === -1) {
                continue;
            }
            const rest = text.slice(idx + marker.length);
            const nextBlock = rest.search(/\n\[/);
            const body = nextBlock === -1 ? rest : rest.slice(0, nextBlock);
            return { body, file: path.relative(CONTENT_ROOT, full) };
        }
    }
    return null;
}

function buildEntrance(base: Omit<Entrance, 'kind' | 'destination' | 'method' | 'up'>, chunk: string, headerComment: string | null = null): Entrance[] {
    const description = base.description ?? extractComment(chunk) ?? headerComment;

    const climb = findCall(chunk, '~climb_ladder') ?? findCall(chunk, 'climb_ladder');
    if (climb && climb.args.length === 2) {
        const destination = parseCoordExpr(climb.args[0]);
        const up = climb.args[1].trim() === 'true';
        return [{ ...base, description, method: 'climb_ladder', destination, up, kind: classify(base.source, destination) }];
    }

    const jump = findCall(chunk, 'p_telejump');
    if (jump && jump.args.length === 1) {
        const destination = parseCoordExpr(jump.args[0]);
        return [{ ...base, description, method: 'p_telejump', destination, up: null, kind: classify(base.source, destination) }];
    }

    const teleport = findCall(chunk, 'p_teleport');
    if (teleport && teleport.args.length === 1) {
        const destination = parseCoordExpr(teleport.args[0]);
        return [{ ...base, description, method: 'p_teleport', destination, up: null, kind: classify(base.source, destination) }];
    }

    for (const choiceLabel of ['stair_options', 'ladder_options']) {
        const choice = findCall(chunk, choiceLabel);
        if (choice && choice.args.length === 2) {
            const up = parseCoordExpr(choice.args[0]);
            const down = parseCoordExpr(choice.args[1]);
            return [
                { ...base, description, method: 'p_telejump', destination: up, up: true, kind: classify(base.source, up) },
                { ...base, description, method: 'p_telejump', destination: down, up: false, kind: classify(base.source, down) }
            ];
        }
    }

    if (/@unhandled_(stairs|ladder)\b/.test(chunk)) {
        return [{ ...base, description, method: 'unhandled', destination: null, up: null, kind: 'no-transition' }];
    }

    const gosub = findBareGosub(chunk);
    if (gosub) {
        const resolved = resolveExternalLabel(gosub);
        if (resolved) {
            const gated = /\bif\s*\(/.test(resolved.body.split(/~climb_ladder|p_telejump|p_teleport/)[0] ?? '');
            const nested = buildEntrance({ ...base, description }, resolved.body);
            return nested.map(e => ({ ...e, gosubTarget: gosub, resolvedFrom: resolved.file, gated }));
        }
        return [{ ...base, description, method: 'gosub', destination: null, up: null, gosubTarget: gosub, kind: 'unresolved' }];
    }

    return [{ ...base, description, method: 'unhandled', destination: null, up: null, kind: 'no-transition' }];
}

// splits a `switch_coord (...) { ... }` or `switch_int (...) { ... }` body into
// per-case chunks. cases are found by looking for `case X :` / `default :` markers at
// the start of a (trimmed) line.
function splitSwitchCases(body: string): { label: string; chunk: string }[] {
    const lines = body.split('\n');
    const cases: { label: string; chunk: string }[] = [];
    let current: { label: string; lines: string[] } | null = null;

    for (const line of lines) {
        const trimmed = line.trim();
        const marker = trimmed.match(/^case\s+([^:]+?)\s*:\s*(.*)$/) ?? trimmed.match(/^(default)\s*:\s*(.*)$/);
        if (marker) {
            if (current) {
                cases.push({ label: current.label, chunk: current.lines.join('\n') });
            }
            current = { label: marker[1].trim(), lines: [marker[2]] };
        } else if (current) {
            current.lines.push(line);
        }
    }
    if (current) {
        cases.push({ label: current.label, chunk: current.lines.join('\n') });
    }
    return cases;
}

function findBlock(text: string, keyword: string): { inner: string; endIdx: number } | null {
    const re = new RegExp(`switch_${keyword}\\s*\\([^)]*\\)\\s*\\{`);
    const match = text.match(re);
    if (!match || match.index === undefined) {
        return null;
    }
    const braceIdx = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = braceIdx; i < text.length; i++) {
        if (text[i] === '{') {
            depth++;
        } else if (text[i] === '}') {
            depth--;
            if (depth === 0) {
                return { inner: text.slice(braceIdx + 1, i), endIdx: i + 1 };
            }
        }
    }
    return null;
}

function parseHandlerBody(file: string, line: number, category: string, op: string, body: string, headerComment: string | null): Entrance[] {
    const entrances: Entrance[] = [];

    const coordSwitch = findBlock(body, 'coord');
    if (coordSwitch) {
        for (const { label, chunk } of splitSwitchCases(coordSwitch.inner)) {
            const source: SourceSpec = label === 'default' || !COORD_RE.test(label) ? { type: 'any' } : { type: 'literal', coord: decodeCoord(label) };
            entrances.push(...buildEntrance({ file, line, category, op, source, description: null }, chunk, headerComment));
        }
        return entrances;
    }

    const angleSwitch = findBlock(body, 'int');
    if (angleSwitch) {
        for (const { label, chunk } of splitSwitchCases(angleSwitch.inner)) {
            const source: SourceSpec = label === 'default' ? { type: 'any' } : { type: 'angle', angle: parseInt(label, 10) };
            entrances.push(...buildEntrance({ file, line, category, op, source, description: null }, chunk, headerComment));
        }
        return entrances;
    }

    // if ($coord = LITERAL) { ... } / if (loc_coord = LITERAL) { ... } - both forms
    // appear (compare ladders.rs2's wizard tower ladders vs. the mining guild ladder).
    // each branch checked in turn, plus whatever code follows as an implicit default.
    const ifChain = [...body.matchAll(/if\s*\(\s*(?:\$coord|loc_coord)\s*=\s*([\d_]+)\s*\)\s*\{([\s\S]*?)\n\}/g)];
    if (ifChain.length) {
        for (const m of ifChain) {
            const source: SourceSpec = { type: 'literal', coord: decodeCoord(m[1]) };
            entrances.push(...buildEntrance({ file, line, category, op, source, description: null }, m[2], headerComment));
        }

        const last = ifChain[ifChain.length - 1];
        const tail = body.slice(last.index! + last[0].length);
        const tailWithoutElse = tail.replace(/^\s*else\s*\{[\s\S]*?\n\}/, '');
        if (/~climb_ladder|p_telejump|p_teleport|@[a-zA-Z]/.test(tailWithoutElse)) {
            entrances.push(...buildEntrance({ file, line, category, op, source: { type: 'any' }, description: null }, tailWithoutElse, headerComment));
        }
        return entrances;
    }

    // no switch/if at all - a single unconditional handler applying to every loc of
    // this category.
    entrances.push(...buildEntrance({ file, line, category, op, source: { type: 'any' }, description: null }, body, headerComment));
    return entrances;
}

const COMMENT_ONLY_RE = /^\s*(\/\/.*)?$/;

// relFileLabel lets callers parse a file living somewhere other than CONTENT_ROOT (e.g.
// a backup copy) while still tagging entrances with their logical content-relative path.
export function parseFile(filePath: string, relFileLabel?: string): Entrance[] {
    const text = readSource(filePath);
    const relFile = relFileLabel ?? path.relative(CONTENT_ROOT, filePath);
    const lines = text.split('\n');

    const entrances: Entrance[] = [];
    const headerRe = /^\[oploc(\d+),([^\]]+)\]/;

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(headerRe);
        if (!match) {
            continue;
        }

        // a `// comment` line directly above the header describes this handler (e.g.
        // "// Climb Up" above `[oploc1,ship_ladder]`) - walk up to find it.
        let headerComment: string | null = null;
        for (let h = i - 1; h >= 0 && COMMENT_ONLY_RE.test(lines[h]); h--) {
            const c = lines[h].trim();
            if (c.startsWith('//')) {
                headerComment = c.slice(2).trim();
                break;
            }
        }

        let end = i + 1;
        while (end < lines.length && !lines[end].startsWith('[')) {
            end++;
        }

        // trailing blank/comment-only lines right before the *next* header belong to
        // that next handler, not this one - don't let them get read as this handler's
        // own inline comment.
        let bodyEnd = end;
        while (bodyEnd > i + 1 && COMMENT_ONLY_RE.test(lines[bodyEnd - 1])) {
            bodyEnd--;
        }

        const body = lines.slice(i + 1, bodyEnd).join('\n');
        entrances.push(...parseHandlerBody(relFile, i + 1, match[2], `oploc${match[1]}`, body, headerComment));
        i = end - 1;
    }

    return entrances;
}
