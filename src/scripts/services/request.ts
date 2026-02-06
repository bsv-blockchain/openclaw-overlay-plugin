/**
 * Service request command.
 */

import { OVERLAY_URL } from '../config.js';
import { ok, fail } from '../output.js';
import { loadIdentity, signRelayMessage } from '../wallet/identity.js';
import { buildDirectPayment, buildMneePayment } from '../payment/build.js';

/**
 * Derive a BSV address from a compressed public key.
 */
async function pubkeyToAddress(pubkeyHex: string): Promise<string> {
  const { PublicKey } = await import('@bsv/sdk');
  const pub = PublicKey.fromString(pubkeyHex);
  return pub.toAddress().toString();
}

/**
 * Request service command: send a service request with optional payment.
 *
 * @param paymentType - 'bsv' (default) or 'mnee'
 * @param amountUsdStr - USD amount for MNEE payments (ignored for BSV)
 */
export async function cmdRequestService(
  targetKey: string | undefined,
  serviceId: string | undefined,
  satsStr?: string,
  inputJsonStr?: string,
  paymentType?: string,
  amountUsdStr?: string
): Promise<never> {
  if (!targetKey || !serviceId) {
    return fail('Usage: request-service <identityKey> <serviceId> [sats] [inputJson] [paymentType] [amountUsd]');
  }

  if (!/^0[23][0-9a-fA-F]{64}$/.test(targetKey)) {
    return fail('Target must be a compressed public key (66 hex chars, 02/03 prefix)');
  }

  const { identityKey, privKey } = await loadIdentity();
  const sats = parseInt(satsStr || '5', 10);
  const currency = paymentType === 'mnee' ? 'mnee' : 'bsv';

  // Parse optional input JSON
  let inputData: unknown = null;
  if (inputJsonStr) {
    try {
      inputData = JSON.parse(inputJsonStr);
    } catch {
      return fail('inputJson must be valid JSON');
    }
  }

  // Build the service request payload
  let paymentData: any = null;

  if (currency === 'mnee') {
    const amountUsd = parseFloat(amountUsdStr || '0');
    if (amountUsd <= 0) {
      return fail('amountUsd must be greater than 0 for MNEE payments');
    }
    try {
      const recipientAddress = await pubkeyToAddress(targetKey);
      const mneeResult = await buildMneePayment(recipientAddress, amountUsd, `service-request: ${serviceId}`);
      paymentData = {
        paymentType: 'mnee',
        txid: mneeResult.txid,
        ticketId: mneeResult.ticketId,
        amountUsd: mneeResult.amountUsd,
        amountAtomic: mneeResult.amountAtomic,
        senderAddress: mneeResult.senderAddress,
        senderIdentityKey: mneeResult.senderIdentityKey,
      };
    } catch (err: any) {
      paymentData = { paymentType: 'mnee', error: String(err.message || err) };
    }
  } else if (sats > 0) {
    try {
      const payment = await buildDirectPayment(targetKey, sats, `service-request: ${serviceId}`);
      paymentData = {
        beef: payment.beef,
        txid: payment.txid,
        satoshis: payment.satoshis,
        derivationPrefix: payment.derivationPrefix,
        derivationSuffix: payment.derivationSuffix,
        senderIdentityKey: payment.senderIdentityKey,
      };
    } catch (err: any) {
      // Payment failed — send request without payment
      paymentData = { error: String(err.message || err) };
    }
  }

  const requestPayload = {
    serviceId,
    ...(inputData ? { input: inputData } : {}),
    payment: paymentData,
    requestedAt: new Date().toISOString(),
  };

  const signature = await signRelayMessage(privKey, targetKey, 'service-request', requestPayload);

  const resp = await fetch(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: identityKey,
      to: targetKey,
      type: 'service-request',
      payload: requestPayload,
      signature,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    return fail(`Relay send failed (${resp.status}): ${body}`);
  }

  const result = await resp.json();

  return ok({
    sent: true,
    requestId: result.id,
    to: targetKey,
    serviceId,
    paymentType: currency,
    paymentIncluded: paymentData && !paymentData.error,
    paymentTxid: paymentData?.txid || null,
    satoshis: currency === 'bsv' ? (paymentData?.satoshis || 0) : 0,
    amountUsd: currency === 'mnee' ? (paymentData?.amountUsd || 0) : undefined,
    note: 'Poll for service-response to get the result',
  });
}
