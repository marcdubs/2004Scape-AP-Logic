import fs from 'fs';
import path from 'path';

// Shared plumbing for the teleport-destination shuffle (docs/goals-and-checks.md
// Feature 4): locate the 7 standard-spellbook tele_coord rows in
// magic_spells.dbrow, and manage their pristine backup under content/.ap-backup
// (same convention as NpcDripParser.ts / DropTableParser.ts - RegenerateAll.ts
// restores the backup once per reseed pipeline, tools write onto the live file).
//
// Split from RandomizeTeleports.ts so RegenerateAll.ts can import the backup
// helpers without executing the CLI (tool entry scripts run main() on import).

export const CONTENT_ROOT = path.resolve(process.cwd(), '../content');
const DBROW_REL = path.join('scripts', 'skill_magic', 'configs', 'magic_spells.dbrow');
export const TELEPORT_DBROW_PATH = path.join(CONTENT_ROOT, DBROW_REL);
export const TELEPORT_BACKUP_PATH = path.join(CONTENT_ROOT, '.ap-backup', DBROW_REL);

// one data=tele_coord,... line inside a [magic_spell_teleport_<city>] block.
export type TeleportRow = {
    city: string; // "varrock" - the block-name suffix
    line: number; // 0-based line index in the dbrow source
    coord: string; // "0_50_53_13_32"
};

const BLOCK_RE = /^\[magic_spell_teleport_([a-z_]+)\]\r?$/;
const TELE_COORD_RE = /^data=tele_coord,([0-9_]+)\r?$/;

// copies the live dbrow to the backup path if no backup exists yet. Returns true
// if a backup was created. Call before the first mutation ever touches the file.
export function ensureTeleportBackup(): boolean {
    if (fs.existsSync(TELEPORT_BACKUP_PATH)) {
        return false;
    }
    fs.mkdirSync(path.dirname(TELEPORT_BACKUP_PATH), { recursive: true });
    fs.copyFileSync(TELEPORT_DBROW_PATH, TELEPORT_BACKUP_PATH);
    return true;
}

// copies the pristine backup back onto the live path. Returns true if a backup
// existed to restore. Only RegenerateAll.ts should call this - see its header.
export function restoreTeleportBackup(): boolean {
    if (!fs.existsSync(TELEPORT_BACKUP_PATH)) {
        return false;
    }
    fs.copyFileSync(TELEPORT_BACKUP_PATH, TELEPORT_DBROW_PATH);
    return true;
}

// parses tele_coord rows out of a dbrow source. Lines keep their original
// index so writeTeleportCoords can patch in place, CRLF intact.
export function parseTeleportRows(source: string): TeleportRow[] {
    const lines = source.split('\n');
    const rows: TeleportRow[] = [];
    let city: string | null = null;
    for (let i = 0; i < lines.length; i++) {
        const block = BLOCK_RE.exec(lines[i]);
        if (block) {
            city = block[1];
            continue;
        }
        if (lines[i].startsWith('[')) {
            city = null;
            continue;
        }
        const tele = TELE_COORD_RE.exec(lines[i]);
        if (tele && city !== null) {
            rows.push({ city, line: i, coord: tele[1] });
        }
    }
    return rows;
}

// rewrites the given lines' tele_coord values in-place and returns the new
// source. Only the coord substring changes - trailing \r survives because the
// replacement stops at it, so the file stays byte-identical everywhere else.
export function writeTeleportCoords(source: string, updates: { line: number; coord: string }[]): string {
    const lines = source.split('\n');
    for (const { line, coord } of updates) {
        lines[line] = lines[line].replace(TELE_COORD_RE, `data=tele_coord,${coord}` + (lines[line].endsWith('\r') ? '\r' : ''));
    }
    return lines.join('\n');
}
