/**
 * Configuration constants and environment variables for the overlay CLI.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Auto-load .env from overlay state dir if it exists
const overlayEnvPath = path.join(os.homedir(), '.clawdbot', 'bsv-overlay', '.env');
try {
  if (fs.existsSync(overlayEnvPath)) {
    for (const line of fs.readFileSync(overlayEnvPath, 'utf-8').split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  }
} catch {
  // Ignore errors loading .env
}

/** Wallet storage directory */
export const WALLET_DIR = process.env.BSV_WALLET_DIR
  || path.join(os.homedir(), '.clawdbot', 'bsv-wallet');

/** Network to use (mainnet or testnet) */
export const NETWORK: 'mainnet' | 'testnet' =
  (process.env.BSV_NETWORK as 'mainnet' | 'testnet') || 'mainnet';

/** Overlay server URL */
export const OVERLAY_URL = process.env.OVERLAY_URL || 'http://162.243.168.235:8080';

/** WhatsOnChain API key (optional, for rate limit bypass) */
export const WOC_API_KEY = process.env.WOC_API_KEY || '';

/** Overlay state directory for registration, services, etc. */
export const OVERLAY_STATE_DIR = path.join(os.homedir(), '.clawdbot', 'bsv-overlay');

/** Protocol identifier for overlay transactions */
export const PROTOCOL_ID = 'clawdbot-overlay-v1';

/** Topic managers for overlay submissions */
export const TOPICS = {
  IDENTITY: 'tm_clawdbot_identity',
  SERVICES: 'tm_clawdbot_services',
  X_VERIFICATION: 'tm_clawdbot_x_verification',
} as const;

/** Lookup services for overlay queries */
export const LOOKUP_SERVICES = {
  AGENTS: 'ls_clawdbot_agents',
  SERVICES: 'ls_clawdbot_services',
  X_VERIFICATIONS: 'ls_clawdbot_x_verifications',
} as const;

/** Paths derived from config */
export const PATHS = {
  walletIdentity: path.join(WALLET_DIR, 'wallet-identity.json'),
  registration: path.join(OVERLAY_STATE_DIR, 'registration.json'),
  services: path.join(OVERLAY_STATE_DIR, 'services.json'),
  latestChange: path.join(OVERLAY_STATE_DIR, 'latest-change.json'),
  receivedPayments: path.join(OVERLAY_STATE_DIR, 'received-payments.jsonl'),
  researchQueue: path.join(OVERLAY_STATE_DIR, 'research-queue.jsonl'),
  serviceQueue: path.join(OVERLAY_STATE_DIR, 'service-queue.jsonl'),
  notifications: path.join(OVERLAY_STATE_DIR, 'notifications.jsonl'),
  xVerifications: path.join(OVERLAY_STATE_DIR, 'x-verifications.json'),
  pendingXVerification: path.join(OVERLAY_STATE_DIR, 'pending-x-verification.json'),
  xEngagementQueue: path.join(OVERLAY_STATE_DIR, 'x-engagement-queue.jsonl'),
  memoryStore: path.join(WALLET_DIR, 'memory-store.json'),
  baemailConfig: path.join(OVERLAY_STATE_DIR, 'baemail-config.json'),
  baemailLog: path.join(OVERLAY_STATE_DIR, 'baemail-log.jsonl'),
} as const;
