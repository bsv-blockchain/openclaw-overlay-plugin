/**
 * Overlay discovery commands.
 */
import { OVERLAY_URL, LOOKUP_SERVICES } from '../config.js';
import { ok } from '../output.js';
import { lookupOverlay, parseOverlayOutput } from './transaction.js';
// Dynamic import for @bsv/sdk
let _sdk = null;
async function getSdk() {
    if (_sdk)
        return _sdk;
    try {
        _sdk = await import('@bsv/sdk');
        return _sdk;
    }
    catch {
        const { fileURLToPath } = await import('node:url');
        const path = await import('node:path');
        const os = await import('node:os');
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const candidates = [
            path.resolve(__dirname, '..', '..', '..', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
            path.resolve(__dirname, '..', '..', '..', '..', '..', 'a2a-bsv', 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
            path.resolve(os.homedir(), 'a2a-bsv', 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
        ];
        for (const p of candidates) {
            try {
                _sdk = await import(p);
                return _sdk;
            }
            catch {
                // Try next
            }
        }
        throw new Error('Cannot find @bsv/sdk. Run setup.sh first.');
    }
}
/**
 * Discover command: query the overlay for agents and services.
 */
export async function cmdDiscover(args) {
    const sdk = await getSdk();
    // Parse flags
    let serviceFilter = null;
    let agentFilter = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--service' && args[i + 1])
            serviceFilter = args[++i];
        else if (args[i] === '--agent' && args[i + 1])
            agentFilter = args[++i];
    }
    const results = { agents: [], services: [] };
    // Query agents
    if (!serviceFilter) {
        try {
            const agentQuery = agentFilter ? { name: agentFilter } : { type: 'list' };
            const agentResult = await lookupOverlay(LOOKUP_SERVICES.AGENTS, agentQuery);
            if (agentResult.outputs) {
                for (const output of agentResult.outputs) {
                    const data = await parseOverlayOutput(output.beef, output.outputIndex);
                    if (data && data.type === 'identity') {
                        let txid = null;
                        try {
                            const tx = sdk.Transaction.fromBEEF(output.beef);
                            txid = tx.id('hex');
                        }
                        catch { /* ignore */ }
                        results.agents.push({ ...data, txid });
                    }
                }
            }
        }
        catch (err) {
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
                    const data = await parseOverlayOutput(output.beef, output.outputIndex);
                    if (data && data.type === 'service') {
                        let txid = null;
                        try {
                            const tx = sdk.Transaction.fromBEEF(output.beef);
                            txid = tx.id('hex');
                        }
                        catch { /* ignore */ }
                        results.services.push({ ...data, txid });
                    }
                }
            }
        }
        catch (err) {
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
