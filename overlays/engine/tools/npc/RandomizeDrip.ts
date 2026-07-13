import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

import {
    BACKUP_ROOT,
    SCRIPTS_ROOT,
    type ModelSlot,
    type WeaponGroup,
    type WeaponSlot,
    ensureNpcBackup,
    findNpcFiles,
    isShieldName,
    loadModelUniverse,
    loadWeaponUniverse,
    parseSlots,
    parseWeaponGroups,
    readNpcSource
} from './NpcDripParser.js';
import { mulberry32 } from '../shared/Prng.js';

// Shuffles NPC cosmetics (outfits/hair/etc) by reassigning model# values within matching
// slot pools across every .npc config in the content tree. Pure config mutation - no
// engine or script changes, no gameplay coupling (see docs/archipelago-ideas.md #3,
// which explicitly calls this the easiest of the six ideas and recommends exactly this
// approach instead of the runtime-override pattern used for entrances). Unlike the
// entrance randomizer, reseeding here DOES require a content pack rebuild
// (npx tsx tools/pack/Build.ts) since model# is compiled into npc.dat, not read at
// runtime.
//
// Pools are keyed by gender + body-part category (e.g. "man_torso", "woman_hat"). Each
// model# slot gets an independently-sampled replacement drawn from every valid model in
// that category across the WHOLE cache (content/pack/model.pack via
// loadModelUniverse()), not just the values some NPC already happens to be wearing -
// that pool is meaningfully bigger (e.g. woman_hat: 23 valid models vs only 8 ever worn
// by a vanilla NPC), so this surfaces combinations vanilla never used. Every slot is
// guaranteed to actually change (resampled until it differs from its own original
// value, unless the category has fewer than 2 valid models total).
//
// Values that don't match the `(man|woman)_<part>_<detail>` naming convention (creature
// models) are left untouched - see NpcDripParser.ts for why that convention is a safe
// swap boundary.
//
// Held items (human_weapons_*) are shuffled separately, per NPC block rather than per
// slot, so that a two-handed weapon (bow/staff/halberd/scythe/harpoon - see
// isTwoHandedName()) can never land in the same block as a shield. A block with a
// single weapon slot draws from the full weapon+prop pool (anything goes when there's
// no shield to clip with); a block with a weapon+shield pair draws the weapon from the
// one-handed pool only and the shield from the shield pool. Blocks using the
// human_weaponsextra_* companion piece (currently just the staff orb) are left vanilla
// entirely - see the weapon-assignment loop below for why.
//
// Usage: npx tsx tools/npc/RandomizeDrip.ts [--seed <number>] [--dry-run] [--mixed-gender] [--no-weapons] [--exclude <substr,substr,...>]

const SPOILER_OUTPUT = path.join(import.meta.dirname, 'drip-seed.json');

function parseArgs() {
    const args = process.argv.slice(2);
    const seedIdx = args.indexOf('--seed');
    const seed = seedIdx !== -1 ? parseInt(args[seedIdx + 1], 10) : Math.floor(Math.random() * 0xffffffff);
    const excludeIdx = args.indexOf('--exclude');
    const exclude =
        excludeIdx !== -1
            ? args[excludeIdx + 1]
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean)
            : [];
    return { seed, dryRun: args.includes('--dry-run'), mixedGender: args.includes('--mixed-gender'), noWeapons: args.includes('--no-weapons'), exclude };
}

// picks a value from pool that differs from avoid, resampling up to 50x - bounded so a
// pathologically small pool can't spin forever. Returns null if pool is empty.
function pickDifferent(pool: string[], avoid: string, rand: () => number): string | null {
    if (pool.length === 0) {
        return null;
    }
    let candidate = avoid;
    for (let attempt = 0; attempt < 50 && candidate === avoid; attempt++) {
        candidate = pool[Math.floor(rand() * pool.length)];
    }
    return candidate;
}

