// Where this app's documents live.
//
// The store itself — the backend interface, the compare-and-swap, the id scheme
// — is @joinbankroll/sdk/store; the docs' "The store" page covers it. This file
// only chooses the backend: local files while developing, Vercel Blob when
// deployed.
import type { StoreBackend } from '@joinbankroll/sdk/store';
import { fsBackend, storeDirectory } from '@joinbankroll/sdk/store/fs';
import { vercelBlobBackend } from '@joinbankroll/sdk/store/vercel';

// Set in .env.local when the app is scaffolded, and gitignored — so a
// deployment never sees it and always gets Blob.
const FILESYSTEM_STORE = 'fs';

export const usingFilesystemStore = () => process.env.STORE === FILESYSTEM_STORE;

const backend: StoreBackend = usingFilesystemStore() ? fsBackend() : vercelBlobBackend();

export const storeBackend = (): StoreBackend => backend;

/** Where filesystem-backed data lives, for display. */
export { storeDirectory };
