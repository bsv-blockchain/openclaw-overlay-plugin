/**
 * Server validation logic mirrored from clawdbot-overlay.
 *
 * This module contains the exact same parsing and validation logic
 * used by the server's topic managers, allowing us to validate
 * client output before submission.
 *
 * Updated to use PushDrop tokens instead of plain OP_RETURN.
 */

import { Script, OP, Beef, PushDrop, LockingScript } from '@bsv/sdk';

export const PROTOCOL_ID = 'clawdbot-overlay-v1';

// ============================================================================
// Type Definitions (mirrored from server)
// ============================================================================

export interface ClawdbotIdentityData {
  protocol: string;
  type: 'identity';
  identityKey: string;
  name: string;
  description: string;
  channels: Record<string, string>;
  capabilities: string[];
  timestamp: string;
}

export interface ClawdbotIdentityRevocationData {
  protocol: string;
  type: 'identity-revocation';
  identityKey: string;
  reason?: string;
  timestamp: string;
}

export interface ClawdbotServiceData {
  protocol: string;
  type: 'service';
  identityKey: string;
  serviceId: string;
  name: string;
  description: string;
  pricing: {
    model: string;
    amountSats: number;
  };
  timestamp: string;
}

export type ClawdbotPayload = ClawdbotIdentityData | ClawdbotIdentityRevocationData | ClawdbotServiceData;

export interface AdmittanceResult {
  outputsToAdmit: number[];
  coinsToRetain: number[];
}

export interface STEAKResponse {
  [topic: string]: AdmittanceResult;
}

// ============================================================================
// Script Parsing using PushDrop.decode()
// ============================================================================

/**
 * Extract data fields from a PushDrop script using the SDK's decode method.
 * Returns the fields array or null if not a valid PushDrop script.
 */
export function extractPushDropFields(script: Script | LockingScript): number[][] | null {
  try {
    const decoded = PushDrop.decode(script as LockingScript);
    return decoded.fields;
  } catch {
    return null;
  }
}

/**
 * Legacy function for backwards compatibility - extracts from OP_RETURN scripts.
 * @deprecated Use extractPushDropFields instead
 */
export function extractOpReturnPushes(script: Script): Uint8Array[] | null {
  const chunks = script.chunks;

  // Legacy 4+ chunk format: OP_FALSE OP_RETURN <data> <data> ...
  if (chunks.length >= 4 &&
      chunks[0].op === OP.OP_FALSE &&
      chunks[1].op === OP.OP_RETURN) {
    const pushes: Uint8Array[] = [];
    for (let i = 2; i < chunks.length; i++) {
      if (chunks[i].data) {
        pushes.push(new Uint8Array(chunks[i].data!));
      }
    }
    return pushes;
  }

  // Collapsed 2-chunk format: OP_FALSE OP_RETURN with data blob
  if (chunks.length === 2 &&
      chunks[0].op === OP.OP_FALSE &&
      chunks[1].op === OP.OP_RETURN &&
      chunks[1].data) {
    const blob = chunks[1].data;
    const pushes: Uint8Array[] = [];
    let pos = 0;

    while (pos < blob.length) {
      const op = blob[pos++];

      if (op > 0 && op <= 75) {
        const end = Math.min(pos + op, blob.length);
        pushes.push(new Uint8Array(blob.slice(pos, end)));
        pos = end;
      } else if (op === 0x4c) {
        const len = blob[pos++] ?? 0;
        const end = Math.min(pos + len, blob.length);
        pushes.push(new Uint8Array(blob.slice(pos, end)));
        pos = end;
      } else if (op === 0x4d) {
        const len = (blob[pos] ?? 0) | ((blob[pos + 1] ?? 0) << 8);
        pos += 2;
        const end = Math.min(pos + len, blob.length);
        pushes.push(new Uint8Array(blob.slice(pos, end)));
        pos = end;
      } else if (op === 0x4e) {
        const len = ((blob[pos] ?? 0) |
          ((blob[pos + 1] ?? 0) << 8) |
          ((blob[pos + 2] ?? 0) << 16) |
          ((blob[pos + 3] ?? 0) << 24)) >>> 0;
        pos += 4;
        const end = Math.min(pos + len, blob.length);
        pushes.push(new Uint8Array(blob.slice(pos, end)));
        pos = end;
      } else {
        break;
      }
    }

    return pushes.length >= 2 ? pushes : null;
  }

  return null;
}

// ============================================================================
// Payload Parsing - Updated for PushDrop
// ============================================================================

/**
 * Parse identity payload from a PushDrop script.
 * The first field contains the JSON payload.
 */
