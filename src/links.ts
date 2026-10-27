import { randomInt } from 'node:crypto';
import { HttpError } from './errors.ts';
import type { Link, Store } from './store.ts';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 7;
const CODE_ATTEMPTS = 5;
const MAX_TARGET_LENGTH = 2048;

export interface LinkView {
  code: string;
  target: string;
  clicks: number;
  createdAt: string;
}

/** The fields a client may see. The owner id stays server side. */
export function toLinkView(link: Link): LinkView {
  return {
    code: link.code,
    target: link.target,
    clicks: link.clicks,
    createdAt: link.createdAt,
  };
}

/** Accepts absolute http and https URLs only, so javascript: and file: links never get stored. */
export function parseTarget(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TARGET_LENGTH) {
    throw new HttpError(400, `url must be a string of 1-${MAX_TARGET_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'url is not a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'only http and https urls are allowed');
  }
  return url.href;
}

function newCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

export function createLink(store: Store, ownerId: string, value: unknown): Link {
  const target = parseTarget(value);
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const link: Link = {
      code: newCode(),
      target,
      ownerId,
      clicks: 0,
      createdAt: new Date().toISOString(),
    };
    if (store.insertLink(link)) return link;
  }
  throw new HttpError(500, 'could not allocate a short code');
}

/** Records one click and returns the link, or undefined for an unknown code. */
export function followLink(store: Store, code: string): Link | undefined {
  return store.incrementClicks(code);
}

/** Only the owner can delete. Anyone else gets the same 404 as an unknown code. */
export function deleteLink(store: Store, ownerId: string, code: string): void {
  const link = store.findLink(code);
  if (!link || link.ownerId !== ownerId) throw new HttpError(404, 'link not found');
  store.deleteLink(code);
}

/** Newest first. */
export function listLinks(store: Store, ownerId: string): Link[] {
  return store.listLinksByOwner(ownerId).reverse();
}
