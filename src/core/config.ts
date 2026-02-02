/**
 * @a2a-bsv/core — Configuration defaults and helpers.
 */

import type { WalletConfig } from './types.js';

/** Map our 'mainnet'/'testnet' to the wallet-toolbox's 'main'/'test' chain type. */
export type Chain = 'main' | 'test';

export function toChain(network: WalletConfig['network']): Chain {
  return network === 'mainnet' ? 'main' : 'test';
}

/** Default TAAL API keys from the wallet-toolbox examples. */
export const DEFAULT_TAAL_API_KEYS: Record<Chain, string> = {
  main: 'mainnet_9596de07e92300c6287e4393594ae39c',
  test: 'testnet_0e6cf72133b43ea2d7861da2a38684e3',
};

/** Default SQLite database name. */
export const DEFAULT_DB_NAME = 'a2a_agent_wallet';
