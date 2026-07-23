import { spawnSync } from 'node:child_process';

/** MCP tools whose service implementation requires a real deny-net boundary. */
const DENY_NET_TOOLS = ['run_nodejs_script', 'derive_file'] as const;

let linuxSystemdProbe: boolean | undefined;

/**
 * Mirror the service's executable Linux probe at MCP registration time.
 * Finding systemd-run is not enough: this checks that the user manager really
 * applies RestrictAddressFamilies and rejects an AF_INET socket.
 */
export function canUseLinuxSystemdDenyNet(): boolean {
  if (process.platform !== 'linux') return false;
  if (linuxSystemdProbe !== undefined) return linuxSystemdProbe;
  const probe =
    "const net=require('node:net');" +
    "const s=net.connect({host:'127.0.0.1',port:9});" +
    "s.once('connect',()=>process.exit(9));" +
    "s.once('error',e=>process.exit(['EAFNOSUPPORT','EPERM','EACCES'].includes(e.code)?0:2));" +
    'setTimeout(()=>process.exit(3),1000);';
  const result = spawnSync(
    'systemd-run',
    [
      '--user',
      '--quiet',
      '--pipe',
      '--wait',
      '--collect',
      '-p',
      'RestrictAddressFamilies=AF_UNIX',
      '-p',
      'RuntimeMaxSec=3',
      '--',
      process.execPath,
      '-e',
      probe,
    ],
    { stdio: 'ignore', timeout: 3_000 },
  );
  linuxSystemdProbe = result.status === 0;
  return linuxSystemdProbe;
}

export function unavailableToolsForPlatform(
  platform: NodeJS.Platform,
  options: { linuxSystemdAvailable?: boolean } = {},
): readonly string[] {
  if (platform === 'darwin') return [];
  if (platform === 'linux' && (options.linuxSystemdAvailable ?? canUseLinuxSystemdDenyNet())) {
    return [];
  }
  return DENY_NET_TOOLS;
}
