import { spawnSync } from 'node:child_process';

/** MCP tools whose service implementation requires a real deny-net boundary. */
const DENY_NET_TOOLS = ['run_nodejs_script', 'derive_file'] as const;

/**
 * Set to `1` on the MCP child when the security policy's External services
 * switch is on. See {@link unavailableToolsForPlatform}.
 */
export const SCRIPT_NETWORK_ALLOWED_ENV = 'GEZEL_SCRIPT_NETWORK_ALLOWED';

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

/**
 * The deny-net tools this host cannot offer. Without an enforceable network
 * boundary (Windows; Linux without the probed systemd manager) they are
 * withheld — unless `networkAllowed`: when the policy already lets gezellen
 * reach the network, the boundary has nothing left to protect, and the
 * service runs these scripts without it. Where a boundary exists it is always
 * applied, so script egress stays behind the mediated web tools there.
 */
export function unavailableToolsForPlatform(
  platform: NodeJS.Platform,
  options: { linuxSystemdAvailable?: boolean; networkAllowed?: boolean } = {},
): readonly string[] {
  if (platform === 'darwin') return [];
  if (platform === 'linux' && (options.linuxSystemdAvailable ?? canUseLinuxSystemdDenyNet())) {
    return [];
  }
  if (options.networkAllowed) return [];
  return DENY_NET_TOOLS;
}
