// Quest-region extractor (docs/entrance-logic.md follow-up: automated quest spatial
// audit). Statically parses every quest's rs2 scripts - both the quest folder AND any
// script tree-wide whose trigger blocks touch that quest's varps (quest logic leaks
// into doors/, areas/, ladders+stairs/, etc.) - collects every spatial fact
// (trigger-subject NPC/loc/obj placements from map data, coord literals, inzone zones,
// p_teleport destinations), resolves each to a region id via region-graph.json, and
// emits a provenance-annotated draft: tools/logic/data/quest-regions.generated.json.
//
// This is DRAFT data for review/merge into the curated quest-regions.json, not a
// direct ValidateSeed input. Semantics that make the draft trustworthy in one
// direction only: static extraction over-collects (it can't tell a mandatory step
// from optional flavor dialogue), so treating every extracted region as required is
// conservative - it can flag a beatable seed, never bless an unbeatable one. Entities
// with multiple world placements are any-of (scripts trigger on the entity TYPE, so
// any reachable placement satisfies the interaction).
//
// Usage (from Server/engine):
//   npx tsx tools/logic/ExtractQuestRegions.ts [--json <out>] [--verbose]

import fs from 'fs';
import path from 'path';

import { CONTENT_ROOT } from '../map/EntranceParser.js';

import { WorldTile, parseRawCoord, toRawCoord } from './Coords.js';
import { RegionGraph, loadRegionGraph } from './RegionGraph.js';

const argv = process.argv.slice(2);
function argVal(flag: string): string | undefined {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
}
const VERBOSE = argv.includes('--verbose') || argv.includes('-v');
const REGION_GRAPH_PATH = argVal('--region-graph') ?? path.join('tools', 'logic', 'region-graph.json');
const OUT_PATH = argVal('--json') ?? path.join('tools', 'logic', 'data', 'quest-regions.generated.json');

const SCRIPTS_ROOT = path.join(CONTENT_ROOT, 'scripts');
const MAPS_DIR = path.join(CONTENT_ROOT, 'maps');
const QUESTS_DIR = path.join(SCRIPTS_ROOT, 'quests');

// Skip our own AP overlay scripts (they read quest varps for tracking, not quest
// logic) and dev-only trees.
const SKIP_DIRS = new Set(['ap', '_test', '_unpack']);

// Cap stored any-of region lists AFTER region-dedupe (generic NPCs like `man` have
// hundreds of spawns but few distinct regions); mainlandOk is computed pre-cap.
const ANYOF_CAP = 24;

type Domain = 'npc' | 'loc' | 'obj';

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

function* walkFiles(dir: string, ext: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (path.dirname(full) === SCRIPTS_ROOT && SKIP_DIRS.has(entry.name)) {
                continue;
            }
            yield* walkFiles(full, ext);
        } else if (entry.name.endsWith(ext)) {
            yield full;
        }
    }
}

function relContent(full: string): string {
    return path.relative(CONTENT_ROOT, full).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Pack files: id <-> name per domain
// ---------------------------------------------------------------------------

function loadPack(file: string): { byId: Map<number, string>; byName: Map<string, number> } {
    const byId = new Map<number, string>();
    const byName = new Map<string, number>();
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq === -1) {
            continue;
        }
        const id = parseInt(line.slice(0, eq), 10);
        const name = line.slice(eq + 1).trim();
        byId.set(id, name);
        byName.set(name, id);
    }
    return { byId, byName };
}

// ---------------------------------------------------------------------------
// Config files: category membership ([name] blocks with category=<cat> lines)
// ---------------------------------------------------------------------------

function loadCategories(): Map<Domain, Map<string, string[]>> {
    const perDomain = new Map<Domain, Map<string, string[]>>([
        ['npc', new Map()],
        ['loc', new Map()],
        ['obj', new Map()]
    ]);
    for (const domain of ['npc', 'loc', 'obj'] as Domain[]) {
        const catMap = perDomain.get(domain)!;
        for (const file of walkFiles(SCRIPTS_ROOT, `.${domain}`)) {
            let current: string | null = null;
            for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
                const header = /^\[([a-z_0-9]+)\]/.exec(line);
                if (header) {
                    current = header[1];
                    continue;
                }
                const cat = /^category=([a-z_0-9]+)/.exec(line.trim());
                if (cat && current) {
                    if (!catMap.has(cat[1])) {
                        catMap.set(cat[1], []);
                    }
                    catMap.get(cat[1])!.push(current);
                }
            }
        }
    }
    return perDomain;
}

