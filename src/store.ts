export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

export interface Session {
  /** SHA-256 of the bearer token. The raw token is never stored. */
  tokenHash: string;
  userId: string;
  expiresAt: number;
}

export interface Link {
  code: string;
  target: string;
  ownerId: string;
  clicks: number;
  createdAt: string;
}

/**
 * In-memory storage. Each app instance gets its own Store, so tests stay isolated.
 * Methods are synchronous on purpose: check-then-insert pairs cannot interleave.
 */
export class Store {
  private readonly usersByName = new Map<string, User>();
  private readonly usersById = new Map<string, User>();
  private readonly sessions = new Map<string, Session>();
  private readonly links = new Map<string, Link>();

  /** Returns false when the username is already taken. */
  insertUser(user: User): boolean {
    if (this.usersByName.has(user.username)) return false;
    this.usersByName.set(user.username, user);
    this.usersById.set(user.id, user);
    return true;
  }

  findUserByName(username: string): User | undefined {
    return this.usersByName.get(username);
  }

  findUserById(id: string): User | undefined {
    return this.usersById.get(id);
  }

  insertSession(session: Session): void {
    this.sessions.set(session.tokenHash, session);
  }

  findSession(tokenHash: string): Session | undefined {
    return this.sessions.get(tokenHash);
  }

  deleteSession(tokenHash: string): void {
    this.sessions.delete(tokenHash);
  }

  /** Returns false when the code is already in use. */
  insertLink(link: Link): boolean {
    if (this.links.has(link.code)) return false;
    this.links.set(link.code, link);
    return true;
  }

  findLink(code: string): Link | undefined {
    return this.links.get(code);
  }

  deleteLink(code: string): void {
    this.links.delete(code);
  }

  /** Oldest first, in creation order. */
  listLinksByOwner(ownerId: string): Link[] {
    return [...this.links.values()].filter((link) => link.ownerId === ownerId);
  }

  incrementClicks(code: string): Link | undefined {
    const link = this.links.get(code);
    if (link) link.clicks += 1;
    return link;
  }
}
