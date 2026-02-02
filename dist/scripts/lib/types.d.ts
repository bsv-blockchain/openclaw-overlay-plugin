/**
 * Shared TypeScript interfaces for the overlay CLI.
 */
export interface WalletIdentity {
    rootKeyHex: string;
    identityKey: string;
    network: 'mainnet' | 'testnet';
}
export interface PaymentResult {
    beef: string;
    txid: string;
    satoshis: number;
    derivationPrefix: string;
    derivationSuffix: string;
    senderIdentityKey: string;
}
export interface PaymentParams {
    to: string;
    satoshis: number;
    description?: string;
}
export interface ServiceAdvertisement {
    serviceId: string;
    name: string;
    description: string;
    priceSats: number;
    txid?: string;
    registeredAt?: string;
}
export interface Message {
    id: string;
    from: string;
    to: string;
    type: string;
    payload: unknown;
    signature?: string;
    timestamp?: number;
}
export interface CommandResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
}
export interface Registration {
    identityKey: string;
    agentName: string;
    agentDescription: string;
    overlayUrl: string;
    identityTxid: string;
    serviceTxid: string | null;
    funded: string;
    registeredAt: string;
}
export interface OverlayPayload {
    protocol: string;
    type: string;
    identityKey?: string;
    [key: string]: unknown;
}
export interface VerifyAndAcceptResult {
    accepted: boolean;
    txid: string | null;
    satoshis: number;
    outputIndex: number;
    walletAccepted: boolean;
    error: string | null;
}
export interface ProcessMessageResult {
    id: string;
    type: string;
    action: string;
    from: string;
    ack: boolean;
    [key: string]: unknown;
}
export interface RelayMessage {
    id: string;
    from: string;
    to: string;
    type: string;
    payload: Record<string, unknown>;
    signature?: string;
}
export interface XVerification {
    identityKey: string;
    xHandle: string;
    xUserId: string;
    tweetId: string;
    tweetUrl: string;
    signature: string;
    verifiedAt: string;
    txid?: string | null;
}
export interface StoredChange {
    txHex: string;
    txid: string;
    vout: number;
    satoshis: number;
    sourceChain?: SourceChainEntry[];
    savedAt: string;
}
export interface SourceChainEntry {
    txHex: string;
    txid: string;
    merklePathHex?: string;
    blockHeight?: number;
}
