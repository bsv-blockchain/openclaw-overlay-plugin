/**
 * Wallet identity helpers.
 */
import type { WalletIdentity } from '../types.js';
/**
 * Load wallet identity from disk.
 * @returns Identity object with rootKeyHex and identityKey
 * @throws Error if wallet not initialized
 */
export declare function loadWalletIdentity(): WalletIdentity;
/**
 * Load identity and private key for relay message signing.
 * @returns Object with identityKey and privKey
 */
export declare function loadIdentity(): Promise<{
    identityKey: string;
    privKey: any;
}>;
/**
 * Sign a relay message using ECDSA.
 * @param privKey - Private key for signing
 * @param to - Recipient's identity key
 * @param type - Message type
 * @param payload - Message payload
 * @returns Hex-encoded DER signature
 */
export declare function signRelayMessage(privKey: any, to: string, type: string, payload: unknown): Promise<string>;
/**
 * Verify a relay message signature.
 * @param fromKey - Sender's public key
 * @param to - Recipient's identity key
 * @param type - Message type
 * @param payload - Message payload
 * @param signatureHex - Hex-encoded DER signature
 * @returns Verification result
 */
export declare function verifyRelaySignature(fromKey: string, to: string, type: string, payload: unknown, signatureHex: string | undefined): Promise<{
    valid: boolean;
    reason?: string;
}>;
/**
 * Derive wallet address components from a private key.
 */
export declare function deriveWalletAddress(privKey: any): Promise<{
    address: string;
    hash160: Uint8Array;
    pubKey: any;
}>;
