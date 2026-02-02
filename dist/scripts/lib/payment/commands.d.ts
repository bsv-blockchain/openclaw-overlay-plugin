/**
 * Payment CLI commands: pay, verify, accept.
 */
/**
 * Pay command: send satoshis to another agent.
 */
export declare function cmdPay(pubkey: string | undefined, satoshis: string | undefined, description?: string): Promise<never>;
/**
 * Verify command: verify an incoming payment BEEF.
 */
export declare function cmdVerify(beefBase64: string | undefined): Promise<never>;
/**
 * Accept command: accept and internalize a payment.
 */
export declare function cmdAccept(beef: string | undefined, derivationPrefix: string | undefined, derivationSuffix: string | undefined, senderIdentityKey: string | undefined, description?: string): Promise<never>;
