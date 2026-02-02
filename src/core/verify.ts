/**
 * @a2a-bsv/core — Payment verification and acceptance helpers.
 *
 * Verification: parse the Atomic BEEF, validate structure.
 * Acceptance: internalize the payment into the recipient wallet via BRC-29
 * wallet payment protocol.
 */

import { Beef, Utils } from '@bsv/sdk';
import type { SetupWallet } from '@bsv/wallet-toolbox';
import type { VerifyParams, VerifyResult, AcceptParams, AcceptResult } from './types.js';
import type { InternalizeActionArgs } from '@bsv/sdk';

/**
 * Verify an incoming Atomic BEEF payment.
 *
 * This performs structural validation:
 * - Decodes the base64 BEEF
 * - Checks the BEEF is parseable
 * - Checks there is at least one transaction
 * - Runs SPV verification via tx.verify()
 * - Optionally checks the sender identity key
 */
export async function verifyPayment(params: VerifyParams): Promise<VerifyResult> {
  const errors: string[] = [];
  let txid = '';
  let outputCount = 0;

  try {
    const binary = Utils.toArray(params.beef, 'base64');
    const beef = Beef.fromBinary(binary);

    if (beef.txs.length === 0) {
      errors.push('BEEF contains no transactions');
    } else {
      const lastTx = beef.txs[beef.txs.length - 1];
      txid = lastTx.txid;

      // Parse the atomic transaction to count outputs
      const tx = beef.findAtomicTransaction(txid);
      if (tx) {
        outputCount = tx.outputs.length;
        
        // Run SPV verification
        try {
          await tx.verify();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`SPV verification failed: ${message}`);
        }
      } else {
        errors.push('Could not find atomic transaction in BEEF');
      }
    }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`BEEF parse error: ${message}`);
  }

  // Sender validation is independent of BEEF parsing
  if (params.expectedSender) {
    if (!/^0[23][0-9a-fA-F]{64}$/.test(params.expectedSender)) {
      errors.push('expectedSender is not a valid compressed public key');
    }
  }

  return {
    valid: errors.length === 0,
    txid,
    outputCount,
    errors,
  };
}

/**
 * Accept (internalize) a verified BRC-29 payment into the recipient's wallet.
 *
 * This calls wallet.internalizeAction with the 'wallet payment' protocol,
 * providing the BRC-29 derivation info so the wallet can derive the correct
 * key and claim the output.
 */
export async function acceptPayment(
  setup: SetupWallet,
  params: AcceptParams,
): Promise<AcceptResult> {
  const desc = normalizeDescription(params.description ?? 'received payment');
  const vout = params.vout ?? 0;

  const binary = Utils.toArray(params.beef, 'base64');

  const args: InternalizeActionArgs = {
    tx: binary,
    outputs: [
      {
        outputIndex: vout,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: params.derivationPrefix,
          derivationSuffix: params.derivationSuffix,
          senderIdentityKey: params.senderIdentityKey,
        },
      },
    ],
    description: desc,
  };

  const result = await setup.wallet.internalizeAction(args);

  return {
    accepted: result.accepted,
  };
}

function normalizeDescription(desc: string): string {
  if (desc.length < 5) return desc.padEnd(5, ' ');
  if (desc.length > 50) return desc.slice(0, 50);
  return desc;
}
