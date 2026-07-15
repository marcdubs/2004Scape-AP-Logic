import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

// Archipelago unlock-item table (2004Scape-AP-Logic docs/checks-and-unlocks.md,
// "Unlock plumbing"). Backing store for the ap_unlock_count script command and the
// skill-cap clamp called from Player.addXp.
//
// UNLIKE the other Ap*Overrides loaders (entrances/gather/process/drops), this table
// changes MID-SESSION: an Archipelago client (or the pre-AP ::apunlock / SetUnlock.ts
// test path) rewrites data/config/ap-unlocks.json while the server keeps running, not
// just between reseeds. getUnlockCount/getSkillCap/clampStatXp run on every xp gain and
// every equip attempt, so this can't just cache forever (stale mid-session) or re-stat
// the file on every call (too hot - PPE said "at most once per ~2000ms"). Design: cache
// the parsed table, re-check fs.statSync(...).mtimeMs at most once per
// RELOAD_THROTTLE_MS, and only reparse when the mtime actually changed. Handles the
// file appearing/disappearing at runtime - disappearing goes back to vanilla defaults.
//
// Defaults preserve vanilla behavior: missing table = everything unlocked/uncapped
// (getUnlockCount -> 99, getSkillCap -> 99, clampStatXp -> passthrough). A table that
// EXISTS but is missing a specific key means "0 received" for that key - that's the
// correct default for an AP run that hasn't sent any copies of that item yet (distinct
// from "no table at all", which means "not an AP run, stay vanilla").

const OVERRIDES_PATH = 'data/config/ap-unlocks.json';
const RELOAD_THROTTLE_MS = 2000;

let table: Map<string, number> | null = null; // null = no table on disk (vanilla defaults)
let lastStatCheckMs = 0;
let lastMtimeMs = -1; // -1 doubles as "file absent" sentinel

function parseTable(): Map<string, number> | null {
    if (!fs.existsSync(OVERRIDES_PATH)) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8')) as { unlocks?: Record<string, number> };
        const parsedTable = new Map<string, number>();
        for (const [name, count] of Object.entries(parsed.unlocks ?? {})) {
            if (typeof name !== 'string' || name.length === 0 || !Number.isInteger(count) || count < 0) {
                printWarning(`AP unlock overrides: skipping malformed entry ${name} -> ${count}`);
                continue;
            }
            parsedTable.set(name, count);
        }
        return parsedTable;
    } catch (err) {
        printWarning(`AP unlock overrides: failed to parse ${OVERRIDES_PATH}, unlocks are vanilla (${err instanceof Error ? err.message : err})`);
        return null;
    }
}

// Ensures `table` reflects the current on-disk state, at most once per
// RELOAD_THROTTLE_MS wall-clock. Cheap in the common case (a Date.now() + one compare)
// since the fs.statSync only runs after the throttle window elapses.
function ensureFresh(): void {
    const now = Date.now();
    if (now - lastStatCheckMs < RELOAD_THROTTLE_MS) {
        return;
    }
    lastStatCheckMs = now;

    let mtimeMs = -1;
    try {
        mtimeMs = fs.statSync(OVERRIDES_PATH).mtimeMs;
    } catch {
        // file does not exist (or briefly unreadable mid-write) - treat as absent.
    }

    if (mtimeMs === lastMtimeMs) {
        return;
    }
    lastMtimeMs = mtimeMs;

    const wasLoaded = table !== null;
    table = parseTable();
    if (table === null) {
        if (wasLoaded) {
            printInfo(`AP unlock overrides: ${path.basename(OVERRIDES_PATH)} disappeared, unlocks are vanilla again`);
        }
    } else {
        printInfo(`AP unlock overrides: loaded ${table.size} unlock(s)`);
    }
}

// How many of a named progressive unlock the player has received
// (e.g. "progressive_melee", "progressive_pickaxe"). 99 = effectively unlimited (no
// table = not an AP run). A table that exists but lacks the key = 0 received so far.
export function getUnlockCount(name: string): number {
    ensureFresh();
    if (table === null) {
        return 99;
    }
    return table.get(name) ?? 0;
}

