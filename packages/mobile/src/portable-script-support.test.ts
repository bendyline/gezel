import { describe, expect, it } from 'vitest';
import { supportsPortableScriptSource } from '../scripts/portable-script-support.js';
const source = `import {defineScript, gezel} from '@bendyline/gezel-sdk'; export const meta = defineScript({name:'prepare',description:'Prepare an offline artifact',requires:['artifacts.write']}); await gezel.artifacts.write('note.md','Prepared'); gezel.output({ok:true});`;
describe('embedded script packaging eligibility', () => {
  it('accepts the same SDK compiler and supported mediated calls', () => {
    expect(supportsPortableScriptSource('prepare', source)).toBe(true);
    expect(supportsPortableScriptSource('prepare', `${source} await gezel.fs.listAll();`)).toBe(
      true,
    );
  });
  it('admits nested calls only when the bundled helper name is known', () => {
    const nested = `${source} await gezel.script.run('child', {});`;
    expect(supportsPortableScriptSource('prepare', nested, new Set(['child']))).toBe(true);
    expect(supportsPortableScriptSource('prepare', nested, new Set(['other']))).toBe(false);
    expect(
      supportsPortableScriptSource(
        'prepare',
        `${source} await gezel.script.run(gezel.input.name);`,
        new Set(['child']),
      ),
    ).toBe(false);
  });
  it.each([
    source.replace('gezel.artifacts.write', 'gezel.task.create'),
    `${source} await gezel.artifacts.listAll();`,
    `${source} await gezel.artifacts.stat('note.md');`,
    source.replace("['artifacts.write']", "['network']"),
    `${source} import fs from 'node:fs';`,
    `${source} const g = gezel;`,
    source.replace('gezel.artifacts.write', "gezel['artifacts'].write"),
  ])('excludes unavailable or obscured host operations', (invalid) => {
    expect(supportsPortableScriptSource('prepare', invalid)).toBe(false);
  });
});
