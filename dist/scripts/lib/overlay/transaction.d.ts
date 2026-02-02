/**
 * Overlay transaction building utilities.
 */
import type { OverlayPayload } from '../types.js';
/**
 * Build an OP_RETURN locking script with JSON payload.
 */
export declare function buildOpReturnScript(payload: OverlayPayload): Uint8Array;
/**
 * Build and submit an overlay transaction.
 * @param payload - JSON data to store in OP_RETURN
 * @param topic - Topic manager for submission
 * @returns Transaction result with txid and funding info
 */
export declare function buildRealOverlayTransaction(payload: OverlayPayload, topic: string): Promise<{
    txid: string;
    funded: string;
    explorer: string;
}>;
/**
 * Lookup data from an overlay lookup service.
 */
export declare function lookupOverlay(service: string, query: Record<string, unknown>): Promise<any>;
/**
 * Parse an overlay output from BEEF data.
 */
export declare function parseOverlayOutput(beefBase64: string | Uint8Array, outputIndex: number): Promise<OverlayPayload | null>;
