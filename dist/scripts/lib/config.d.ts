/**
 * Configuration constants and environment variables for the overlay CLI.
 */
/** Wallet storage directory */
export declare const WALLET_DIR: string;
/** Network to use (mainnet or testnet) */
export declare const NETWORK: 'mainnet' | 'testnet';
/** Overlay server URL */
export declare const OVERLAY_URL: string;
/** WhatsOnChain API key (optional, for rate limit bypass) */
export declare const WOC_API_KEY: string;
/** Overlay state directory for registration, services, etc. */
export declare const OVERLAY_STATE_DIR: string;
/** Protocol identifier for overlay transactions */
export declare const PROTOCOL_ID = "clawdbot-overlay-v1";
/** Topic managers for overlay submissions */
export declare const TOPICS: {
    readonly IDENTITY: "tm_clawdbot_identity";
    readonly SERVICES: "tm_clawdbot_services";
    readonly X_VERIFICATION: "tm_clawdbot_x_verification";
};
/** Lookup services for overlay queries */
export declare const LOOKUP_SERVICES: {
    readonly AGENTS: "ls_clawdbot_agents";
    readonly SERVICES: "ls_clawdbot_services";
    readonly X_VERIFICATIONS: "ls_clawdbot_x_verifications";
};
/** Paths derived from config */
export declare const PATHS: {
    readonly walletIdentity: string;
    readonly registration: string;
    readonly services: string;
    readonly latestChange: string;
    readonly receivedPayments: string;
    readonly researchQueue: string;
    readonly serviceQueue: string;
    readonly notifications: string;
    readonly xVerifications: string;
    readonly pendingXVerification: string;
    readonly xEngagementQueue: string;
    readonly memoryStore: string;
    readonly baemailConfig: string;
    readonly baemailLog: string;
};
