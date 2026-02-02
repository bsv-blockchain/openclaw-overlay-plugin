/**
 * X (Twitter) verification commands.
 */
/**
 * Start X verification: generate a tweet with identity key and signature.
 */
export declare function cmdXVerifyStart(handleArg: string | undefined): Promise<never>;
/**
 * Complete X verification by checking the posted tweet.
 */
export declare function cmdXVerifyComplete(tweetUrl: string | undefined): Promise<never>;
/**
 * List verified X accounts (local cache).
 */
export declare function cmdXVerifications(): Promise<never>;
/**
 * Lookup X verifications from the overlay network.
 */
export declare function cmdXLookup(query: string | undefined): Promise<never>;
/**
 * List pending X engagement requests.
 */
export declare function cmdXEngagementQueue(): Promise<never>;
/**
 * Mark an X engagement request as fulfilled.
 */
export declare function cmdXEngagementFulfill(requestId: string | undefined, proofUrl?: string): Promise<never>;
