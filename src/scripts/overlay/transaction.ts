/**
 * Overlay transaction building utilities.
 * 
 * Follows the clawdbot-overlay server API:
 * - Submit: POST /submit with binary BEEF and X-Topics header
 * - OP_RETURN format: OP_FALSE OP_RETURN <"clawdbot-overlay-v1"> <JSON>
 */

import { NETWORK, OVERLAY_URL, PROTOCOL_ID, WALLET_DIR } from '../config.js';
import type { OverlayPayload } from '../types.js';
import { Utils, PushDrop, TopicBroadcaster } from '@bsv/sdk';
import { BSVAgentWallet } from '../../core/wallet.js';

// Dynamic import for @bsv/sdk
let _sdk: any = null;

async function getSdk(): Promise<any> {
  if (_sdk) return _sdk;

  try {
    _sdk = await import('@bsv/sdk');
    return _sdk;
  } catch {
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const os = await import('node:os');

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(__dirname, '..', '..', '..', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
      path.resolve(__dirname, '..', '..', '..', '..', '..', 'a2a-bsv', 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
      path.resolve(os.homedir(), 'a2a-bsv', 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
    ];

    for (const p of candidates) {
      try {
        _sdk = await import(p);
        return _sdk;
      } catch {
        // Try next
      }
    }
    throw new Error('Cannot find @bsv/sdk. Run setup.sh first.');
  }
}

/**
 * Build an PushDrop locking script with JSON payload using SDK's Script class.
 * 
 * Format: OP_FALSE OP_RETURN <"clawdbot-overlay-v1"> <JSON payload>
 * This matches the clawdbot-overlay server's expected format.
 * 
 * @param payload - The data to embed in the OP_RETURN
 * @param sdk - The @bsv/sdk module
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
): Promise<OverlayPayload | null> {
  const sdk = await getSdk();

  try {
    // Handle different input formats
    let beefArray: number[];
    if (typeof beefData === 'string') {
      beefArray = Array.from(new Uint8Array(sdk.Utils.fromBase64(beefData)));
    } else if (Array.isArray(beefData)) {
      beefArray = beefData;
    } else {
      beefArray = Array.from(beefData);
    }

    // Parse using Beef.fromBinary (handles BRC-95 BEEF format)
    const beef = sdk.Beef.fromBinary(beefArray);

    // Find the transaction with the OP_RETURN output
    for (const beefTx of (beef.txs || [])) {
      const tx = beefTx.tx || beefTx._tx;
      if (!tx || !tx.outputs) continue;

      const output = tx.outputs[outputIndex];
      if (!output) continue;

      // Convert script to Uint8Array (toBinary may return plain Array)
      const scriptRaw = output.lockingScript.toBinary();
      const script = scriptRaw instanceof Uint8Array ? scriptRaw : new Uint8Array(scriptRaw);

      // Check for OP_RETURN patterns:
      // - 0x6a ... (direct OP_RETURN)
      // - 0x00 0x6a ... (OP_FALSE OP_RETURN)
      let offset = 0;
      if (script[0] === 0x6a) {
        offset = 1;
      } else if (script[0] === 0x00 && script[1] === 0x6a) {
        offset = 2;
      } else {
        continue; // Not OP_RETURN
      }

      // Parse PUSHDATA opcodes to extract JSON
      const readPush = (): Uint8Array | null => {
        if (offset >= script.length) return null;
        const op = script[offset++];
        if (op <= 75) {
          const data = script.slice(offset, offset + op);
          offset += op;
          return data;
        } else if (op === 0x4c) {
          const len = script[offset++];
          const data = script.slice(offset, offset + len);
          offset += len;
          return data;
        } else if (op === 0x4d) {
          const len = script[offset] | (script[offset + 1] << 8);
          offset += 2;
          const data = script.slice(offset, offset + len);
          offset += len;
          return data;
        }
        return null;
      };

      // First push: protocol ID
      readPush();

      // Second push: JSON payload
      const payloadBytes = readPush();
      if (!payloadBytes) continue;

      try {
        const json = new TextDecoder().decode(payloadBytes);
        const parsed = JSON.parse(json);
        return parsed;
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}
