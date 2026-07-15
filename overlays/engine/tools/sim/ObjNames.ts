// Lazy id->name lookup for content/pack/obj.pack ("id=name" plain text, one per line -
// see NpcDripParser.ts's CONTENT_ROOT convention for why this is ../content relative to
// the engine cwd the sim is invoked from). Used only for -v2 narration flavor when
// describing gather/process swaps (ap-gather.json / ap-process.json store numeric obj
// ids) - never load-bearing for the logic engine itself.

import fs from 'fs';
import path from 'path';

let cache: Map<string, string> | null = null;

function load(): Map<string, string> {
    if (cache !== null) {
        return cache;
    }
    cache = new Map();
    const objPackPath = path.resolve(process.cwd(), '../content/pack/obj.pack');
    if (!fs.existsSync(objPackPath)) {
        return cache;
    }
    try {
        const text = fs.readFileSync(objPackPath, 'utf8');
        for (const line of text.split(/\r?\n/)) {
            const eq = line.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            const id = line.slice(0, eq).trim();
            const name = line.slice(eq + 1).trim();
            if (id.length > 0 && name.length > 0) {
                cache.set(id, name);
            }
        }
    } catch {
        // leave cache empty - narration falls back to raw ids.
    }
    return cache;
}

/** Human-readable obj name for a numeric id (as it appears in ap-gather.json/ap-process.json keys), or the raw id string if unknown/obj.pack unavailable. */
export function objName(id: string): string {
    return load().get(id) ?? `obj#${id}`;
}
