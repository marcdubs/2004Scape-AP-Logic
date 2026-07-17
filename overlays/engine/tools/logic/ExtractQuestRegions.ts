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

// Cap stored any-of placement lists (generic NPCs like `man` have hundreds of
// spawns); mainland-satisfiability is computed over ALL placements before capping.
const ANYOF_CAP = 12;

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

    function addEvidence(questId: string, kind: Evidence['kind'], key: string, tiles: WorldTile[], prov: string, opts: { domain?: Domain; name?: string; flags?: string[] } = {}): Evidence {
        const draft = drafts.get(questId)!;
        const dedupeKey = `${kind}|${key}`;
        let ev = draft.evidence.get(dedupeKey);
        if (!ev) {
            const resolved = tiles.map(resolveTile);
            const walkable = resolved.filter(r => r.region !== 0);
            const flags = [...(opts.flags ?? [])];
            if (resolved.length > 0 && walkable.length === 0) {
                flags.push('unwalkable');
            }
            ev = {
                kind,
                domain: opts.domain,
                name: opts.name,
                anyOf: walkable.slice(0, ANYOF_CAP),
                anyOfTotal: walkable.length,
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

    // ---- walk every rs2 block ----
    let filesScanned = 0;
    let blocksAttributed = 0;
    for (const file of walkFiles(SCRIPTS_ROOT, '.rs2')) {
        filesScanned++;
        const rel = relContent(file);
        const folderQuestMatch = /^scripts\/quests\/quest_([a-z_0-9]+)\//.exec(rel);
        const folderQuest = folderQuestMatch && drafts.has(folderQuestMatch[1]) ? folderQuestMatch[1] : null;

        for (const block of parseBlocks(file)) {
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
                        addEvidence(questId, 'zone-trigger', block.subject, [parseRawCoord(block.subject)], headerProv);
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

                    // raw coord literals, classified by enclosing command.
                    for (const m of line.matchAll(COORD_LIT_RE)) {
                        const raw = m[0];
                        const tile = parseRawCoord(raw);
                        const before = line.slice(0, m.index);
                        const isTeleport = /(p_teleport|p_telejump)\(\s*$/.test(before) || /(p_teleport|p_telejump)\([^()]*$/.test(before);
                        const isInzone = /inzone\([^()]*$/.test(before);
                        if (isTeleport) {
                            const ev = addEvidence(questId, 'teleport-dest', raw, [tile], prov);
                            if (ev.anyOf.length > 0) {
                                drafts.get(questId)!.edges.push({ dest: ev.anyOf[0], fromRegions: [], provenance: prov });
                            }
                        } else if (isInzone) {
                            noteContext(addEvidence(questId, 'inzone', raw, [tile], prov));
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
        quests: questsOut
    };

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');

    console.log(`ExtractQuestRegions: ${filesScanned} rs2 files, ${blocksAttributed} attributed blocks, ${questIds.length} quests in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
