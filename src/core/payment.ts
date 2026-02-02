/**
 * @a2a-bsv/core — Payment construction helpers.
 *
 * Uses BRC-29 key derivation so the recipient can internalize the payment
 * without ever reusing an address.
 */

import { PrivateKey, PublicKey, Beef, Utils } from '@bsv/sdk';
import { Setup, randomBytesBase64, ScriptTemplateBRC29 } from '@bsv/wallet-toolbox';
import type { SetupWallet } from '@bsv/wallet-toolbox';
import type { PaymentParams, PaymentResult } from './types.js';
import type { CachedKeyDeriver } from '@bsv/sdk';

/**
 * Build a BRC-29 payment transaction using the wallet's createAction API.
 *
 * The transaction is created with `acceptDelayedBroadcast: false` — the sender
 * broadcasts immediately. The resulting Atomic BEEF and derivation metadata are
 * returned so the recipient can verify and internalize the payment on their side.
 */
export async function buildPayment(
  setup: SetupWallet,
  params: PaymentParams,
): Promise<PaymentResult> {
  const { to, satoshis, description } = params;
  const desc = normalizeDescription(description ?? 'agent payment');

  // Generate unique BRC-29 derivation prefixes and suffixes
  const derivationPrefix = randomBytesBase64(8);
  const derivationSuffix = randomBytesBase64(8);

  // Build BRC-29 locking script
  const keyDeriver = setup.keyDeriver as CachedKeyDeriver;
  const t = new ScriptTemplateBRC29({
    derivationPrefix,
    derivationSuffix,
    keyDeriver,
  });

  // Determine the recipient identity key.
  // If `to` is a compressed public key hex (66 chars, starts with 02/03), use directly.
  // Otherwise treat as an address — for BRC-29 we need a public key.
  let recipientPubKey: string;
  if (/^0[23][0-9a-fA-F]{64}$/.test(to)) {
    recipientPubKey = to;
  } else {
    // If it's an address, we can't do BRC-29 (needs pubkey). Throw a clear error.
    throw new Error(
      'PaymentParams.to must be a compressed public key (hex) for BRC-29 payments. ' +
      'Raw BSV addresses are not supported — the recipient must share their identity key.'
    );
  }

  const lockingScript = t.lock(setup.rootKey.toString(), recipientPubKey);

  const label = 'a2a-payment';
  const car = await setup.wallet.createAction({
    outputs: [
      {
        lockingScript: lockingScript.toHex(),
        satoshis,
        outputDescription: desc,
        tags: ['relinquish'],
        customInstructions: JSON.stringify({
          derivationPrefix,
          derivationSuffix,
          type: 'BRC29',
        }),
      },
    ],
    options: {
      randomizeOutputs: false,
      acceptDelayedBroadcast: false,
    },
    labels: [label],
    description: desc,
  });

  // Extract the txid from the createAction result.
  // The tx field is a number[] (AtomicBEEF binary). Parse it to get txid.
  if (!car.tx) {
    throw new Error('createAction did not return a transaction. Check wallet funding.');
  }

  const beef = Beef.fromBinary(car.tx);
  // The last transaction in the beef is our new tx
  const lastTx = beef.txs[beef.txs.length - 1];
  const txid = lastTx.txid;

  // Encode the atomic BEEF as base64
  const atomicBinary = beef.toBinaryAtomic(txid);
  const beefBase64 = Utils.toBase64(atomicBinary);

  return {
    beef: beefBase64,
    txid,
    satoshis,
    derivationPrefix,
    derivationSuffix,
    senderIdentityKey: setup.identityKey,
  };
}

/**
 * Ensure description meets BRC-100's 5-50 character requirement.
 */
function normalizeDescription(desc: string): string {
  if (desc.length < 5) return desc.padEnd(5, ' ');
  if (desc.length > 50) return desc.slice(0, 50);
  return desc;
}
