/**
 * Baemail service handler - processes incoming paid messages.
 */
interface BaemailInput {
    message?: string;
    senderName?: string;
    replyIdentityKey?: string;
}
interface ServiceMessage {
    id: string;
    from: string;
    payload?: {
        input?: BaemailInput;
        payment?: any;
    };
}
interface ProcessResult {
    id: string;
    type: string;
    serviceId: string;
    action: string;
    tier?: string;
    deliverySuccess?: boolean;
    deliveryError?: string | null | undefined;
    paymentAccepted?: boolean;
    paymentTxid?: string;
    satoshisReceived?: number;
    from: string;
    ack: boolean;
    reason?: string | null;
}
/**
 * Process incoming baemail service request.
 */
export declare function processBaemail(msg: ServiceMessage, identityKey: string, privKey: any): Promise<ProcessResult>;
export {};
