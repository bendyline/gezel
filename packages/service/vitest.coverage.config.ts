import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import inference from '../inference/vitest.config';
import service from './vitest.config';

const inferenceSource = fileURLToPath(new URL('../inference/src/', import.meta.url));

// Normal unit and installed-package tests keep exercising built inference
// modules. Coverage resolves them to source so the extraction cannot silently
// remove that runtime from the original service coverage floors. Assets and
// subprocess entry points still require the ordinary inference build.
export default defineConfig({
  ...service,
  resolve: {
    alias: [
      {
        find: /^@bendyline\/gezel-inference\/internal\/(.+)$/,
        replacement: `${inferenceSource}$1`,
      },
      ...[
        ['', 'index'],
        ['/native-release', 'native-release-entry'],
        ['/speech', 'speech'],
      ].map(([subpath, entry]) => ({
        find: new RegExp(`^@bendyline/gezel-inference${subpath}$`),
        replacement: `${inferenceSource}${entry}.ts`,
      })),
    ],
  },
  test: {
    ...service.test,
    projects: [
      ...(service.test?.projects ?? []).map((project) => {
        if (typeof project !== 'object' || project.test?.name !== 'unit') return project;
        return {
          ...project,
          test: { ...project.test, maxWorkers: Math.max(1, Number(project.test.maxWorkers) - 1) },
        };
      }),
      {
        extends: true,
        test: {
          ...inference.test,
          name: 'inference',
          root: fileURLToPath(new URL('../inference/', import.meta.url)),
          include: ['src/**/*.test.ts'],
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
  },
});
