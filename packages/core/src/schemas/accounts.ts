import { z } from 'zod';

/**
 * Accounts sign people in on network-facing surfaces (the container
 * listener, later first-class remote access). See ADR 0029 and
 * docs/accounts.md. The desktop app and the same-machine CLI never use them.
 */

export const ACCOUNT_NAME_MAX_LENGTH = 64;
export const ACCOUNT_PASSWORD_MIN_LENGTH = 8;
export const ACCOUNT_PASSWORD_MAX_LENGTH = 1024;

/** What a person signs in with, and how others see them. Unique without regard to case. */
export const AccountNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(ACCOUNT_NAME_MAX_LENGTH, `Use at most ${ACCOUNT_NAME_MAX_LENGTH} characters.`)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  .refine(
    (name) => !/[\u0000-\u001f\u007f]/.test(name),
    'Names cannot contain control characters.',
  );

export const AccountPasswordSchema = z
  .string()
  .min(
    ACCOUNT_PASSWORD_MIN_LENGTH,
    `Use at least ${ACCOUNT_PASSWORD_MIN_LENGTH} characters for the password.`,
  )
  .max(ACCOUNT_PASSWORD_MAX_LENGTH);

/**
 * A role as stored. Deliberately an open string: a role a later build adds
 * must survive a downgrade on disk, and this build refuses to sign it in
 * (see `isKnownAccountRole`) rather than guessing what it may do.
 */
export const AccountRoleNameSchema = z.string().min(1).max(32);

/** An account as the API returns it. The password hash never leaves the daemon. */
export const AccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: AccountRoleNameSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  passwordChangedAt: z.string().optional(),
  lastSignInAt: z.string().optional(),
  disabledAt: z.string().optional(),
});
export type Account = z.infer<typeof AccountSchema>;

/** One signed-in browser or client. */
export const AccountSessionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  /** "Firefox on Linux", from the user agent at sign-in. */
  label: z.string().optional(),
  /** The address the session signed in from, as the daemon saw it. */
  address: z.string().optional(),
  /** True on the session making the request. */
  current: z.boolean().optional(),
});
export type AccountSession = z.infer<typeof AccountSessionSchema>;

/**
 * The subject behind a request, per ADR 0004's principal model. `password`
 * comes from an account session; `device` is reserved for paired devices,
 * `os` for an OS-authenticated local broker.
 */
export const AccountPrincipalSchema = z.object({
  id: z.string(),
  source: z.enum(['password', 'device', 'os']),
  label: z.string(),
});
export type AccountPrincipal = z.infer<typeof AccountPrincipalSchema>;

export const CreateAccountRequestSchema = z.object({
  name: AccountNameSchema,
  password: AccountPasswordSchema,
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequestSchema>;

export const UpdateAccountRequestSchema = z
  .object({
    name: AccountNameSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((body) => body.name !== undefined || body.disabled !== undefined, {
    message: 'Nothing to change.',
  });
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequestSchema>;

/**
 * Set a password. `currentPassword` is required when people change their
 * own password from a browser; an administrator resetting someone else's,
 * or the owner's shell, leaves it out.
 */
export const SetAccountPasswordRequestSchema = z.object({
  password: AccountPasswordSchema,
  currentPassword: z.string().max(ACCOUNT_PASSWORD_MAX_LENGTH).optional(),
});
export type SetAccountPasswordRequest = z.infer<typeof SetAccountPasswordRequestSchema>;

export const SignInRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(ACCOUNT_NAME_MAX_LENGTH * 4),
  password: z.string().min(1).max(ACCOUNT_PASSWORD_MAX_LENGTH),
});
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

/** Create the first account with the single-use setup code. */
export const AccountSetupRequestSchema = z.object({
  code: z.string().min(1).max(128),
  name: AccountNameSchema,
  password: AccountPasswordSchema,
});
export type AccountSetupRequest = z.infer<typeof AccountSetupRequestSchema>;

export const SignInResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  account: AccountSchema,
});
export type SignInResponse = z.infer<typeof SignInResponseSchema>;

/** What the sign-in screen needs to know before anyone has signed in. Carries no secrets. */
export const SignInStateSchema = z.object({
  /** True when this listener only accepts signed-in accounts. */
  accountsRequired: z.boolean(),
  /** True while no account exists yet. */
  setupRequired: z.boolean(),
  /** True when a setup code is waiting in the logs; false when setup must happen from the shell. */
  setupCodeAvailable: z.boolean(),
});
export type SignInState = z.infer<typeof SignInStateSchema>;

export const AccountListResponseSchema = z.object({
  accounts: z.array(AccountSchema),
  /** The account making the request; absent for the owner's local credential. */
  me: AccountSchema.optional(),
});
export type AccountListResponse = z.infer<typeof AccountListResponseSchema>;

export const AccountSessionListResponseSchema = z.object({
  sessions: z.array(AccountSessionSchema),
});
export type AccountSessionListResponse = z.infer<typeof AccountSessionListResponseSchema>;
