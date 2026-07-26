// Create this app's own token.
//
//   npm run mint-token -- --to <your-wallet>
//
// A token you mint yourself, hand out for free, and accept as payment: promo
// credit, or funds for testing the money loop without spending real money. It
// is worth nothing outside your app — that is the point. Bankroll shows it as
// your app's funds, and a charge settles in it only because your manifest
// declares it.
//
// Everything here is done with the treasury key `npm run bankroll` generated,
// so the treasury ends up holding both the mint authority and the supply — it
// needs the supply to pay anyone back. Fund it with a little SOL first: the
// mint account and each token account pay one-time rent, and the treasury pays
// its own transaction fees (unlike a Bankroll-sponsored wallet).
//
// The SPL instructions are encoded here rather than pulled from
// @solana/spl-token, which carries an unfixable advisory; the three used are
// small and stable.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

// A mint account is a fixed 82 bytes.
const MINT_ACCOUNT_BYTES = 82;

// The only shape charges settle in: 9 decimals, one token to the dollar. The
// host refuses any other scale before it signs, so this is not a preference.
const DECIMALS = 9;
const BASE_UNITS_PER_TOKEN = 10n ** BigInt(DECIMALS);

// Enough for the mint account's rent, a couple of token accounts, and fees,
// with room to spare. Rent is refundable; fees are pennies.
const MIN_TREASURY_SOL = 0.01;
// Topping up an existing token creates nothing but, at most, one token account
// for a first-time recipient — so it needs a fraction of the above.
const MIN_TREASURY_SOL_TOP_UP = 0.003;
const LAMPORTS_PER_SOL = 1_000_000_000;

// Instruction discriminators (SPL Token / Associated Token program).
const IX_MINT_TO = 7;
const IX_TRANSFER_CHECKED = 12;
const IX_INITIALIZE_MINT_2 = 20;
const IX_ATA_CREATE_IDEMPOTENT = 1;

const DEFAULT_SUPPLY = 1_000_000;
const DEFAULT_SEND = 1_000;

const u64 = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};

// InitializeMint2 — like InitializeMint but without the rent sysvar account.
// No freeze authority: freezing your own users' balances is a footgun, and a
// token nobody can freeze is easier to reason about.
const initializeMint2 = (mint, decimals, mintAuthority) =>
  new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data: Buffer.concat([
      Buffer.from([IX_INITIALIZE_MINT_2, decimals]),
      mintAuthority.toBuffer(),
      Buffer.from([0]),
    ]),
  });

const associatedTokenAddress = (mint, owner) =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];

// Idempotent: succeeds whether or not the account already exists, so re-running
// this script never fails on an account it made last time.
const createAtaIdempotent = (payer, ata, owner, mint) =>
  new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([IX_ATA_CREATE_IDEMPOTENT]),
  });

const mintTo = (mint, destination, authority, amount) =>
  new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX_MINT_TO]), u64(amount)]),
  });

// transferChecked rather than transfer: the mint and decimals are verified
// on-chain, so a wrong scale fails the transfer instead of moving the wrong
// amount.
const transferChecked = (source, mint, destination, owner, amount, decimals) =>
  new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX_TRANSFER_CHECKED]), u64(amount), Buffer.from([decimals])]),
  });

// .env.local is what `npm run bankroll` wrote; read it directly rather than
// depending on a loader.
function readEnvLocal(root) {
  const path = join(root, '.env.local');
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...readEnvLocal(root), ...process.env };

const secretKey = env.BANKROLL_TREASURY_KEY;
if (!secretKey) {
  console.error('\n  No treasury yet — run `npm run bankroll` once first.\n');
  process.exit(1);
}
const rpcUrl = env.SOLANA_RPC_URL;
if (!rpcUrl) {
  console.error('\n  SOLANA_RPC_URL is not set (it is written to .env.local by `npm run bankroll`).\n');
  process.exit(1);
}

const treasury = Keypair.fromSecretKey(bs58.decode(secretKey));
const connection = new Connection(rpcUrl, 'confirmed');

const supply = BigInt(arg('supply') ?? DEFAULT_SUPPLY);
const send = BigInt(arg('send') ?? DEFAULT_SEND);
const to = arg('to');

// Minting more of a token you already made, rather than making another one.
// The treasury kept the mint authority, so this needs nothing but the treasury
// key — and it mints fresh rather than moving the treasury's own supply, which
// it needs to keep in order to pay anyone back.
const existingMint = arg('mint') ?? env.BANKROLL_APP_TOKEN_MINT;

if (!existingMint && to && send > supply) {
  console.error(`\n  --send ${send} is more than the --supply ${supply}.\n`);
  process.exit(1);
}

