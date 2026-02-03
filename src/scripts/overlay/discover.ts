/**
 * Overlay discovery commands.
 */

import { OVERLAY_URL, LOOKUP_SERVICES } from '../config.js';
import { ok } from '../output.js';
import { lookupOverlay, parseOverlayOutput } from './transaction.js';

/**
 * Discover command: query the overlay for agents and services.
 */
export async function cmdDiscover(args: string[]): Promise<never> {

  // Parse flags
  let serviceFilter: string | null = null;
  let agentFilter: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--service' && args[i + 1]) serviceFilter = args[++i];
    else if (args[i] === '--agent' && args[i + 1]) agentFilter = args[++i];
  }

  const results: {
    agents: any[];
    services: any[];
    agentError?: string;
    serviceError?: string;
  } = { agents: [], services: [] };

  // Query agents
  if (!serviceFilter) {
    try {
      const agentQuery = agentFilter ? { name: agentFilter } : { type: 'list' };
      const agentResult = await lookupOverlay(LOOKUP_SERVICES.AGENTS, agentQuery);

      if (agentResult.outputs) {
        for (const output of agentResult.outputs) {
          try {
            const { data, txid } = await parseOverlayOutput(output.beef, output.outputIndex);
            if (data?.type === 'identity') {
              results.agents.push({ ...data, txid });
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err: any) {
      results.agentError = String(err);
    }
  }

  // Query services
  if (!agentFilter) {
    try {
      const serviceQuery = serviceFilter ? { serviceType: serviceFilter } : {};
      const serviceResult = await lookupOverlay(LOOKUP_SERVICES.SERVICES, serviceQuery);

      if (serviceResult.outputs) {
        for (const output of serviceResult.outputs) {
          try {
            const { data, txid } = await parseOverlayOutput(output.beef, output.outputIndex);
            if (data?.type === 'service') {
              results.services.push({ ...data, txid });
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err: any) {
      results.serviceError = String(err);
    }
  }

  return ok({
    overlayUrl: OVERLAY_URL,
    agentCount: results.agents.length,
    serviceCount: results.services.length,
    agents: results.agents,
    services: results.services,
    ...(results.agentError && { agentError: results.agentError }),
    ...(results.serviceError && { serviceError: results.serviceError }),
  });
}
