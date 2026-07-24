import fs from 'fs';
import path from 'path';

import { CONTENT_ROOT, SCRIPTS_ROOT, decodeCoord, type CoordLiteral } from './EntranceParser.js';
import { scanPlacements } from './LocPlacementScanner.js';

// Deterministic scan of every passage-controlling loc ("door") in the content set,
// classifying each as FREE (opens/passes unconditionally) or GATED (the open/pass action
// is guarded by a quest / skill / item / membership condition). Also enumerates
// dynamically-spawned barriers (loc_add/loc_change/loc_del of a blocking loc) that gate
// passage without being an openable door at all.
//
// WHY THIS IS COMPLETE (not a heuristic guess): for a barrier to ever become passable it
// must EITHER (a) have an interaction handler you click to open - an `[oploc*,X]` block,
// enumerable by scanning every .rs2 - OR (b) be spawned/removed by a script -
// loc_add/loc_change/loc_del, also enumerable. There is no third way for blocking
// geometry to open, so the union of those two scans is the whole universe of gateable
// passages. "Is it gated" is then a STRUCTURAL property of the handler (does an `if`
// condition on a gate-signal stand between the click and the open), not a name guess.
//
// The only residue that is genuinely undecidable statically - a loc_* call whose coord or
// condition is a runtime value - is emitted as an explicit `unresolved` list rather than
// silently dropped. Completeness is therefore "every door + a finite, printed list of the
// N cases a human must eyeball", which is what makes this deterministic.
//
// Run from the engine dir: `npx tsx tools/map/ScanDoors.ts` -> writes tools/map/door-scan.json.

// ---------------------------------------------------------------------------
// loc config parsing
// ---------------------------------------------------------------------------

type LocConfig = {
    name: string;      // debugname (the [name] header)
    displayName?: string; // name= field
    model?: string;
    category?: string;
    ops: string[];     // op1..op5 labels, lowercased
};

// UNAMBIGUOUS passage verbs. Deliberately NOT "open"/"close"/"shut" - those are shared
// with containers (chests/cupboards/drawers open too), which is the main precision trap.
// A real door with only op1=Open is still caught by its wall/door/gate MODEL below.
// Climb-up/Climb-down (ladders/stairs) are excluded - EntranceParser's domain.
const PASSAGE_OP_RE = /^(pick[ -]?lock|go[ -]through|squeeze[ -]through|climb[ -]through|climb[ -]over|force|unlock|enter|push|pull)$/;
// the geometry itself reads as a doorway/wall. `STRONG_DOOR_RE` is decisive (a thing
// literally named/modelled door|gate wins even if a container word is also present);
// `BARRIER_MODEL_RE` is the softer wall/obstacle signal.
const STRONG_DOOR_RE = /door|gate|portcullis|grille|drawbridge|hoarding/i;
const BARRIER_MODEL_RE = /wall|fence|barrier|railings|\bpipe\b|obstacle|rope_swing|crumbly|tunnel|hole|bars\b/i;
// containers/furniture that carry op1=Open + a key/quest gate but do NOT block walking -
// bucketed separately so they never pollute the reachability-relevant passage list.
const CONTAINER_RE = /chest|cupboard|drawer|sack|barrel|trough|crate|coffin|casket|wardrobe|cabinet|bookcase|\btable\b|desk|dresser|shelf|\bbin\b|closet|drawers|tap\b/i;

function readSource(file: string): string {
    // content is CRLF; normalise so regexes with line semantics behave (EntranceParser
    // convention). We never write these files back, so restoring CRLF is unnecessary.
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function walk(dir: string, ext: string, out: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, ext, out);
        } else if (entry.name.endsWith(ext)) {
            out.push(full);
        }
    }
}

function findFiles(ext: string): string[] {
    const out: string[] = [];
    walk(SCRIPTS_ROOT, ext, out);
    return out.sort();
}

function loadLocConfigs(): Map<string, LocConfig> {
    const configs = new Map<string, LocConfig>();
    for (const file of findFiles('.loc')) {
        let cur: LocConfig | null = null;
        for (const line of readSource(file).split('\n')) {
            if (line.startsWith('[')) {
                cur = { name: line.slice(1, line.lastIndexOf(']')), ops: [] };
                // last definition wins if a name is redefined (area configs override the
                // _unpack base dumps); merging isn't needed - door signals are stable.
                configs.set(cur.name, cur);
                continue;
            }
            if (!cur) {
                continue;
            }
            const eq = line.indexOf('=');
            if (eq === -1) {
                continue;
            }
            const key = line.slice(0, eq);
            const val = line.slice(eq + 1).trim();
            if (key === 'name') cur.displayName = val;
            else if (key === 'model') cur.model = val;
            else if (key === 'category') cur.category = val;
            else if (/^op[1-5]$/.test(key)) cur.ops.push(val.toLowerCase());
        }
    }
    return configs;
}

