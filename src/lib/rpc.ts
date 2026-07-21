// Solana's public endpoint — enough to develop against and to run a quiet app,
// but rate-limited and not meant for production traffic. Setting your own
// SOLANA_RPC_URL is the upgrade, not a requirement to get started.
export const PUBLIC_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

// Recorded before the default is applied below, so /setup can still tell you
// whether you're on your own endpoint or ours.
const configured = Boolean(process.env.SOLANA_RPC_URL);

export const usingPublicRpc = (): boolean => !configured;

/** The endpoint actually in use, public default included. */
export const rpcUrl = (): string => process.env.SOLANA_RPC_URL ?? PUBLIC_MAINNET_RPC;

/**
 * The SDK reads SOLANA_RPC_URL from the environment, so default it here rather
 * than making every deployment set one. Imported for its side effect by
 * everything that talks to the chain.
 */
process.env.SOLANA_RPC_URL ||= PUBLIC_MAINNET_RPC;
