import fs from 'fs';

import { derangement, hashKey, mulberry32 } from './Prng.js';

// Progression bands shared by gathering and processing randomization (GitHub #15).
//
// Both tools' flat modes (shuffle / chaos) ignore level entirely: a level-1 fish can
// become a rune bar and a rune bar can become a raw shrimp. That is the point of those
// modes, but it also makes the early game swing wildly - and it is the main reason a
// cross-skill quest item can land behind a skill requirement the player has no way to
// meet yet. `--mode tiered` keeps the cross-skill shuffle (a fish still becomes an ore)
// but confines it to the band the product's own level requirement puts it in, so a
// level-1 fish becomes a level-1 ore or log and a level-75 one becomes another level-75
// product.
//
// FIXED level bands, not percentile ones. Drop randomization's tiered mode buckets by
// rarity percentile because "rare" only means anything relative to the rest of the
// table; a skill level is an absolute, player-visible number, and the bands below are
// the ones a player already thinks in (they line up with the equipment tiers: bronze/
// iron, steel, mithril, adamant, rune). Fixed bands are also stable - adding a product
// to the corpus can't silently reshuffle which band everything else lands in.
//
// The band NAME is the PRNG salt (`mulberry32(seed ^ hashKey(band))`, same trick as
// drops), so each band draws from its own stream and a band whose membership didn't
// change keeps its permutation across corpus edits.
export const LEVEL_BANDS: { name: string; max: number }[] = [
    { name: 'lvl1-14', max: 14 },
    { name: 'lvl15-29', max: 29 },
    { name: 'lvl30-44', max: 44 },
    { name: 'lvl45-59', max: 59 },
    { name: 'lvl60-74', max: 74 },
    { name: 'lvl75+', max: Infinity }
];

export function bandFor(level: number): string {
    for (const band of LEVEL_BANDS) {
        if (level <= band.max) {
            return band.name;
        }
    }
    return LEVEL_BANDS[LEVEL_BANDS.length - 1].name;
}

/** One product and the skill level needed to obtain it (0/1 = available immediately). */
export interface ProductLevel {
    item: string;
    level: number;
}

// ---------------------------------------------------------------------------
// dbrow parsing
// ---------------------------------------------------------------------------

export interface DbrowBlock {
    name: string;
    /** field name -> every `data=<field>,...` tuple in the block, comma-split, in file order. */
    fields: Map<string, string[][]>;
}

/** Reads a `.dbrow` file into its `[block]` sections. */
export function readDbrowBlocks(file: string): DbrowBlock[] {
    const blocks: DbrowBlock[] = [];
    let current: DbrowBlock | null = null;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        const header = trimmed.match(/^\[([a-zA-Z0-9_]+)\]$/);
        if (header) {
            current = { name: header[1], fields: new Map() };
            blocks.push(current);
            continue;
        }
        if (current === null || !trimmed.startsWith('data=')) {
            continue;
        }
        const parts = trimmed.slice('data='.length).split(',');
        const field = parts[0];
        const values = parts.slice(1).map(v => v.trim());
        const existing = current.fields.get(field);
        if (existing) {
            existing.push(values);
        } else {
            current.fields.set(field, [values]);
        }
    }
    return blocks;
}

export interface DbrowProductSpec {
    /** the `data=<field>,<item>[,...]` column that names the product. */
    product: string;
    /**
     * where the level requirement lives: a sibling `data=<field>,<n>` column name, or a
     * numeric index INTO the product tuple (fletch_bow_table stores
     * `data=shortbow,<obj>,<level>,<exp>` - the level rides on the product itself).
     */
    level: string | number;
    /** blocks to skip entirely (see RandomizeProcessing's cooking_burn_meat note). */
    excludeBlocks?: ReadonlySet<string>;
}

/**
 * Pulls `{ item, level }` out of a dbrow. "null" products are a real sentinel in this
 * content ("you can't make this directly" rows), never an item - they're skipped.
 * A block whose product column exists but whose level column doesn't throws: a silently
 * missing level would put a high-level product in the level-1 band, which is exactly the
 * failure `--mode tiered` exists to prevent.
 */
export function readDbrowProducts(file: string, spec: DbrowProductSpec): ProductLevel[] {
    const out: ProductLevel[] = [];
    for (const block of readDbrowBlocks(file)) {
        if (spec.excludeBlocks?.has(block.name)) {
            continue;
        }
        const tuples = block.fields.get(spec.product);
        if (!tuples) {
            continue;
        }
        let blockLevel: number | null = null;
        if (typeof spec.level === 'string') {
            const raw = block.fields.get(spec.level)?.[0]?.[0];
            blockLevel = raw === undefined ? null : parseInt(raw, 10);
        }
        for (const tuple of tuples) {
            const item = tuple[0];
            if (item === undefined || item === 'null') {
                continue;
            }
            const level = typeof spec.level === 'number' ? parseInt(tuple[spec.level], 10) : blockLevel;
            if (level === null || !Number.isFinite(level)) {
                throw new Error(`${file}: block [${block.name}] product "${item}" has no usable ${typeof spec.level === 'number' ? `level at tuple index ${spec.level}` : `data=${spec.level}`} - parser drift?`);
            }
            out.push({ item, level });
        }
    }
    return out;
}

/**
 * Collapses duplicate products (limestone sits on 3 rocks, plain logs on 2 trees) to the
 * LOWEST level that yields them - the level at which the item first becomes reachable,
 * which is what a progression band is trying to model.
 */
export function minLevels(entries: Iterable<ProductLevel>): Map<string, number> {
    const out = new Map<string, number>();
    for (const { item, level } of entries) {
        const seen = out.get(item);
        if (seen === undefined || level < seen) {
            out.set(item, level);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// the tiered shuffle itself
// ---------------------------------------------------------------------------

export interface TieredBandSummary {
    band: string;
    members: string[];
}

export interface TieredResult {
    /** product -> what that action hands out now. Empty for bands too small to shuffle. */
    mapping: Map<string, string>;
    bands: TieredBandSummary[];
    /** bands that stayed vanilla because they hold fewer than 2 eligible products. */
    warnings: string[];
}

/**
 * Deranges `pool` WITHIN each level band. Like shuffle mode this is a bijection - per
 * band rather than globally - so every product is still obtainable from exactly one
 * action and nothing maps to itself. A band holding 0 or 1 eligible products can't be
 * deranged, so its member (if any) simply stays vanilla; that's reported, not fatal,
 * because `--skills`/`--exclude` can legitimately empty a band out.
 *
 * `pool` order is the caller's ordered candidate list; membership is filtered out of it
 * in place, so the apworld's port only has to reproduce the same filter to get the same
 * permutation.
 */
export function tieredSwaps(pool: string[], levelOf: ReadonlyMap<string, number>, seed: number): TieredResult {
    const mapping = new Map<string, string>();
    const bands: TieredBandSummary[] = [];
    const warnings: string[] = [];

    for (const band of LEVEL_BANDS) {
        const members = pool.filter(item => bandFor(levelOf.get(item)!) === band.name);
        if (members.length < 2) {
            if (members.length === 1) {
                warnings.push(`band ${band.name} holds only ${members[0]} - left vanilla (nothing to swap it with)`);
            }
            continue;
        }
        const rand = mulberry32(seed ^ hashKey(band.name));
        const perm = derangement(members.length, rand);
        for (let i = 0; i < members.length; i++) {
            mapping.set(members[i], members[perm[i]]);
        }
        bands.push({ band: band.name, members });
    }

    return { mapping, bands, warnings };
}
