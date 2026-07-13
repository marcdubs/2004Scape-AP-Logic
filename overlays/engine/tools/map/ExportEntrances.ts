import fs from 'fs';
import path from 'path';

import { printInfo, printWarning } from '#/util/Logger.js';

import { CONTENT_ROOT, ENTRANCE_DIR, type Entrance, parseFile } from './EntranceParser.js';

// Dumps the parsed ladder/stair entrance edge list to JSON. See EntranceParser.ts for
// the actual parsing logic and ARCHIPELAGO_IDEAS.md #1 for context.

const DEFAULT_OUTPUT = path.join(import.meta.dirname, 'entrances.json');

function main() {
    const outputPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT;

    if (!fs.existsSync(ENTRANCE_DIR)) {
        printWarning(`entrance script directory not found: ${ENTRANCE_DIR}`);
        process.exit(1);
    }

    const files = fs
        .readdirSync(ENTRANCE_DIR)
        .filter(f => f.endsWith('.rs2'))
        .map(f => path.join(ENTRANCE_DIR, f));

    const entrances: Entrance[] = files.flatMap(f => parseFile(f));

    const stats = {
        total: entrances.length,
        byKind: entrances.reduce<Record<string, number>>((acc, e) => {
            acc[e.kind] = (acc[e.kind] ?? 0) + 1;
            return acc;
        }, {}),
        byMethod: entrances.reduce<Record<string, number>>((acc, e) => {
            acc[e.method] = (acc[e.method] ?? 0) + 1;
            return acc;
        }, {}),
        unresolvedGosubs: entrances.filter(e => e.method === 'gosub').map(e => `${e.category}/${e.op} -> @${e.gosubTarget}`)
    };

    const output = {
        generatedAt: new Date().toISOString(),
        sourceFiles: files.map(f => path.relative(CONTENT_ROOT, f)),
        stats,
        entrances
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    printInfo(`wrote ${entrances.length} entrance records to ${outputPath}`);
    if (stats.unresolvedGosubs.length) {
        printWarning(`${stats.unresolvedGosubs.length} unresolved gosub target(s): ${stats.unresolvedGosubs.join(', ')}`);
    }
}

main();