const requiredSol = existingMint ? MIN_TREASURY_SOL_TOP_UP : MIN_TREASURY_SOL;
const balance = await connection.getBalance(treasury.publicKey);
if (balance < requiredSol * LAMPORTS_PER_SOL) {
  console.error(`
  The treasury needs about ${requiredSol} SOL for this and to pay fees.

    treasury  ${treasury.publicKey.toBase58()}
    balance   ${balance / LAMPORTS_PER_SOL} SOL

  Send it some SOL and run this again. Most of it is refundable account rent.
`);
  process.exit(1);
}

// Topping up an existing token: mint straight to whoever needs more. Nothing
// is created, so this is one instruction plus the recipient's account.
if (existingMint) {
  const mintKey = new PublicKey(existingMint);
  const info = await connection.getParsedAccountInfo(mintKey);
  const parsed = info.value?.data?.parsed?.info;
  if (!parsed) {
    console.error(`\n  ${existingMint} is not an SPL token mint.\n`);
    process.exit(1);
  }
  if (parsed.mintAuthority !== treasury.publicKey.toBase58()) {
    console.error(`
  This treasury cannot mint ${existingMint} — the mint authority is someone else.

    treasury        ${treasury.publicKey.toBase58()}
    mint authority  ${parsed.mintAuthority ?? 'none (supply is frozen forever)'}
`);
    process.exit(1);
  }

  const owner = new PublicKey(to ?? treasury.publicKey.toBase58());
  const ata = associatedTokenAddress(mintKey, owner);
  const amount = BigInt(arg('send') ?? arg('supply') ?? DEFAULT_SEND);

  const topUp = new Transaction({
    feePayer: treasury.publicKey,
    ...(await connection.getLatestBlockhash()),
  });
  topUp.add(
    createAtaIdempotent(treasury.publicKey, ata, owner, mintKey),
    mintTo(mintKey, ata, treasury.publicKey, amount * BASE_UNITS_PER_TOKEN),
  );
  topUp.sign(treasury);
  const topUpSignature = await connection.sendRawTransaction(topUp.serialize());
  await connection.confirmTransaction(
    {
      blockhash: topUp.recentBlockhash,
      lastValidBlockHeight: topUp.lastValidBlockHeight,
      signature: topUpSignature,
    },
    'confirmed',
  );

  const updated = await connection.getTokenAccountBalance(ata);
  console.log(`
  Minted ${amount} more.

    mint       ${existingMint}
    to         ${owner.toBase58()}
    balance    ${updated.value.uiAmountString} tokens
    signature  ${topUpSignature}
`);
  process.exit(0);
}

// One transaction: create and initialize the mint, open the treasury's token
// account, and mint the supply into it. Either the token exists complete or
// nothing happened.
const mint = Keypair.generate();
const treasuryAta = associatedTokenAddress(mint.publicKey, treasury.publicKey);
const instructions = [
  SystemProgram.createAccount({
    fromPubkey: treasury.publicKey,
    newAccountPubkey: mint.publicKey,
    lamports: await connection.getMinimumBalanceForRentExemption(MINT_ACCOUNT_BYTES),
    space: MINT_ACCOUNT_BYTES,
    programId: TOKEN_PROGRAM_ID,
  }),
  initializeMint2(mint.publicKey, DECIMALS, treasury.publicKey),
  createAtaIdempotent(treasury.publicKey, treasuryAta, treasury.publicKey, mint.publicKey),
  mintTo(mint.publicKey, treasuryAta, treasury.publicKey, supply * BASE_UNITS_PER_TOKEN),
];

// Spending money needs some in the wallet doing the spending, so seed it here
// rather than leaving a second manual step.
if (to) {
  const recipient = new PublicKey(to);
  const recipientAta = associatedTokenAddress(mint.publicKey, recipient);
  instructions.push(
    createAtaIdempotent(treasury.publicKey, recipientAta, recipient, mint.publicKey),
    transferChecked(
      treasuryAta,
      mint.publicKey,
      recipientAta,
      treasury.publicKey,
      send * BASE_UNITS_PER_TOKEN,
      DECIMALS,
    ),
  );
}

const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
const transaction = new Transaction({
  feePayer: treasury.publicKey,
  blockhash,
  lastValidBlockHeight,
});
transaction.add(...instructions);
transaction.sign(treasury, mint);

const signature = await connection.sendRawTransaction(transaction.serialize());
await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, 'confirmed');

console.log(`
  Minted ${supply} tokens.

    mint       ${mint.publicKey.toBase58()}
    treasury   ${supply - (to ? send : 0n)} tokens${to ? `\n    ${to}   ${send} tokens` : ''}
    signature  ${signature}

  Add this to .env.local, then restart \`npm run bankroll\`:

    BANKROLL_APP_TOKEN_MINT=${mint.publicKey.toBase58()}

  Your manifest will declare it, which is what lets a charge settle in it and
  what makes Bankroll show it as your app's own funds.
`);
