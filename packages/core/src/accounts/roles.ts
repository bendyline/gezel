/**
 * The one home for what an account's role allows. Every account is an
 * `admin` today; `member` (no terminals, Settings, Integrations or account
 * management) is the next role, and per-project ACLs (ADR 0004) attach to
 * the account id rather than to a role.
 */

/** Roles this build can sign in with. Anything else on disk came from a newer build. */
export const ACCOUNT_ROLES = ['admin'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** The role a new account gets. */
export const DEFAULT_ACCOUNT_ROLE: AccountRole = 'admin';

/**
 * A role this build does not know cannot sign in. Treating it as `admin`
 * would let a downgrade widen what a newer build had narrowed.
 */
export function isKnownAccountRole(role: string): role is AccountRole {
  return (ACCOUNT_ROLES as readonly string[]).includes(role);
}

/** Whether an account may add, change, sign out or remove accounts. */
export function accountCanManageAccounts(role: string): boolean {
  return role === 'admin';
}
