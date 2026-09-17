import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing, with Node's own scrypt — no native dependency.
 *
 * A stored hash carries everything needed to check it again:
 *
 *   scrypt$v1$16384$8$1$<salt>$<derived key>
 *   \____/ \_/ \___/ | |  \__/  \__________/
 *   algo   ver   N   r p  salt   derived key      (both base64url)
 *
 * The algorithm, the version and the three cost parameters are part of the
 * value, so raising the cost later is a new version written by
 * hashPassword() while verifyPassword() keeps reading every older one. The
 * key length is not stored separately — it is the length of the decoded
 * derived key.
 *
 * Nothing here logs, throws or returns the password it was given.
 */

const scryptAsync = promisify(scrypt);

const ALGORITHM = 'scrypt';
const VERSION = 'v1';

/** v1: 128 * N * r = 16 MiB per hash, ~50-100 ms on a small container. */
const V1 = { N: 16384, r: 8, p: 1, keyLength: 32, saltBytes: 16 };

/**
 * What each version is allowed to be. A stored hash names its version and
 * repeats its parameters, and both have to agree with this table before the
 * value is used.
 *
 * That check is the point, not bookkeeping. scrypt's last step is a single
 * PBKDF2 pass, so a shorter key is a prefix of a longer one: left to trust
 * the stored length, a hash truncated to one byte would verify against any
 * password 1 time in 256. Lowering N in the stored value would likewise
 * make a guess cheap. Neither is possible when the version decides.
 */
const VERSIONS = { [VERSION]: V1 };

/**
 * The most memory any stored hash may ask us to allocate. Well above v1, so
 * a later version can raise N without touching this; a stored value that
 * asks for more than this is rejected rather than allowed to exhaust the
 * process.
 */
const MAX_MEMORY = 64 * 1024 * 1024;

/**
 * Short enough that nobody is locked out of the first bootstrap, long enough
 * that "admin123" is refused. There is no composition rule on purpose: length
 * is the part that matters, and rules only push people towards "P@ssw0rd!".
 */
export const MIN_PASSWORD_LENGTH = 12;

const b64 = (buffer) => buffer.toString('base64url');

// NFKC so the same typed password matches whichever way the keyboard
// composed its accents — on the way in and on the way back.
const bytes = (password) => Buffer.from(String(password).normalize('NFKC'), 'utf8');

const derive = (password, salt, { N, r, p, keyLength }) =>
  scryptAsync(bytes(password), salt, keyLength, { N, r, p, maxmem: MAX_MEMORY });

/**
 * Why this password cannot be used, or null when it can.
 * The password itself never appears in the message.
 */
export function passwordProblem(password) {
  if (typeof password !== 'string') return 'it must be text';
  if (password.trim() === '') return 'it is blank';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `it is shorter than ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

/** @returns the encoded hash. Throws for a password that may not be used. */
export async function hashPassword(password) {
  const problem = passwordProblem(password);
  if (problem) throw new Error(`That password cannot be used: ${problem}.`);

  const salt = randomBytes(V1.saltBytes);
  const derived = await derive(password, salt, V1);
  return [ALGORITHM, VERSION, V1.N, V1.r, V1.p, b64(salt), b64(derived)].join('$');
}

/**
 * Read an encoded hash back into its parts, or null for anything we cannot
 * check: a different algorithm, a version we do not know, parameters that
 * disagree with that version, an empty salt, or a key of the wrong length.
 */
function parseHash(encoded) {
  if (typeof encoded !== 'string') return null;

  const parts = encoded.split('$');
  if (parts.length !== 7) return null;
  const [algorithm, version, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  if (algorithm !== ALGORITHM) return null;

  const spec = Object.hasOwn(VERSIONS, version) ? VERSIONS[version] : null;
  if (!spec) return null;

  // The stored cost is only believed when it is the cost that version uses.
  if (Number(rawN) !== spec.N || Number(rawR) !== spec.r || Number(rawP) !== spec.p) return null;
  if (128 * spec.N * spec.r > MAX_MEMORY) return null;

  const salt = Buffer.from(rawSalt, 'base64url');
  const hash = Buffer.from(rawHash, 'base64url');
  if (salt.length === 0) return null;
  // Not "long enough": exactly this version's length, so a truncated key
  // cannot be re-derived at its own shorter length and match.
  if (hash.length !== spec.keyLength) return null;

  return { ...spec, salt, hash };
}

/**
 * Does this password produce that stored hash?
 *
 * False for every kind of no — wrong password, malformed value, unknown
 * version — so a caller cannot tell a corrupt row from a wrong guess.
 * The comparison is timing-safe over the derived keys.
 */
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password === '') return false;

  const stored = parseHash(encoded);
  if (!stored) return false;

  let derived;
  try {
    derived = await derive(password, stored.salt, stored);
  } catch {
    return false;
  }

  if (derived.length !== stored.hash.length) return false;
  return timingSafeEqual(derived, stored.hash);
}

/**
 * A real hash of a value nobody knows, made once and kept. Checking a
 * password against it costs exactly what checking a real one costs, which
 * is the point: see verifyPasswordOrDummy.
 */
let dummy = null;
export function dummyPasswordHash() {
  dummy ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummy;
}

/**
 * For the sign-in path: check a password against a stored hash, and when
 * there is no stored hash — no such email, or an account that cannot sign
 * in — spend the same work against the dummy before answering false.
 *
 * Without this, "no such user" would come back sooner than "wrong
 * password", and the difference is enough to enumerate who has an account.
 *
 * Not used yet: sign-in still checks AUTH_USERNAME / AUTH_PASSWORD. It is
 * here so the cutover has nothing left to invent.
 */
export async function verifyPasswordOrDummy(password, encoded) {
  if (typeof encoded === 'string' && encoded !== '') {
    return verifyPassword(password, encoded);
  }
  await verifyPassword(password, await dummyPasswordHash());
  return false;
}
