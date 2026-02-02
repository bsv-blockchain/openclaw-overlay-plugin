/**
 * Baemail commands - paid message forwarding service.
 */
export interface BaemailConfig {
    deliveryChannel: string;
    tiers: {
        standard: number;
        priority: number;
        urgent: number;
    };
    maxMessageLength: number;
    blocklist: string[];
    createdAt: string;
    updatedAt: string;
}
export interface BaemailLogEntry {
    requestId: string;
    from: string;
    senderName: string;
    tier: string;
    paidSats: number;
    messageLength: number;
    deliveryChannel: string;
    deliverySuccess: boolean;
    deliveryError: string | null;
    paymentTxid: string;
    refundStatus: string | null;
    refundTxid?: string;
    refundedAt?: string;
    timestamp: string;
    _lineIdx?: number;
}
/**
 * Load baemail configuration.
 */
export declare function loadBaemailConfig(): BaemailConfig | null;
/**
 * Save baemail configuration.
 */
export declare function saveBaemailConfig(config: BaemailConfig): void;
/**
 * Setup baemail service with delivery channel and tier pricing.
 */
export declare function cmdBaemailSetup(channel: string | undefined, standardStr: string | undefined, priorityStr?: string, urgentStr?: string): Promise<never>;
/**
 * View current baemail configuration.
 */
export declare function cmdBaemailConfig(): Promise<never>;
/**
 * Block a sender from using baemail.
 */
export declare function cmdBaemailBlock(identityKey: string | undefined): Promise<never>;
/**
 * Unblock a sender.
 */
export declare function cmdBaemailUnblock(identityKey: string | undefined): Promise<never>;
/**
 * View baemail delivery log.
 */
export declare function cmdBaemailLog(limitStr?: string): Promise<never>;
/**
 * Refund a failed baemail delivery.
 */
export declare function cmdBaemailRefund(requestId: string | undefined): Promise<never>;
