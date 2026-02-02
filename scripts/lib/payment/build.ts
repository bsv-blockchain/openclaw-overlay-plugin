/**
 * Payment building using a2a-bsv wallet.createPayment().
 *
 * This replaces the old buildDirectPayment() which used plain P2PKH scripts
 * and manual UTXO management. The new implementation:
 * - Uses proper BRC-29 locking scripts via wallet.createPayment()
 * - Relies on wallet's createAction() for UTXO management
 * - Uses noSend: true (recipient broadcasts via acceptPayment())
 */

import { NETWORK, WALLET_DIR } from '../config.js';
import type { PaymentResult, PaymentParams } from './types.js';

// Dynamic import for BSVAgentWallet
let _BSVAgentWallet: any = null;

async function getBSVAgentWallet(): Promise<any> {
  if (_BSVAgentWallet) return _BSVAgentWallet;

  try {
    const core = await import('@a2a-bsv/core');
    _BSVAgentWallet = core.BSVAgentWallet;
    return _BSVAgentWallet;
  } catch {
    // Try alternative paths
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const os = await import('node:os');

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(__dirname, '..', '..', '..', 'node_modules', '@a2a-bsv', 'core', 'dist', 'index.js'),
      path.resolve(__dirname, '..', '..', '..', '..', '..', 'a2a-bsv', 'packages', 'core', 'dist', 'index.js'),
      path.resolve(os.homedir(), 'a2a-bsv', 'packages', 'core', 'dist', 'index.js'),
    ];

    for (const p of candidates) {
      try {
        const core = await import(p);
        _BSVAgentWallet = core.BSVAgentWallet;
        return _BSVAgentWallet;
      } catch {
        // Try next
      }
    }
    throw new Error('Cannot find @a2a-bsv/core. Run setup.sh first.');
  }
}

/**
 * Build a BRC-29 payment using the a2a-bsv wallet.
 *
 * This creates a payment transaction using proper BRC-29 locking scripts.
 * The transaction uses noSend: true, meaning:
 * - The sender does NOT broadcast the transaction
 * - The recipient broadcasts it when they call acceptPayment()
 *
 * @param recipientPubKey - Recipient's compressed public key (66 hex chars, 02/03 prefix)
 * @param sats - Amount to send in satoshis
 * @param desc - Optional description for the payment
 * @returns PaymentResult with BEEF and derivation metadata for the recipient
 */
export async function buildDirectPayment(
  recipientPubKey: string,
  sats: number,
  desc?: string
): Promise<PaymentResult> {
  // Validate recipient pubkey format
  if (!/^0[23][0-9a-fA-F]{64}$/.test(recipientPubKey)) {
    throw new Error('Recipient must be a compressed public key (66 hex chars starting with 02 or 03)');
  }

  const BSVAgentWallet = await getBSVAgentWallet();
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });

  try {
    const result = await wallet.createPayment({
      to: recipientPubKey,
      satoshis: sats,
      description: desc || 'agent payment',
    });

    // Return format compatible with existing code
    return {
      beef: result.beef,
      txid: result.txid,
      satoshis: result.satoshis,
      derivationPrefix: result.derivationPrefix,
      derivationSuffix: result.derivationSuffix,
      senderIdentityKey: result.senderIdentityKey,
    };
  } finally {
    await wallet.destroy();
  }
}
