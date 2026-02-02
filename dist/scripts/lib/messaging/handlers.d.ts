/**
 * Message type handlers and processMessage function.
 */
import type { RelayMessage, ProcessMessageResult } from '../types.js';
/**
 * Verify and accept a payment from a service request.
 * Uses a2a-bsv wallet.acceptPayment() for proper BRC-29 handling.
 */
export declare function verifyAndAcceptPayment(payment: any, minSats: number, senderKey: string, serviceId: string, ourHash160: Uint8Array): Promise<{
    accepted: boolean;
    txid: string | null;
    satoshis: number;
    outputIndex: number;
    walletAccepted: boolean;
    error: string | null;
}>;
/**
 * Process a single relay message.
 * Handles pings, service requests, pongs, and service responses.
 */
export declare function processMessage(msg: RelayMessage, identityKey: string, privKey: any): Promise<ProcessMessageResult>;
