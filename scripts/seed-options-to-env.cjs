#!/usr/bin/env node
'use strict';

// Shared by new-run.sh and new-run.bat: converts data/config/ap-seed-options.json
// (written by the game server when it connects to an Archipelago room) into
// knob assignments that override the scripts' defaults.
//
//   node seed-options-to-env.cjs <file>          # sh:  eval "$(node ...)"
//   node seed-options-to-env.cjs <file> --bat    # bat: for /f ... do %%L
//
// The --bat output uses !VAR! (delayed expansion) for appends - new-run.bat
// runs under setlocal enabledelayedexpansion, so each emitted line expands at
// execution time exactly like the sh output does under eval.

const fs = require('fs');

const file = process.argv[2];
const bat = process.argv[3] === '--bat';
if (!file) {
    console.error('usage: node seed-options-to-env.cjs <ap-seed-options.json> [--bat]');
    process.exit(64);
}

const o = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = [];
const set = (key, value) => out.push(bat ? `set "${key}=${value}"` : `${key}=${value}`);
const prepend = (key, flag) => out.push(bat ? `set "${key}=${flag} !${key}!"` : `${key}="${flag} $${key}"`);
// `if` is a cmd parser keyword and cannot be executed via a for-variable, so
// the existence check happens here (we run from the engine dir, same as the
// scripts) and the emitted line is a bare del/rm.
const del = name => {
    if (fs.existsSync(`data/config/${name}`)) {
        out.push(bat ? `del /q "data\\config\\${name}"` : `rm -f data/config/${name}`);
    }
};

if (o.entrances === 'off') {
    set('RUN_ENTRANCES', 0);
    del('ap-entrances.json');
} else {
    if (o.entrances === 'mixed') {
        prepend('ENTRANCE_EXTRA', '--mixed');
    }
    // Adopting this file means an AP run: a stranded quest's checks may hold the
    // multiworld's progression, so the entrance roll must not accept stranded
    // tables (solo runs may - GenerateSeed just makes those checks filler).
    prepend('ENTRANCE_EXTRA', '--require-perfect');
}
if (o.npcDrip === false) prepend('REGENERATE_EXTRA', '--skip-drip');
if (o.shops === false) prepend('REGENERATE_EXTRA', '--skip-shops');
if (o.drops === 'off') prepend('REGENERATE_EXTRA', '--skip-drops');
else if (typeof o.drops === 'string') set('DROPS_MODE', o.drops);
if (o.gathering === 'off') {
    set('RUN_GATHER', 0);
    del('ap-gather.json');
} else if (typeof o.gathering === 'string') {
    set('GATHER_MODE', o.gathering);
}
if (o.processing === 'off') {
    set('RUN_PROCESS', 0);
    del('ap-process.json');
} else if (typeof o.processing === 'string') {
    set('PROCESS_MODE', o.processing);
}
if (o.spawn === 'off') {
    set('RUN_SPAWN', 0);
    del('ap-spawn.json');
} else if (typeof o.spawn === 'string') {
    set('SPAWN_MODE', o.spawn);
}

console.log(out.join('\n'));
