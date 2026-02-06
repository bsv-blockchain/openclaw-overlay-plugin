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
import type { PaymentResult } from './types.js';
import type { MneePaymentResult } from '../../core/types.js';
import { loadWalletIdentity } from '../wallet/identity.js';

import { BSVAgentWallet } from '../../core/index.js';

async function getBSVAgentWallet(): Promise<typeof BSVAgentWallet> {
  return BSVAgentWallet;
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

/**
 * Build an MNEE stablecoin payment.
 *
 * MNEE broadcasts immediately on the sender side via the cosigner.
 * No BEEF/derivation data is needed — the recipient receives tokens automatically.
 *
 * @param recipientAddress - Recipient's BSV address
 * @param amountUsd - Amount to send in USD
 * @param desc - Optional description
 * @returns MneePaymentResult with txid and amount info
 */
export async function buildMneePayment(
  recipientAddress: string,
  amountUsd: number,
  desc?: string
): Promise<MneePaymentResult> {
  const { deriveWifAndAddress, sendMnee } = await import('../../core/mnee.js');
  const identity = loadWalletIdentity();
  const { wif } = await deriveWifAndAddress(identity.rootKeyHex);

  return await sendMnee({
    recipientAddress,
    amountUsd,
    senderWif: wif,
    description: desc,
  });
}
