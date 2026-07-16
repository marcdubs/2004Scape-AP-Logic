import { execFileSync, type ExecFileSyncOptions } from 'child_process';

// On Windows, `npx` is a `npx.cmd` shim, not a real executable - and since Node's
// CVE-2024-27980 fix (present in the Node 24 the user runs), spawning a .cmd/.bat file
// directly via execFileSync/spawnSync throws EINVAL even when named correctly, because
// Windows can only launch .cmd files through cmd.exe, not CreateProcess directly.
// `shell: true` is what makes Node route it through cmd.exe. On POSIX this is
// unnecessary (npx is a real executable on PATH either way) but harmless (routes
// through /bin/sh -c instead). Every tool that shells out to `npx tsx <other tool>`
// must go through this rather than calling execFileSync('npx', ...) directly.
const NPX_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const USE_SHELL = process.platform === 'win32';

export function execNpxTsx(args: readonly string[], options: ExecFileSyncOptions = {}): Buffer | string {
    return execFileSync(NPX_CMD, ['tsx', ...args], { ...options, shell: USE_SHELL });
}
