/**
 * MNEE stablecoin wrapper module.
 *
 * Centralizes all @mnee/ts-sdk interaction behind a lazy-loaded facade.
 * The SDK is an optional dependency — functions throw a clear error if
 * it is not installed.
 *
 * SDK API (class-based):
 *   const Mnee = (await import('@mnee/ts-sdk')).default;
 *   const mnee = new Mnee({ environment: 'production' });
 *   mnee.balance(address)   → { address, amount, decimalAmount }
 *   mnee.transfer([{address, amount}], wif) → transfer result (amount in USD)
 *   mnee.parseTx(txid)      → parsed tx data
 *   mnee.toAtomicAmount(usd) / mnee.fromAtomicAmount(atomic)
 */

import type { MneePaymentResult, MneeVerifyResult } from './types.js';

// ---------------------------------------------------------------------------
// Lazy-load the MNEE SDK (optional dependency)
// ---------------------------------------------------------------------------

let _mneeInstance: any = null;

async function getMnee(): Promise<any> {
  if (_mneeInstance) return _mneeInstance;
  try {
    const mod = await import('@mnee/ts-sdk');
    const MneeClass = mod.default;
    const env = process.env.BSV_NETWORK === 'testnet' ? 'sandbox' : 'production';
    const apiKey = process.env.MNEE_API_KEY || undefined;
    _mneeInstance = new MneeClass({ environment: env, ...(apiKey && { apiKey }) } as any);
    return _mneeInstance;
  } catch (err: any) {
    if (err.message?.includes('environment') || err.message?.includes('Cannot read')) {
      throw err; // SDK loaded but constructor failed — bubble up
    }
    throw new Error(
      '@mnee/ts-sdk is not installed. Install it with: npm install @mnee/ts-sdk'
    );
  }
}

// Lazy-load @bsv/sdk (always available as a regular dependency)
let _bsvSdk: any = null;

async function getBsvSdk(): Promise<any> {
  if (_bsvSdk) return _bsvSdk;
  _bsvSdk = await import('@bsv/sdk');
  return _bsvSdk;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive a WIF private key and BSV address from the existing root key hex.
 * Reuses the root key material — no separate MNEE wallet needed.
 */
export async function deriveWifAndAddress(rootKeyHex: string): Promise<{
  wif: string;
  address: string;
}> {
  const { PrivateKey } = await getBsvSdk();
  const privKey = PrivateKey.fromHex(rootKeyHex);
  const wif = privKey.toWif();
  const address = privKey.toAddress().toString();
  return { wif, address };
}

/**
 * Check the MNEE token balance at a BSV address.
 */
export async function getMneeBalance(address: string): Promise<{
  balanceUsd: number;
  balanceAtomic: number;
}> {
  const mnee = await getMnee();
  const result = await mnee.balance(address);
  // SDK returns { address, amount (atomic), decimalAmount (USD) }
  const atomic = result?.amount ?? 0;
  const usd = result?.decimalAmount ?? mnee.fromAtomicAmount(atomic);
  return {
    balanceAtomic: atomic,
    balanceUsd: usd,
  };
}

/**
 * Send MNEE tokens to a recipient address. Broadcasts immediately via the
 * MNEE cosigner — no receiver-side broadcast needed.
 */
export async function sendMnee(opts: {
  recipientAddress: string;
  amountUsd: number;
  senderWif: string;
  description?: string;
}): Promise<MneePaymentResult> {
  if (opts.amountUsd <= 0) {
    throw new Error('MNEE amount must be greater than 0');
  }

  const mnee = await getMnee();
  const { PrivateKey } = await getBsvSdk();

  const senderPriv = PrivateKey.fromWif(opts.senderWif);
  const senderAddress = senderPriv.toAddress().toString();
  const senderIdentityKey = senderPriv.toPublicKey().toString();

  // SDK transfer() takes: (recipients[], wif, options?)
  // Amount is in USD (decimal) — the SDK converts to atomic internally
  const result = await mnee.transfer(
    [{ address: opts.recipientAddress, amount: opts.amountUsd }],
    opts.senderWif,
  );

  const amountAtomic = mnee.toAtomicAmount(opts.amountUsd);

  return {
    paymentType: 'mnee',
    txid: result?.txid || result?.tx_id,
    ticketId: result?.ticketId || result?.id,
    amountUsd: opts.amountUsd,
    amountAtomic,
    senderAddress,
    senderIdentityKey,
  };
}

/**
 * Verify an incoming MNEE payment by parsing the transaction.
 * Checks that the tx pays the expected receiver and (optionally) meets
 * a minimum USD amount.
 */
export async function verifyMneePayment(opts: {
  txid: string;
  receiverAddress: string;
  expectedAmountUsd?: number;
}): Promise<MneeVerifyResult> {
  const mnee = await getMnee();
  const errors: string[] = [];

  let parsed: any;
  try {
    parsed = await mnee.parseTx(opts.txid);
  } catch (err: any) {
    return {
      valid: false,
      txid: opts.txid,
      amountUsd: 0,
      amountAtomic: 0,
      errors: [`Failed to parse MNEE tx: ${err.message}`],
    };
  }

  // Extract outputs going to our address
  const outputs: any[] = Array.isArray(parsed?.outputs) ? parsed.outputs : (parsed ? [parsed] : []);
  const toUs = outputs.filter(
    (o: any) => o.address === opts.receiverAddress || o.to === opts.receiverAddress
  );

  if (toUs.length === 0) {
    errors.push(`No MNEE output found for address ${opts.receiverAddress}`);
    return { valid: false, txid: opts.txid, amountUsd: 0, amountAtomic: 0, errors };
  }

  const totalAtomic = toUs.reduce(
    (sum: number, o: any) => sum + (o.amount ?? o.value ?? 0),
    0
  );
  const totalUsd = mnee.fromAtomicAmount(totalAtomic);

  if (opts.expectedAmountUsd !== undefined && totalUsd < opts.expectedAmountUsd) {
    errors.push(
      `Insufficient MNEE: received $${totalUsd.toFixed(2)}, expected $${opts.expectedAmountUsd.toFixed(2)}`
    );
  }

  return {
    valid: errors.length === 0,
    txid: opts.txid,
    amountUsd: totalUsd,
    amountAtomic: totalAtomic,
    errors,
  };
}