// Placement mode (docs/placement-mode.md "Receipt wiring"): called from
// ApChecks.fireCheck when a fired check's placed item is a real unlock (not
// filler). Bumps `name`'s count by `count` and persists the FULL table back to
// OVERRIDES_PATH synchronously (write-temp-then-rename, same crash-safety
// pattern as ApTracker's flush, but sync rather than debounced-async: the
// caller needs the write to be observably complete - and lastMtimeMs updated
// to match - before it returns, so the very next ensureFresh() throttle tick
// doesn't see "the file changed underneath us" and reparse redundantly).
//
// Requires a table already on disk: placements mode's contract is that the
// generator always writes a starting ap-unlocks.json before a placement seed
// ships (docs/placement-mode.md "Starting state"), so `table === null` here
// means placements mode is misconfigured (no starting unlocks file), NOT
// "create one from scratch" - that would silently paper over a generator bug.
// --pool groups synthetic-key membership (see docs/placement-mode.md). Mirror of
// tools/sim/PlacementEngine.ts - keep both in sync.
const SKILL_GROUPS: Record<string, readonly string[]> = {
    progressive_gathering: ['mining', 'fishing', 'woodcutting'],
    progressive_artisan: ['smithing', 'cooking', 'crafting', 'fletching', 'firemaking', 'herblore', 'runecraft'],
    progressive_combat: ['attack', 'strength', 'defence', 'ranged', 'magic', 'prayer'],
    progressive_support: ['agility', 'thieving']
};

export function grantUnlock(name: string, count: number): void {
    try {
        ensureFresh();

        if (table === null) {
            printWarning(`AP unlock overrides: grantUnlock(${name}, ${count}) called with no ${OVERRIDES_PATH} on disk - placement mode requires a starting unlocks table, ignoring`);
            return;
        }

        if (typeof name !== 'string' || name.length === 0 || !Number.isInteger(count) || count <= 0) {
            printWarning(`AP unlock overrides: grantUnlock called with invalid args (${JSON.stringify(name)}, ${count})`);
            return;
        }

        // --pool groups placements use 4 synthetic keys that are NOT real unlock
        // keys: expand each into a +count bump on every member skill's real
        // progressive_<skill> key, mirroring PlacementEngine.applyPlacementItem
        // (tools side) exactly. Membership must stay in sync with
        // tools/sim/PlacementEngine.ts's group definitions.
        const group = SKILL_GROUPS[name];
        if (group) {
            for (const skill of group) {
                const key = `progressive_${skill}`;
                table.set(key, (table.get(key) ?? 0) + count);
            }
        } else {
            table.set(name, (table.get(name) ?? 0) + count);
        }

        const dir = path.dirname(OVERRIDES_PATH);
        fs.mkdirSync(dir, { recursive: true });

        const payload = JSON.stringify({ unlocks: Object.fromEntries(table) }, null, 2);
        const tmpPath = `${OVERRIDES_PATH}.tmp`;
        fs.writeFileSync(tmpPath, payload, 'utf8');
        fs.renameSync(tmpPath, OVERRIDES_PATH);

        // Force the cached mtime bookkeeping to the state we just wrote so the
        // next ensureFresh() (throttled, but this write may land inside the
        // same throttle window) treats our own write as already-current rather
        // than reloading it redundantly - table is already authoritative in
        // memory.
        lastMtimeMs = fs.statSync(OVERRIDES_PATH).mtimeMs;
        lastStatCheckMs = Date.now();

        printInfo(`AP unlock overrides: granted ${count}x ${name}${SKILL_GROUPS[name] ? ` (expanded to ${SKILL_GROUPS[name].length} member skills)` : ` (now ${table.get(name)})`}`);
    } catch (err) {
        printWarning(`AP unlock overrides: grantUnlock(${name}, ${count}) failed (${err instanceof Error ? err.message : err})`);
    }
}

