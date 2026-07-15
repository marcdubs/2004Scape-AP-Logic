// Archipelago discovery tracker (2004Scape-AP-Logic docs/tracker-map.md). Records
// "the player did/saw this once" events so the browser tracker map can reveal what
// the randomizers did - only after first use.
//
// In-memory Map<category, Map<key, value>>, lazily seeded from
// data/config/ap-tracker.json if present (same relative-path convention as the
// other Ap*Overrides.ts loaders), with a debounced async flush back to disk so a
// fresh discovery survives a restart. Reads are always served from memory.
//
// recordDiscovery is called from randomizer lookups inside the game tick (entrance/
// gather/process/drop overrides) and from the ap_track script command - it must be
// fire-and-forget cheap and must never throw or block the tick.

import fs from 'fs';
import path from 'path';

import { printWarning } from '#/util/Logger.js';

const TRACKER_PATH = 'data/config/ap-tracker.json';
const FLUSH_DELAY_MS = 2000;

let state: Map<string, Map<string, string>> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Map<string, Map<string, string>> {
    const table = new Map<string, Map<string, string>>();

    try {
        if (fs.existsSync(TRACKER_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf8')) as Record<string, Record<string, string>>;
            for (const [category, entries] of Object.entries(parsed)) {
                const inner = new Map<string, string>();
                for (const [key, value] of Object.entries(entries)) {
                    inner.set(key, String(value));
                }
                table.set(category, inner);
            }
        }
    } catch (err) {
        // a corrupt tracker file should never take the server down - start empty and
        // let it get rebuilt (worst case: previously-seen discoveries are re-revealed).
        printWarning(`AP tracker: failed to load ${TRACKER_PATH}, starting empty (${err instanceof Error ? err.message : err})`);
    }

    return table;
}

function ensureLoaded(): Map<string, Map<string, string>> {
    if (state === null) {
        state = load();
    }
    return state;
}

function toPlainObject(table: Map<string, Map<string, string>>): Record<string, Record<string, string>> {
    const obj: Record<string, Record<string, string>> = {};
    for (const [category, entries] of table) {
        obj[category] = Object.fromEntries(entries);
    }
    return obj;
}

async function flushNow(): Promise<void> {
    try {
        if (state === null) {
            return;
        }

        const dir = path.dirname(TRACKER_PATH);
        await fs.promises.mkdir(dir, { recursive: true });

        // write-to-temp then rename so a crash mid-write can never corrupt the file
        // that's about to be re-loaded on next boot.
        const tmpPath = `${TRACKER_PATH}.tmp`;
        await fs.promises.writeFile(tmpPath, JSON.stringify(toPlainObject(state), null, 2), 'utf8');
        await fs.promises.rename(tmpPath, TRACKER_PATH);
    } catch (err) {
        printWarning(`AP tracker: failed to write ${TRACKER_PATH} (${err instanceof Error ? err.message : err})`);
    }
}

// coalesces bursts of discoveries (e.g. a player mining a whole rock over several
// ticks) into one write every ~2s, instead of one fs write per event.
function scheduleFlush(): void {
    if (flushTimer !== null) {
        // a flush is already pending - it will pick up everything recorded up to the
        // moment it fires, so nothing further to do here.
        return;
    }

    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushNow();
    }, FLUSH_DELAY_MS);

    // never let the pending flush keep the process alive on its own.
    flushTimer.unref?.();
}

export function recordDiscovery(category: string, key: string, value: string): void {
    try {
        const table = ensureLoaded();

        let entries = table.get(category);
        if (!entries) {
            entries = new Map<string, string>();
            table.set(category, entries);
        }

        if (entries.get(key) === value) {
            // already recorded exactly this discovery - no-op, don't touch the flush timer.
            return;
        }

        entries.set(key, value);
        scheduleFlush();
    } catch (err) {
        // called from inside the game tick - must never throw.
        printWarning(`AP tracker: recordDiscovery(${category}, ${key}) failed (${err instanceof Error ? err.message : err})`);
    }
}

// Full discovery state for the web route: category -> key -> value.
export function getTrackerState(): Record<string, Record<string, string>> {
    try {
        return toPlainObject(ensureLoaded());
    } catch {
        return {};
    }
}

// Number of discoveries recorded so far in one category (0 if none/unknown category).
export function getDiscoveryCount(category: string): number {
    try {
        return ensureLoaded().get(category)?.size ?? 0;
    } catch {
        return 0;
    }
}
