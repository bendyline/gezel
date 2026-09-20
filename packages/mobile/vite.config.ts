import { builtinModules } from 'node:module';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

function mobileBoundary() {
  return {
    name: 'mobile-runtime-boundary',
    enforce: 'pre' as const,
    resolveId(source: string) {
      if (source.startsWith('node:') || builtins.has(source)) {
        throw new Error(`Mobile code cannot import a Node module: ${source}`);
      }
      if (/^@bendyline\/gezel-(service|mcp|app)(?:\/|$)/.test(source)) {
        throw new Error(`Mobile code cannot import a desktop host: ${source}`);
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [mobileBoundary(), react()],
  base: './',
  resolve: { dedupe: ['react', 'react-dom'] },
  worker: { format: 'es', plugins: () => [mobileBoundary()] },
  build: { target: 'es2022' },
});
