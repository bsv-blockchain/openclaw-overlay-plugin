/**
 * WhatsOnChain API helpers with retry logic and rate limiting.
 */
/**
 * Fetch from WhatsonChain with optional API key auth and retry logic.
 * Retries on 429 (rate limit) and 5xx errors with exponential backoff.
 * Includes timeout to prevent hanging indefinitely.
 */
export declare function wocFetch(urlPath: string, options?: RequestInit, maxRetries?: number, timeoutMs?: number): Promise<Response>;
/**
 * Fetch with timeout using AbortController.
 */
export declare function fetchWithTimeout(url: string, options?: RequestInit, timeoutMs?: number): Promise<Response>;
/**
 * Fetch a pre-built BEEF from WhatsonChain for a given txid.
 * WoC returns raw binary BEEF that includes the full source chain and merkle proofs.
 */
export declare function fetchBeefFromWoC(txid: string): Promise<Uint8Array | null>;
/**
 * Get the WoC base URL for the current network.
 */
export declare function getWocBaseUrl(): string;
/**
 * Get the explorer base URL for the current network.
 */
export declare function getExplorerBaseUrl(): string;
