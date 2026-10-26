#!/usr/bin/env node
/**
 * Print the scrypt hash of a password, for SUPER_ADMIN_PASSWORD.
 *
 *   npm --prefix server run hash-password -- "the new password"
 *
 * Paste the printed scrypt$v1$... line into .env in place of the plain
 * password. The hash is not the password: anyone reading .env learns
 * nothing they could type on the sign-in form.
 */
import { superAdminPasswordProblem } from '../src/auth/superAdmin.js';
import { hashPassword } from '../src/lib/passwords.js';

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm --prefix server run hash-password -- "the new password"');
  process.exit(1);
}
// Checked here, before hashing: a hash of a short password looks exactly
// like a hash of a long one, so the portal cannot refuse it later.
const problem = superAdminPasswordProblem(password);
if (problem) {
  console.error(`That password cannot be used: ${problem}.`);
  process.exit(1);
}
console.log(await hashPassword(password));
