import {
  DocumentNotFound,
  PreconditionFailed,
  type StoreBackend,
  type StoredJson,
  TooContended,
} from '@joinbankroll/sdk/store';

export interface Document {
  revision: number;
}

const ATTEMPTS = 20;

function nextRevision(current: Document): number {
  const revision = current.revision + 1;
  if (!Number.isSafeInteger(revision) || revision <= 0)
    throw new Error('Invalid document revision');
  return revision;
}

/** Conditional document writes only. The engine owns event registration and paths. */
export function createPersistence(store: StoreBackend) {
  async function read<T extends Document>(path: string): Promise<StoredJson<T> | null> {
    const stored = await store.readJson<T>(path);
    if (stored && (!Number.isSafeInteger(stored.value.revision) || stored.value.revision < 0))
      throw new Error('Invalid document revision');
    return stored;
  }

  async function required<T extends Document>(path: string): Promise<StoredJson<T>> {
    const stored = await read<T>(path);
    if (!stored) throw new DocumentNotFound(path);
    return stored;
  }

  /** Creation installs a harmless shell before the engine registers external events. */
  async function create<T extends Document>(path: string, initial: T): Promise<T> {
    if (initial.revision !== 0) throw new Error('A new document must have revision zero');
    await store.createIfAbsent(path, initial);
    return (await required<T>(path)).value;
  }

  async function change<T extends Document>(path: string, update: (current: T) => T): Promise<T> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const stored = await required<T>(path);
      const proposed = update(stored.value);
      if (proposed === stored.value) return stored.value;
      const next = { ...proposed, revision: nextRevision(stored.value) };
      try {
        await store.writeJson(path, next, stored.etag);
        return next;
      } catch (error) {
        if (!(error instanceof PreconditionFailed)) throw error;
      }
    }
    throw new TooContended(path, ATTEMPTS);
  }

  /** A preparation may commit only against its original revision and exact etag. */
  async function conditional<T extends Document>(
    path: string,
    baseRevision: number,
    update: (current: T) => T,
  ): Promise<T | null> {
    const stored = await required<T>(path);
    if (stored.value.revision !== baseRevision) return null;
    const proposed = update(stored.value);
    if (proposed === stored.value) return stored.value;
    const next = { ...proposed, revision: nextRevision(stored.value) };
    try {
      await store.writeJson(path, next, stored.etag);
      return next;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
      return null;
    }
  }

  /**
   * Invalidate an uninstalled preparation with a real write, including on stores
   * that hash document contents for etags. Callers must reread event identity after
   * this returns: its installation may have beaten this fence.
   */
  async function fence(path: string, baseRevision: number): Promise<void> {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0)
      throw new Error('Invalid preparation revision');
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const stored = await required<Document>(path);
      if (stored.value.revision > baseRevision) return;
      if (stored.value.revision < baseRevision)
        throw new Error('Preparation refers to a future document revision');
      try {
        await store.writeJson(
          path,
          { ...stored.value, revision: nextRevision(stored.value) },
          stored.etag,
        );
        return;
      } catch (error) {
        if (!(error instanceof PreconditionFailed)) throw error;
      }
    }
    throw new TooContended(path, ATTEMPTS);
  }

  return { read, required, create, change, conditional, fence };
}
