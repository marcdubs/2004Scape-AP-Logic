import { sql } from 'kysely';

import { db } from '#/db/query.js';
import Environment from '#/util/Environment.js';
import { printInfo, printWarning } from '#/util/Logger.js';

// Manual fix for an account stuck "already logged in elsewhere" (login response
// code 3) after the server process was killed instead of shut down cleanly - the
// clean-logout/force-logout paths that zero account_login.logged_in never ran, so
// the row still points at the dead node and every future login attempt for that
// account gets rejected by the check at LoginServer.ts's player_login handler
// (`account.logged_in !== null && account.logged_in !== 0`).
//
// The server actually self-heals this on its own: every boot sends a 'world_startup'
// message that runs the equivalent of this script's UPDATE for every account stuck
// on that same node id + profile (see LoginServer.ts's 'world_startup' handler). A
// plain restart is enough in the common case. This script exists for when you want
// it fixed immediately without a restart, or you're bringing the world back up under
// a different node id/profile than what it crashed on.
//
// IMPORTANT: only run this while the world process for the target profile is NOT
// running. If a world is still up and genuinely holds the session, clearing the flag
// out from under it lets a second client log in alongside the first.
//
// Usage: npx tsx tools/admin/UnstickAccount.ts <username> [--profile <profile>]

function parseArgs(): { username: string; profile: string } {
    const args = process.argv.slice(2);
    const username = args[0];
    if (!username || username.startsWith('--')) {
        printWarning('usage: npx tsx tools/admin/UnstickAccount.ts <username> [--profile <profile>]');
        process.exit(1);
    }
    const profileIdx = args.indexOf('--profile');
    const profile = profileIdx !== -1 && args[profileIdx + 1] ? args[profileIdx + 1] : Environment.node.profile;
    return { username, profile };
}

async function main() {
    const { username, profile } = parseArgs();

    const account = await db
        .selectFrom('account')
        .selectAll()
        .where(sql`lower(username)`, '=', username.toLowerCase())
        .executeTakeFirst();

    if (!account) {
        printWarning(`no account found with username "${username}"`);
        await db.destroy();
        process.exit(1);
    }

    const login = await db.selectFrom('account_login').selectAll().where('account_id', '=', account.id).where('profile', '=', profile).executeTakeFirst();

    if (!login || (login.logged_in === 0 && login.login_time === null)) {
        printInfo(`${account.username} (profile "${profile}") is not marked as logged in - nothing to fix`);
        await db.destroy();
        process.exit(0);
    }

    printInfo(`${account.username} (profile "${profile}") is marked logged_in=${login.logged_in} since ${login.login_time} - clearing`);

    await db.updateTable('account_login').set({ logged_in: 0, login_time: null }).where('account_id', '=', account.id).where('profile', '=', profile).execute();

    printInfo(`done - ${account.username} can log back in`);
    await db.destroy();
    process.exit(0);
}

main();
