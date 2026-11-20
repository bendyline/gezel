import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canApplyMacSandbox, runInSandbox, selectNodeHardeningFlags } from './runner.js';
import { canApplyWindowsMxcSandbox } from './windows-mxc.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspaceWith(source: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gezel-hardening-')));
  dirs.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const entry = join(workspace, 'main.mjs');
  await writeFile(entry, source, 'utf8');
  return { root, workspace, entry };
}

const run = (entry: string, cwd: string, denyNet = false) =>
  runInSandbox({
    entry,
    cwd,
    input: '',
    timeoutMs: 20_000,
    denyNet,
    allowMissingNetBoundary: true,
  });

describe('Node options the sandbox adds', () => {
  it('asks only for what the binary advertises', () => {
    expect(
      selectNodeHardeningFlags(`
  --disable-sigusr1           Disable inspector thread to be
  --no-experimental-sqlite    experimental node:sqlite module
  --permission                enable the permission system
`),
    ).toEqual(['--disable-sigusr1', '--no-experimental-sqlite']);
    expect(selectNodeHardeningFlags('  --experimental-sqlite  opt in\n')).toEqual([]);
  });
});

describe('what a sandboxed script can no longer reach', () => {
  // node:sqlite opened, ATTACHed and VACUUMed INTO paths outside the folders
  // the permission model granted.
  it('has no node:sqlite', async () => {
    const { workspace, entry } = await workspaceWith(`
      const results = [];
      try { await import('node:sqlite'); results.push('import loaded'); } catch (e) { results.push(e.code); }
      try { process.getBuiltinModule('node:sqlite') ? results.push('builtin loaded') : results.push('none'); } catch (e) { results.push(e.code); }
      process.stdout.write(results.join(','));
    `);
    const result = await run(entry, workspace);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('loaded');
  });

  // A script could open the daemon's (or any Node program's) inspector and
  // run code inside it.
  it('signals no process but its own and opens no inspector', async () => {
    const { workspace, entry } = await workspaceWith(`
      const results = [];
      for (const [label, attempt] of [
        ['kill-parent', () => process.kill(process.ppid, 0)],
        ['debug-parent', () => process._debugProcess(process.ppid)],
        ['restore', () => { process._kill = () => 0; return process._kill === undefined; }],
      ]) {
        try { attempt(); results.push(label + ':allowed'); } catch (e) { results.push(label + ':' + (/not allowed in this sandbox|read only|Cannot assign/.test(e.message) ? 'refused' : e.message)); }
      }
      results.push('self:' + process.kill(process.pid, 0));
      process.stdout.write(results.join(','));
    `);
    const result = await run(entry, workspace);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      'kill-parent:refused,debug-parent:refused,restore:refused,self:true',
    );
  });

  // The permission model does not gate local sockets: D-Bus, the Docker
  // socket, Windows named pipes.
  it('connects a network-on script to no local socket or pipe', async () => {
    const { workspace, entry } = await workspaceWith(`
      import net from 'node:net';
      const results = [];
      const pipe = process.platform === 'win32' ? '\\\\\\\\.\\\\pipe\\\\InitShutdown' : '/run/dbus/system_bus_socket';
      for (const attempt of [() => net.connect(pipe), () => net.createConnection({ path: pipe }), () => new net.Socket().connect(pipe)]) {
        try { attempt().on('error', () => {}); results.push('allowed'); } catch (e) { results.push(/local sockets/.test(e.message) ? 'refused' : e.message); }
      }
      const tcp = net.connect({ host: '127.0.0.1', port: 9 });
      tcp.on('error', () => {});
      tcp.destroy();
      results.push('tcp:ok');
      process.stdout.write(results.join(','));
    `);
    const result = await run(entry, workspace);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe('refused,refused,refused,tcp:ok');
  });
});

describe('links that lead out of the folder', () => {
  it('refuses to start where nothing confines the file system by real path', async () => {
    const confined =
      (process.platform === 'darwin' && (await canApplyMacSandbox())) ||
      (process.platform === 'win32' &&
        (await canApplyWindowsMxcSandbox(process.env.GEZEL_NODE_PATH || process.execPath)));
    const { root, workspace, entry } = await workspaceWith(`process.stdout.write('ran')`);
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(workspace, 'r'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await run(entry, workspace);
    if (confined) {
      expect(result.stdout).toBe('ran');
      return;
    }
    expect(result.exitCode).toBe(126);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('leads out of it');
  });
});
