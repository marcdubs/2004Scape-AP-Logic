import fs from 'fs';
import path from 'path';

import VarPlayerType from '#/cache/config/VarPlayerType.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerStatEnabled } from '#/engine/entity/PlayerStat.js';
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

// Returns the resulting count that best represents "what this grant just did" so
// the caller (ApChecks.resolvePlacement) can build an announcement from the ACTUAL
// post-grant state instead of trusting a pre-baked string (see describeUnlock below
// for why that distinction matters). Sentinel 0 means "grant did not happen" -
// callers should fail open to whatever fallback text they already have rather than
// trusting a fabricated "now 0" message (a real successful grant always ends at
// count >= 1, since count > 0 is required to reach the increment).
export function grantUnlock(name: string, count: number): number {
    try {
        ensureFresh();

        if (table === null) {
            printWarning(`AP unlock overrides: grantUnlock(${name}, ${count}) called with no ${OVERRIDES_PATH} on disk - placement mode requires a starting unlocks table, ignoring`);
            return 0;
        }

        if (typeof name !== 'string' || name.length === 0 || !Number.isInteger(count) || count <= 0) {
            printWarning(`AP unlock overrides: grantUnlock called with invalid args (${JSON.stringify(name)}, ${count})`);
            return 0;
        }

        // --pool groups placements use 4 synthetic keys that are NOT real unlock
        // keys: expand each into a +count bump on every member skill's real
        // progressive_<skill> key, mirroring PlacementEngine.applyPlacementItem
        // (tools side) exactly. Membership must stay in sync with
        // tools/sim/PlacementEngine.ts's group definitions.
        const group = SKILL_GROUPS[name];
        let resultCount: number;
        if (group) {
            let first = 0;
            for (const skill of group) {
                const key = `progressive_${skill}`;
                const updated = (table.get(key) ?? 0) + count;
                table.set(key, updated);
                if (first === 0) {
                    first = updated;
                }
            }
            // Every member is always bumped by the same amount in lockstep (groups
            // never receive a member-specific grant), so any one member's new
            // count is representative for announcement purposes.
            resultCount = first;
        } else {
            resultCount = (table.get(name) ?? 0) + count;
            table.set(name, resultCount);
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

        printInfo(`AP unlock overrides: granted ${count}x ${name}${group ? ` (expanded to ${group.length} member skills, now ${resultCount})` : ` (now ${resultCount})`}`);
        return resultCount;
    } catch (err) {
        printWarning(`AP unlock overrides: grantUnlock(${name}, ${count}) failed (${err instanceof Error ? err.message : err})`);
        return 0;
    }
}

// ---------------------------------------------------------------------------
// Bug fix (2026-07-16, user report: "first bone buried got progressive melee
// Tier 5?? Level 10 firemaking got a rune axe??"): GenerateSeed/PlacementEngine
// bake an assumed-tier display string into ap-placements.json PER COPY, based on
// that copy's position when the item pool was built (e.g. the 5th of 7
// progressive_melee copies is labelled "tier 5"). That label is only accurate if
// copies are collected in the exact 1..N order the generator built them in - real
// play has no such guarantee (a player can hit their first-ever melee-family
// placement from ANY check, in ANY order). The functional grant was always
// correct (a flat +1/+2 bump, i.e. genuinely one tier/step at a time) - only the
// ANNOUNCEMENT TEXT lied about which tier the bump actually reached. Fix: never
// trust the generator's baked string for the live announcement; rebuild it from
// the real post-grant count every time. Mirrors PlacementEngine.ts's
// GEAR_TIER_LEVELS/PICKAXE_TIERS/AXE_TIERS tables (kept in sync manually, same
// duplication precedent as STAT_NAMES/levelExperience above - avoids a
// tools/ <-> engine import across the build boundary).
// ---------------------------------------------------------------------------

const GEAR_FAMILY_LABELS: Record<string, string> = {
    progressive_melee: 'Melee',
    progressive_armour: 'Armour',
    progressive_ranged: 'Ranged',
    progressive_magic: 'Magic'
};

// tier (1-indexed) -> base-level threshold it unlocks. Mirrors
// PlacementEngine.ts's GEAR_TIER_LEVELS and levelrequire.rs2's ap_gear_locked.
const GEAR_TIER_LEVELS = [5, 10, 20, 30, 40, 45, 60];

// Mirrors PlacementEngine.ts's PICKAXE_TIERS/AXE_TIERS (verified against
// mining.rs2's ap_pickaxe_tier and woodcut.rs2's axe fallback cascade).
const PICKAXE_TIERS = ['iron', 'steel', 'mithril', 'adamant', 'rune'];
const AXE_TIERS = ['iron', 'steel', 'black', 'mithril', 'adamant', 'rune'];

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// Builds the honest "what did this grant actually just do" announcement from the
// REAL post-grant count for `name` (the value grantUnlock returned). Handles the
// three placement item shapes: gear/tool families (tier/material name), plain
// per-skill cap keys, and the two keys that are BOTH (progressive_ranged/magic -
// see the "KNOWN DESIGN POINT" comment on STAT_NAMES above) by reporting every
// applicable facet.
export function describeUnlock(name: string, newCount: number): string {
    const parts: string[] = [];

    const gearLabel = GEAR_FAMILY_LABELS[name];
    if (gearLabel) {
        const tier = Math.min(Math.max(newCount, 1), GEAR_TIER_LEVELS.length);
        const lvl = GEAR_TIER_LEVELS[tier - 1];
        parts.push(`tier ${tier} (unlocks lv ${lvl}+ ${gearLabel.toLowerCase()} equipment)`);
    }

    if (name === 'progressive_pickaxe' || name === 'progressive_axe') {
        const tiers = name === 'progressive_pickaxe' ? PICKAXE_TIERS : AXE_TIERS;
        const idx = Math.min(Math.max(newCount, 1), tiers.length) - 1;
        parts.push(`now ${tiers[idx]}`);
    }

    const groupMembers = SKILL_GROUPS[name];
    if (groupMembers) {
        const cap = Math.min(99, 20 + 10 * newCount);
        return `+level cap to ${groupMembers.map(capitalize).join('/')} (now ${cap})`;
    }

    const bareSkill = name.startsWith('progressive_') ? name.slice('progressive_'.length) : '';
    if (bareSkill.length > 0 && STAT_NAMES.includes(bareSkill) && bareSkill !== 'hitpoints') {
        const cap = Math.min(99, 20 + 10 * newCount);
        parts.push(`${capitalize(bareSkill)} cap now ${cap}`);
    }

    const label = gearLabel ?? capitalize(name.replace(/^progressive_/, ''));
    if (parts.length === 0) {
        return `Progressive ${label} received (now ${newCount})`;
    }
    return `Progressive ${label}: ${parts.join(', ')}`;
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
//
// Bug fix (2026-07-16, user report: "struck with inspiration hits your level cap,
// save the remaining XP so when the level is uncapped it applies"): the truncated
// portion used to be silently discarded - a "10k-50k random skill" reward rolled
// while that skill was capped just vanished. Now the discarded remainder is banked
// per-skill (see bankOverflowXp/applyBankedXp below) instead of lost.
export function clampStatXp(player: Player, stat: number, currentXp: number, xp: number): number {
    const cap = getSkillCap(stat);
    if (cap >= 99) {
        return xp;
    }

    // Highest xp that still keeps the base level at (or below) `cap`: one xp short of
    // the threshold for level cap+1. getLevelByExp(ceilXp) === cap and
    // getLevelByExp(ceilXp + 1) === cap + 1 (verified via tsx one-liner against this
    // exact table - see session notes).
    const ceilXp = getExpByLevel(cap + 1) - 1;
    const allowed = Math.max(0, Math.min(xp, ceilXp - currentXp));

    const overflow = xp - allowed;
    if (overflow > 0) {
        bankOverflowXp(player, stat, overflow);
    }

    return allowed;
}

// ---------------------------------------------------------------------------
// Banked XP (2026-07-16 fix, docs/lessons-learned.md progressive-cap section).
// Backing store: one perm varp per cappable real skill, `ap_xpbank_<skill>`
// (configs/ap.varp) - per-PLAYER persistence, the same mechanism %ap_kills/
// %ap_kbd_killed already use elsewhere in this codebase (a global JSON file like
// ap-unlocks.json would be wrong here: banked xp is per-account state, not
// seed-wide state). Varp ids are resolved lazily against VarPlayerType (not known
// until config load) and cached per stat id - the mapping never changes at
// runtime so this cache never goes stale.
// ---------------------------------------------------------------------------

const xpBankVarpCache = new Map<number, number>(); // stat id -> varp id (-1 = no varp declared for this stat)

function getXpBankVarpId(stat: number): number {
    const cached = xpBankVarpCache.get(stat);
    if (cached !== undefined) {
        return cached;
    }

    let varId = -1;
    if (stat !== HITPOINTS_STAT && PlayerStatEnabled[stat]) {
        const name = STAT_NAMES[stat];
        if (name !== undefined) {
            varId = VarPlayerType.getId(`ap_xpbank_${name}`);
            if (varId === -1) {
                printWarning(`AP unlock overrides: no ap_xpbank_${name} varp declared (configs/ap.varp) - banked xp for this stat is disabled`);
            }
        }
    }

    xpBankVarpCache.set(stat, varId);
    return varId;
}

// Adds `amount` (engine tenths of a point, already post-multiplier - same units
// clampStatXp truncates) to `stat`'s banked-xp varp. Never throws (mirrors every
// other Ap* hook's fail-safe contract) - a failure here loses the overflow amount
// same as pre-fix behavior, it just doesn't crash the xp gain that triggered it.
function bankOverflowXp(player: Player, stat: number, amount: number): void {
    try {
        if (!(amount > 0)) {
            return;
        }
        const varId = getXpBankVarpId(stat);
        if (varId === -1) {
            return;
        }
        const current = player.getVar(varId);
        const banked = (typeof current === 'number' ? current : 0) + amount;
        player.setVar(varId, banked);
    } catch (err) {
        printWarning(`AP unlock overrides: bankOverflowXp(stat=${stat}, ${amount}) failed (${err instanceof Error ? err.message : err})`);
    }
}

// Applies `stat`'s ENTIRE banked xp back through the real addXp path. Relies on
// clampStatXp (above) to do the right thing on its own: withdrawing the full
// bank and handing it to addXp re-truncates (and re-banks the leftover,
// unchanged) if the new cap still can't fit all of it, and applies it in full if
// the stat is uncapped or the bank now fits - either way this function doesn't
// need its own cap arithmetic. Safe to call speculatively (a zero/absent bank,
// or a stat with no ap_xpbank_* varp, is a same-tick no-op) - the two call sites
// are "a grant just raised a cap that might cover this stat" (immediate) and "a
// player just logged in" (safety net, see login.rs2's `ap_apply_banked_xp;`).
export function applyBankedXp(player: Player, stat: number): void {
    try {
        const varId = getXpBankVarpId(stat);
        if (varId === -1) {
            return;
        }
        const banked = player.getVar(varId);
        if (typeof banked !== 'number' || banked <= 0) {
            return;
        }

        player.setVar(varId, 0);
        player.addXp(stat, banked, false); // allowMulti=false: already multiplied when it was banked
    } catch (err) {
        printWarning(`AP unlock overrides: applyBankedXp(stat=${stat}) failed (${err instanceof Error ? err.message : err})`);
    }
}

// Login safety net entry point (AP_APPLY_BANKED_XP opcode, wired from
// login.rs2): sweeps every cappable real stat. Cheap even on a bare-vanilla
// server (no ap-unlocks.json, no ap_xpbank_* varps set) - each stat is one
// getVar + an early return.
export function applyAllBankedXp(player: Player): void {
    for (let stat = 0; stat < STAT_NAMES.length; stat++) {
        if (stat === HITPOINTS_STAT) {
            continue;
        }
        applyBankedXp(player, stat);
    }
}

// Resolves the real stat id(s) a just-granted unlock KEY affects the cap of, so
// the caller (ApChecks.resolvePlacement) can immediately drain that stat's bank
// the moment a placement raises its cap - not just wait for the next xp gain or
// the login safety net. Three shapes: a --pool groups synthetic key (expands to
// every member's stat id), a real progressive_<skill> key naming an actual stat
// (covers both plain per-skill caps AND the shared progressive_ranged/magic
// gear-tier keys - see the STAT_NAMES comment above on that collision), or a
// gear/tool-only key (progressive_melee/armour/pickaxe/axe) that affects no
// skill cap at all, correctly returning [].
export function statsAffectedByUnlockKey(name: string): number[] {
    const group = SKILL_GROUPS[name];
    if (group) {
        const stats: number[] = [];
        for (const skill of group) {
            const stat = STAT_NAMES.indexOf(skill);
            if (stat !== -1) {
                stats.push(stat);
            }
        }
        return stats;
    }

    if (name.startsWith('progressive_')) {
        const stat = STAT_NAMES.indexOf(name.slice('progressive_'.length));
        if (stat !== -1 && stat !== HITPOINTS_STAT) {
            return [stat];
        }
    }

    return [];
}

// Convenience wrapper for ApChecks.resolvePlacement: applies banked xp for every
// stat `unlockName`'s just-granted copy affects (usually 0 or 1 stat, up to 7 for
// a --pool groups synthetic key). Called AFTER grantUnlock so getSkillCap already
// reflects the new count.
export function applyBankedXpForUnlock(player: Player, unlockName: string): void {
    for (const stat of statsAffectedByUnlockKey(unlockName)) {
        applyBankedXp(player, stat);
    }
}
