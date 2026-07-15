// Archipelago new-player setup (skip Tutorial Island). Gated behind
// Environment.node.apSkipTutorial (WorldConfig.ts) - both exports are safe no-ops
// when called on a player who has already finished (or already been fast-tracked
// through) the tutorial, so callers may call applyNewPlayerSetup() unconditionally
// once the flag is on and rely on it to be idempotent.
//
// Investigation notes (docs/lessons-learned.md has the full writeup):
// - "brand new account" is detected in PlayerLoading.load() (Server/engine/src/
//   engine/entity/PlayerLoading.ts): the `sav.data.length < 2` branch. A returning
//   account mid-tutorial is any account whose saved %tutorial varp is below
//   ^tutorial_complete. Both are handled uniformly by the idempotency check below -
//   the hook in PlayerLoading.ts just calls applyNewPlayerSetup() once per login
//   when the flag is on, and this module decides whether there's anything to do.
// - %tutorial is a single perm varp (content/scripts/tutorial/configs/tutorial.varp,
//   scope=perm, transmit not set so setVar() never tries to write a client packet
//   for it - safe to poke before a NetworkPlayer's connection is fully live).
//   ^tutorial_complete = 1000 (content/scripts/general/configs/quest.constant).
//   content/scripts/login_logout/login.rs2's `[login,_]` trigger re-enters the
//   tutorial (`@start_tutorial`) whenever `%tutorial < ^tutorial_complete &
//   ~in_tutorial_island(coord) = true` - setting the varp to 1000 here, before that
//   script ever runs, is what suppresses both the tutorial resume AND the
//   `allowdesign(true)` / player_kit design-screen open that only happens inside
//   tutorial.rs2's `start_tutorial` label (the only allowdesign(true) call in all of
//   content) - so the vanilla character-design screen is never shown to a
//   skip-tutorial player; randomizeAppearance() below replaces it. No separate
//   suppression code needed - it falls out of the hook site.
// - Starter kit + coins are copied verbatim from tutorial.rs2's `tutorial_complete`
//   label (the exit door of the real tutorial), names verified against
//   content/pack/obj.pack.
//
// Both functions below are wrapped so they never throw into the login path.

import IdkType from '#/cache/config/IdkType.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
// TYPE-ONLY on purpose: a runtime `import Player` here creates a circular module
// graph (login worker: PlayerLoading -> ApNewPlayer -> Player -> NetworkPlayer ->
// Player[TDZ]) that crashed the Windows server with "Cannot access 'Player' before
// initialization" at NetworkPlayer's `extends Player`. The one static we need
// (DESIGN_BODY_COLORS) is read off the passed instance's constructor instead.
import type Player from '#/engine/entity/Player.js';
import { getHomeCoord } from '#/engine/ApSpawnOverrides.js';
import { printWarning } from '#/util/Logger.js';

// content/scripts/general/configs/quest.constant: ^tutorial_complete = 1000.
const TUTORIAL_COMPLETE_VALUE = 1000;

// content/scripts/tutorial/scripts/tutorial.rs2, [label,tutorial_complete] -
// the exact inv_add list a player leaving the real tutorial ends up with.
const STARTER_KIT: ReadonlyArray<{ readonly name: string; readonly count: number }> = [
    { name: 'bronze_axe', count: 1 },
    { name: 'tinderbox', count: 1 },
    { name: 'net', count: 1 },
    { name: 'shrimp', count: 1 },
    { name: 'bucket_empty', count: 1 },
    { name: 'pot_empty', count: 1 },
    { name: 'bread', count: 1 },
    { name: 'bronze_pickaxe', count: 1 },
    { name: 'bronze_dagger', count: 1 },
    { name: 'bronze_sword', count: 1 },
    { name: 'wooden_shield', count: 1 },
    { name: 'shortbow', count: 1 },
    { name: 'bronze_arrow', count: 25 },
    { name: 'airrune', count: 25 },
    { name: 'mindrune', count: 15 },
    { name: 'waterrune', count: 6 },
    { name: 'earthrune', count: 4 },
    { name: 'bodyrune', count: 2 }
];

// tutorial.rs2 also does `inv_clear(bank); inv_add(bank, coins, 25);`.
const STARTER_BANK_COINS = 25;

// Lazily-built {IdkType.type -> [config ids]} index, disable-flagged entries
// excluded so we can never pick an id that doesn't actually render (the
// invisible-NPC lesson applies to player idk kits too). IdkType.count is a
// boot-time constant once the cache is loaded, so this is safe to cache forever.
let idkByType: Map<number, number[]> | null = null;

