/**
 * Overlay registration commands: register, unregister.
 */

import fs from 'node:fs';
import { NETWORK, WALLET_DIR, OVERLAY_URL, PROTOCOL_ID, TOPICS, PATHS } from '../config.js';
import { ok, fail } from '../output.js';
import { loadWalletIdentity } from '../wallet/identity.js';
import { loadRegistration, saveRegistration, deleteRegistration, loadServices } from '../utils/storage.js';
import { buildRealOverlayTransaction } from './transaction.js';

// Dynamic import for BSVAgentWallet
let _BSVAgentWallet: any = null;

async function getBSVAgentWallet(): Promise<any> {
  if (_BSVAgentWallet) return _BSVAgentWallet;

  try {
    const core = await import('@a2a-bsv/core');
    _BSVAgentWallet = core.BSVAgentWallet;
    return _BSVAgentWallet;
  } catch {
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const os = await import('node:os');

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(__dirname, '..', '..', '..', 'node_modules', '@a2a-bsv', 'core', 'dist', 'index.js'),
      path.resolve(__dirname, '..', '..', '..', '..', '..', 'a2a-bsv', 'packages', 'core', 'dist', 'index.js'),
      path.resolve(os.homedir(), 'a2a-bsv', 'packages', 'core', 'dist', 'index.js'),
    ];

    for (const p of candidates) {
      try {
        const core = await import(p);
        _BSVAgentWallet = core.BSVAgentWallet;
        return _BSVAgentWallet;
      } catch {
        // Try next
      }
    }
    throw new Error('Cannot find @a2a-bsv/core. Run setup.sh first.');
  }
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

  // Agent metadata (could be customized later)
  const agentName = process.env.AGENT_NAME || 'BSV Agent';
  const agentDescription = process.env.AGENT_DESCRIPTION || 'A BSV overlay network agent';

  // Create identity record on-chain
  const identityPayload = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey,
    name: agentName,
    description: agentDescription,
    registeredAt: new Date().toISOString(),
  };

  let identityResult: { txid: string; funded: string };
  try {
    identityResult = await buildRealOverlayTransaction(identityPayload, TOPICS.IDENTITY);
  } catch (err: any) {
    return fail(`Registration failed: ${err.message}`);
  }

  // Optionally register services if pre-configured
  const services = loadServices();
  let serviceTxid: string | null = null;

  if (services.length > 0) {
    const servicesPayload = {
      protocol: PROTOCOL_ID,
      type: 'service-bundle',
      identityKey,
      services: services.map(s => ({
        serviceId: s.serviceId,
        name: s.name,
        description: s.description,
        pricingSats: s.priceSats,
      })),
      registeredAt: new Date().toISOString(),
    };

    try {
      const serviceResult = await buildRealOverlayTransaction(servicesPayload, TOPICS.SERVICES);
      serviceTxid = serviceResult.txid;
    } catch {
      // Non-fatal — identity registered but services failed
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
