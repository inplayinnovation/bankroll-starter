// Status, not instructions: what this deployment has and what it's missing.
// How to fix any of it is in AGENTS.md, where the developer's agent will read
// it — repeating it here would just be a second copy to keep correct.
import { appName, appNameConfigured } from '@/lib/app-identity';
import { getOrigin } from '@/lib/origin';
import { usingPublicRpc } from '@/lib/rpc';
import { storeDirectory, usingFilesystemStore } from '@/lib/store';
import { treasuryAddress } from '@/lib/treasury';

export const dynamic = 'force-dynamic';

export default async function Setup() {
  const origin = await getOrigin();
  const treasury = treasuryAddress();
  // Local files are a working store, not a missing one — the app takes and pays
  // money on either backend, so neither should read as unfinished setup.
  const onFilesystem = usingFilesystemStore();
  const storage = onFilesystem || Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const live = Boolean(treasury) && storage;

  const rows = [
    {
      label: 'Storage',
      done: storage,
      value: onFilesystem ? `local files (${storeDirectory}/)` : storage ? 'Vercel Blob' : 'no Blob store',
    },
    { label: 'Treasury', done: Boolean(treasury), value: treasury ?? 'not set' },
    {
      label: 'App name',
      done: appNameConfigured(),
      value: appNameConfigured() ? appName() : 'default',
    },
    {
      label: 'RPC',
      done: !usingPublicRpc(),
      value: usingPublicRpc() ? 'public endpoint' : 'configured',
    },
  ];

  return (
    <div className="flex flex-col gap-8 py-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {live ? 'Ready to take money' : 'Not set up yet'}
        </h1>
        <p className="text-sm text-neutral-400">
          {live ? (
            <>Open it on a phone signed into Bankroll.</>
          ) : (
            <>
              Ask your coding agent to set this up — it&apos;ll find what it needs in{' '}
              <code>AGENTS.md</code>.
            </>
          )}
        </p>
      </header>

      <dl className="flex flex-col gap-px overflow-hidden rounded-xl border border-neutral-800 bg-neutral-800">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline gap-3 bg-neutral-950 px-4 py-3">
            <dt className="w-24 shrink-0 text-sm text-neutral-400">{row.label}</dt>
            <dd
              className={`min-w-0 flex-1 font-mono text-[13px] break-all ${
                row.done ? 'text-neutral-200' : 'text-neutral-600'
              }`}
            >
              {row.value}
            </dd>
            <span className={row.done ? 'text-emerald-400' : 'text-neutral-700'}>
              {row.done ? '✓' : '○'}
            </span>
          </div>
        ))}
      </dl>

      {live && (
        <a
          className="break-all font-mono text-[13px] text-neutral-400 underline hover:text-neutral-200"
          href={`https://joinbankroll.com/play?url=${encodeURIComponent(origin)}`}
        >
          joinbankroll.com/play?url={origin}
        </a>
      )}
    </div>
  );
}
