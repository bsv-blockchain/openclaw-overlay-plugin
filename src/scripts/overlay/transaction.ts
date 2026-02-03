/**
 * Overlay transaction building utilities.
 * 
 * Follows the clawdbot-overlay server API:
 * - Submit: POST /submit with binary BEEF and X-Topics header
 * - OP_RETURN format: OP_FALSE OP_RETURN <"clawdbot-overlay-v1"> <JSON>
 */

import { NETWORK, OVERLAY_URL, PROTOCOL_ID, WALLET_DIR } from '../config.js';
import type { OverlayPayload } from '../types.js';
import { Utils, PushDrop, Transaction } from '@bsv/sdk';
import { BSVAgentWallet } from '../../core/wallet.js';

/**
 * Build an PushDrop locking script with JSON payload using SDK's Script class.
 * 
 * @param payload - The data to embed in the OP_RETURN
 * @returns A proper Script object that the SDK can serialize
 */
export async function buildPushDropScript(wallet: BSVAgentWallet, payload: OverlayPayload): Promise<string> {
  const jsonBytes = Utils.toArray(JSON.stringify(payload), 'utf8')
  const fields: number[][] = [jsonBytes]
  const token = new PushDrop(wallet._setup.wallet);
  const script = await token.lock(fields, [0, PROTOCOL_ID], '1', 'self', true, true)
  return script.toHex();
}

/**
 * Build and submit an overlay transaction.
 * @param payload - JSON data to store in OP_RETURN
 * @param topic - Topic manager for submission
 * @returns Transaction result with txid and funding info
 */
export async function buildRealOverlayTransaction(
  payload: OverlayPayload,
  topic: string
): Promise<{ txid: string; funded: string; explorer: string }> {
  
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR })
  const lockingScript = await buildPushDropScript(wallet, payload)

  const response = await wallet._setup.wallet.createAction({
    description: 'topic manager submission',
    outputs: [
      {
        lockingScript,
        satoshis: 1,
        outputDescription: 'overlay',
        basket: topic, // basket is the topic manager
      }
    ],
    options: {
      acceptDelayedBroadcast: false,
    }
  })

  // --- Submit to overlay ---
  // Use binary BEEF with X-Topics header (matches clawdbot-overlay server API)
  const submitResp = await fetch(`${OVERLAY_URL}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Topics': JSON.stringify([topic]),
    },
    body: new Uint8Array(response.tx as number[]),
  });

  if (!submitResp.ok) {
    const errText = await submitResp.text();
    throw new Error(`Overlay submission failed: ${submitResp.status} — ${errText}`);
  }

  const wocNet = NETWORK === 'mainnet' ? '' : 'test.';
  return {
    txid: response.txid as string,
    funded: 'stored-beef',
    explorer: `https://${wocNet}whatsonchain.com/tx/${response.txid as string}`,
  };
}

/**
 * Lookup data from an overlay lookup service.
 */
export async function lookupOverlay(
  service: string,
  query: Record<string, unknown>
): Promise<any> {
  const resp = await fetch(`${OVERLAY_URL}/lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, query }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Lookup failed: ${resp.status} — ${errText}`);
  }

  return resp.json();
}

/**
 * Parse an overlay output from BEEF data.
 * 
 * Handles both formats:
 * - OP_FALSE OP_RETURN <protocol> <json> (standard)
 * - OP_RETURN <protocol> <json> (legacy)
 */
export async function parseOverlayOutput(
  beefData: string | Uint8Array | number[],
  outputIndex: number
): Promise<{ data: OverlayPayload | null; txid: string | null }> {
  try {
    const tx = Transaction.fromBEEF(beefData as number[]);
    const txid = tx.id('hex')
    const output = tx.outputs[outputIndex];
    if (!output) return { data: null, txid: null };

    const { fields } = PushDrop.decode(output.lockingScript);
    return { data: JSON.parse(Utils.toUTF8(fields[0])), txid };
  } catch {
    return { data: null, txid: null };
  }
}