// PlayerStat enum order (engine/src/engine/entity/PlayerStat.ts), lowercased, used to
// build the "progressive_<name>" unlock key each stat's cap reads. Verified against
// PlayerStat.ts on 2026-07-15 - keep in sync if that enum ever changes order.
//
// NOTE on a deliberate key collision: stat MAGIC and stat RANGED produce
// "progressive_magic" / "progressive_ranged" - the SAME unlock names used by the
// family-A gear-tier gate for Magic/Ranged equipment (ap_gear_locked in
// levelrequire.rs2). This is per the frozen spec for this workstream, not a bug: a
// single "Progressive Magic" / "Progressive Ranged" AP item simultaneously raises the
// wearable gear tier AND the skill level cap for that combat style. Melee splits into
// separate attack/strength/defence caps (no "progressive_melee" skill-cap key exists),
// so only Magic and Ranged double up.
const STAT_NAMES: readonly string[] = ['attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic', 'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting', 'smithing', 'mining', 'herblore', 'agility', 'thieving', 'stat18', 'stat19', 'runecraft'];

const HITPOINTS_STAT = 3;

// The current base-level ceiling for a stat under progressive skill caps.
export function getSkillCap(stat: number): number {
    ensureFresh();
    if (table === null) {
        return 99;
    }

    // Hitpoints is never capped: starts at level 10 (1154 xp) regardless, and being
    // unable to survive combat is a brick risk this feature must never introduce
    // (checks-and-unlocks.md family C, "Combat safety"). Simplest correct guard:
    // exclude it from capping entirely rather than special-casing a floor.
    if (stat === HITPOINTS_STAT) {
        return 99;
    }

    const name = STAT_NAMES[stat];
    if (name === undefined) {
        // unknown/future stat id - fail open rather than accidentally hard-capping
        // something this table was never told about.
        return 99;
    }

    const count = table.get(`progressive_${name}`) ?? 0;
    return Math.min(99, 20 + 10 * count);
}

// Local copy of Player.ts's level<->exp table (engine/src/engine/entity/Player.ts,
// getLevelByExp/getExpByLevel). Duplicated rather than imported: Player.ts imports
// clampStatXp from THIS module (Player.addXp calls it on every xp gain), so importing
// back from Player.ts would create a circular module dependency into a frozen file.
// The formula is copied verbatim - verify against Player.ts if it ever changes.
const levelExperience = new Int32Array(99);
{
    let acc = 0;
    for (let i = 0; i < 99; i++) {
        const level = i + 1;
        const delta = Math.floor(level + Math.pow(2.0, level / 7.0) * 300.0);
        acc += delta;
        levelExperience[i] = Math.floor(acc / 4) * 10;
    }
}

// exp (engine tenths of a point) required to REACH `level`. Mirrors
// Player.getExpByLevel exactly (valid for level 2..100).
function getExpByLevel(level: number): number {
    return levelExperience[level - 2];
}

// Returns the portion of `xp` (post-multiplier, engine tenths of a point) the
// player may actually gain in `stat` given their current xp and the stat's cap.
// Called from Player.addXp on EVERY xp gain - must stay O(1) (it is: one throttled
// mtime check + a couple of Map/array lookups + arithmetic, no loops).
export function clampStatXp(stat: number, currentXp: number, xp: number): number {
    const cap = getSkillCap(stat);
    if (cap >= 99) {
        return xp;
    }

    // Highest xp that still keeps the base level at (or below) `cap`: one xp short of
    // the threshold for level cap+1. getLevelByExp(ceilXp) === cap and
    // getLevelByExp(ceilXp + 1) === cap + 1 (verified via tsx one-liner against this
    // exact table - see session notes).
    const ceilXp = getExpByLevel(cap + 1) - 1;
    return Math.max(0, Math.min(xp, ceilXp - currentXp));
}
