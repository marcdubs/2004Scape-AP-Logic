// Prints the denial message every gated area would actually show a player, with the
// requirement rendered in (ApAreaGates.explainMessage). Run it after editing
// data/config/ap-gated-areas.json to see the wording without booting a server:
//
//   npx tsx tools/logic/ExplainGates.ts            # all areas
//   npx tsx tools/logic/ExplainGates.ts --grep door
//
// The rendering needs the packed config caches (varp/obj/stat name -> id and back),
// so this loads data/pack the same way tools/pack/Compiler.ts does.

import ObjType from '#/cache/config/ObjType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { allGateMessages } from '#/engine/ApAreaGates.js';

const argv = process.argv.slice(2);
const grepIdx = argv.indexOf('--grep');
const needle = grepIdx === -1 ? null : (argv[grepIdx + 1] ?? '').toLowerCase();

VarPlayerType.load('data/pack');
ObjType.load('data/pack');

const all = allGateMessages();
const shown = needle ? all.filter(a => a.name.toLowerCase().includes(needle) || a.message.toLowerCase().includes(needle)) : all;

console.log(`${shown.length}/${all.length} gated area(s)${needle ? ` matching "${needle}"` : ''}:\n`);
for (const { name, message } of shown) {
    console.log(`  ${name}`);
    console.log(`    ${message}`);
}

// A gate nobody can ever fail is dead weight in the table (and a lie to the
// validator): flag the shape rather than leaving it to be rediscovered in game.
const alwaysOpen = shown.filter(a => / >= 0\)/.test(a.message));
if (alwaysOpen.length > 0) {
    console.log(`\nNOTE: ${alwaysOpen.length} area(s) have a trivially-true requirement (>= 0) - they can never bar anyone:`);
    for (const a of alwaysOpen) {
        console.log(`  ${a.name}`);
    }
}
