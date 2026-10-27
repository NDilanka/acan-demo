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

/** Verified when the username is unknown, so a miss costs the same scrypt work as a hit. */
const DUMMY_HASH = `scrypt$${'00'.repeat(SALT_BYTES)}$${'00'.repeat(KEY_LENGTH)}`;

export interface PublicUser {
  id: string;
  username: string;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Format: scrypt$<salt hex>$<key hex>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await derive(password, Buffer.from(saltHex, 'hex'));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new HttpError(400, `${key} is required`);
  return value;
}

export async function signup(store: Store, input: Record<string, unknown>): Promise<PublicUser> {
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
    passwordHash: await hashPassword(password),
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
): Promise<{ token: string; user: PublicUser }> {
  const username = readString(input, 'username').trim().toLowerCase();
  const password = readString(input, 'password');
  const user = store.findUserByName(username);
  const matches = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
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
