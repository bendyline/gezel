import { fixNodePtyPermissions } from './node-pty-permissions.js';

const fixed = fixNodePtyPermissions();
if (fixed > 0) {
  console.log(`[gezel-service] restored execute permission on ${fixed} node-pty spawn-helper`);
}
