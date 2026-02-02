/**
 * Baemail service handler - processes incoming paid messages.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OVERLAY_URL, PATHS, WALLET_DIR } from '../config.js';
import { loadBaemailConfig, BaemailConfig, BaemailLogEntry } from './commands.js';
import { loadIdentity, signRelayMessage } from '../wallet/identity.js';
import { verifyAndAcceptPayment } from '../messaging/handlers.js';
import { fetchWithTimeout } from '../utils/woc.js';
import { ensureStateDir } from '../utils/storage.js';

// Dynamic SDK import
let _sdk: any = null;

async function getSdk(): Promise<any> {
  if (_sdk) return _sdk;
  try {
    _sdk = await import('@bsv/sdk');
    return _sdk;
  } catch {
    throw new Error('Cannot load @bsv/sdk');
  }
}

interface BaemailInput {
  message?: string;
  senderName?: string;
  replyIdentityKey?: string;
}

interface ServiceMessage {
  id: string;
  from: string;
  payload?: {
    input?: BaemailInput;
    payment?: any;
  };
}

interface ProcessResult {
  id: string;
  type: string;
  serviceId: string;
  action: string;
  tier?: string;
  deliverySuccess?: boolean;
  deliveryError?: string | null | undefined;
  paymentAccepted?: boolean;
  paymentTxid?: string;
  satoshisReceived?: number;
  from: string;
  ack: boolean;
  reason?: string | null;
}

/**
 * Process incoming baemail service request.
 */
export async function processBaemail(
  msg: ServiceMessage,
  identityKey: string,
  privKey: any
): Promise<ProcessResult> {
  const input = (msg.payload?.input || msg.payload) as BaemailInput;
  const payment = msg.payload?.payment;

  // Load config
  const config = loadBaemailConfig();
  if (!config) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: 'Baemail service not configured on this agent.',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: 'not configured', from: msg.from, ack: true };
  }

  // Check blocklist
  if (config.blocklist?.includes(msg.from)) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: 'Sender is blocked.',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: 'blocked', from: msg.from, ack: true };
  }

  // Validate message
  const message = input?.message;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: 'Missing or empty message. Send {message: "your message"}',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: 'missing message', from: msg.from, ack: true };
  }

  if (message.length > (config.maxMessageLength || 4000)) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: `Message too long. Max ${config.maxMessageLength || 4000} characters.`,
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: 'message too long', from: msg.from, ack: true };
  }

  // Load wallet identity
  const sdk = await getSdk();
  const { PrivateKey, Hash } = sdk;
  
  let walletIdentity: any;
  try {
    walletIdentity = JSON.parse(fs.readFileSync(PATHS.walletIdentity, 'utf-8'));
  } catch (err) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: 'Service temporarily unavailable (wallet error)',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: 'wallet error', from: msg.from, ack: true };
  }

  // Sender info
  const senderName = input?.senderName || 'Anonymous';
  const replyKey = input?.replyIdentityKey || msg.from;

  // Check hooks configured
  let hookToken: string | null = null;
  let hookPort = 18789;
  const openclawConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  
  if (fs.existsSync(openclawConfigPath)) {
    try {
      const openclawConfig = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf-8'));
      hookToken = openclawConfig?.hooks?.token;
      hookPort = openclawConfig?.gateway?.port || 18789;
    } catch {
      // Ignore parse errors
    }
  }

  if (!hookToken) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: 'OpenClaw hooks not configured. Payment NOT accepted.',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: 'hooks not configured', from: msg.from, ack: true };
  }

  // Verify and accept payment
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  const minPrice = config.tiers.standard;
  
  const payResult = await verifyAndAcceptPayment(payment, minPrice, msg.from, 'baemail', ourHash160);

  if (!payResult.accepted) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: `Payment rejected: ${payResult.error}. Minimum: ${minPrice} sats.`,
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: payResult.error, from: msg.from, ack: true };
  }

  // Determine tier
  const paidSats = payResult.satoshis;
  let tier = 'standard';
  let tierEmoji = '📧';
  if (paidSats >= config.tiers.urgent) {
    tier = 'urgent';
    tierEmoji = '🚨';
  } else if (paidSats >= config.tiers.priority) {
    tier = 'priority';
    tierEmoji = '⚡';
  }

  // Format message
  const formattedMessage = `${tierEmoji} **Baemail** (${tier.toUpperCase()})

**From:** ${senderName}
**Paid:** ${paidSats} sats
**Reply to:** \`${replyKey.slice(0, 16)}...\`

---

${message}

---
_Reply via overlay: \`overlay-cli send ${replyKey} ping "your reply"\`_`;

  // Deliver via hooks
  let deliverySuccess = false;
  let deliveryError: string | null = null;

  try {
    const hookHost = process.env.CLAWDBOT_HOST || process.env.OPENCLAW_HOST || '127.0.0.1';
    const hookUrl = `http://${hookHost}:${hookPort}/hooks/agent`;
    const hookResp = await fetchWithTimeout(hookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${hookToken}`,
        'x-clawdbot-token': hookToken,
      },
      body: JSON.stringify({
        message: formattedMessage,
        name: 'Baemail',
        sessionKey: `baemail:${msg.id}`,
        wakeMode: 'now',
        deliver: true,
        channel: config.deliveryChannel,
      }),
    });

    if (hookResp.ok) {
      deliverySuccess = true;
    } else {
      const body = await hookResp.text().catch(() => '');
      deliveryError = `Hook failed: ${hookResp.status} ${body}`;
    }
  } catch (err) {
    deliveryError = (err as Error).message;
  }

  // Log delivery
  ensureStateDir();
  const logEntry: BaemailLogEntry = {
    requestId: msg.id,
    from: msg.from,
    senderName,
    tier,
    paidSats,
    messageLength: message.length,
    deliveryChannel: config.deliveryChannel,
    deliverySuccess,
    deliveryError: deliveryError ?? null,
    paymentTxid: payResult.txid || '',
    refundStatus: deliverySuccess ? null : 'pending',
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(PATHS.baemailLog, JSON.stringify(logEntry) + '\n');

  // Send response
  const responsePayload = {
    requestId: msg.id,
    serviceId: 'baemail',
    status: deliverySuccess ? 'fulfilled' : 'delivery_failed',
    result: {
      delivered: deliverySuccess,
      tier,
      channel: config.deliveryChannel,
      paidSats,
      error: deliveryError,
      replyTo: identityKey,
      refundable: !deliverySuccess,
      note: deliverySuccess ? undefined : 'Delivery failed. Run: baemail-refund ' + msg.id,
    },
    paymentAccepted: true,
    paymentTxid: payResult.txid,
    satoshisReceived: payResult.satoshis,
  };

  const respSig = signRelayMessage(privKey, msg.from, 'service-response', responsePayload);
  await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: responsePayload, signature: respSig }),
  });

  return {
    id: msg.id,
    type: 'service-request',
    serviceId: 'baemail',
    action: deliverySuccess ? 'fulfilled' : 'delivery_failed',
    tier,
    deliverySuccess,
    deliveryError: deliveryError === null ? undefined : deliveryError,
    paymentAccepted: true,
    paymentTxid: payResult.txid || undefined,
    satoshisReceived: payResult.satoshis,
    from: msg.from,
    ack: true,
  };
}
