/**
 * @a2a-bsv/core — Agent-to-agent BSV payment library.
 *
 * Wraps @bsv/sdk and @bsv/wallet-toolbox to provide a clean, minimal API
 * for AI agents to pay each other using BSV blockchain transactions.
 *
 * @example
 * ```ts
 * import { BSVAgentWallet } from '@a2a-bsv/core';
 *
 * const wallet = await BSVAgentWallet.create({
 *   network: 'testnet',
 *   storageDir: './my-agent-wallet',
 * });
 *
 * const identityKey = await wallet.getIdentityKey();
 * console.log('My identity:', identityKey);
 * ```
 */

// Main wallet class
export { BSVAgentWallet } from './wallet.js';

// All types
export type {
  WalletConfig,
  WalletIdentity,
  PaymentParams,
  PaymentResult,
  VerifyParams,
  VerifyResult,
  AcceptParams,
  AcceptResult,
} from './types.js';

// Config helpers (for advanced use)
export { toChain, DEFAULT_TAAL_API_KEYS, DEFAULT_DB_NAME } from './config.js';
export type { Chain } from './config.js';

// Lower-level helpers (for advanced use)
export { buildPayment } from './payment.js';
export { verifyPayment, acceptPayment } from './verify.js';