// ---------------------------------------------------------------------------
// Map placements: jm2 NPC/OBJ/LOC sections -> per-domain name -> WorldTile[]
// jm2 placement lines: `level localX localZ: id [shape] [angle]` under
// `==== NPC ====` / `==== OBJ ====` / `==== LOC ====` section markers.
// ---------------------------------------------------------------------------

const PLACEMENT_LINE_RE = /^(\d+) (\d+) (\d+): (\d+)/;

function loadPlacements(packs: Map<Domain, { byId: Map<number, string> }>): Map<Domain, Map<string, WorldTile[]>> {
    const out = new Map<Domain, Map<string, WorldTile[]>>([
        ['npc', new Map()],
        ['loc', new Map()],
        ['obj', new Map()]
    ]);
    const sectionFor = new Map<string, Domain>([
        ['==== NPC ====', 'npc'],
        ['==== OBJ ====', 'obj'],
        ['==== LOC ====', 'loc']
    ]);
    for (const file of fs.readdirSync(MAPS_DIR)) {
        const m = /^m(\d+)_(\d+)\.jm2$/.exec(file);
        if (!m) {
            continue;
        }
        const mapX = parseInt(m[1], 10);
        const mapZ = parseInt(m[2], 10);
        let domain: Domain | null = null;
        for (const line of fs.readFileSync(path.join(MAPS_DIR, file), 'utf8').split(/\r?\n/)) {
            if (line.startsWith('====')) {
                domain = sectionFor.get(line.trim()) ?? null;
                continue;
            }
            if (!domain) {
                continue;
            }
            const p = PLACEMENT_LINE_RE.exec(line);
            if (!p) {
                continue;
            }
            const name = packs.get(domain)!.byId.get(parseInt(p[4], 10));
            if (name === undefined) {
                continue;
            }
            const tile: WorldTile = {
                level: parseInt(p[1], 10),
                x: mapX * 64 + parseInt(p[2], 10),
                z: mapZ * 64 + parseInt(p[3], 10)
            };
            const byName = out.get(domain)!;
            if (!byName.has(name)) {
                byName.set(name, []);
            }
            byName.get(name)!.push(tile);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Quest varp map: quests/quest_<id>/configs/*.varp [name] headers -> quest id
// ---------------------------------------------------------------------------

function loadQuestVarps(): { varpToQuest: Map<string, string>; questIds: string[] } {
    const varpToQuest = new Map<string, string>();
    const questIds: string[] = [];
    for (const entry of fs.readdirSync(QUESTS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('quest_')) {
            continue;
        }
        const questId = entry.name.slice('quest_'.length);
        questIds.push(questId);
        const configDir = path.join(QUESTS_DIR, entry.name, 'configs');
        if (!fs.existsSync(configDir)) {
            continue;
        }
        for (const file of fs.readdirSync(configDir)) {
            if (!file.endsWith('.varp')) {
                continue;
            }
            for (const line of fs.readFileSync(path.join(configDir, file), 'utf8').split(/\r?\n/)) {
                const m = /^\[([a-z_0-9]+)\]/.exec(line);
                if (m) {
                    varpToQuest.set(m[1], questId);
                }
            }
        }
    }
    return { varpToQuest, questIds };
}

// ---------------------------------------------------------------------------
// rs2 block model
// ---------------------------------------------------------------------------

interface Block {
    file: string; // content-relative
    trigger: string;
    subject: string;
    startLine: number; // 1-based
    lines: { line: string; num: number }[]; // comment-stripped body incl. header line
}

const HEADER_RE = /^\[([a-z_0-9]+),([^\]]+)\]/;

function parseBlocks(fullPath: string): Block[] {
    const rel = relContent(fullPath);
    const blocks: Block[] = [];
    let current: Block | null = null;
    const rawLines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
    for (let i = 0; i < rawLines.length; i++) {
        // strip line comments - coords inside comments are documentation, not logic.
        const line = rawLines[i].replace(/\/\/.*$/, '');
        const header = HEADER_RE.exec(line);
        if (header) {
            current = { file: rel, trigger: header[1], subject: header[2].trim(), startLine: i + 1, lines: [] };
            blocks.push(current);
        }
        if (current) {
            current.lines.push({ line, num: i + 1 });
        }
    }
    return blocks;
}

function subjectDomain(trigger: string): Domain | 'zone' | null {
    if (trigger.startsWith('opnpc') || trigger.startsWith('apnpc') || trigger.startsWith('ai_')) {
        return 'npc';
    }
    if (trigger.startsWith('oploc') || trigger.startsWith('aploc')) {
        return 'loc';
    }
    if (trigger.startsWith('opobj') || trigger.startsWith('apobj')) {
        return 'obj';
    }
    if (trigger === 'zone' || trigger === 'zoneexit') {
        return 'zone';
    }
    return null;
}

// ---------------------------------------------------------------------------
// Evidence model
// ---------------------------------------------------------------------------

interface ResolvedTile {
    raw: string; // canonical level_mapX_mapZ_localX_localZ
    region: number;
    mainland: boolean;
}

interface Evidence {
    /** Stable dedupe key ("<kind>|<entity-or-coord>") - the handle curated
     *  quest-regions.json ignore-lists use to exempt an item from validation. */
    key: string;
    kind: 'subject' | 'zone-trigger' | 'coord' | 'teleport-dest' | 'inzone' | 'entity-ref' | 'dynamic-spawn';
    domain?: Domain;
    name?: string; // entity/category name for subject/entity-ref kinds
    anyOf: ResolvedTile[]; // capped at ANYOF_CAP for storage
    anyOfTotal: number; // pre-cap count
    mainlandOk: boolean; // at least one resolution reaches the mainland region
    provenance: string[]; // "file:line"
    flags: string[]; // 'unresolved-name', 'no-placements', 'unwalkable', ...
}

interface QuestEdge {
    dest: ResolvedTile;
    fromRegions: number[]; // candidate source regions from same-block context
    provenance: string;
}

/**
 * A quest-agnostic physical transition extracted from ANY rs2 block (not just
 * quest-attributed ones): bespoke cave entrances, sewer ladders, non-shuffle-pool
 * stairs - every `p_teleport`/`p_telejump` to a literal destination. `from` is precise
 * when the teleport sits on a `case <coord> :` line (the case coord IS the trigger
 * tile - this reproduces the vanilla ladders+stairs edge set exactly); otherwise it
 * falls back to the block's subject placements / zone / inzone context. Consumers
 * must drop edges whose from-tile the seed's entrance overrides replace (the override
 * preamble preempts the vanilla case body at runtime).
 */
interface WorldEdge {
    from: ResolvedTile[];
    dest: ResolvedTile;
    viaCase: boolean;
    provenance: string;
}

interface QuestDraft {
    evidence: Map<string, Evidence>; // dedupe key -> merged evidence
    edges: QuestEdge[];
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const COORD_LIT_RE = /\b([0-3])_(\d+)_(\d+)_(\d+)_(\d+)\b/g;
const VARP_RE = /%([a-z_][a-z_0-9]*)/g;
const NPC_FIND_RE = /npc_find\(\s*[^,)]+,\s*([a-z_][a-z_0-9]*)/g;
const ENTITY_ADD_RE = /(npc_add|loc_add|obj_add)\(\s*([^,]+),\s*([a-z_][a-z_0-9]*)/g;

function main(): void {
    const t0 = Date.now();
    console.log('ExtractQuestRegions: loading region graph, packs, configs, map placements...');
    const graph = loadRegionGraph(REGION_GRAPH_PATH);
    const mainlandId = graph.meta.mainlandRegionId;

    const packs = new Map<Domain, ReturnType<typeof loadPack>>([
        ['npc', loadPack(path.join(CONTENT_ROOT, 'pack', 'npc.pack'))],
        ['loc', loadPack(path.join(CONTENT_ROOT, 'pack', 'loc.pack'))],
        ['obj', loadPack(path.join(CONTENT_ROOT, 'pack', 'obj.pack'))]
    ]);
    const categories = loadCategories();
    const placements = loadPlacements(packs);
    const { varpToQuest, questIds } = loadQuestVarps();

    const drafts = new Map<string, QuestDraft>(questIds.map(id => [id, { evidence: new Map(), edges: [] }]));

    // NOTE on upper-level megaregions (level 1: 415k tiles, level 2: ~250k, level 3:
    // 1.1M): these merged walkable layers are PARTIALLY legitimate - real upstairs
    // floors merge into them, and world edges route through them - so they must NOT
    // be filtered out of resolution (tried 2026-07-17: dropped 88 world edges and
    // regressed region-only completion 63->51). Evidence that resolves ONLY into a
    // megaregion (the Underground Pass level-1 walkways) is instead handled by
    // targeted curated ignores; open-area membership has its own tile cap.
    function resolveTile(tile: WorldTile): ResolvedTile {
        const region = graph.resolveRegion(tile);
        return { raw: toRawCoord(tile), region, mainland: region === mainlandId };
    }

    /** Placements for a subject name, expanding _category subjects to member entities. */
    function placementsFor(domain: Domain, name: string): { tiles: WorldTile[]; flags: string[] } {
        const flags: string[] = [];
        let names: string[];
        if (name.startsWith('_')) {
            const members = categories.get(domain)!.get(name.slice(1));
            if (!members || members.length === 0) {
                return { tiles: [], flags: ['unresolved-category'] };
            }
            names = members;
        } else {
            if (!packs.get(domain)!.byName.has(name)) {
                return { tiles: [], flags: ['unresolved-name'] };
            }
            names = [name];
        }
        const tiles: WorldTile[] = [];
        for (const n of names) {
            tiles.push(...(placements.get(domain)!.get(n) ?? []));
        }
        if (tiles.length === 0) {
            flags.push('no-placements'); // script-spawned only (npc_add elsewhere) or unused
        }
        return { tiles, flags };
    }

    /**
     * All distinct walkable regions within `radius` of the tile, as ResolvedTiles
     * sharing the placement's raw coord. Interaction evidence (subjects, entity refs,
     * dynamic spawns) is satisfied from ANY of these: ops work at melee range and
     * through fences/bars/counters, so a penned NPC (Wormbrain in his jail, the
     * mourner on the watchtower) does not require entering its own tiny region -
     * standing in a neighboring one suffices.
     */
    function resolveNearby(tile: WorldTile, radius = 3): ResolvedTile[] {
        const raw = toRawCoord(tile);
        const seen = new Map<number, ResolvedTile>();
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                const region = graph.regionAt(tile.x + dx, tile.z + dz, tile.level);
                if (region !== 0 && !seen.has(region)) {
                    seen.set(region, { raw, region, mainland: region === mainlandId });
                }
            }
        }
        return [...seen.values()];
    }

    const ADJACENT_KINDS = new Set<Evidence['kind']>(['subject', 'entity-ref', 'dynamic-spawn']);

    function addEvidence(questId: string, kind: Evidence['kind'], key: string, tiles: WorldTile[], prov: string, opts: { domain?: Domain; name?: string; flags?: string[] } = {}): Evidence {
        const draft = drafts.get(questId)!;
        const dedupeKey = `${kind}|${key}`;
        let ev = draft.evidence.get(dedupeKey);
        if (!ev) {
            const resolved = ADJACENT_KINDS.has(kind) ? tiles.flatMap(t => resolveNearby(t)) : tiles.map(resolveTile);
            const walkable = resolved.filter(r => r.region !== 0);
            // any-of semantics only cares about DISTINCT regions - dedupe by region
            // (one representative tile each) BEFORE capping, so a satisfiable region
            // can never be truncated away by placement multiplicity.
            const byRegion = new Map<number, ResolvedTile>();
            for (const t of walkable) {
                if (!byRegion.has(t.region)) {
                    byRegion.set(t.region, t);
                }
            }
            const distinct = [...byRegion.values()];
            const flags = [...(opts.flags ?? [])];
            if (resolved.length > 0 && walkable.length === 0) {
                flags.push('unwalkable');
            }
            ev = {
                key: dedupeKey,
                kind,
                domain: opts.domain,
                name: opts.name,
                anyOf: distinct.slice(0, ANYOF_CAP),
                anyOfTotal: distinct.length,
                mainlandOk: walkable.some(r => r.mainland),
                provenance: [],
                flags
            };
            draft.evidence.set(dedupeKey, ev);
        }
        if (ev.provenance.length < 8 && !ev.provenance.includes(prov)) {
            ev.provenance.push(prov);
        }
        return ev;
    }

    // ---- pre-pass: index every label/proc body's literal teleport destinations.
    // Subject blocks frequently delegate the actual p_teleport to a label (
    // "@open_camp_door", "~ikov_winelda_teleport") - when a subject block calls one,
    // the callee's destinations become edges from the caller's context. Depth 1 only;
    // arg-driven helpers (~set_sail) have no literals in their bodies, so they are
    // naturally skipped rather than special-cased. ----
    const procTeleportDests = new Map<string, { raw: string; prov: string }[]>();
    for (const file of walkFiles(SCRIPTS_ROOT, '.rs2')) {
        for (const block of parseBlocks(file)) {
            if (block.trigger !== 'label' && block.trigger !== 'proc' && block.trigger !== 'queue') {
                continue;
            }
            for (const { line, num } of block.lines) {
                const m = /(?:p_teleport|p_telejump)\(\s*([0-3]_\d+_\d+_\d+_\d+)/.exec(line);
                if (!m) {
                    continue;
                }
                if (!procTeleportDests.has(block.subject)) {
                    procTeleportDests.set(block.subject, []);
                }
                procTeleportDests.get(block.subject)!.push({ raw: m[1], prov: `${block.file}:${num}` });
            }
        }
    }

    // ---- walk every rs2 block ----
    const worldEdges: WorldEdge[] = [];
    const worldEdgeSigs = new Set<string>();
    let filesScanned = 0;
    let blocksAttributed = 0;
    for (const file of walkFiles(SCRIPTS_ROOT, '.rs2')) {
        filesScanned++;
        const rel = relContent(file);
        const folderQuestMatch = /^scripts\/quests\/quest_([a-z_0-9]+)\//.exec(rel);
        const folderQuest = folderQuestMatch && drafts.has(folderQuestMatch[1]) ? folderQuestMatch[1] : null;

        for (const block of parseBlocks(file)) {
            // ---- world-edge pass: quest-agnostic physical transitions, EVERY block ----
            {
                const dom = subjectDomain(block.trigger);
                const isPlayerTrigger = dom !== null && !block.trigger.startsWith('ai_');
                let contextTiles: WorldTile[] | null = null;
                const contextFor = (): WorldTile[] => {
                    if (contextTiles !== null) {
                        return contextTiles;
                    }
                    contextTiles = [];
                    if (dom === 'zone') {
                        try {
                            contextTiles.push(parseRawCoord(block.subject));
                        } catch {
                            /* malformed zone subject */
                        }
                    } else if (isPlayerTrigger && dom !== null) {
                        for (const subj of block.subject.split(',').map(s => s.trim())) {
                            contextTiles.push(...placementsFor(dom, subj).tiles);
                        }
                    }
                    for (const { line } of block.lines) {
                        for (const m of line.matchAll(/inzone\(\s*([0-3]_\d+_\d+_\d+_\d+)/g)) {
                            contextTiles.push(parseRawCoord(m[1]));
                        }
                    }
                    return contextTiles;
                };
                const emitEdge = (fromTiles: WorldTile[], dest: ResolvedTile, viaCase: boolean, prov: string) => {
                    if (dest.region === 0) {
                        return;
                    }
                    const uniqueByRegion = new Map(
                        fromTiles
                            .map(t => resolveTile(t))
                            .filter(t => t.region !== 0 && t.region !== dest.region)
                            .map(t => [t.region, t] as const)
                    );
                    if (uniqueByRegion.size === 0) {
                        return;
                    }
                    const fromList = [...uniqueByRegion.values()];
                    const sig = `${fromList
                        .map(t => t.region)
                        .sort((a, b) => a - b)
                        .join(',')}>${dest.region}`;
                    if (!worldEdgeSigs.has(sig)) {
                        worldEdgeSigs.add(sig);
                        worldEdges.push({ from: fromList.slice(0, 16), dest, viaCase, provenance: prov });
                    }
                };
                for (const { line, num } of block.lines) {
                    const prov = `${block.file}:${num}`;
                    const caseMatch = /^\s*case\s+([^:]*):/.exec(line);
                    const caseTiles = caseMatch ? [...caseMatch[1].matchAll(/[0-3]_\d+_\d+_\d+_\d+/g)].map(m => parseRawCoord(m[0])) : null;

                    // absolute destination: teleports, ladder climbs, and forced walks
                    // (~forcewalk/2 = skill_agility's clipped telewalk - obstacle
                    // crossings like the desert jail rocks or Elena's sewer pipe).
                    const abs = /(?:p_teleport|p_telejump|~climb_ladder|~forcewalk2?)\(\s*([0-3]_\d+_\d+_\d+_\d+)/.exec(line);
                    if (abs) {
                        emitEdge(caseTiles ?? contextFor(), resolveTile(parseRawCoord(abs[1])), caseTiles !== null, prov);
                        continue;
                    }

                    // scripted door/gate traversal: the handler opens the loc and the
                    // player walks through (no teleport), so the loc's flanking regions
                    // connect. Probe each cardinal neighbor of the placement tile - a
                    // door that splits the graph has >=2 distinct regions around it.
                    if (dom === 'loc' && /open_and_close_door|loc_change\(/.test(line)) {
                        for (const t of contextFor()) {
                            const sides = new Map<number, WorldTile>();
                            for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0], [0, 2], [0, -2], [2, 0], [-2, 0]] as const) {
                                const nb = { level: t.level, x: t.x + dx, z: t.z + dz };
                                const rid = graph.regionAt(nb.x, nb.z, nb.level);
                                if (rid !== 0 && !sides.has(rid)) {
                                    sides.set(rid, nb);
                                }
                            }
                            const rids = [...sides.keys()];
                            for (let a = 0; a < rids.length; a++) {
                                for (let b = a + 1; b < rids.length; b++) {
                                    emitEdge([sides.get(rids[a])!], resolveTile(sides.get(rids[b])!), false, prov);
                                }
                            }
                        }
                        continue;
                    }

                    // label/proc/queue delegation: caller context -> callee's teleport dests.
                    if (isPlayerTrigger) {
                        for (const m of line.matchAll(/[~@]([a-z_0-9]+)|(?:^|[^a-z_])(?:queue|longqueue|weakqueue|strongqueue)\(\s*([a-z_0-9]+)/g)) {
                            for (const dest of procTeleportDests.get(m[1] ?? m[2]) ?? []) {
                                emitEdge(caseTiles ?? contextFor(), resolveTile(parseRawCoord(dest.raw)), caseTiles !== null, `${prov} via ${dest.prov}`);
                            }
                        }
                    }

                    // relative destination: movecoord(coord|loc_coord, dx, dy(level), dz)
                    // inside a teleport/climb call. `coord` is the operating player's tile
                    // ~ the trigger tile (region-level resolution absorbs the 1-2 tile
                    // approach offset that landing-precision work could not - see
                    // lessons-learned "Relative-destination stairs"); loc_coord is the
                    // loc's own tile. Both delta off the case/subject placement tile.
                    const rel = /(?:p_teleport|p_telejump|~climb_ladder|~forcewalk2?)\(\s*movecoord\(\s*(?:coord|loc_coord)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/.exec(line);
                    if (rel) {
                        const dx = parseInt(rel[1], 10);
                        const dy = parseInt(rel[2], 10);
                        const dz = parseInt(rel[3], 10);
                        for (const t of caseTiles ?? contextFor()) {
                            const destLevel = t.level + dy;
                            if (destLevel < 0 || destLevel > 3) {
                                continue;
                            }
                            emitEdge([t], resolveTile({ level: destLevel, x: t.x + dx, z: t.z + dz }), caseTiles !== null, prov);
                        }
                    }
                }
            }
            // attribution: quest folder membership + any quest varp the block touches.
            const quests = new Set<string>();
            if (folderQuest) {
                quests.add(folderQuest);
            }
            const body = block.lines.map(l => l.line).join('\n');
            for (const m of body.matchAll(VARP_RE)) {
                const q = varpToQuest.get(m[1]);
                if (q) {
                    quests.add(q);
                }
            }
            if (quests.size === 0) {
                continue;
            }
            blocksAttributed++;
            const headerProv = `${block.file}:${block.startLine}`;

            for (const questId of quests) {
                // 1) trigger subject placements (the entity the block is attached to).
                const dom = subjectDomain(block.trigger);
                if (dom === 'zone') {
                    try {
                        // zone subjects are the SW corner of an 8x8 zone - sample the
                        // box, any overlapping region satisfies (player is somewhere in it).
                        const c = parseRawCoord(block.subject);
                        const samples = [
                            [0, 0],
                            [7, 7],
                            [0, 7],
                            [7, 0],
                            [4, 4]
                        ].map(([dx, dz]) => ({ level: c.level, x: c.x + dx, z: c.z + dz }));
                        addEvidence(questId, 'zone-trigger', block.subject, samples, headerProv);
                    } catch {
                        /* malformed zone subject - ignore */
                    }
                } else if (dom) {
                    for (const subj of block.subject.split(',').map(s => s.trim())) {
                        const { tiles, flags } = placementsFor(dom, subj);
                        addEvidence(questId, 'subject', `${dom}:${subj}`, tiles, headerProv, { domain: dom, name: subj, flags });
                    }
                }

                // block-context regions for edge derivation (subjects + inzone + zone).
                const contextRegions = new Set<number>();
                const noteContext = (ev: Evidence) => {
                    for (const r of ev.anyOf) {
                        contextRegions.add(r.region);
                    }
                };

                // 2) line-level extraction.
                for (const { line, num } of block.lines) {
                    const prov = `${block.file}:${num}`;

                    // entity references in commands (npc_find / npc_add / loc_add / obj_add).
                    for (const m of line.matchAll(NPC_FIND_RE)) {
                        const { tiles, flags } = placementsFor('npc', m[1]);
                        addEvidence(questId, 'entity-ref', `npc:${m[1]}`, tiles, prov, { domain: 'npc', name: m[1], flags });
                    }
                    for (const m of line.matchAll(ENTITY_ADD_RE)) {
                        const coordExpr = m[2].trim();
                        if (COORD_RE_ANCHORED.test(coordExpr)) {
                            // dynamic spawn at a literal coord - the coord IS the placement.
                            addEvidence(questId, 'dynamic-spawn', coordExpr, [parseRawCoord(coordExpr)], prov, { name: m[3] });
                        } else if (m[1] === 'npc_add') {
                            // computed spawn coord - fall back to the npc's map placements if any.
                            const { tiles, flags } = placementsFor('npc', m[3]);
                            addEvidence(questId, 'entity-ref', `npc:${m[3]}`, tiles, prov, { domain: 'npc', name: m[3], flags: [...flags, 'computed-spawn-coord'] });
                        }
                    }

                    // inzone(cornerA, cornerB, ...) FIRST: the two corners are a
                    // bounding box, not standing spots - the player stands SOMEWHERE
                    // inside, so the pair forms ONE any-of group sampled across the
                    // box (corners, center, edge midpoints). Level span (e.g.
                    // 0_.._0_0 .. 2_.._63_63) samples every level in range.
                    const inzoneSpans = new Set<string>();
                    for (const m of line.matchAll(/inzone\(\s*([0-3]_\d+_\d+_\d+_\d+)\s*,\s*([0-3]_\d+_\d+_\d+_\d+)/g)) {
                        inzoneSpans.add(m[1]).add(m[2]);
                        const a = parseRawCoord(m[1]);
                        const b = parseRawCoord(m[2]);
                        const samples: WorldTile[] = [];
                        for (let level = Math.min(a.level, b.level); level <= Math.max(a.level, b.level); level++) {
                            const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
                            const [z1, z2] = [Math.min(a.z, b.z), Math.max(a.z, b.z)];
                            const mx = (x1 + x2) >> 1;
                            const mz = (z1 + z2) >> 1;
                            for (const [x, z] of [[x1, z1], [x2, z2], [x1, z2], [x2, z1], [mx, mz], [mx, z1], [mx, z2], [x1, mz], [x2, mz]] as const) {
                                samples.push({ level, x, z });
                            }
                        }
                        noteContext(addEvidence(questId, 'inzone', `${m[1]}..${m[2]}`, samples, prov));
                    }

                    // remaining raw coord literals, classified by enclosing command.
                    for (const m of line.matchAll(COORD_LIT_RE)) {
                        const raw = m[0];
                        if (inzoneSpans.has(raw)) {
                            continue; // consumed by the inzone pair grouping above.
                        }
                        const tile = parseRawCoord(raw);
                        const before = line.slice(0, m.index);
                        const isTeleport = /(p_teleport|p_telejump)\(\s*$/.test(before) || /(p_teleport|p_telejump)\([^()]*$/.test(before);
                        if (isTeleport) {
                            const ev = addEvidence(questId, 'teleport-dest', raw, [tile], prov);
                            if (ev.anyOf.length > 0) {
                                drafts.get(questId)!.edges.push({ dest: ev.anyOf[0], fromRegions: [], provenance: prov });
                            }
                        } else {
                            addEvidence(questId, 'coord', raw, [tile], prov);
                        }
                    }
                }

                // subject/zone context feeds edges recorded for this block.
                const dom2 = subjectDomain(block.trigger);
                if (dom2 === 'zone') {
                    const ev = drafts.get(questId)!.evidence.get(`zone-trigger|${block.subject}`);
                    if (ev) {
                        noteContext(ev);
                    }
                } else if (dom2) {
                    for (const subj of block.subject.split(',').map(s => s.trim())) {
                        const ev = drafts.get(questId)!.evidence.get(`subject|${dom2}:${subj}`);
                        if (ev) {
                            noteContext(ev);
                        }
                    }
                }
                for (const edge of drafts.get(questId)!.edges) {
                    if (edge.provenance.startsWith(`${block.file}:`) && edge.fromRegions.length === 0) {
                        edge.fromRegions = [...contextRegions];
                    }
                }
            }
        }
    }

    // ---- aggregate + classify ----
    interface RegionRollup {
        region: number;
        levels: number[];
        mainland: boolean;
        evidenceCount: number;
    }
    interface QuestOut {
        classification: 'all-mainland' | 'needs-review';
        reviewReasons: string[];
        regions: RegionRollup[];
        evidence: Evidence[];
        edges: QuestEdge[];
    }
    const questsOut: Record<string, QuestOut> = {};
    const allMainland: string[] = [];
    const needsReview: string[] = [];

    for (const questId of [...questIds].sort()) {
        const draft = drafts.get(questId)!;
        const evidence = [...draft.evidence.values()];
        const regionMap = new Map<number, RegionRollup>();
        for (const ev of evidence) {
            for (const t of ev.anyOf) {
                let r = regionMap.get(t.region);
                if (!r) {
                    r = { region: t.region, levels: [], mainland: t.mainland, evidenceCount: 0 };
                    regionMap.set(t.region, r);
                }
                const level = parseInt(t.raw.split('_')[0], 10);
                if (!r.levels.includes(level)) {
                    r.levels.push(level);
                }
                r.evidenceCount++;
            }
        }

        const reviewReasons: string[] = [];
        // an evidence item is "satisfiable on mainland" if any of its any-of placements
        // is mainland; only items with NO mainland option force review.
        const offMainland = evidence.filter(ev => ev.anyOf.length > 0 && !ev.mainlandOk);
        if (offMainland.length > 0) {
            const regions = new Set(offMainland.flatMap(ev => ev.anyOf.map(t => t.region)));
            reviewReasons.push(`${offMainland.length} evidence item(s) resolve only outside the mainland region (${regions.size} distinct region(s))`);
        }
        const flagged = evidence.filter(ev => ev.flags.length > 0);
        if (flagged.some(ev => ev.flags.includes('unresolved-category'))) {
            reviewReasons.push('has unresolved _category subject(s)');
        }
        if (flagged.some(ev => ev.flags.includes('unwalkable'))) {
            reviewReasons.push('has coord(s) resolving to no walkable region (cutscene/instanced/unbuilt tile?)');
        }

        const out: QuestOut = {
            classification: reviewReasons.length === 0 ? 'all-mainland' : 'needs-review',
            reviewReasons,
            regions: [...regionMap.values()].sort((a, b) => b.evidenceCount - a.evidenceCount),
            evidence: evidence.sort((a, b) => Number(a.mainlandOk) - Number(b.mainlandOk)),
            edges: draft.edges
        };
        questsOut[questId] = out;
        (out.classification === 'all-mainland' ? allMainland : needsReview).push(questId);
    }

    const output = {
        meta: {
            generatedAt: new Date().toISOString(),
            regionGraph: REGION_GRAPH_PATH,
            mainlandRegionId: mainlandId,
            questCount: questIds.length,
            scriptFilesScanned: filesScanned,
            blocksAttributed,
            note: 'DRAFT static extraction - over-collects by design (mandatory vs optional steps are not distinguished). Review needs-review quests against walkthroughs before merging into quest-regions.json.'
        },
        summary: { allMainland, needsReview },
        worldEdges,
        quests: questsOut
    };

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');

    console.log(`ExtractQuestRegions: ${filesScanned} rs2 files, ${blocksAttributed} attributed blocks, ${questIds.length} quests in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  world edges: ${worldEdges.length} (${worldEdges.filter(e => e.viaCase).length} via switch-case triggers)`);
    console.log(`  all-mainland: ${allMainland.length}   needs-review: ${needsReview.length}`);
    for (const id of needsReview) {
        console.log(`  [review] ${id}: ${questsOut[id].reviewReasons.join('; ')}`);
    }
    if (VERBOSE) {
        for (const id of allMainland) {
            console.log(`  [ok] ${id}: ${questsOut[id].regions.length} region(s), all satisfiable on mainland`);
        }
    }
    console.log(`  wrote ${OUT_PATH}`);
}

const COORD_RE_ANCHORED = /^[0-3]_\d+_\d+_\d+_\d+$/;

main();
