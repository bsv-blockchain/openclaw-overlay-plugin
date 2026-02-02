/**
 * Connect command: WebSocket real-time message processing.
 */
import fs from 'node:fs';
import { OVERLAY_URL, PATHS } from '../config.js';
import { fail } from '../output.js';
import { loadIdentity } from '../wallet/identity.js';
import { processMessage } from './handlers.js';
import { ensureStateDir } from '../utils/storage.js';
/**
 * Connect command: establish WebSocket connection for real-time messaging.
 * Note: This function never returns normally - it runs until SIGINT/SIGTERM.
 */
export async function cmdConnect() {
    let WebSocketClient;
    try {
        const ws = await import('ws');
        WebSocketClient = ws.default || ws.WebSocket || ws;
    }
    catch {
        return fail('WebSocket client not available. Install it: npm install ws');
    }
    const { identityKey, privKey } = await loadIdentity();
    const wsUrl = OVERLAY_URL.replace(/^http/, 'ws') + '/relay/subscribe?identity=' + identityKey;
    let reconnectDelay = 1000;
    let shouldReconnect = true;
    let currentWs = null;
    function shutdown() {
        shouldReconnect = false;
        if (currentWs) {
            try {
                currentWs.close();
            }
            catch { }
        }
        process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    function connect() {
        const ws = new WebSocketClient(wsUrl);
        currentWs = ws;
        ws.on('open', () => {
            reconnectDelay = 1000; // reset on successful connect
            console.error(JSON.stringify({ event: 'connected', identity: identityKey, overlay: OVERLAY_URL }));
        });
        ws.on('message', async (data) => {
            try {
                const envelope = JSON.parse(data.toString());
                if (envelope.type === 'message') {
                    const result = await processMessage(envelope.message, identityKey, privKey);
                    // Output the result as a JSON line to stdout
                    console.log(JSON.stringify(result));
                    // Also append to notification log
                    ensureStateDir();
                    try {
                        fs.appendFileSync(PATHS.notifications, JSON.stringify({ ...result, _ts: Date.now() }) + '\n');
                    }
                    catch { }
                    // Ack the message
                    if (result.ack) {
                        try {
                            await fetch(OVERLAY_URL + '/relay/ack', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ identity: identityKey, messageIds: [result.id] }),
                            });
                        }
                        catch (ackErr) {
                            console.error(JSON.stringify({ event: 'ack-error', id: result.id, message: String(ackErr) }));
                        }
                    }
                }
                // Handle service announcements
                if (envelope.type === 'service-announced') {
                    const svc = envelope.service || {};
                    const announcement = {
                        event: 'service-announced',
                        serviceId: svc.serviceId,
                        name: svc.name,
                        description: svc.description,
                        priceSats: svc.pricingSats,
                        provider: svc.identityKey,
                        txid: envelope.txid,
                        _ts: Date.now(),
                    };
                    console.log(JSON.stringify(announcement));
                    ensureStateDir();
                    try {
                        fs.appendFileSync(PATHS.notifications, JSON.stringify(announcement) + '\n');
                    }
                    catch { }
                }
            }
            catch (err) {
                console.error(JSON.stringify({ event: 'process-error', message: String(err) }));
            }
        });
        ws.on('close', () => {
            currentWs = null;
            if (shouldReconnect) {
                console.error(JSON.stringify({ event: 'disconnected', reconnectMs: reconnectDelay }));
                setTimeout(connect, reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, 30000);
            }
        });
        ws.on('error', (err) => {
            console.error(JSON.stringify({ event: 'error', message: err.message }));
        });
    }
    connect();
    // Keep the process alive — never resolves
    await new Promise(() => { });
}
