import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EvalContext } from '../types.ts';
import {
  evaluateSchemaMigrationHandlers,
  evaluateSchemaMigrationStructure,
  evaluateSchemaMigrationTests,
  runSchemaMigrationFunctionGateInDir,
  runSchemaMigrationTestTypecheckInDir,
  schemaMigrationFeedbackFor,
  schemaMigrationScenario,
} from './schema-migration.ts';

const REFERENCE_TYPES = `
export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface CreateUserInput {
  firstName: string;
  lastName: string;
  email: string;
}
`;

const REFERENCE_STORE = `
export class UserStore {
  add(input: CreateUserInput): User {
    return {
      id: '1',
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
    };
  }

  get(_id: string): User | undefined {
    return undefined;
  }

  list(users: User[]): User[] {
    return users.sort(
      (a, b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName),
    );
  }
}
`;

const REFERENCE_HANDLERS = `
export function formatDisplayName(user: User): string {
  return \`${'${user.firstName} ${user.lastName}'}\`;
}

export function renderUserCardHtml(user: User): string {
  return '<div><h3>' + user.firstName + ' ' + user.lastName + '</h3><p>' + user.email + '</p></div>';
}

export function summarizeUsersForLog(users: User[]): string {
  return users.map((user) => user.id + ': ' + user.firstName + ' ' + user.lastName).join(', ');
}
`;

const REFERENCE_MIGRATE = `
import type { User } from './types.ts';

interface LegacyUser {
  id: string;
  name: string;
  email: string;
}

export function migrateUser(oldUser: LegacyUser): User {
  const [firstName = '', ...rest] = oldUser.name.trim().split(/\\s+/);
  return {
    id: oldUser.id,
    firstName,
    lastName: rest.join(' '),
    email: oldUser.email,
  };
}
`;

const REFERENCE_MIGRATION_TESTS = `
import { describe, expect, it } from 'vitest';
import { migrateUser } from '../src/migrate.ts';

describe('migrateUser', () => {
  it('splits a normal full name', () => {
    expect(migrateUser({ id: '1', name: 'John Doe', email: 'john@example.test' })).toEqual({
      id: '1',
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@example.test',
    });
  });

  it('keeps a one-word name as firstName', () => {
    expect(migrateUser({ id: '2', name: 'Cher', email: 'cher@example.test' })).toEqual({
      id: '2',
      firstName: 'Cher',
      lastName: '',
      email: 'cher@example.test',
    });
  });

  it('keeps the remainder of a multi-word name as lastName', () => {
    const legacy = { id: '3', name: 'Mary Anne Smith', email: 'mary@example.test' };
    expect(migrateUser(legacy)).toEqual({
      id: '3',
      firstName: 'Mary',
      lastName: 'Anne Smith',
      email: 'mary@example.test',
    });
  });
});
`;

// Exact false-positive shape captured in the hardened passing trial: three
// cases existed, but every call passed a string to an object-parameter API.
const CAPTURED_BARE_STRING_TESTS = `
import { describe, it, expect } from 'vitest';
import { migrateUser } from '../src/migrate';

describe('migrateUser', () => {
  it('normal full name', () => {
    const oldName = 'John Doe';
    expect(migrateUser(oldName)).toEqual({ firstName: 'John', lastName: 'Doe' });
  });

  it('one word name', () => {
    const oldName = 'Cher';
    expect(migrateUser(oldName)).toEqual({ firstName: 'Cher', lastName: '' });
  });

  it('multi-word name', () => {
    const oldName = 'Mary Anne Smith';
    expect(migrateUser(oldName)).toEqual({ firstName: 'Mary', lastName: 'Anne Smith' });
  });
});
`;

// Exact migrate.ts and generated suite captured by the clean
// final-matrix trial `.../schema-migration-...-qu3p`. That trial reached 7/7
// while dropping id/email, so this pair is a permanent false-positive anchor.
const CAPTURED_FIELD_DROPPING_MIGRATE = `/**
 * @fileoverview Contains the user migration logic to split 'name' into 'firstName' and 'lastName'.
 */

export function migrateUser(oldUser: { name: string }): { firstName: string; lastName: string } {
  if (!oldUser.name) {
    throw new Error("Cannot migrate user with null or empty name.");
  }

  const parts = oldUser.name.trim().split(/\\s+/);

  if (parts.length === 1) {
    // Handle single-word names by assigning the whole name to firstName and empty string to lastName
    return {
      firstName: parts[0],
      lastName: "",
    };
  }

  // Assign the first part as firstName and the rest joined by space as lastName
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ');

  return { firstName, lastName };
}
`;

