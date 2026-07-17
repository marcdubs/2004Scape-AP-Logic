// Shared consumer for ExtractQuestRegions.ts's quest-regions.generated.json draft.
// Two consumers, one reading:
//   - ValidateSeed.ts turns each quest's evidence into region requirement GROUPS
//     (every group must have >=1 reachable region - group = one interaction, its
//     any-of placements are alternatives) plus optimistic script-teleport edges.
//   - GenerateSeed.ts's spawn-distance weighting scores each quest by how far its
//     required groups sit from the seed's spawn region.
// The curated quest-regions.json remains the review lever: its `generated.ignore`
// lists (per quest, by evidence `key`) exempt items a human judged optional/flavor,
// and `generated.ignoreGlobal` exempts an evidence key everywhere (shared helpers).
// Ignoring is the ONLY relaxation mechanism - extraction over-collects by design
// (conservative direction), so consumption never silently drops anything else:
// evidence with an empty resolved any-of (unwalkable/unresolved, already flagged by
// the extractor) is skipped because there is nothing evaluable, not because it was
// judged unimportant.

import fs from 'fs';

export interface GenTile {
    raw: string;
    region: number;
    mainland: boolean;
}

export interface GenEvidence {
    key: string;
    kind: string;
    domain?: string;
    name?: string;
    anyOf: GenTile[];
    anyOfTotal: number;
    mainlandOk: boolean;
    provenance: string[];
    flags: string[];
}

export interface GenEdge {
    dest: GenTile;
    fromRegions: number[];
    provenance: string;
}

export interface GenQuest {
    classification: 'all-mainland' | 'needs-review';
    reviewReasons: string[];
    evidence: GenEvidence[];
    edges: GenEdge[];
}

export interface GenWorldEdge {
    from: GenTile[];
    dest: GenTile;
    viaCase: boolean;
    provenance: string;
}

export interface GeneratedFile {
    meta: { mainlandRegionId: number; questCount: number };
    worldEdges?: GenWorldEdge[];
    quests: Record<string, GenQuest>;
}

export interface GeneratedIgnores {
    ignore?: Record<string, string[]>;
    ignoreGlobal?: string[];
}

export function loadGeneratedQuestRegions(filePath: string): GeneratedFile | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as GeneratedFile;
}

/** One quest interaction that must be physically reachable; its any-of tiles are alternatives. */
export interface RequirementGroup {
    key: string;
    label: string; // human-readable for diagnostics ("npc fisher_king", "coord 1_43_73_10_16")
    regions: number[]; // deduped, no zeros
    tiles: GenTile[];
    provenance: string[];
}

/**
 * Evidence -> requirement groups per quest, applying curated ignores. Groups with no
 * resolvable region are dropped (nothing to evaluate - extractor already flagged them).
 */
export function buildRequirementGroups(gen: GeneratedFile, ignores: GeneratedIgnores | undefined): Map<string, RequirementGroup[]> {
    const globalIgnore = new Set(ignores?.ignoreGlobal ?? []);
    const out = new Map<string, RequirementGroup[]>();
    for (const [questId, q] of Object.entries(gen.quests)) {
        const questIgnore = new Set(ignores?.ignore?.[questId] ?? []);
        const groups: RequirementGroup[] = [];
        for (const ev of q.evidence) {
            if (globalIgnore.has(ev.key) || questIgnore.has(ev.key)) {
                continue;
            }
            const regions = [...new Set(ev.anyOf.map(t => t.region).filter(r => r !== 0))];
            if (regions.length === 0) {
                continue;
            }
            groups.push({
                key: ev.key,
                label: ev.name ? `${ev.domain ?? ev.kind} ${ev.name}` : `${ev.kind} ${ev.anyOf[0].raw}`,
                regions,
                tiles: ev.anyOf,
                provenance: ev.provenance
            });
        }
        out.set(questId, groups);
    }
    return out;
}

export interface ScriptEdge {
    questId: string;
    fromRegions: number[];
    toRegion: number;
    provenance: string;
}

/**
 * Script-teleport edges (p_teleport literals with same-block source context), deduped
 * across quests. Modeled as ungated, always-available region edges - OPTIMISTIC by
 * design, same judgment the curated file already applies to dialogue transports (the
 * Karamja boat, Dragon Slayer's Crandor ship): the teleport mechanism itself is never
 * entrance-shuffled, so if its trigger region is physically reachable the transition
 * is genuinely performable once the quest reaches that stage. Mid-quest stage gating
 * is intentionally not modeled (matches the sim's documented item/stage policy).
 */
/**
 * World edges usable under a given seed: every extracted quest-agnostic transition
 * EXCEPT those whose trigger tile the seed's entrance overrides replace (the runtime
 * override preamble preempts the vanilla case body, so the vanilla destination is
 * dead for that trigger). `overriddenTriggerCoords` = raw coords (no :op suffix) of
 * every override key. Same optimism note as collectScriptEdges applies to any
 * in-handler quest checks (mcannon-style gated caves read as open).
 */
export function usableWorldEdges(gen: GeneratedFile, overriddenTriggerCoords: Set<string>): ScriptEdge[] {
    const out: ScriptEdge[] = [];
    for (const e of gen.worldEdges ?? []) {
        const from = e.viaCase ? e.from.filter(t => !overriddenTriggerCoords.has(t.raw)) : e.from;
        const fromRegions = [...new Set(from.map(t => t.region).filter(r => r !== 0))];
        if (fromRegions.length === 0 || e.dest.region === 0) {
            continue;
        }
        out.push({ questId: '(world)', fromRegions, toRegion: e.dest.region, provenance: e.provenance });
    }
    return out;
}

export function collectScriptEdges(gen: GeneratedFile): ScriptEdge[] {
    const seen = new Set<string>();
    const out: ScriptEdge[] = [];
    for (const [questId, q] of Object.entries(gen.quests)) {
        for (const e of q.edges) {
            if (e.fromRegions.length === 0 || e.dest.region === 0) {
                continue;
            }
            const sig = `${e.fromRegions.join(',')}>${e.dest.region}`;
            if (seen.has(sig)) {
                continue;
            }
            seen.add(sig);
            out.push({ questId, fromRegions: e.fromRegions, toRegion: e.dest.region, provenance: e.provenance });
        }
    }
    return out;
}
