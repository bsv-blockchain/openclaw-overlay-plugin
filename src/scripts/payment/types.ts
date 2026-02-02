/**
 * Payment-specific type definitions.
 */

export interface PaymentResult {
  /** Base64-encoded Atomic BEEF transaction data */
  beef: string;
  /** Transaction ID (hex) */
  txid: string;
  /** Amount paid in satoshis */
  satoshis: number;
  /** BRC-29 derivation prefix (base64) - needed by recipient */
  derivationPrefix: string;
  /** BRC-29 derivation suffix (base64) - needed by recipient */
  derivationSuffix: string;
  /** Sender's identity key (compressed hex) - needed by recipient */
  senderIdentityKey: string;
}

export interface PaymentParams {
  /** Recipient's compressed public key (hex, 66 chars starting with 02/03) */
  to: string;
  /** Amount to pay in satoshis */
  satoshis: number;
  /** Optional human-readable description */
  description?: string;
}

export interface VerifyParams {
  /** Base64-encoded BEEF */
  beef: string;
  /** Expected amount (optional) */
  expectedAmount?: number;
  /** Expected sender identity key (optional) */
  expectedSender?: string;
}

export interface VerifyResult {
  valid: boolean;
  txid: string;
  outputCount: number;
  errors: string[];
}

export interface AcceptParams {
  /** Base64-encoded Atomic BEEF */
  beef: string;
  /** Output index (default: 0) */
  vout?: number;
  /** BRC-29 derivation prefix from PaymentResult */
  derivationPrefix: string;
  /** BRC-29 derivation suffix from PaymentResult */
  derivationSuffix: string;
  /** Sender's identity key from PaymentResult */
  senderIdentityKey: string;
  /** Optional description */
  description?: string;
}

export interface AcceptResult {
  accepted: boolean;
}