const CAPTURED_FIELD_DROPPING_TESTS = `import { describe, it, expect } from 'vitest';
import { migrateUser } from '../src/migrate';

describe('migrateUser', () => {
  // Test case 1: Normal two-word name
  it('should correctly split a standard two-word name', () => {
    const legacyUser = { id: '123', name: 'John Doe' };
    const migratedUser = migrateUser(legacyUser);
    expect(migratedUser.firstName).toBe('John');
    expect(migratedUser.lastName).toBe('Doe');
  });

  // Test case 2: One-word name (should put all in firstName, lastName empty or undefined depending on implementation)
  it('should handle a single-word name', () => {
    const legacyUser = { id: '456', name: 'Cher' };
    const migratedUser = migrateUser(legacyUser);
    expect(migratedUser.firstName).toBe('Cher');
    // Assuming the implementation handles single word by setting lastName to empty string or null/undefined,
    // based on the requirement "split the name on the first space". If no space, it's all firstName.
    expect(migratedUser.lastName).toBe('');
  });

  // Test case 3: Three or more word name
  it('should correctly split a multi-word name', () => {
    const legacyUser = { id: '789', name: 'Mary Anne Smith' };
    const migratedUser = migrateUser(legacyUser);
    expect(migratedUser.firstName).toBe('Mary');
    expect(migratedUser.lastName).toBe('Anne Smith'); // Everything after the first space is lastName
  });
});
`;

