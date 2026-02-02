/**
 * Payment CLI commands: pay, verify, accept.
 */

import { NETWORK, WALLET_DIR } from '../config.js';
import { ok, fail } from '../output.js';
import { buildDirectPayment } from './build.js';

import { BSVAgentWallet } from '../../core/index.js';

async function getBSVAgentWallet(): Promise<typeof BSVAgentWallet> {
  return BSVAgentWallet;
}

/**
 * Pay command: send satoshis to another agent.
 */
export async function cmdPay(
  pubkey: string | undefined,
  satoshis: string | undefined,
  description?: string
): Promise<never> {
  if (!pubkey || !satoshis) {
    return fail('Usage: pay <pubkey> <satoshis> [description]');
  }

  const sats = parseInt(satoshis, 10);
  if (isNaN(sats) || sats <= 0) {
    return fail('satoshis must be a positive integer');
  }

  try {
    const payment = await buildDirectPayment(pubkey, sats, description || 'agent payment');
    return ok(payment);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Verify command: verify an incoming payment BEEF.
 */
export async function cmdVerify(beefBase64: string | undefined): Promise<never> {
  if (!beefBase64) {
    return fail('Usage: verify <beef_base64>');
  }

  const BSVAgentWallet = await getBSVAgentWallet();
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });

  try {
    const result = wallet.verifyPayment({ beef: beefBase64 });
    await wallet.destroy();
    return ok(result);
  } catch (err) {
    await wallet.destroy();
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Accept command: accept and internalize a payment.
 */
export async function cmdAccept(
  beef: string | undefined,
  derivationPrefix: string | undefined,
  derivationSuffix: string | undefined,
  senderIdentityKey: string | undefined,
  description?: string
): Promise<never> {
  if (!beef || !derivationPrefix || !derivationSuffix || !senderIdentityKey) {
    return fail('Usage: accept <beef> <prefix> <suffix> <senderKey> [description]');
  }

  const BSVAgentWallet = await getBSVAgentWallet();
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });

  try {
    const receipt = await wallet.acceptPayment({
      beef,
      derivationPrefix,
      derivationSuffix,
      senderIdentityKey,
      description: description || undefined,
    });
    await wallet.destroy();
    return ok(receipt);
  } catch (err) {
    await wallet.destroy();
    return fail(err instanceof Error ? err.message : String(err));
  }
}
