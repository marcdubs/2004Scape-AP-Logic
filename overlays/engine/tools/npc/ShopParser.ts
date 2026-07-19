import fs from 'fs';
import path from 'path';

import { SCRIPTS_ROOT, readNpcSource } from './NpcDripParser.js';

// Parses content/scripts/**/*.npc for shopkeeper param bundles.
//
// A shopkeeper NPC points at its stock via `param=owned_shop,<inv name>`
// (content/scripts/shop/scripts/shop.rs2's ~openshop_activenpc reads it, along with
// shop_buy_multiplier/shop_sell_multiplier/shop_delta/shop_title from the same NPC's
// params - see shop/configs/shopkeeper.param for the param type declarations). Every
// one of the 117 owned_shop occurrences in vanilla content has all 5 of these params
// present (verified by scanning the whole tree), so a block's shop identity is always
// a complete, swappable 5-field bundle - no partial/default-value cases to handle.

export type ShopBundle = {
    file: string;
    block: string;
    shopLine: number;
    shop: string;
    sellLine: number;
    sell: string;
    buyLine: number;
    buy: string;
    deltaLine: number;
    delta: string;
    titleLine: number;
    title: string;
};

const OWNED_SHOP_RE = /^param=owned_shop,(.+)$/;
const SELL_RE = /^param=shop_sell_multiplier,(.+)$/;
const BUY_RE = /^param=shop_buy_multiplier,(.+)$/;
const DELTA_RE = /^param=shop_delta,(.+)$/;
const TITLE_RE = /^param=shop_title,(.*)$/;

export function parseShopBundles(filePath: string, relFile: string): ShopBundle[] {
    const lines = readNpcSource(filePath).split('\n');
    const bundles: ShopBundle[] = [];
    let block = '';

    type Partial = { shopLine?: number; shop?: string; sellLine?: number; sell?: string; buyLine?: number; buy?: string; deltaLine?: number; delta?: string; titleLine?: number; title?: string };
    let current: Partial = {};

    const tryFlush = () => {
        const c = current;
        if (c.shopLine !== undefined && c.sellLine !== undefined && c.buyLine !== undefined && c.deltaLine !== undefined && c.titleLine !== undefined) {
            bundles.push({
                file: relFile,
                block,
                shopLine: c.shopLine,
                shop: c.shop!,
                sellLine: c.sellLine,
                sell: c.sell!,
                buyLine: c.buyLine,
                buy: c.buy!,
                deltaLine: c.deltaLine,
                delta: c.delta!,
                titleLine: c.titleLine,
                title: c.title!
            });
        }
        current = {};
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('[')) {
            tryFlush();
            block = line.slice(1, line.lastIndexOf(']'));
            continue;
        }

        let match;
        if ((match = line.match(OWNED_SHOP_RE))) {
            current.shopLine = i;
            current.shop = match[1];
        } else if ((match = line.match(SELL_RE))) {
            current.sellLine = i;
            current.sell = match[1];
        } else if ((match = line.match(BUY_RE))) {
            current.buyLine = i;
            current.buy = match[1];
        } else if ((match = line.match(DELTA_RE))) {
            current.deltaLine = i;
            current.delta = match[1];
        } else if ((match = line.match(TITLE_RE))) {
            current.titleLine = i;
            current.title = match[1];
        }
    }
    tryFlush();

    return bundles;
}

// finds every shop id that's hardcoded as a literal argument to ~openshop(...) rather
// than read from an NPC's own owned_shop param via ~openshop_activenpc - e.g. dommik/
// rommik pick between a members/f2p shop id in a hardcoded if/else in their own
// opnpc3 handler. Reassigning such an NPC's owned_shop param would silently do
// nothing (worse: their opnpc1 dialogue path DOES read the param, so the NPC would
// show one shop when talked to and a different one when right-click "Trade"d) - any
// bundle whose current shop value is in this set is excluded from the shuffle.
// ~openshop_activenpc/~openshop($shop, ...) (the generic proc definition, which takes
// a variable) don't match this regex, only literal-argument call sites do.
const HARDCODED_OPENSHOP_RE = /~openshop\(([a-zA-Z0-9_]+),/g;

function walkRs2(dir: string, out: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkRs2(full, out);
        } else if (entry.name.endsWith('.rs2')) {
            out.push(full);
        }
    }
}

export function loadHardcodedShopIds(): Set<string> {
    const ids = new Set<string>();
    const files: string[] = [];
    walkRs2(SCRIPTS_ROOT, files);
    for (const file of files) {
        const text = readNpcSource(file);
        for (const match of text.matchAll(HARDCODED_OPENSHOP_RE)) {
            ids.add(match[1]);
        }
    }
    return ids;
}
