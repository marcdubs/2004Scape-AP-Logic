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
}

main();
