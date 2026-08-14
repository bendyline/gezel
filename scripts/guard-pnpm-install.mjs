#!/usr/bin/env node

const serialized = process.env.GEZEL_SERIALIZED_PNPM_INSTALL === '1';
const ci = process.env.CI === '1' || process.env.CI === 'true';

if (serialized || ci) process.exit(0);

console.error('[pnpm-install] Refusing a bare pnpm install in this shared checkout.');
console.error('');
console.error('Multiple local tasks can otherwise rewrite node_modules at the same time,');
console.error('which leaves partial package imports and missing workspace binaries on Windows.');
console.error('Run the checkout-locked installer instead:');
console.error('');
console.error('  pnpm deps:install');
console.error('');
console.error('If you explicitly intend to reconcile the entire dependency tree, use:');
console.error('');
console.error('  pnpm deps:repair');
process.exit(1);