async function runMigrationFunctionFixture(migrateTs: string) {
  const dir = await mkdtemp(join(tmpdir(), 'gezel-schema-migrate-gate-'));
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    await Promise.all([
      writeFile(join(dir, 'src/types.ts'), REFERENCE_TYPES, 'utf8'),
      writeFile(join(dir, 'src/migrate.ts'), migrateTs, 'utf8'),
    ]);
    return await runSchemaMigrationFunctionGateInDir(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('evaluateSchemaMigrationStructure', () => {
  it('accepts the reference migrated contracts and live consumers', () => {
    expect(
      evaluateSchemaMigrationStructure({
        typesTs: REFERENCE_TYPES,
        storeTs: REFERENCE_STORE,
        handlersTs: REFERENCE_HANDLERS,
      }),
    ).toEqual({ typesUpdated: true, storeUpdated: true, handlersUpdated: true });
  });

  it('rejects the seeded sources even though their TODO comments mention both new fields', () => {
    const result = evaluateSchemaMigrationStructure({
      typesTs: `
        // User.name will become firstName + lastName.
        export interface User { id: string; name: string; email: string; }
        export interface CreateUserInput { name: string; email: string; }
      `,
      storeTs: `
        // Migrate name to firstName and lastName.
        const user = { name: input.name };
        users.sort((a, b) => a.name.localeCompare(b.name));
      `,
      handlersTs: `
        // These handlers will use firstName and lastName.
        export const display = (user: User) => user.name;
      `,
    });

    expect(result).toEqual({
      typesUpdated: false,
      storeUpdated: false,
      handlersUpdated: false,
    });
  });

  it('requires both named contracts to have required string fields and no name member', () => {
    const result = evaluateSchemaMigrationStructure({
      typesTs: `
        export type User = {
          id: string;
          firstName: string;
          lastName: string;
          email: string;
        };
        export interface CreateUserInput {
          firstName?: string;
          lastName: string;
          name: string;
          email: string;
        }
      `,
      storeTs: REFERENCE_STORE,
      handlersTs: REFERENCE_HANDLERS,
    });

    expect(result.typesUpdated).toBe(false);
  });

  it('rejects inherited or referenced legacy members whose absence cannot be proven', () => {
    const inherited = evaluateSchemaMigrationStructure({
      typesTs: `
        interface LegacyUser { name: string; }
        export interface User extends LegacyUser {
          id: string;
          firstName: string;
          lastName: string;
          email: string;
        }
        export interface CreateUserInput {
          firstName: string;
          lastName: string;
          email: string;
        }
      `,
      storeTs: REFERENCE_STORE,
      handlersTs: REFERENCE_HANDLERS,
    });
    expect(inherited.typesUpdated).toBe(false);

    const intersected = evaluateSchemaMigrationStructure({
      typesTs: `
        type LegacyInput = { name: string };
        export type User = {
          id: string;
          firstName: string;
          lastName: string;
          email: string;
        };
        export type CreateUserInput = LegacyInput & {
          firstName: string;
          lastName: string;
          email: string;
        };
      `,
      storeTs: REFERENCE_STORE,
      handlersTs: REFERENCE_HANDLERS,
    });
    expect(intersected.typesUpdated).toBe(false);
  });

  it('tolerates legacy wording in comments and strings around migrated live code', () => {
    const result = evaluateSchemaMigrationStructure({
      typesTs: `
        // Historical contract: User.name. Keep this note for migration readers.
        ${REFERENCE_TYPES}
      `,
      storeTs: `
        const historicalNote = 'input.name and user.name were removed';
        // Do not restore a.name or b.name here.
        ${REFERENCE_STORE}
      `,
      handlersTs: `
        const historicalNote = 'user.name';
        /* The old handler returned user.name. */
        ${REFERENCE_HANDLERS}
      `,
    });

    expect(result).toEqual({ typesUpdated: true, storeUpdated: true, handlersUpdated: true });
  });

  it('rejects near-miss consumers with comments-only new fields or less obvious stale access', () => {
    const commentsOnly = evaluateSchemaMigrationStructure({
      typesTs: REFERENCE_TYPES,
      storeTs: `
        // firstName and lastName are implemented elsewhere.
        const note = 'firstName lastName';
      `,
      handlersTs: `
        // firstName + lastName
        export const display = (user: User) => user['name'];
      `,
    });
    expect(commentsOnly.storeUpdated).toBe(false);
    expect(commentsOnly.handlersUpdated).toBe(false);

    const staleSort = evaluateSchemaMigrationStructure({
      typesTs: REFERENCE_TYPES,
      storeTs: REFERENCE_STORE.replace(
        'a.lastName.localeCompare(b.lastName)',
        'a.lastName.localeCompare(b.lastName) || a.name.localeCompare(b.name)',
      ),
      handlersTs: REFERENCE_HANDLERS,
    });
    expect(staleSort.storeUpdated).toBe(false);
  });

  it('rejects deleted public APIs even when a dummy object mentions both migrated fields', () => {
    const result = evaluateSchemaMigrationStructure({
      typesTs: REFERENCE_TYPES,
      storeTs: `
        const dummy = { firstName: 'Ada', lastName: 'Lovelace' };
        export class ReplacementStore {
          read() { return dummy.firstName + dummy.lastName; }
        }
      `,
      handlersTs: `
        const dummy = { firstName: 'Ada', lastName: 'Lovelace' };
        export function replacementHandler() {
          return dummy.firstName + dummy.lastName;
        }
      `,
    });

    expect(result.storeUpdated).toBe(false);
    expect(result.handlersUpdated).toBe(false);
  });

  it('rejects stubbed public APIs when migrated fields only appear in unrelated dummy code', () => {
    const result = evaluateSchemaMigrationStructure({
      typesTs: REFERENCE_TYPES,
      storeTs: `
        const dummy = { firstName: 'Ada', lastName: 'Lovelace' };
        export class UserStore {
          add(input: CreateUserInput) { return input; }
          get(_id: string) { return undefined; }
          list() { return []; }
        }
        export const unrelated = () => dummy.firstName + dummy.lastName;
      `,
      handlersTs: `
        const dummy = { firstName: 'Ada', lastName: 'Lovelace' };
        export function formatDisplayName(_user: User) { return 'user'; }
        export function renderUserCardHtml(_user: User) { return '<div></div>'; }
        export function summarizeUsersForLog(_users: User[]) { return ''; }
        export const unrelated = () => dummy.firstName + dummy.lastName;
      `,
    });

    expect(result.storeUpdated).toBe(false);
    expect(result.handlersUpdated).toBe(false);
  });

  it('rejects a literal id label when the summary drops each actual user id', () => {
    const result = evaluateSchemaMigrationStructure({
      typesTs: REFERENCE_TYPES,
      storeTs: REFERENCE_STORE,
      handlersTs: `
        export function formatDisplayName(user: User): string {
          return \`${'${user.firstName} ${user.lastName}'}\`;
        }

        export function renderUserCardHtml(user: User): string {
          return \`<h3>${'${user.firstName} ${user.lastName}'}</h3><p>${'${user.email}'}</p>\`;
        }

        export function summarizeUsersForLog(users: User[]): string {
          return users.map((user) => \`id: ${'${user.firstName} ${user.lastName}'}\`).join('; ');
        }
      `,
    });

    expect(result.handlersUpdated).toBe(false);
  });

  it('rejects migrated fields that are read but do not contribute to handler output', () => {
    const result = evaluateSchemaMigrationStructure({
      typesTs: REFERENCE_TYPES,
      storeTs: REFERENCE_STORE,
      handlersTs: `
        export function formatDisplayName(user: User): string {
          void user.firstName;
          void user.lastName;
          return 'anonymous';
        }

        export function renderUserCardHtml(user: User): string {
          const ignored = user.firstName + user.lastName;
          void ignored;
          return \`<p>${'${user.email}'}</p>\`;
        }

        export function summarizeUsersForLog(users: User[]): string {
          return users.map((user) => {
            void user.id;
            return \`${'${user.firstName} ${user.lastName}'}\`;
          }).join(', ');
        }
      `,
    });

    expect(result.handlersUpdated).toBe(false);
  });

  it('accepts a summary that delegates full-name formatting but preserves each user id', () => {
    const result = evaluateSchemaMigrationStructure({
      typesTs: REFERENCE_TYPES,
      storeTs: REFERENCE_STORE,
      handlersTs: `
        export function formatDisplayName(person: User): string {
          return \`${'${person.firstName} ${person.lastName}'}\`;
        }

        export function renderUserCardHtml(person: User): string {
          return \`<h3>${'${person.firstName} ${person.lastName}'}</h3><p>${'${person.email}'}</p>\`;
        }

        export function summarizeUsersForLog(allUsers: User[]): string {
          return allUsers.map((person) => \`${'${person.id}'}: ${'${formatDisplayName(person)}'}\`).join(', ');
        }
      `,
    });

    expect(result.handlersUpdated).toBe(true);
  });

  it('rejects handler rewrites that change signatures or add unrelated store dependencies', () => {
    const changedSignature = evaluateSchemaMigrationStructure({
      typesTs: REFERENCE_TYPES,
      storeTs: REFERENCE_STORE,
      handlersTs: REFERENCE_HANDLERS.replace(
        'renderUserCardHtml(user: User): string',
        'renderUserCardHtml(user: User, compact = false): string',
      ),
    });
    expect(changedSignature.handlersUpdated).toBe(false);

    const unrelatedDependencies = evaluateSchemaMigrationStructure({
      typesTs: REFERENCE_TYPES,
      storeTs: REFERENCE_STORE,
      handlersTs: `
        import type { CreateUserInput, User } from './types.ts';
        import { UserStore } from './store.ts';
        const store = new UserStore();
        ${REFERENCE_HANDLERS}
      `,
    });
    expect(unrelatedDependencies.handlersUpdated).toBe(false);
  });

  it('isolates forbidden imports when every handler signature and body already passes', () => {
    const diagnostics = evaluateSchemaMigrationHandlers(`
      import type { CreateUserInput, User } from './types.ts';
      import { UserStore } from './store.ts';
      ${REFERENCE_HANDLERS}
    `);

    expect(diagnostics).toEqual({
      updated: false,
      bodiesPass: true,
      unmet: ['allowed-imports'],
      forbiddenImports: ['CreateUserInput', 'UserStore'],
    });
  });

  it('reports the exact semantic subcontracts missing from a near-miss summary', () => {
    const diagnostics = evaluateSchemaMigrationHandlers(`
      export function formatDisplayName(user: User): string {
        return \`${'${user.firstName} ${user.lastName}'}\`;
      }
      export function renderUserCardHtml(user: User): string {
        return \`<h3>${'${user.firstName} ${user.lastName}'}</h3><p>${'${user.email}'}</p>\`;
      }
      export function summarizeUsersForLog(users: User[]): string {
        return users.map((user) => \`id: ${'${user.firstName} ${user.lastName}'}\`).join(', ');
      }
    `);

    expect(diagnostics.updated).toBe(false);
    expect(diagnostics.bodiesPass).toBe(false);
    expect(diagnostics.unmet).toEqual(['summary-actual-user-id']);
    expect(diagnostics.forbiddenImports).toEqual([]);
  });
});

describe('schema migration harness-owned migrateUser gate', () => {
  it('passes the reference full-record migration', async () => {
    await expect(runMigrationFunctionFixture(REFERENCE_MIGRATE)).resolves.toEqual({
      ok: true,
      stage: 'pass',
      exitCode: 0,
      timedOut: false,
    });
  });

  it('rejects the exact captured field-dropping artifact even though its authored suite typechecks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-schema-captured-field-drop-'));
    try {
      await Promise.all([
        mkdir(join(dir, 'src'), { recursive: true }),
        mkdir(join(dir, 'tests'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(dir, 'src/types.ts'), REFERENCE_TYPES, 'utf8'),
        writeFile(join(dir, 'src/migrate.ts'), CAPTURED_FIELD_DROPPING_MIGRATE, 'utf8'),
        writeFile(join(dir, 'tests/migrate.test.ts'), CAPTURED_FIELD_DROPPING_TESTS, 'utf8'),
      ]);

      await expect(runSchemaMigrationTestTypecheckInDir(dir)).resolves.toEqual({
        ok: true,
        exitCode: 0,
        timedOut: false,
      });
      const authoredDiagnostics = evaluateSchemaMigrationTests(CAPTURED_FIELD_DROPPING_TESTS);
      expect(authoredDiagnostics.updated).toBe(false);
      expect(authoredDiagnostics.invalidMigrateUserCallCount).toBe(3);
      expect(authoredDiagnostics.unmet).toContain('legacy-record-arguments');
      const hidden = await runSchemaMigrationFunctionGateInDir(dir);
      expect(hidden).toMatchObject({ ok: false, stage: 'runtime', timedOut: false });
      expect(hidden?.firstError).toContain('did not preserve id');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a type-compatible migration that substitutes a non-name field', async () => {
    const result = await runMigrationFunctionFixture(`
      import type { User } from './types.ts';
      interface LegacyUser { id: string; name: string; email: string; }
      export function migrateUser(oldUser: LegacyUser): User {
        const [firstName = '', ...rest] = oldUser.name.trim().split(/\\s+/);
        return {
          id: 'hard-coded-id',
          firstName,
          lastName: rest.join(' '),
          email: oldUser.email,
        };
      }
    `);

    expect(result).toMatchObject({ ok: false, stage: 'runtime', timedOut: false });
    expect(result?.firstError).toContain('did not preserve id');
    expect(result?.firstError).toContain('hard-coded-id');
  });

  it('checks email preservation independently after id is correct', async () => {
    const result = await runMigrationFunctionFixture(`
      import type { User } from './types.ts';
      interface LegacyUser { id: string; name: string; email: string; }
      export function migrateUser(oldUser: LegacyUser): User {
        const [firstName = '', ...rest] = oldUser.name.trim().split(/\\s+/);
        return {
          id: oldUser.id,
          firstName,
          lastName: rest.join(' '),
          email: 'replacement@example.test',
        };
      }
    `);

    expect(result).toMatchObject({ ok: false, stage: 'runtime', timedOut: false });
    expect(result?.firstError).toContain('did not preserve email');
    expect(result?.firstError).toContain('replacement@example.test');
  });

  it('rejects spreading the legacy name back into an otherwise preserved User', async () => {
    const result = await runMigrationFunctionFixture(`
      import type { User } from './types.ts';
      interface LegacyUser { id: string; name: string; email: string; }
      export function migrateUser(oldUser: LegacyUser): User {
        const [firstName = '', ...rest] = oldUser.name.trim().split(/\\s+/);
        return { ...oldUser, firstName, lastName: rest.join(' ') };
      }
    `);

    expect(result).toMatchObject({ ok: false, stage: 'runtime', timedOut: false });
    expect(result?.firstError).toContain('still has the legacy name field');
  });
});

describe('schema migration generated-test gate', () => {
  it('accepts the reference suite with three distinct legacy-record calls', () => {
    expect(evaluateSchemaMigrationTests(REFERENCE_MIGRATION_TESTS)).toEqual({
      updated: true,
      testCaseCount: 3,
      validTestCaseCount: 3,
      validLegacyRecordCallCount: 3,
      invalidMigrateUserCallCount: 0,
      coverage: {
        normalFullName: true,
        oneWordName: true,
        multiWordName: true,
      },
      unmet: [],
    });
  });

  it('rejects the captured three-test false positive because every call uses a bare string', () => {
    const diagnostics = evaluateSchemaMigrationTests(CAPTURED_BARE_STRING_TESTS);

    expect(diagnostics.updated).toBe(false);
    expect(diagnostics.testCaseCount).toBe(3);
    expect(diagnostics.validTestCaseCount).toBe(0);
    expect(diagnostics.validLegacyRecordCallCount).toBe(0);
    expect(diagnostics.invalidMigrateUserCallCount).toBe(3);
    expect(diagnostics.coverage).toEqual({
      normalFullName: false,
      oneWordName: false,
      multiWordName: false,
    });
    expect(diagnostics.unmet).toEqual([
      'legacy-record-arguments',
      'normal-full-name-case',
      'one-word-name-case',
      'multi-word-name-case',
    ]);
  });

  it('does not accept three unrelated green tests without production calls', () => {
    const diagnostics = evaluateSchemaMigrationTests(`
      import { describe, expect, it } from 'vitest';
      import { migrateUser } from '../src/migrate.ts';
      void migrateUser;
      describe('placeholder', () => {
        it('one', () => expect(1).toBe(1));
        it('two', () => expect(2).toBe(2));
        it('three', () => expect(3).toBe(3));
      });
    `);

    expect(diagnostics.testCaseCount).toBe(3);
    expect(diagnostics.validTestCaseCount).toBe(0);
    expect(diagnostics.validLegacyRecordCallCount).toBe(0);
    expect(diagnostics.unmet).toContain('legacy-record-arguments');
    expect(diagnostics.updated).toBe(false);
  });

  it('requires the three input shapes to exercise migrateUser in distinct test cases', () => {
    const diagnostics = evaluateSchemaMigrationTests(`
      import { expect, it } from 'vitest';
      import { migrateUser } from '../src/migrate.ts';
      it('does every migration in one case', () => {
        expect(migrateUser({ id: '1', name: 'John Doe', email: 'john@example.test' })).toBeTruthy();
        expect(migrateUser({ id: '2', name: 'Cher', email: 'cher@example.test' })).toBeTruthy();
        expect(migrateUser({ id: '3', name: 'Mary Anne Smith', email: 'mary@example.test' })).toBeTruthy();
      });
      it('placeholder two', () => expect(true).toBe(true));
      it('placeholder three', () => expect(true).toBe(true));
    `);

    expect(diagnostics.testCaseCount).toBe(3);
    expect(diagnostics.validTestCaseCount).toBe(1);
    expect(diagnostics.validLegacyRecordCallCount).toBe(3);
    expect(diagnostics.unmet).toEqual(['legacy-record-arguments']);
    expect(diagnostics.updated).toBe(false);
  });

  it('strict-typechecks the reference and rejects the frozen bare-string calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-schema-test-gate-'));
    try {
      await Promise.all([
        mkdir(join(dir, 'src'), { recursive: true }),
        mkdir(join(dir, 'tests'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(dir, 'src/types.ts'), REFERENCE_TYPES, 'utf8'),
        writeFile(join(dir, 'src/migrate.ts'), REFERENCE_MIGRATE, 'utf8'),
        writeFile(join(dir, 'tests/migrate.test.ts'), REFERENCE_MIGRATION_TESTS, 'utf8'),
      ]);

      const reference = await runSchemaMigrationTestTypecheckInDir(dir);
      expect(reference).toEqual({ ok: true, exitCode: 0, timedOut: false });

      await writeFile(join(dir, 'tests/migrate.test.ts'), CAPTURED_BARE_STRING_TESTS, 'utf8');
      const captured = await runSchemaMigrationTestTypecheckInDir(dir);
      expect(captured).toMatchObject({ ok: false, exitCode: 2, timedOut: false });
      expect(captured?.firstError).toContain('error TS2345');
      expect(captured?.firstError).toContain("Argument of type 'string'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('schemaMigrationFeedbackFor', () => {
  it('requests only a localized import deletion when handler bodies already pass', () => {
    const diagnostics = evaluateSchemaMigrationHandlers(`
      import type { CreateUserInput, User } from './types.ts';
      import { UserStore } from './store.ts';
      ${REFERENCE_HANDLERS}
    `);
    const feedback = schemaMigrationFeedbackFor(
      ['types-updated', 'store-updated', 'migrate-function'],
      'handlers.ts unmet subcontracts: allowed-imports',
      diagnostics,
    );

    expect(feedback.filePath).toBe('src/handlers.ts');
    expect(feedback.failReason).toContain('SCHEMA_HANDLER_IMPORT_REPAIR');
    expect(feedback.failReason).toContain(
      'all three exported handler signatures and bodies already pass',
    );
    expect(feedback.failReason).toContain('Delete exactly these forbidden unused imports');
    expect(feedback.failReason).toContain('`CreateUserInput`, `UserStore`');
    expect(feedback.failReason).toContain('Preserve the `User` import');
    expect(feedback.failReason).toContain('remove only that import specifier');
    expect(feedback.failReason).toContain('replaceInFile or replaceLines');
    expect(feedback.failReason).toContain('Do not use writeFile');
    expect(feedback.failReason).not.toContain('Repair every live name call site');
  });

  it('targets handlers.ts once store.ts is already passing', () => {
    const feedback = schemaMigrationFeedbackFor(
      ['types-updated', 'store-updated', 'migrate-function', 'tests-present', 'migration-doc'],
      'handlers.ts still references .name or is missing firstName/lastName',
    );

    expect(feedback.filePath).toBe('src/handlers.ts');
    expect(feedback.failReason).toContain('src/store.ts is already passing');
    expect(feedback.failReason).toContain('Preserve the seeded public API');
    expect(feedback.failReason).toContain('formatDisplayName(user: User): string');
    expect(feedback.failReason).toContain('summarizeUsersForLog(users: User[]): string');
    expect(feedback.failReason).toContain('Do not change those signatures');
    expect(feedback.failReason).not.toContain('Rewrite src/handlers.ts completely with writeFile');
    expect(feedback.failReason).toContain('renderUserCardHtml');
    expect(feedback.failReason).toContain('summarizeUsersForLog');
    expect(feedback.failReason).toContain('actual `user.id`');
    expect(feedback.failReason).toContain('still includes `user.email`');
    expect(feedback.failReason).toContain('one-occurrence replacement is insufficient');
  });

  it('routes to store.ts first when store.ts and handlers.ts are both missing', () => {
    const feedback = schemaMigrationFeedbackFor(
      ['types-updated'],
      'store.ts still references .name or is missing firstName/lastName',
    );

    expect(feedback.filePath).toBe('src/store.ts');
    expect(feedback.failReason).toContain('SCHEMA_STORE_REPAIR');
    expect(feedback.failReason).toContain('Preserve the seeded public API');
    expect(feedback.failReason).toContain('exported UserStore class');
    expect(feedback.failReason).toContain('add(input: CreateUserInput): User');
    expect(feedback.failReason).toContain('get(id: string): User | undefined');
    expect(feedback.failReason).toContain('list(): User[]');
    expect(feedback.failReason).toContain('Do not rename or replace the class');
    expect(feedback.failReason).toContain('firstName: input.firstName');
    expect(feedback.failReason).not.toContain('Rewrite src/store.ts with writeFile');
    expect(feedback.failReason).toContain('src/handlers.ts also remains');
  });

  it('routes a contract failure to types.ts before its consumers', () => {
    const feedback = schemaMigrationFeedbackFor(
      [],
      'types.ts still references .name or is missing firstName/lastName',
    );

    expect(feedback.filePath).toBe('src/types.ts');
    expect(feedback.failReason).toContain('SCHEMA_TYPES_REPAIR');
    expect(feedback.failReason).toContain('CreateUserInput');
    expect(feedback.failReason).toContain('neither contract may retain a name property');
  });

  it('targets the compiler-named file once only tsc-clean is failing', () => {
    const feedback = schemaMigrationFeedbackFor(
      [
        'types-updated',
        'store-updated',
        'handlers-updated',
        'migrate-function',
        'tests-present',
        'migration-doc',
      ],
      "tsc-clean failed: src/store.ts(25,61): error TS2339: Property 'name' does not exist on type 'User'.",
    );

    expect(feedback.filePath).toBe('src/store.ts');
    expect(feedback.failReason).toContain('SCHEMA_TSC_REPAIR');
    expect(feedback.failReason).toContain('CreateUserInput has firstName, lastName, email');
    expect(feedback.failReason).toContain('No live code should read or write User.name');
    expect(feedback.failReason).toContain('legacy input with required id, name, and email');
    expect(feedback.failReason).toContain('preserves old.id/old.email');
    expect(feedback.failReason).toContain('Do not add `name` back to src/types.ts');
    expect(feedback.failReason).toContain('rewrite that whole file once');
  });

  it('targets MIGRATION.md when the remaining structural gap is the migration guide', () => {
    const feedback = schemaMigrationFeedbackFor(
      ['types-updated', 'store-updated', 'handlers-updated', 'migrate-function', 'tests-present'],
      'MIGRATION.md not present yet',
    );

    expect(feedback.filePath).toBe('MIGRATION.md');
    expect(feedback.failReason).toContain('SCHEMA_MIGRATION_DOC');
    expect(feedback.failReason).toContain('at least 1 KB');
    expect(feedback.failReason).toContain('firstName/lastName');
    expect(feedback.failReason).toContain('Do not keep editing src/store.ts');
  });

  it('uses real workspace paths for migration utility and test repairs', () => {
    const sourceSignals = ['types-updated', 'store-updated', 'handlers-updated'];
    const migrate = schemaMigrationFeedbackFor(sourceSignals, 'migrate.ts missing');
    expect(migrate.filePath).toBe('src/migrate.ts');

    const tests = schemaMigrationFeedbackFor(
      [...sourceSignals, 'migrate-function'],
      "tests/migrate.test.ts strict generated-test typecheck failed: error TS2345: Argument of type 'string' is not assignable to parameter of type '{ name: string; }'",
    );
    expect(tests.filePath).toBe('tests/migrate.test.ts');
    expect(tests.failReason).toContain('SCHEMA_TESTS_REPAIR');
    expect(tests.failReason).toContain('legacy record objects');
    expect(tests.failReason).toContain('`migrateUser({ id, name: value, email })`');
    expect(tests.failReason).toContain('a bare string or name-only object is invalid');
    expect(tests.failReason).toContain('Assert preserved id/email');
    expect(tests.failReason).toContain('strictly typechecks this exact test file');
    expect(tests.failReason).toContain('TS2345');
  });
});

describe('schemaMigrationScenario repair target', () => {
  it('records the directory-qualified file selected by its multi-file checker', async () => {
    const files = new Map<string, string>([
      ['src/types.ts', REFERENCE_TYPES],
      [
        'src/store.ts',
        `
          export class UserStore {
            add(input: CreateUserInput): User {
              return { id: '1', name: input.firstName, email: input.email };
            }
            get(_id: string): User | undefined { return undefined; }
            list(users: User[]): User[] { return users.sort((a, b) => a.name.localeCompare(b.name)); }
          }
        `,
      ],
      ['src/handlers.ts', REFERENCE_HANDLERS],
    ]);
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'project-1', name: 'User Store' }],
      }),
      fetchProjectWorkspaceBlob: vi.fn(async (_projectId: string, filePath: string) => {
        const content = files.get(filePath);
        if (content === undefined) throw new Error(`missing ${filePath}`);
        return new Blob([content]);
      }),
      listChatSessions: vi.fn().mockResolvedValue({ sessions: [] }),
      listGezels: vi.fn().mockResolvedValue({ gezels: [] }),
    };
    const recordSniff = vi.fn();

    const result = await schemaMigrationScenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff,
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(recordSniff).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'schema-migration',
        repairFilePath: 'src/store.ts',
      }),
    );
  });

  it('advances feedback escalation after the selected repair file changes but the gate does not', async () => {
    const files = new Map<string, string>([
      ['src/types.ts', REFERENCE_TYPES],
      [
        'src/store.ts',
        `
          export class UserStore {
            add(input: CreateUserInput): User {
              return { id: '1', firstName: input.firstName, email: input.email };
            }
            get(_id: string): User | undefined { return undefined; }
            list(): User[] { return []; }
          }
        `,
      ],
      ['src/handlers.ts', REFERENCE_HANDLERS],
    ]);
    const messageGezel = vi.fn().mockResolvedValue({ accepted: true });
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'project-1', name: 'User Store' }],
      }),
      fetchProjectWorkspaceBlob: vi.fn(async (_projectId: string, filePath: string) => {
        const content = files.get(filePath);
        if (content === undefined) throw new Error(`missing ${filePath}`);
        return new Blob([content]);
      }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-1',
            gezelId: 'developer-1',
            projectId: 'project-1',
            lastActivityAt: '2026-07-10T16:00:00.000Z',
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({
        gezels: [{ id: 'developer-1', role: 'Developer' }],
      }),
      listInflightTurns: vi.fn().mockResolvedValue({ inflight: [] }),
      messageGezel,
    };
    const ctx = {
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext;

    await schemaMigrationScenario.successCheck(ctx);

    files.set(
      'src/store.ts',
      `
        export class UserStore {
          add(input: CreateUserInput): User {
            return { id: '1', firstName: input.firstName, lastName: '', email: input.email };
          }
          get(_id: string): User | undefined { return undefined; }
          list(): User[] { return []; }
        }
      `,
    );
    await schemaMigrationScenario.successCheck(ctx);

    expect(messageGezel).toHaveBeenCalledTimes(2);
    expect(messageGezel.mock.calls[0]![1].expectedDeliverable).toEqual({
      kind: 'file',
      filePath: 'src/store.ts',
    });
    expect(messageGezel.mock.calls[1]![1].text).toContain('REPEAT MISS — attempt 2');
    expect(messageGezel.mock.calls[1]![1].text).toContain('Preserve the seeded public API');
  });
});
