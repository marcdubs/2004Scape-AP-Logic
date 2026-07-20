#!/usr/bin/env node
'use strict';

// Deploys this repo's overlay files on top of a plain LostCityRS checkout tree.
//
// Every top-level folder under overlays/ names a directory in the Server checkout
// (overlays/engine/... -> <server-root>/engine/...). To add something new later, just
// drop a file under the matching overlays/<target>/ path and re-run this script -
// nothing here needs to change.
//
// Usage: node scripts/install.js [--server-root <path>]

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const OVERLAYS_DIR = path.join(REPO_ROOT, 'overlays');

function parseServerRoot() {
    const args = process.argv.slice(2);
    const idx = args.indexOf('--server-root');
    if (idx !== -1 && args[idx + 1]) {
        return path.resolve(args[idx + 1]);
    }
    return path.resolve(REPO_ROOT, '..', 'Server');
}

function copyRecursive(src, dest, serverRoot) {
    if (fs.statSync(src).isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dest, entry), serverRoot);
        }
        return;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`  ${path.relative(REPO_ROOT, src)} -> ${path.relative(serverRoot, dest)}`);
}

// Seeds engine/data/config/world.json with the AP-relevant knobs so they're
// discoverable and editable without digging through engine source, and forces
// the three BUILD_VERIFY flags off - AP content adds objs/varps, so the packed
// cache can never match the vanilla rev-274 checksums and the checksum safety
// check would fail every fresh build. world.json deep-merges over the engine
// defaults, so a partial file is fine. Values you have already set are never
// overwritten (only missing keys are added); the verify flags are the one
// exception and are always forced to false.
function ensureWorldConfig(serverRoot) {
    const configPath = path.join(serverRoot, 'engine', 'data', 'config', 'world.json');
    let config = {};
    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (err) {
            console.warn(`could not parse ${configPath} (${err.message}) - leaving it alone; set build.verify=false yourself`);
            return;
        }
    }

    const changed = [];
    const seed = (section, key, value) => {
        const obj = (config[section] ??= {});
        if (!(key in obj)) {
            obj[key] = value;
            changed.push(`${section}.${key}=${value}`);
        }
    };

    seed('web', 'port', 8080); // tracker/client port; all docs examples assume 8080
    seed('node', 'xpRate', 1); // flat XP multiplier - only applies when progressiveXpRate is off in ap-options.json (progressive 5x-320x level scaling is the default)
    seed('node', 'infiniteRun', false);
    seed('node', 'apSkipTutorial', true); // new accounts skip Tutorial Island

    const build = (config.build ??= {});
    for (const key of ['verify', 'verifyFolder', 'verifyPack']) {
        if (build[key] !== false) {
            build[key] = false;
            changed.push(`build.${key}=false`);
        }
    }

    if (changed.length === 0) {
        return;
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n');
    console.log(`world.json (${path.relative(serverRoot, configPath)}): set ${changed.join(', ')}`);
}

function main() {
    const serverRoot = parseServerRoot();

    if (!fs.existsSync(OVERLAYS_DIR)) {
        console.error(`no overlays/ directory found at ${OVERLAYS_DIR}`);
        process.exit(1);
    }
    if (!fs.existsSync(serverRoot)) {
        console.error(`Server checkout not found at ${serverRoot} (pass --server-root <path> to override)`);
        process.exit(1);
    }

    const targets = fs.readdirSync(OVERLAYS_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
    if (!targets.length) {
        console.log('overlays/ is empty, nothing to install');
        return;
    }

    for (const target of targets) {
        const srcRoot = path.join(OVERLAYS_DIR, target.name);
        const destRoot = path.join(serverRoot, target.name);
        if (!fs.existsSync(destRoot)) {
            console.warn(`skipping overlays/${target.name}/ - ${destRoot} does not exist (is it cloned?)`);
            continue;
        }
        console.log(`installing overlays/${target.name}/ -> ${path.relative(REPO_ROOT, destRoot)}/`);
        copyRecursive(srcRoot, destRoot, serverRoot);
    }

    ensureWorldConfig(serverRoot);
}

main();
