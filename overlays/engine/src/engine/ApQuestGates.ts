// AP family-D quest-start gates (docs/checks-and-unlocks.md unlock family D).
//
// Placement mode can put "Quest unlock: <name>" items in the pool; until the player
// receives one, its quest must not be startable. There is no shared quest-START proc in
// this content set (only ~send_quest_complete on the completion side) - every quest
// giver's dialogue writes its own progress varp directly - so instead of overlaying
// ~20 vanilla dialogue scripts, the gate lives at the single choke point every one of
// those writes goes through: Player.setVar. When a write would take a GATED quest's
// varp from 0 (never started) to nonzero (started) and the player hasn't received the
// `quest_<id>` unlock, the write is vetoed entirely and the player is told why. The
// dialogue that attempted the write plays out cosmetically, but nothing persists -
// quest scripts re-read their varp on every interaction, so the NPC treats the player
// as never-started next time (one-time cosmetic desync, no state corruption).
//
// Safety properties:
// - PlayerLoading restores saves via `player.vars[id] = ...` directly, never setVar,
//   so a save with a started quest can NEVER be blocked/corrupted by this gate.
// - Gates are active ONLY for quest ids listed in ap-placements.json's `questGates`
//   (written by GenerateSeed.ts). No placements file, a pre-family-D placements file,
//   or a parse failure = zero gates = vanilla behavior.
// - getUnlockCount returns 99 with no ap-unlocks.json on disk (not an AP run), which
//   also opens every gate.
// - quest id -> varp comes from ap-checks.json's own quest_<id> watches (the same
//   authoritative varp source the completion checks use) - no second hand-maintained
//   varp table to drift.
//
// Loaded once per process (a reseed is always followed by a server restart, same
// lifetime convention as ApChecks' placements cache).

import fs from 'fs';

import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { getUnlockCount, questGateLabel } from '#/engine/ApUnlockOverrides.js';
// TYPE-ONLY on purpose: a runtime Player import from an Ap* module crashes the login
// worker via circular-import TDZ - see lessons-learned "first live boot crash".
import type Player from '#/engine/entity/Player.js';
import { printInfo, printWarning } from '#/util/Logger.js';

const PLACEMENTS_PATH = 'data/config/ap-placements.json';
const WATCHES_PATH = 'data/config/ap-checks.json';

interface Gate {
    questId: string;
    /** ap-unlocks.json key, `quest_<id>`. */
    key: string;
    /** Human name for the blocked-start message. */
    label: string;
}

// Quests whose START writes a varp other than (or in addition to) their completion
// watch varp - the veto must cover every start path. Verified against
// general/scripts/quests.rs2's update_questlist special cases:
//   - blackarmgang (Shield of Arrav): joining the Phoenix Gang writes %phoenixgang,
//     the Black Arm path writes %blackarmgang (the watch varp).
//   - upass (Underground Pass): stage 1 sets a bit in %ibanmulti instead of the
//     %upass progress varp.
// Extra varps fail soft: an unresolved name is skipped with a warning (quest stays
// gated via its watch varp at minimum).
const EXTRA_GATE_VARPS: Record<string, string[]> = {
    blackarmgang: ['phoenixgang'],
    upass: ['ibanmulti']
};

let gatesByVarp: Map<number, Gate> | null = null;

function loadGates(): Map<number, Gate> {
    const map = new Map<number, Gate>();

    if (!fs.existsSync(PLACEMENTS_PATH)) {
        return map;
    }

    let gateIds: string[];
    try {
        const parsed = JSON.parse(fs.readFileSync(PLACEMENTS_PATH, 'utf8')) as { questGates?: unknown[] };
        gateIds = (parsed.questGates ?? []).filter((id): id is string => typeof id === 'string');
    } catch (err) {
        printWarning(`AP quest gates: failed to parse ${PLACEMENTS_PATH}, no quest gates active (${err instanceof Error ? err.message : err})`);
        return map;
    }
    if (gateIds.length === 0) {
        return map;
    }

    // quest id -> varp name, from the completion watch table (plain-varp watches only -
    // QUEST_GATE_IDS curation in tools/sim/PlacementEngine.ts guarantees no gated quest
    // uses the bit/varbit watch shapes).
    let watches: { varp?: string; check?: string }[];
    try {
        watches = (JSON.parse(fs.readFileSync(WATCHES_PATH, 'utf8')) as { watches?: { varp?: string; check?: string }[] }).watches ?? [];
    } catch (err) {
        printWarning(`AP quest gates: failed to parse ${WATCHES_PATH}, no quest gates active (${err instanceof Error ? err.message : err})`);
        return map;
    }

    for (const questId of gateIds) {
        const watch = watches.find(w => w.check === `quest_${questId}` && typeof w.varp === 'string');
        if (!watch || !watch.varp) {
            printWarning(`AP quest gates: no plain-varp watch found for gated quest "${questId}" - gate skipped (quest stays startable)`);
            continue;
        }
        const varpId = VarPlayerType.getId(watch.varp);
        if (varpId === -1) {
            printWarning(`AP quest gates: varp "${watch.varp}" for gated quest "${questId}" did not resolve - gate skipped`);
            continue;
        }
        const key = `quest_${questId}`;
        const gate: Gate = { questId, key, label: questGateLabel(key) };
        map.set(varpId, gate);
        for (const extra of EXTRA_GATE_VARPS[questId] ?? []) {
            const extraId = VarPlayerType.getId(extra);
            if (extraId === -1) {
                printWarning(`AP quest gates: extra varp "${extra}" for gated quest "${questId}" did not resolve - that start path stays open`);
                continue;
            }
            map.set(extraId, gate);
        }
    }

    printInfo(`AP quest gates: ${map.size} quest-start gate(s) active`);
    return map;
}

/**
 * Called from Player.setVar for every numeric varp write. Returns true if the write
 * must be vetoed (gated quest, not started, unlock not yet received). O(1) for
 * unwatched varps.
 */
export function interceptVarpWrite(player: Player, varpId: number, oldValue: number, newValue: number): boolean {
    try {
        if (gatesByVarp === null) {
            gatesByVarp = loadGates();
        }
        if (gatesByVarp.size === 0) {
            return false;
        }
        const gate = gatesByVarp.get(varpId);
        if (!gate || oldValue !== 0 || newValue === 0) {
            return false;
        }
        if (getUnlockCount(gate.key) >= 1) {
            return false;
        }
        player.messageGame(`A mysterious force prevents you from starting ${gate.label}.`);
        player.messageGame(`The "Quest unlock: ${gate.label}" item is hidden somewhere in your world.`);
        printInfo(`AP quest gates: blocked start of ${gate.questId} (varp write 0 -> ${newValue}, ${gate.key} not received)`);
        return true;
    } catch (err) {
        printWarning(`AP quest gates: interceptVarpWrite(${varpId}) failed open (${err instanceof Error ? err.message : err})`);
        return false;
    }
}
