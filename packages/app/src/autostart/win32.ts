import { execFile } from 'node:child_process';
import type { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AutostartInstallOptions } from './index.js';

const exec = promisify(execFile);

const TASK_NAME = 'GezelService';

export function buildTaskXml(opts: AutostartInstallOptions, userId: string): string {
  // Minimal Task Scheduler XML — on-logon trigger, Limited privilege so no
  // UAC prompt, runs as the installing user. Date field is informational.
  const now = new Date().toISOString();
  const escapeXml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const argumentsValue = `"${opts.gezeldPath}" "--gezel-autostart-home=${opts.gezelHome}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>${now}</Date>
    <Author>Gezel</Author>
    <Description>Start gezel service at user logon.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(opts.nodePath)}</Command>
      <Arguments>${escapeXml(argumentsValue).replace(/"/g, '&quot;')}</Arguments>
      <WorkingDirectory>${escapeXml(opts.gezelHome)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

async function currentUserId(): Promise<string> {
  const { stdout } = await exec('whoami', []);
  return stdout.trim();
}

export async function install(opts: AutostartInstallOptions): Promise<void> {
  const userId = await currentUserId();
  const xml = buildTaskXml(opts, userId);
  const dir = await mkdtemp(join(tmpdir(), 'gezel-task-'));
  const xmlPath = join(dir, 'task.xml');
  // Task Scheduler requires UTF-16 for XML import.
  await writeFile(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
  try {
    await exec('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function uninstall(): Promise<void> {
  try {
    await exec('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
  } catch {
    /* not registered */
  }
}

export async function isInstalled(): Promise<boolean> {
  try {
    await exec('schtasks', ['/Query', '/TN', TASK_NAME]);
    return true;
  } catch {
    return false;
  }
}

// Suppress unused-param lint warnings in type file — the functions are
// called through the index dispatch above.
export type _Unused = typeof existsSync;
