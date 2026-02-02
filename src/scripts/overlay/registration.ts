/**
 * Overlay registration commands: register, unregister.
 * 
 * Registration creates an identity record on the overlay network with:
 * - identityKey: compressed public key (66 hex chars)
 * - name: agent display name
 * - description: what the agent does
 * - channels: contact methods (e.g., { overlay: "https://..." })
 * - capabilities: what the agent can do (e.g., ["services", "jokes"])
 * - timestamp: ISO 8601 registration time
 */

import fs from 'node:fs';
import { NETWORK, WALLET_DIR, OVERLAY_URL, PROTOCOL_ID, TOPICS, PATHS } from '../config.js';
import { ok, fail } from '../output.js';
import { loadRegistration, saveRegistration, deleteRegistration, loadServices } from '../utils/storage.js';
import { buildRealOverlayTransaction } from './transaction.js';

import { BSVAgentWallet } from '../../core/index.js';

async function getBSVAgentWallet(): Promise<typeof BSVAgentWallet> {
  return BSVAgentWallet;
}

/**
 * Register command: register this agent on the overlay network.
 */
export async function cmdRegister(): Promise<never> {
  if (!fs.existsSync(PATHS.walletIdentity)) {
    return fail('Wallet not initialized. Run: setup');
  }

  const BSVAgentWallet = await getBSVAgentWallet();
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();
  await wallet.destroy();

  const existingReg = loadRegistration();
  if (existingReg && existingReg.identityKey === identityKey) {
    return ok({
      alreadyRegistered: true,
      identityKey,
      identityTxid: existingReg.identityTxid,
      overlayUrl: OVERLAY_URL,
    });
  }

  // Agent metadata
  const agentName = process.env.AGENT_NAME || 'clawdbot-agent';
  const agentDescription = process.env.AGENT_DESCRIPTION || 
    `Clawdbot agent (${agentName}). Offers services for BSV micropayments.`;

  // Build capabilities list based on what services we might offer
  const capabilities: string[] = ['services'];
  const services = loadServices();
  if (services.some(s => s.serviceId === 'tell-joke')) {
    capabilities.push('jokes');
  }

  // Create identity record on-chain
  // This payload format matches the clawdbot-overlay server's expected schema
  const identityPayload = {
    protocol: PROTOCOL_ID,
    type: 'identity' as const,
    identityKey,
    name: agentName,
    description: agentDescription,
    channels: {
      overlay: OVERLAY_URL,
    },
    capabilities,
    timestamp: new Date().toISOString(),
  };

  let identityResult: { txid: string; funded: string };
  try {
    identityResult = await buildRealOverlayTransaction(identityPayload, TOPICS.IDENTITY);
  } catch (err: any) {
    return fail(`Registration failed: ${err.message}`);
  }

  // Optionally register services if pre-configured
  let serviceTxid: string | null = null;

  if (services.length > 0) {
    // Register each service individually (server expects 'service' type, not 'service-bundle')
    for (const service of services) {
      const servicePayload = {
        protocol: PROTOCOL_ID,
        type: 'service' as const,
        identityKey,
        serviceId: service.serviceId,
        name: service.name,
        description: service.description,
        pricing: {
          model: 'per-task',
          amountSats: service.priceSats,
        },
        timestamp: new Date().toISOString(),
      };

      try {
        const serviceResult = await buildRealOverlayTransaction(servicePayload, TOPICS.SERVICES);
        serviceTxid = serviceResult.txid; // Keep last one for backward compat
      } catch {
        // Non-fatal — identity registered but this service failed
      }
    }
  }

  // Save registration
  const registration = {
    identityKey,
    agentName,
    agentDescription,
    overlayUrl: OVERLAY_URL,
    identityTxid: identityResult.txid,
    serviceTxid,
    funded: identityResult.funded,
    registeredAt: new Date().toISOString(),
  };
  saveRegistration(registration);

  return ok({
    registered: true,
    identityKey,
    identityTxid: identityResult.txid,
    serviceTxid,
    overlayUrl: OVERLAY_URL,
    funded: identityResult.funded,
    stateFile: PATHS.registration,
  });
}

/**
 * Unregister command: remove local registration (does not delete on-chain records).
 */
export async function cmdUnregister(): Promise<never> {
  const existingReg = loadRegistration();
  if (!existingReg) {
    return fail('Not registered');
  }

  deleteRegistration();

  return ok({
    unregistered: true,
    identityKey: existingReg.identityKey,
    note: 'Local registration removed. On-chain records remain (blockchain is immutable).',
  });
}