function passageOps(cfg: LocConfig): string[] {
    return cfg.ops.filter(op => PASSAGE_OP_RE.test(op.replace(/\s+/g, ' ').trim()));
}

type LocKind = 'passage' | 'container' | 'none';

// Deterministic three-way classification of a loc from its config alone. Passages block
// walking (doors/gates/walls/obstacles); containers are openable furniture that don't;
// everything else is irrelevant. Recall-biased: a strong door/gate name/model always wins
// (a mislabelled false-negative here would be a missed reachability gate, the dangerous
// direction), and containers are flagged rather than dropped.
function locKind(cfg: LocConfig | undefined): LocKind {
    if (!cfg) {
        return 'none';
    }
    // debugname included: some furniture only self-identifies there (barrelwithtap,
    // ctfoodtrough). Safe because STRONG_DOOR_RE is tested FIRST - a door whose debugname
    // happens to contain a container word (kitchen_cupboard_door) still wins as a passage.
    // The `outdoor`/`indoor` strip is essential: model names like `outdoorfurniture_*`
    // contain the substring "door" and would otherwise false-match every barrel/trough as
    // a door. "gate" inside the same names (metalgate...) survives the strip and is kept.
    const hay = `${cfg.model ?? ''} ${cfg.displayName ?? ''} ${cfg.category ?? ''} ${cfg.name}`
        .toLowerCase()
        .replace(/(out|in)door(furniture)?/g, ' ');
    if (STRONG_DOOR_RE.test(hay)) {
        return 'passage';
    }
    if (CONTAINER_RE.test(hay)) {
        return 'container';
    }
    if (passageOps(cfg).length > 0 || BARRIER_MODEL_RE.test(hay)) {
        return 'passage';
    }
    return 'none';
}

// ---------------------------------------------------------------------------
// gate-signal detection (the structural classifier)
// ---------------------------------------------------------------------------

type GateKind = 'quest' | 'skill' | 'item' | 'members';

// procs that ARE the gate (skill + lockpick) - a handler calling one is gated regardless
// of nesting, since the refusal lives inside the proc.
const LOCKED_DOOR_PROC_RE = /~(attempt_open_locked_door|pick_locked_door)\b/;

