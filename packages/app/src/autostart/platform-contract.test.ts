import { describe, expect, it } from 'vitest';
import { buildPlist } from './darwin.js';
import { buildUnit } from './linux.js';
import { buildTaskXml } from './win32.js';

const opts = {
  nodePath: '/Users/test user/.gezel/bin/node',
  pnpmPath: '/Users/test user/.gezel/bin/pnpm-runtime/bin/pnpm.mjs',
  gezeldPath: '/Users/test user/.gezel/service/dist/bin/gezeld.js',
  gezelHome: '/Users/test user/.gezel',
};

describe('autostart platform runtime contract', () => {
  it('pins the bundled Node path in the macOS LaunchAgent', () => {
    const plist = buildPlist(opts);
    expect(plist).toContain(`<string>${opts.nodePath}</string>`);
    expect(plist).toContain('<key>GEZEL_NODE_PATH</key>');
    expect(plist).toContain('<key>GEZEL_PNPM_PATH</key>');
  });

  it('quotes the bundled Node path in the Linux user unit', () => {
    const unit = buildUnit(opts);
    expect(unit).toContain(`ExecStart="${opts.nodePath}" "${opts.gezeldPath}"`);
    expect(unit).toContain(`Environment="GEZEL_NODE_PATH=${opts.nodePath}"`);
    expect(unit).toContain(`Environment="GEZEL_PNPM_PATH=${opts.pnpmPath}"`);
  });

  it('pins the bundled Node executable in the Windows scheduled task', () => {
    const windowsOpts = {
      nodePath: 'C:\\Users\\Test & User\\.gezel\\bin\\node.exe',
      gezeldPath: 'C:\\Users\\Test & User\\.gezel\\service\\dist\\bin\\gezeld.js',
      gezelHome: 'C:\\Users\\Test & User\\.gezel',
    };
    const xml = buildTaskXml(windowsOpts, 'DESKTOP\\Test & User');
    expect(xml).toContain('<Command>C:\\Users\\Test &amp; User\\.gezel\\bin\\node.exe</Command>');
    expect(xml).toContain(
      '<Arguments>&quot;C:\\Users\\Test &amp; User\\.gezel\\service\\dist\\bin\\gezeld.js&quot; &quot;--gezel-autostart-home=C:\\Users\\Test &amp; User\\.gezel&quot;</Arguments>',
    );
  });
});