function main() {
    if (!fs.existsSync(SCRIPTS_ROOT)) {
        printWarning(`content scripts directory not found: ${SCRIPTS_ROOT}`);
        process.exit(1);
    }

    const { seed, dryRun, mixedGender, noWeapons, exclude } = parseArgs();

    const backedUp = ensureNpcBackup();
    if (backedUp) {
        printInfo(`created vanilla content backup for ${backedUp} file(s) at ${BACKUP_ROOT}`);
    }

    // always (re)derive from the untouched vanilla backup, never the live files.
    const backupFiles = findNpcFiles(BACKUP_ROOT);
    const allSlots: ModelSlot[] = [];
    const slotsByFile = new Map<string, ModelSlot[]>();
    for (const file of backupFiles) {
        const rel = path.relative(BACKUP_ROOT, file);
        const slots = parseSlots(file, rel);
        allSlots.push(...slots);
        slotsByFile.set(rel, slots);
    }

    const excludedSet = new Set(allSlots.filter(s => exclude.some(x => s.block.includes(x) || s.file.includes(x))));
    const eligible = allSlots.filter(s => !excludedSet.has(s));

    const pools = new Map<string, ModelSlot[]>();
    for (const s of eligible) {
        const key = mixedGender ? s.category : `${s.gender}_${s.category}`;
        (pools.get(key) ?? pools.set(key, []).get(key)!).push(s);
    }

    const modelUniverse = loadModelUniverse();
    // in --mixed-gender mode a pool key is just the category ("torso") - merge both
    // genders' cache universes so a man_ NPC can end up in woman_ gear and vice versa.
    function universeFor(key: string): string[] {
        if (!mixedGender) {
            return modelUniverse.get(key) ?? [];
        }
        const man = modelUniverse.get(`man_${key}`) ?? [];
        const woman = modelUniverse.get(`woman_${key}`) ?? [];
        return [...new Set([...man, ...woman])];
    }

    const newValueBySlot = new Map<ModelSlot, string>();
    const poolSummaries: { pool: string; universeSize: number; occurrences: number; changed: number }[] = [];
    for (const [key, slots] of [...pools].sort(([a], [b]) => a.localeCompare(b))) {
        const universe = universeFor(key);
        if (universe.length < 2) {
            printWarning(`pool "${key}" has only ${universe.length} model(s) in model.pack - left vanilla`);
            continue;
        }

        const rand = mulberry32(seed ^ hashKey(key));
        let changed = 0;
        for (const slot of slots) {
            const candidate = pickDifferent(universe, slot.value, rand)!;
            newValueBySlot.set(slot, candidate);
            if (candidate !== slot.value) {
                changed++;
            }
        }
        poolSummaries.push({ pool: key, universeSize: universe.length, occurrences: slots.length, changed });
    }

    // --- weapons/held items: group-level, not per-slot - see file header. ---
    const weaponGroupsByFile = new Map<string, WeaponGroup[]>();
    const allWeaponGroups: WeaponGroup[] = [];
    if (!noWeapons) {
        for (const file of backupFiles) {
            const rel = path.relative(BACKUP_ROOT, file);
            const groups = parseWeaponGroups(file, rel);
            weaponGroupsByFile.set(rel, groups);
            allWeaponGroups.push(...groups);
        }
    }

    const excludedGroups = new Set(allWeaponGroups.filter(g => exclude.some(x => g.block.includes(x) || g.file.includes(x))));
    const weaponUniverse = loadWeaponUniverse();
    const weaponRand = mulberry32(seed ^ hashKey('weapons'));
    const newWeaponValue = new Map<WeaponSlot, string>();
    let weaponGroupsTouched = 0;
    let weaponGroupsSkipped = 0;

    for (const group of allWeaponGroups) {
        if (excludedGroups.has(group)) {
            continue;
        }

        // the staff-orb companion piece is tied to one specific weapon, not an
        // independent slot - leave the whole group vanilla rather than risk stranding
        // it on a mismatched weapon.
        if (group.slots.some(s => s.value.startsWith('human_weaponsextra_'))) {
            weaponGroupsSkipped++;
            continue;
        }

        if (group.slots.length === 1) {
            const slot = group.slots[0];
            const pool = [...weaponUniverse.oneHand, ...weaponUniverse.twoHand];
            const value = pickDifferent(pool, slot.value, weaponRand);
            if (value) {
                newWeaponValue.set(slot, value);
                weaponGroupsTouched++;
            }
            continue;
        }

        if (group.slots.length === 2) {
            const shieldSlot = group.slots.find(s => isShieldName(s.value));
            const weaponSlot = group.slots.find(s => s !== shieldSlot);
            // both shields, or neither is a shield (e.g. vanilla's one excalibur +
            // model_526 two-piece item) - the weapon/shield role can't be inferred
            // safely, leave vanilla.
            if (!shieldSlot || !weaponSlot || !isShieldName(shieldSlot.value) || isShieldName(weaponSlot.value)) {
                weaponGroupsSkipped++;
                continue;
            }

            const newShield = pickDifferent(weaponUniverse.shield, shieldSlot.value, weaponRand);
            // one-handed only - this is what keeps a 2h weapon out of a shield pairing.
            const newWeapon = pickDifferent(weaponUniverse.oneHand, weaponSlot.value, weaponRand);
            if (newShield && newWeapon) {
                newWeaponValue.set(shieldSlot, newShield);
                newWeaponValue.set(weaponSlot, newWeapon);
                weaponGroupsTouched++;
            }
            continue;
        }

        // 3+ weapon-slot values in one block has never been observed in vanilla - bail
        // rather than guess a structural role.
        weaponGroupsSkipped++;
    }

    let filesWritten = 0;
    let slotsChanged = 0;
    const spoilerEntries: { file: string; block: string; field: string; was: string; now: string }[] = [];

    for (const file of backupFiles) {
        const rel = path.relative(BACKUP_ROOT, file);
        const slots = slotsByFile.get(rel) ?? [];
        const bodyEdits = slots.filter(s => !excludedSet.has(s) && newValueBySlot.get(s) !== undefined && newValueBySlot.get(s) !== s.value);

        const weaponGroups = weaponGroupsByFile.get(rel) ?? [];
        const weaponEdits: WeaponSlot[] = [];
        for (const group of weaponGroups) {
            for (const slot of group.slots) {
                const now = newWeaponValue.get(slot);
                if (now !== undefined && now !== slot.value) {
                    weaponEdits.push(slot);
                }
            }
        }

        if (!bodyEdits.length && !weaponEdits.length) {
            continue;
        }

        // base text is the CURRENT LIVE file, not the backup - line indices are stable
        // across backup/live (edits only ever replace a line's value, never add/remove
        // lines), but reading the backup here would silently erase any edits another
        // .npc-config tool (e.g. RandomizeShops.ts) already applied to this same file.
        const livePath = path.join(SCRIPTS_ROOT, rel);
        const lines = readNpcSource(livePath).split('\n');
        for (const slot of bodyEdits) {
            const newValue = newValueBySlot.get(slot)!;
            lines[slot.line] = `${slot.field}=${newValue}`;
            spoilerEntries.push({ file: rel, block: slot.block, field: slot.field, was: slot.value, now: newValue });
        }
        for (const slot of weaponEdits) {
            const newValue = newWeaponValue.get(slot)!;
            lines[slot.line] = `${slot.field}=${newValue}`;
            spoilerEntries.push({ file: rel, block: slot.block, field: slot.field, was: slot.value, now: newValue });
        }

        filesWritten++;
        slotsChanged += bodyEdits.length + weaponEdits.length;
        if (!dryRun) {
            fs.writeFileSync(livePath, lines.join('\n').replace(/\n/g, '\r\n'));
        }
    }

    const weaponSummary = noWeapons ? 'weapons: disabled (--no-weapons)' : `weapons: ${weaponGroupsTouched} group(s) reassigned, ${weaponGroupsSkipped} left vanilla (companion piece/ambiguous role)`;
    printInfo(`${dryRun ? '[dry run] ' : ''}seed ${seed}: ${pools.size} body pool(s), ${slotsChanged} total swap(s) across ${filesWritten} file(s) (${excludedSet.size} body slot(s) excluded); ${weaponSummary}`);

    fs.writeFileSync(
        SPOILER_OUTPUT,
        JSON.stringify(
            {
                seed,
                mixedGender,
                noWeapons,
                exclude,
                generatedAt: new Date().toISOString(),
                dryRun,
                pools: poolSummaries,
                weaponUniverse: { shield: weaponUniverse.shield.length, twoHand: weaponUniverse.twoHand.length, oneHand: weaponUniverse.oneHand.length },
                weaponGroupsTouched,
                weaponGroupsSkipped,
                swaps: spoilerEntries
            },
            null,
            2
        )
    );
    printInfo(`${dryRun ? '[dry run] ' : ''}spoiler written to ${SPOILER_OUTPUT}`);
    if (!dryRun) {
        printInfo('rebuild the pack before testing: npx tsx tools/pack/Build.ts');
    }
}

// derives a distinct per-pool sub-seed so pools don't all draw from the same PRNG
// stream in lockstep while staying fully reproducible from the one --seed value.
function hashKey(key: string): number {
    let h = 0;
    for (let i = 0; i < key.length; i++) {
        h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
    }
    return h >>> 0;
}

main();