// tokens that, when they appear inside an `if (...)` / `while (...)` condition, mean the
// open action past that branch is gated. Ordered so the reported kind is the most
// specific match.
const GATE_TOKENS: { kind: GateKind; re: RegExp }[] = [
    { kind: 'item', re: /\binv_total\s*\(|\binv_contains\s*\(|\blast_useitem\b|~has(_|_worn_|_equipped_)?item/ },
    { kind: 'skill', re: /\bstat_(base|level)\s*\(|~levelrequire/ },
    { kind: 'members', re: /\bmap_members\b/ },
    { kind: 'quest', re: /%[a-z0-9_]+/ }, // a quest/progress varp read in the condition
];

// pull out every `if (...)` / `while (...)` condition text in a handler body. Handles
// nested parens by depth-counting from each `if`/`while` keyword.
function extractConditions(body: string): string[] {
    const conds: string[] = [];
    const kw = /\b(if|while)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = kw.exec(body)) !== null) {
        let depth = 1;
        let i = m.index + m[0].length;
        const start = i;
        while (i < body.length && depth > 0) {
            if (body[i] === '(') depth++;
            else if (body[i] === ')') depth--;
            i++;
        }
        conds.push(body.slice(start, i - 1));
    }
    return conds;
}

type Verdict =
    | { gated: false }
    | { gated: true; kind: GateKind; condition: string };

function classifyHandler(body: string): Verdict {
    if (LOCKED_DOOR_PROC_RE.test(body)) {
        return { gated: true, kind: 'skill', condition: '~attempt_open_locked_door / ~pick_locked_door (Thieving + lockpick)' };
    }
    for (const cond of extractConditions(body)) {
        for (const { kind, re } of GATE_TOKENS) {
            if (re.test(cond)) {
                return { gated: true, kind, condition: cond.trim() };
            }
        }
    }
    return { gated: false };
}

// ---------------------------------------------------------------------------
// handler enumeration
// ---------------------------------------------------------------------------

const OPLOC_HEADER_RE = /^\[oploc([1-5u]),([a-zA-Z0-9_]+)\]/;

type DoorHandler = {
    loc: string;
    op: string;
    file: string;
    kind: LocKind;
    verdict: Verdict;
};

// splits a .rs2 file into [header, body] handler blocks: a block runs from its `[...]`
// header line to the next top-level `[...]` header.
function forEachBlock(text: string, fn: (header: string, body: string) => void): void {
    const lines = text.split('\n');
    let header: string | null = null;
    let body: string[] = [];
    const flush = () => {
        if (header !== null) {
            fn(header, body.join('\n'));
        }
    };
    for (const line of lines) {
        if (line.startsWith('[')) {
            flush();
            header = line;
            body = [];
        } else if (header !== null) {
            body.push(line);
        }
    }
    flush();
}

function scanHandlers(locs: Map<string, LocConfig>): DoorHandler[] {
    const handlers: DoorHandler[] = [];
    for (const file of findFiles('.rs2')) {
        const rel = path.relative(SCRIPTS_ROOT, file);
        forEachBlock(readSource(file), (header, body) => {
            const m = header.match(OPLOC_HEADER_RE);
            if (!m) {
                return;
            }
            const loc = m[2];
            const kind = locKind(locs.get(loc));
            if (kind === 'none') {
                return; // skips ladders, searches, NPCs-as-locs, decorative interactables
            }
            handlers.push({ loc, op: `oploc${m[1]}`, file: rel, kind, verdict: classifyHandler(body) });
        });
    }
    return handlers;
}

// ---------------------------------------------------------------------------
// dynamic barrier enumeration (loc_add / loc_change / loc_del of a blocking loc)
// ---------------------------------------------------------------------------

type DynamicBarrier = {
    loc: string;
    call: 'loc_add' | 'loc_change' | 'loc_del' | 'loc_addchange';
    file: string;
    coord: string | null; // literal coord if statically resolvable, else null -> residue
};

const LOC_CALL_RE = /\b(loc_add|loc_change|loc_del|loc_addchange)\s*\(([^;]*?)\)/g;
const COORD_LITERAL_RE = /\b(\d+_\d+_\d+_\d+_\d+)\b/;

function scanDynamicBarriers(locs: Map<string, LocConfig>): { barriers: DynamicBarrier[]; unresolved: DynamicBarrier[] } {
    const barriers: DynamicBarrier[] = [];
    const unresolved: DynamicBarrier[] = [];
    for (const file of findFiles('.rs2')) {
        const rel = path.relative(SCRIPTS_ROOT, file);
        const text = readSource(file);
        let m: RegExpExecArray | null;
        LOC_CALL_RE.lastIndex = 0;
        while ((m = LOC_CALL_RE.exec(text)) !== null) {
            const args = m[2];
            // find which passage loc (if any) is named in this call's args - containers
            // spawned/removed dynamically don't gate walking, so only 'passage' counts
            const loc = args.split(/[\s,()]+/).find(tok => locKind(locs.get(tok)) === 'passage');
            if (!loc) {
                continue;
            }
            const coordMatch = args.match(COORD_LITERAL_RE);
            const rec: DynamicBarrier = {
                loc,
                call: m[1] as DynamicBarrier['call'],
                file: rel,
                coord: coordMatch ? coordMatch[1] : null
            };
            (rec.coord ? barriers : unresolved).push(rec);
        }
    }
    return { barriers, unresolved };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function coordDesc(c: CoordLiteral): string {
    return `${c.raw} (world ${c.worldX},${c.worldZ} plane ${c.plane})`;
}

function main(): void {
    const locs = loadLocConfigs();
    const handlers = scanHandlers(locs);

    // collapse per-handler verdicts to per-loc: a loc is gated if ANY of its op handlers
    // gate (right-click Open on the same door as talk-through both matter).
    const perLoc = new Map<string, { locKind: LocKind; gated: boolean; kind?: GateKind; condition?: string; ops: string[]; files: Set<string> }>();
    for (const h of handlers) {
        let e = perLoc.get(h.loc);
        if (!e) {
            e = { locKind: h.kind, gated: false, ops: [], files: new Set() };
            perLoc.set(h.loc, e);
        }
        e.ops.push(h.op);
        e.files.add(h.file);
        if (h.verdict.gated && !e.gated) {
            e.gated = true;
            e.kind = h.verdict.kind;
            e.condition = h.verdict.condition;
        }
    }

    // only PASSAGES gate reachability; gated containers are reported separately below.
    const gatedNames = [...perLoc.entries()].filter(([, e]) => e.gated && e.locKind === 'passage').map(([loc]) => loc);
    const placements = scanPlacements(gatedNames);
    const placementsByLoc = new Map<string, CoordLiteral[]>();
    for (const p of placements) {
        const arr = placementsByLoc.get(p.locName) ?? [];
        arr.push(p.coord);
        placementsByLoc.set(p.locName, arr);
    }

    const gatedDoors = gatedNames.sort().map(loc => {
        const e = perLoc.get(loc)!;
        const coords = placementsByLoc.get(loc) ?? [];
        return {
            loc,
            displayName: locs.get(loc)?.displayName,
            gateKind: e.kind,
            condition: e.condition,
            ops: e.ops,
            files: [...e.files],
            placements: coords.map(coordDesc),
            placementCoords: coords.map(c => c.raw), // machine-readable (level_mapX_mapZ_localX_localZ) for DeriveGatedAreas/BuildRegionGraph
            placedOnMap: coords.length > 0 // false = defined but no static placement found (dynamically spawned or member-map)
        };
    });

    const freePassages = [...perLoc.entries()].filter(([, e]) => !e.gated && e.locKind === 'passage').map(([loc, e]) => ({ loc, ops: e.ops, files: [...e.files] })).sort((a, b) => a.loc.localeCompare(b.loc));

    // gated containers (chests/cupboards behind keys/quests) - NOT reachability gates, but
    // surfaced so the classification is auditable and nothing is silently dropped.
    const gatedContainers = [...perLoc.entries()].filter(([, e]) => e.gated && e.locKind === 'container').map(([loc, e]) => ({ loc, gateKind: e.kind, condition: e.condition, files: [...e.files] })).sort((a, b) => a.loc.localeCompare(b.loc));

    const { barriers, unresolved } = scanDynamicBarriers(locs);

    const report = {
        generatedAt: new Date().toISOString(),
        note: 'Deterministic passage/gate scan. gatedPassages = doors/gates/walls whose open is behind a quest/skill/item/members condition (these gate reachability). dynamicBarriers = blocking locs spawned/removed by scripts. unresolved = statically-undecidable residue to review by hand. gatedContainers = chests/furniture (NOT reachability gates), shown for audit.',
        summary: {
            passageLocsWithHandlers: [...perLoc.values()].filter(e => e.locKind === 'passage').length,
            gatedPassages: gatedDoors.length,
            freePassages: freePassages.length,
            gatedByKind: gatedDoors.reduce((acc, d) => { acc[d.gateKind!] = (acc[d.gateKind!] ?? 0) + 1; return acc; }, {} as Record<string, number>),
            gatedContainers: gatedContainers.length,
            dynamicBarriers: barriers.length,
            unresolvedDynamicBarriers: unresolved.length
        },
        gatedPassages: gatedDoors,
        dynamicBarriers: barriers,
        unresolved: {
            note: 'loc_add/change/del on a blocking passage loc whose coord is a runtime value - the only statically-undecidable residue. Review these by hand.',
            dynamicBarriers: unresolved
        },
        gatedContainers,
        freePassages
    };

    const outPath = path.resolve(process.cwd(), 'tools/map/door-scan.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    console.log('=== ScanDoors ===');
    console.log(`passage locs with handlers : ${report.summary.passageLocsWithHandlers}`);
    console.log(`  GATED passages           : ${report.summary.gatedPassages}  ${JSON.stringify(report.summary.gatedByKind)}`);
    console.log(`  free passages            : ${report.summary.freePassages}`);
    console.log(`gated containers (not reachability gates) : ${report.summary.gatedContainers}`);
    console.log(`dynamic barriers (loc_*)   : ${report.summary.dynamicBarriers} resolved, ${report.summary.unresolvedDynamicBarriers} unresolved`);
    console.log(`\nwrote ${path.relative(process.cwd(), outPath)}`);
    console.log('\ngated passages (loc : kind : #placements):');
    for (const d of gatedDoors) {
        console.log(`  ${d.loc}  :  ${d.gateKind}  :  ${d.placements.length}${d.placedOnMap ? '' : '  (no static placement)'}`);
    }
}

main();
