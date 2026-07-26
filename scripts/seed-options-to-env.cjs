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

/** True when ap-entrances.json is the table Archipelago shipped in slot_data. */
const apBuiltEntranceTable = () => {
    try {
        return JSON.parse(fs.readFileSync('data/config/ap-entrances.json', 'utf8')).source === 'archipelago slot_data';
    } catch {
        return false;
    }
};

// THE seed (GitHub #3). With region_logic on, the apworld rolls gathering, processing,
// shops and spawn itself so its fill can reason about the real world, then pins the seed
// it used. Adopting it here makes every tool below reproduce the identical table - the
// tools are deterministic, and new-run feeds them all one shared $SEED. Overriding SEED
// this way is the point: an AP run's world is decided by the multiworld, not by us.
if (Number.isInteger(o.seed)) {
    set('SEED', o.seed >>> 0);
}

if (o.entrances === 'off') {
    set('RUN_ENTRANCES', 0);
    // "off" means two different things now. If the apworld built the layout itself
    // (region_logic on), ApClient has already written that table here and pinned
    // entrances to "off" so we don't reshuffle it - deleting it would throw away the
    // exact map the multiworld's fill reasoned over. Only a genuinely vanilla-entrance
    // run gets the file removed.
    if (!apBuiltEntranceTable()) {
        del('ap-entrances.json');
    }
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
if (o.teleports === false) prepend('REGENERATE_EXTRA', '--skip-teleports');
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
// Forward-compatible: the apworld does not emit `thieving` yet (its fill does not model
// thieving swaps - see docs/lessons-learned.md, GitHub #6 follow-up), so this is a no-op
// on today's slot data and becomes live the moment the option ships.
if (o.thieving === 'off') {
    set('RUN_THIEVING', 0);
    del('ap-thieving.json');
} else if (typeof o.thieving === 'string') {
    set('THIEVING_MODE', o.thieving);
}
if (o.spawn === 'off') {
    set('RUN_SPAWN', 0);
    del('ap-spawn.json');
} else if (typeof o.spawn === 'string') {
    set('SPAWN_MODE', o.spawn);
}

// Human-readable confirmation of what was adopted, on STDERR: both callers capture
// only stdout (sh `eval "$(...)"`, bat `for /f ... in (`...`)`), so this reaches the
// console without ever landing in the eval. It answers "am I actually rolling the
// multiworld's world, or this script's defaults?" - the one question you cannot
// afford to get wrong, and which counts-only output otherwise hides.
const stageLabel = (value, offLabel = 'off (left vanilla)') => {
    if (value === 'off' || value === false) return offLabel;
    if (value === true || value === undefined) return 'on (default)';
    return String(value);
};
const banner = [
    '================================================================',
    'ARCHIPELAGO MODE - this world is rolled from the multiworld',
    '================================================================',
    `  source:     ${file}`,
    `              (written by the game server when it connected to the room)`,
    Number.isInteger(o.seed)
        ? `  seed:       ${o.seed >>> 0}  <- PINNED BY ARCHIPELAGO, overriding this script's roll`
        : '  seed:       not pinned by the room - using this script\'s own seed',
    o.entrances === 'off' && apBuiltEntranceTable()
        ? '  entrances:  from slot_data (Archipelago built the layout; NOT re-rolled here)'
        : `  entrances:  ${stageLabel(o.entrances, 'off (vanilla entrances)')}`,
    `  gathering:  ${stageLabel(o.gathering)}`,
    `  processing: ${stageLabel(o.processing)}`,
    `  thieving:   ${o.thieving === undefined ? 'not sent by the room - using this script\'s knob' : stageLabel(o.thieving)}`,
    `  drops:      ${stageLabel(o.drops)}`,
    `  spawn:      ${stageLabel(o.spawn)}`,
    `  npc drip:   ${stageLabel(o.npcDrip)}`,
    `  shops:      ${stageLabel(o.shops)}`,
    `  teleports:  ${stageLabel(o.teleports)}`,
    '================================================================'
];
console.error(banner.join('\n'));

console.log(out.join('\n'));
