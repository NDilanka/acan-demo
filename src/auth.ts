import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.ts';
import type { Store, User } from './store.ts';

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

/** scrypt work factors. The defaults are Node's own. Tests pass a cheaper cost to keep the suite fast. */
export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_COST: ScryptCost = { N: 16384, r: 8, p: 1 };

export interface PublicUser {
  id: string;
  username: string;
}

function derive(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const options = { N: cost.N, r: cost.r, p: cost.p, maxmem: SCRYPT_MAX_MEMORY };
    scrypt(password, salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Format: scrypt$<N>$<r>$<p>$<salt hex>$<key hex>. The cost is stored so old hashes keep verifying. */
export async function hashPassword(password: string, cost: ScryptCost): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, cost);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const cost = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  let actual: Buffer;
  try {
    actual = await derive(password, salt, cost);
  } catch {
    return false; // malformed cost parameters in the stored hash
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Verified when the username is unknown, so a miss costs the same scrypt work as a hit. */
function dummyHash(cost: ScryptCost): string {
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${'00'.repeat(SALT_BYTES)}$${'00'.repeat(KEY_LENGTH)}`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new HttpError(400, `${key} is required`);
  return value;
}

export async function signup(
  store: Store,
  input: Record<string, unknown>,
  cost: ScryptCost,
): Promise<PublicUser> {
  const username = readString(input, 'username').trim().toLowerCase();
  const password = readString(input, 'password');
  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(400, 'username must be 3-32 characters: a-z, 0-9, underscore');
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new HttpError(400, `password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`);
  }
  if (store.findUserByName(username)) throw new HttpError(409, 'username is taken');

  const user: User = {
    id: randomUUID(),
    username,
    passwordHash: await hashPassword(password, cost),
    createdAt: new Date().toISOString(),
  };
  // Another signup may have taken the name while we were hashing.
  if (!store.insertUser(user)) throw new HttpError(409, 'username is taken');
  return { id: user.id, username: user.username };
}

/** Returns a new session token for the user. The same 401 covers unknown users and wrong passwords. */
export async function login(
  store: Store,
  input: Record<string, unknown>,
  cost: ScryptCost,
): Promise<{ token: string; user: PublicUser }> {
  const username = readString(input, 'username').trim().toLowerCase();
  const password = readString(input, 'password');
  const user = store.findUserByName(username);
  const matches = await verifyPassword(password, user?.passwordHash ?? dummyHash(cost));
  if (!user || !matches) throw new HttpError(401, 'invalid username or password');

  const token = randomBytes(32).toString('base64url');
  store.insertSession({
    tokenHash: hashToken(token),
    userId: user.id,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return { token, user: { id: user.id, username: user.username } };
}

/** Returns the user id behind a token, or null when the token is missing, unknown or expired. */
export function resolveSession(store: Store, token: string | null): string | null {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = store.findSession(tokenHash);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    store.deleteSession(tokenHash);
    return null;
  }
  return session.userId;
}

export function logout(store: Store, token: string | null): void {
  if (token) store.deleteSession(hashToken(token));
}
