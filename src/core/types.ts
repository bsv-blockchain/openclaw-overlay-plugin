/**
 * @a2a-bsv/core — Type definitions for agent-to-agent BSV payments.
 */

/** Wallet configuration for creating or loading an agent wallet. */
export interface WalletConfig {
  /** BSV network to use. */
  network: 'mainnet' | 'testnet';
  /** Directory path for SQLite wallet persistence. */
  storageDir: string;
  /** Optional: pre-existing root private key hex. If omitted on create(), a new one is generated. */
  rootKeyHex?: string;
  /** Optional TAAL API key for ARC broadcasting. Falls back to public default. */
  taalApiKey?: string;
  /** Optional fee model in sat/KB. Falls back to BSV_FEE_MODEL env var or default 100 sat/KB. */
  feeModel?: number;
}

/** Parameters for building a payment transaction. */
export interface PaymentParams {
  /** Recipient's compressed public key (hex) or BSV address. */
  to: string;
  /** Amount to pay in satoshis. */
  satoshis: number;
  /** Human-readable description (5-50 chars per BRC-100). */
  description?: string;
  /** Optional metadata embedded as OP_RETURN (future use). */
  metadata?: {
    taskId?: string;
    protocol?: string;
  };
}

/** Result from building a payment. */
export interface PaymentResult {
  /** Base64-encoded Atomic BEEF transaction data. */
  beef: string;
  /** Transaction ID (hex). */
  txid: string;
  /** Amount paid in satoshis. */
  satoshis: number;
  /** BRC-29 derivation prefix (base64). Needed by recipient to internalize. */
  derivationPrefix: string;
  /** BRC-29 derivation suffix (base64). Needed by recipient to internalize. */
  derivationSuffix: string;
  /** Sender's identity key (compressed hex). Needed by recipient to internalize. */
  senderIdentityKey: string;
}

/** Parameters for verifying an incoming payment. */
export interface VerifyParams {
  /** Base64-encoded Atomic BEEF data. */
  beef: string;
  /** Expected payment amount in satoshis. */
  expectedAmount?: number;
  /** Expected sender identity key (optional). */
  expectedSender?: string;
}

/** Result from verifying a payment. */
export interface VerifyResult {
  /** Whether the payment passes all checks. */
  valid: boolean;
  /** Transaction ID (hex). */
  txid: string;
  /** Number of outputs found in the transaction. */
  outputCount: number;
  /** Errors encountered during verification. */
  errors: string[];
}

/** Parameters for accepting (internalizing) a verified payment. */
export interface AcceptParams {
  /** Base64-encoded Atomic BEEF data. */
  beef: string;
  /** The output index to internalize (default: 0). */
  vout?: number;
  /** BRC-29 derivation prefix from the PaymentResult. */
  derivationPrefix: string;
  /** BRC-29 derivation suffix from the PaymentResult. */
  derivationSuffix: string;
  /** Sender's identity key from the PaymentResult. */
  senderIdentityKey: string;
  /** Human-readable description for wallet records (5-50 chars). */
  description?: string;
}

/** Result from accepting a payment. */
export interface AcceptResult {
  /** Whether the payment was accepted. */
  accepted: boolean;
}

/** Payment currency type. */
export type PaymentCurrency = 'bsv' | 'mnee';

/** Result from sending an MNEE payment. */
export interface MneePaymentResult {
  /** Payment type identifier. */
  paymentType: 'mnee';
  /** Transaction ID (hex), if available. */
  txid?: string;
  /** MNEE ticket/transfer ID, if available. */
  ticketId?: string;
  /** Amount in USD. */
  amountUsd: number;
  /** Amount in atomic MNEE units. */
  amountAtomic: number;
  /** Sender's BSV address. */
  senderAddress: string;
  /** Sender's identity key (compressed hex). */
  senderIdentityKey: string;
}

/** Result from verifying an incoming MNEE payment. */
export interface MneeVerifyResult {
  /** Whether the payment is valid. */
  valid: boolean;
  /** Transaction ID (hex). */
  txid: string;
  /** Amount in USD. */
  amountUsd: number;
  /** Amount in atomic MNEE units. */
  amountAtomic: number;
  /** Errors encountered during verification. */
  errors: string[];
}

/** Serializable wallet identity info, persisted alongside the SQLite database. */
export interface WalletIdentity {
  /** The root private key (hex). Guard this carefully. */
  rootKeyHex: string;
  /** The wallet's public identity key (compressed hex). */
  identityKey: string;
  /** Network this wallet targets. */
  network: 'mainnet' | 'testnet';
}
