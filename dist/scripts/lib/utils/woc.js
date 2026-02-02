/**
 * WhatsOnChain API helpers with retry logic and rate limiting.
 */
import { NETWORK, WOC_API_KEY } from '../config.js';
/**
 * Fetch from WhatsonChain with optional API key auth and retry logic.
 * Retries on 429 (rate limit) and 5xx errors with exponential backoff.
 * Includes timeout to prevent hanging indefinitely.
 */
export async function wocFetch(urlPath, options = {}, maxRetries = 3, timeoutMs = 30000) {
    const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
    const base = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;
    const url = urlPath.startsWith('http') ? urlPath : `${base}${urlPath}`;
    const headers = { ...(options.headers || {}) };
    if (WOC_API_KEY) {
        headers['Authorization'] = `Bearer ${WOC_API_KEY}`;
    }
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            const resp = await fetch(url, { ...options, headers, signal: controller.signal });
            clearTimeout(timeout);
            // Retry on 429 (rate limit) or 5xx (server error)
            if ((resp.status === 429 || resp.status >= 500) && attempt < maxRetries) {
                const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000);
                await new Promise(r => setTimeout(r, delayMs));
                continue;
            }
            return resp;
        }
        catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000);
                await new Promise(r => setTimeout(r, delayMs));
                continue;
            }
        }
    }
    throw lastError || new Error('WoC fetch failed after retries');
}
/**
 * Fetch with timeout using AbortController.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        return resp;
    }
    finally {
        clearTimeout(timeout);
    }
}
/**
 * Fetch a pre-built BEEF from WhatsonChain for a given txid.
 * WoC returns raw binary BEEF that includes the full source chain and merkle proofs.
 */
export async function fetchBeefFromWoC(txid) {
    try {
        const resp = await wocFetch(`/tx/${txid}/beef`);
        if (!resp.ok)
            return null;
        const hexStr = (await resp.text()).trim();
        if (!hexStr || hexStr.length < 8)
            return null;
        const bytes = hexStr.match(/.{2}/g).map(h => parseInt(h, 16));
        return new Uint8Array(bytes);
    }
    catch {
        return null;
    }
}
/**
 * Get the WoC base URL for the current network.
 */
export function getWocBaseUrl() {
    const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
    return `https://api.whatsonchain.com/v1/bsv/${wocNet}`;
}
/**
 * Get the explorer base URL for the current network.
 */
export function getExplorerBaseUrl() {
    return NETWORK === 'mainnet'
        ? 'https://whatsonchain.com'
        : 'https://test.whatsonchain.com';
}
