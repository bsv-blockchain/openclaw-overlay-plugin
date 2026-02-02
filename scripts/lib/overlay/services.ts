/**
 * Overlay service commands: services, advertise, remove, readvertise.
 */

import { NETWORK, WALLET_DIR, PROTOCOL_ID, TOPICS, PATHS } from '../config.js';
import { ok, fail } from '../output.js';
import { loadServices, saveServices, loadRegistration } from '../utils/storage.js';
import { buildRealOverlayTransaction } from './transaction.js';
import type { ServiceAdvertisement } from '../types.js';

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
 * Services command: list currently advertised services.
 */
export async function cmdServices(): Promise<never> {
  const services = loadServices();
  return ok({ services, count: services.length });
}

/**
 * Advertise command: add a new service advertisement.
 */
export async function cmdAdvertise(
  serviceId: string | undefined,
  name: string | undefined,
  priceSatsStr: string | undefined,
  description?: string
): Promise<never> {
  if (!serviceId || !name || !priceSatsStr) {
    return fail('Usage: advertise <serviceId> <name> <priceSats> [description]');
  }

  const priceSats = parseInt(priceSatsStr, 10);
  if (isNaN(priceSats) || priceSats < 0) {
    return fail('priceSats must be a non-negative integer');
  }

  const BSVAgentWallet = await getBSVAgentWallet();
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();
  await wallet.destroy();

  // Load existing services
  const services = loadServices();
  const existing = services.find(s => s.serviceId === serviceId);
  if (existing) {
    return fail(`Service '${serviceId}' already exists. Use 'readvertise' to update.`);
  }

  // Create service record
  const newService: ServiceAdvertisement = {
    serviceId,
    name,
    description: description || `${name} service`,
    priceSats,
    registeredAt: new Date().toISOString(),
  };

  // Publish on-chain
  const servicePayload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey,
    serviceId,
    name,
    description: newService.description,
    pricingSats: priceSats,
    advertisedAt: newService.registeredAt,
  };

  try {
    const result = await buildRealOverlayTransaction(servicePayload, TOPICS.SERVICES);
    newService.txid = result.txid;

    // Save locally
    services.push(newService);
    saveServices(services);

    return ok({
      advertised: true,
      service: newService,
      txid: result.txid,
      funded: result.funded,
    });
  } catch (err: any) {
    return fail(`Failed to advertise service: ${err.message}`);
  }
}

/**
 * Remove command: remove a service from local registry.
 */
export async function cmdRemove(serviceId: string | undefined): Promise<never> {
  if (!serviceId) {
    return fail('Usage: remove <serviceId>');
  }

  const services = loadServices();
  const idx = services.findIndex(s => s.serviceId === serviceId);
  if (idx === -1) {
    return fail(`Service '${serviceId}' not found`);
  }

  const removed = services.splice(idx, 1)[0];
  saveServices(services);

  return ok({
    removed: true,
    service: removed,
    note: 'Removed from local registry. On-chain record remains (blockchain is immutable).',
  });
}

/**
 * Readvertise command: update an existing service advertisement.
 */
export async function cmdReadvertise(
  serviceId: string | undefined,
  name?: string,
  priceSatsStr?: string,
  description?: string
): Promise<never> {
  if (!serviceId) {
    return fail('Usage: readvertise <serviceId> [name] [priceSats] [description]');
  }

  const services = loadServices();
  const existing = services.find(s => s.serviceId === serviceId);
  if (!existing) {
    return fail(`Service '${serviceId}' not found. Use 'advertise' to create.`);
  }

  const BSVAgentWallet = await getBSVAgentWallet();
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();
  await wallet.destroy();

  // Update fields if provided
  if (name) existing.name = name;
  if (priceSatsStr) {
    const priceSats = parseInt(priceSatsStr, 10);
    if (isNaN(priceSats) || priceSats < 0) {
      return fail('priceSats must be a non-negative integer');
    }
    existing.priceSats = priceSats;
  }
  if (description) existing.description = description;
  existing.registeredAt = new Date().toISOString();

  // Publish update on-chain
  const servicePayload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey,
    serviceId,
    name: existing.name,
    description: existing.description,
    pricingSats: existing.priceSats,
    advertisedAt: existing.registeredAt,
    updated: true,
  };

  try {
    const result = await buildRealOverlayTransaction(servicePayload, TOPICS.SERVICES);
    existing.txid = result.txid;

    // Save locally
    saveServices(services);

    return ok({
      readvertised: true,
      service: existing,
      txid: result.txid,
      funded: result.funded,
    });
  } catch (err: any) {
    return fail(`Failed to readvertise service: ${err.message}`);
  }
}