function getIdkCandidates(type: number): number[] {
    if (!idkByType) {
        const table = new Map<number, number[]>();

        for (let id = 0; id < IdkType.count; id++) {
            const cfg = IdkType.get(id);
            if (!cfg || cfg.disable) {
                continue;
            }

            const list = table.get(cfg.type) ?? [];
            list.push(id);
            table.set(cfg.type, list);
        }

        idkByType = table;
    }

    return idkByType.get(type) ?? [];
}

function randomInt(exclusiveMax: number): number {
    return Math.floor(Math.random() * exclusiveMax);
}

// Called for brand-new accounts (and, when the flag is on, accounts that logged
// out mid-tutorial) when skip-tutorial is enabled: complete tutorial state, grant
// the starter kit, randomize appearance, move to the home spawn. Idempotent - a
// player whose %tutorial is already >= complete (finished vanilla OR already
// fast-tracked by this function on an earlier login) is left untouched, so it's
// safe for the caller to invoke this unconditionally on every login while the
// flag is on.
export function applyNewPlayerSetup(player: Player): void {
    try {
        const tutorialVarId = VarPlayerType.getId('tutorial');
        if (tutorialVarId === -1) {
            printWarning('AP new-player: "tutorial" varp not found, skipping setup');
            return;
        }

        if (player.vars[tutorialVarId] >= TUTORIAL_COMPLETE_VALUE) {
            return;
        }

        player.setVar(tutorialVarId, TUTORIAL_COMPLETE_VALUE);

        const inv = player.getInventory(InvType.INV);
        if (inv) {
            inv.removeAll();

            for (const item of STARTER_KIT) {
                const objId = ObjType.getId(item.name);
                if (objId === -1) {
                    printWarning(`AP new-player: unknown starter kit item "${item.name}"`);
                    continue;
                }
                inv.add(objId, item.count);
            }
        }

        const worn = player.getInventory(InvType.WORN);
        if (worn) {
            worn.removeAll();
        }

        const bankId = InvType.getId('bank');
        const bank = bankId !== -1 ? player.getInventory(bankId) : null;
        if (bank) {
            bank.removeAll();

            const coinsId = ObjType.getId('coins');
            if (coinsId !== -1) {
                bank.add(coinsId, STARTER_BANK_COINS);
            } else {
                printWarning('AP new-player: unknown item "coins", skipping starter bank funds');
            }
        }

        randomizeAppearance(player);

        const home = CoordGrid.unpackCoord(getHomeCoord());
        player.level = home.level;
        player.x = home.x;
        player.z = home.z;
    } catch (err) {
        printWarning(`AP new-player: applyNewPlayerSetup failed (${err instanceof Error ? err.message : err})`);
    }
}

// Re-roll the player's appearance (used by setup above and the ::apnewlook test
// command, via the ap_reroll_look script command / AP_REROLL_LOOK opcode). Picks a
// random gender, then a random valid idk id
// per body part for that gender (IdkType.type: 0-6 male, 7-13 female - confirmed
// via Server/engine/src/network/game/client/handler/IdkSaveDesignHandler.ts, the
// same validation the real design-screen submission goes through), then random
// color indices sized off Player.DESIGN_BODY_COLORS (the same palette the design
// screen validates against). Female jaw (type 8) has zero real IdkType entries in
// this revision's cache - IdkSaveDesignHandler special-cases exactly that as "no
// model", so an empty candidate list there intentionally leaves body[1] = -1
// rather than throwing or picking nothing.
export function randomizeAppearance(player: Player): void {
    try {
        const gender = randomInt(2);
        player.gender = gender;

        const body: number[] = new Array(7).fill(-1);
        for (let slot = 0; slot < 7; slot++) {
            const type = gender === 1 ? slot + 7 : slot;
            const candidates = getIdkCandidates(type);
            if (candidates.length === 0) {
                continue;
            }
            body[slot] = candidates[randomInt(candidates.length)];
        }
        player.body = body;

        // Player.DESIGN_BODY_COLORS via the instance's own constructor - see the
        // type-only import note at the top for why this can't be a static import.
        const DESIGN_BODY_COLORS = (player.constructor as unknown as { DESIGN_BODY_COLORS: number[][] }).DESIGN_BODY_COLORS;
        const colors: number[] = new Array(DESIGN_BODY_COLORS.length).fill(0);
        for (let i = 0; i < DESIGN_BODY_COLORS.length; i++) {
            colors[i] = randomInt(DESIGN_BODY_COLORS[i].length);
        }
        player.colors = colors;

        player.buildAppearance(player.appearanceInv);
    } catch (err) {
        printWarning(`AP new-player: randomizeAppearance failed (${err instanceof Error ? err.message : err})`);
    }
}
