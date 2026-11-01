import type { Auth } from './auth';

export interface NewUser {
  name: string;
  email: string;
  password: string;
}

/**
 * Creates a user with an email-and-password account. Public sign-up is off, so this is how seeds,
 * invites (A-06) and tests create people. Uses better-auth's own hashing and records.
 */
export async function createUserWithPassword(auth: Auth, input: NewUser): Promise<{ id: string }> {
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(input.password);
  const user = await ctx.internalAdapter.createUser(
    { name: input.name, email: input.email.toLowerCase(), emailVerified: true },
    { method: 'admin' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: hash,
  });
  return { id: user.id };
}
