/**
 * Payment building using a2a-bsv wallet.createPayment().
 *
 * This replaces the old buildDirectPayment() which used plain P2PKH scripts
 * and manual UTXO management. The new implementation:
 * - Uses proper BRC-29 locking scripts via wallet.createPayment()
 * - Relies on wallet's createAction() for UTXO management
 * - Uses noSend: true (recipient broadcasts via acceptPayment())
 */
import type { PaymentResult } from './types.js';
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
export declare function buildDirectPayment(recipientPubKey: string, sats: number, desc?: string): Promise<PaymentResult>;
