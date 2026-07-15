import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

// Backing store for the ap_process_swap script command (Archipelago processing-skill
// randomizer - cooking/smithing/crafting/fletching). Maps a processed product's obj id to the
// obj id actually handed to the player - "smith some ore, get a cooked fish". Generated
// by tools/process/RandomizeProcessing.ts.
//
// Same architecture as ApGatherOverrides.ts (which this file is a straight copy of the
// shape of): the table lives outside the compiled script pack on purpose, so reseeding
// only requires swapping this file and restarting the server - no content rebuild (the
// ap_process_swap() wraps at each recipe's inv_add delivery point are seed-independent;
// only this mapping changes per seed).
//
// A miss returns the INPUT id rather than -1, same reasoning as gathering: the natural
// miss semantics for an item transform is "unchanged", and it lets every content
// chokepoint be a pure one-token wrap - inv_add(inv, ap_process_swap($x), n) - with no
// null branch. A missing or empty file therefore means every processed product is
// vanilla.

const OVERRIDES_PATH = 'data/config/ap-process.json';

let overrides: Map<number, number> | null = null;

function load(): Map<number, number> {
    const table = new Map<number, number>();

    if (!fs.existsSync(OVERRIDES_PATH)) {
        printInfo(`AP process overrides: no ${path.basename(OVERRIDES_PATH)}, processing products are vanilla`);
        return table;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8')) as { map?: Record<string, number> };
        for (const [product, replacement] of Object.entries(parsed.map ?? {})) {
            if (!/^\d+$/.test(product) || !Number.isInteger(replacement) || replacement < 0) {
                printWarning(`AP process overrides: skipping malformed entry ${product} -> ${replacement}`);
                continue;
            }
            table.set(parseInt(product, 10), replacement);
        }
        printInfo(`AP process overrides: loaded ${table.size} product swap(s)`);
    } catch (err) {
        printWarning(`AP process overrides: failed to parse ${OVERRIDES_PATH}, processing products are vanilla (${err instanceof Error ? err.message : err})`);
    }

    return table;
}

// returns the replacement obj id for a processed product, or the product itself
// (vanilla passthrough) on miss.
export function getProcessSwap(product: number): number {
    if (overrides === null) {
        overrides = load();
    }
    return overrides.get(product) ?? product;
}