export function parseIdentityOutput(script: Script | LockingScript): ClawdbotIdentityData | null {
  const fields = extractPushDropFields(script);
  if (!fields || fields.length < 1) return null;

  try {
    const payload = JSON.parse(
      new TextDecoder().decode(new Uint8Array(fields[0]))
    ) as ClawdbotIdentityData;

    // Server validation rules
    if (payload.protocol !== PROTOCOL_ID) return null;
    if (payload.type !== 'identity') return null;
    if (typeof payload.identityKey !== 'string' || !/^[0-9a-fA-F]{66}$/.test(payload.identityKey)) return null;
    if (typeof payload.name !== 'string' || payload.name.length === 0) return null;
    if (!Array.isArray(payload.capabilities)) return null;
    if (typeof payload.timestamp !== 'string') return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Parse identity revocation payload from a PushDrop script.
 */
export function parseRevocationOutput(script: Script | LockingScript): ClawdbotIdentityRevocationData | null {
  const fields = extractPushDropFields(script);
  if (!fields || fields.length < 1) return null;

  try {
    const payload = JSON.parse(
      new TextDecoder().decode(new Uint8Array(fields[0]))
    ) as ClawdbotIdentityRevocationData;

    if (payload.protocol !== PROTOCOL_ID) return null;
    if (payload.type !== 'identity-revocation') return null;
    if (typeof payload.identityKey !== 'string' || !/^[0-9a-fA-F]{66}$/.test(payload.identityKey)) return null;
    if (typeof payload.timestamp !== 'string') return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Parse service payload from a PushDrop script.
 */
export function parseServiceOutput(script: Script | LockingScript): ClawdbotServiceData | null {
  const fields = extractPushDropFields(script);
  if (!fields || fields.length < 1) return null;

  try {
    const payload = JSON.parse(
      new TextDecoder().decode(new Uint8Array(fields[0]))
    ) as ClawdbotServiceData;

    if (payload.protocol !== PROTOCOL_ID) return null;
    if (payload.type !== 'service') return null;
    if (typeof payload.identityKey !== 'string' || !/^[0-9a-fA-F]{66}$/.test(payload.identityKey)) return null;
    if (typeof payload.serviceId !== 'string' || payload.serviceId.length === 0) return null;
    if (typeof payload.name !== 'string' || payload.name.length === 0) return null;
    if (!payload.pricing || typeof payload.pricing.amountSats !== 'number') return null;
    if (typeof payload.timestamp !== 'string') return null;

    return payload;
  } catch {
    return null;
  }
}

// ============================================================================
// Topic Manager Simulation
// ============================================================================

/**
 * Simulate the identity topic manager's identifyAdmissibleOutputs.
 */
export function identifyIdentityOutputs(beef: number[]): AdmittanceResult {
  const parsedBeef = Beef.fromBinary(beef);
  const subjectTx = parsedBeef.txs[0]?._tx;

  if (!subjectTx) {
    return { outputsToAdmit: [], coinsToRetain: [] };
  }

  const outputsToAdmit: number[] = [];

  for (let i = 0; i < subjectTx.outputs.length; i++) {
    const output = subjectTx.outputs[i];
    if (output.lockingScript) {
      // Check identity
      const identity = parseIdentityOutput(output.lockingScript);
      if (identity !== null) {
        outputsToAdmit.push(i);
        continue;
      }
      // Check revocation
      const revocation = parseRevocationOutput(output.lockingScript);
      if (revocation !== null) {
        outputsToAdmit.push(i);
      }
    }
  }

  return { outputsToAdmit, coinsToRetain: [] };
}

/**
 * Simulate the services topic manager's identifyAdmissibleOutputs.
 */
export function identifyServiceOutputs(beef: number[]): AdmittanceResult {
  const parsedBeef = Beef.fromBinary(beef);
  const subjectTx = parsedBeef.txs[0]?._tx;

  if (!subjectTx) {
    return { outputsToAdmit: [], coinsToRetain: [] };
  }

  const outputsToAdmit: number[] = [];

  for (let i = 0; i < subjectTx.outputs.length; i++) {
    const output = subjectTx.outputs[i];
    if (output.lockingScript) {
      const service = parseServiceOutput(output.lockingScript);
      if (service !== null) {
        outputsToAdmit.push(i);
      }
    }
  }

  return { outputsToAdmit, coinsToRetain: [] };
}

// ============================================================================
// BEEF Validation
// ============================================================================

/**
 * Validate BEEF format and structure.
 */
export function validateBeef(beef: number[]): {
  valid: boolean;
  error?: string;
  version?: number;
  txCount?: number;
  hasProofs?: boolean;
} {
  try {
    // Check magic bytes
    if (beef.length < 4) {
      return { valid: false, error: 'BEEF too short' };
    }

    const magic = beef.slice(0, 4);
    const magicHex = magic.map(b => b.toString(16).padStart(2, '0')).join('');

    if (magicHex !== '0100beef' && magicHex !== '0200beef') {
      return { valid: false, error: `Invalid magic bytes: ${magicHex}` };
    }

    const version = magicHex === '0100beef' ? 1 : 2;

    // Parse BEEF
    const parsed = Beef.fromBinary(beef);

    if (!parsed.txs || parsed.txs.length === 0) {
      return { valid: false, error: 'BEEF contains no transactions' };
    }

    // Check for merkle proofs
    const hasProofs = parsed.bumps && parsed.bumps.length > 0;

    return {
      valid: true,
      version,
      txCount: parsed.txs.length,
      hasProofs,
    };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}

/**
 * Validate BEEF has proper ancestry chain.
 */
export function validateBeefAncestry(beef: number[]): {
  valid: boolean;
  error?: string;
  chain?: string[];
} {
  try {
    const parsed = Beef.fromBinary(beef);
    const chain: string[] = [];

    for (const btx of parsed.txs) {
      const txid = (btx as { txid?: string }).txid || btx._tx?.id('hex');
      if (txid) chain.push(txid);
    }

    // Use Beef's built-in validation
    const isValid = parsed.isValid(false);

    if (!isValid) {
      return { valid: false, error: 'BEEF ancestry chain is invalid', chain };
    }

    return { valid: true, chain };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}
