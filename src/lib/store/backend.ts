// What a storage backend has to provide — and the whole of it. Everything else
// the store does (path naming, compare-and-swap retries, the payout state
// machine) is written once against this interface, so nothing above here knows
// whether it's talking to Vercel Blob or the local filesystem.
//
// Money code needs exactly two guarantees, and both live here:
//
//   createIfAbsent   an atomic create that fails if the path is taken. Recording
//           "this payment signature is spent" has to be something two concurrent
//           requests cannot both succeed at.
//   writeJson with ifMatch   compare-and-swap, so a balance can't be clobbered
//           by a concurrent writer.

export interface StoredJson<T> {
  value: T;
  etag: string;
}

/** Thrown by writeJson when the stored etag no longer matches — someone else wrote first. */
export class PreconditionFailed extends Error {
  constructor(pathname: string, options?: { cause?: unknown }) {
    super(`${pathname} changed since it was read`, options);
    this.name = 'PreconditionFailed';
  }
}

export interface StoreBackend {
  /** Read a JSON document, or null if it doesn't exist. Never served stale. */
  readJson<T>(pathname: string): Promise<StoredJson<T> | null>;

  /**
   * Write a JSON document. With `ifMatch`, the write only lands if the stored
   * etag still matches, and throws PreconditionFailed otherwise.
   */
  writeJson(pathname: string, value: unknown, ifMatch?: string): Promise<void>;

  /**
   * Create a document only if `pathname` is free. Returns false when it was
   * already taken — losing that race is an expected outcome, not an error, so
   * real failures (network, permissions) still throw.
   */
  createIfAbsent(pathname: string, value: unknown): Promise<boolean>;

  /**
   * A page of documents under a prefix, in ascending key order.
   *
   * Ordering is by key, so a caller that wants time order puts a sortable value
   * at the front of the key rather than sorting after the fact — which is what
   * keeps this cheap at any size: it reads only the page, never the whole
   * prefix. `cursor` resumes where the last page stopped; the returned `cursor`
   * is absent once the prefix is exhausted.
   *
   * Contents still cost a read per document — neither backend returns them in a
   * listing. That is inherent to asking for a collection, not a fix waiting to
   * happen: the alternative is an index document, a second thing to keep in
   * step, which is exactly what this store is shaped to avoid.
   */
  list<T>(
    prefix: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<{ items: T[]; cursor?: string }>;
}
