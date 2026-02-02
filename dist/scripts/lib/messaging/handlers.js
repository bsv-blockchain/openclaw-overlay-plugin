/**
 * Message type handlers and processMessage function.
 */
import { OVERLAY_URL, WALLET_DIR, PATHS } from '../config.js';
import { signRelayMessage, verifyRelaySignature, loadWalletIdentity } from '../wallet/identity.js';
import { loadServices, appendToJsonl } from '../utils/storage.js';
import { fetchWithTimeout } from '../utils/woc.js';
// Dynamic import for @bsv/sdk (needed for hash160 computation)
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
// Dynamic import for BSVAgentWallet
let _BSVAgentWallet = null;
async function getBSVAgentWallet() {
    if (_BSVAgentWallet)
        return _BSVAgentWallet;
    try {
        const core = await import('@a2a-bsv/core');
        _BSVAgentWallet = core.BSVAgentWallet;
        return _BSVAgentWallet;
    }
    catch {
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
            }
            catch {
                // Try next
            }
        }
        throw new Error('Cannot find @a2a-bsv/core. Run setup.sh first.');
    }
}
// Import NETWORK lazily to avoid circular dependencies
async function getNetwork() {
    const config = await import('../config.js');
    return config.NETWORK;
}
/**
 * Verify and accept a payment from a service request.
 * Uses a2a-bsv wallet.acceptPayment() for proper BRC-29 handling.
 */
export async function verifyAndAcceptPayment(payment, minSats, senderKey, serviceId, ourHash160) {
    if (!payment) {
        return { accepted: false, txid: null, satoshis: 0, outputIndex: 0, walletAccepted: false, error: 'no payment' };
    }
    if (payment.error) {
        return { accepted: false, txid: null, satoshis: 0, outputIndex: 0, walletAccepted: false, error: payment.error };
    }
    if (!payment.beef || !payment.satoshis) {
        return { accepted: false, txid: null, satoshis: 0, outputIndex: 0, walletAccepted: false, error: 'missing beef or satoshis' };
    }
    if (payment.satoshis < minSats) {
        return { accepted: false, txid: payment.txid || null, satoshis: payment.satoshis, outputIndex: 0, walletAccepted: false, error: `insufficient payment: ${payment.satoshis} < ${minSats}` };
    }
    // Accept the payment using a2a-bsv wallet
    const BSVAgentWallet = await getBSVAgentWallet();
    const network = await getNetwork();
    const wallet = await BSVAgentWallet.load({ network, storageDir: WALLET_DIR });
    try {
        // First verify the payment structure
        const verifyResult = wallet.verifyPayment({ beef: payment.beef });
        if (!verifyResult.valid) {
            await wallet.destroy();
            return { accepted: false, txid: payment.txid || null, satoshis: payment.satoshis, outputIndex: 0, walletAccepted: false, error: `verification failed: ${verifyResult.errors.join(', ')}` };
        }
        // Accept the payment (this broadcasts the transaction)
        const acceptResult = await wallet.acceptPayment({
            beef: payment.beef,
            derivationPrefix: payment.derivationPrefix,
            derivationSuffix: payment.derivationSuffix,
            senderIdentityKey: payment.senderIdentityKey,
            description: `Payment for ${serviceId}`,
        });
        await wallet.destroy();
        if (!acceptResult.accepted) {
            return { accepted: false, txid: payment.txid || null, satoshis: payment.satoshis, outputIndex: 0, walletAccepted: false, error: 'wallet rejected payment' };
        }
        return {
            accepted: true,
            txid: payment.txid,
            satoshis: payment.satoshis,
            outputIndex: 0,
            walletAccepted: true,
            error: null,
        };
    }
    catch (err) {
        await wallet.destroy();
        return { accepted: false, txid: payment.txid || null, satoshis: payment.satoshis, outputIndex: 0, walletAccepted: false, error: err.message };
    }
}
/**
 * Queue a service request for agent processing.
 */
async function queueForAgent(msg, identityKey, privKey, serviceId) {
    const sdk = await getSdk();
    const payment = msg.payload?.payment;
    const input = msg.payload?.input || msg.payload;
    // Verify and accept payment
    const walletIdentity = loadWalletIdentity();
    const ourHash160 = sdk.Hash.hash160(sdk.PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
    // Find the service price
    const services = loadServices();
    const svc = services.find(s => s.serviceId === serviceId);
    const minPrice = svc?.priceSats || 5;
    const payResult = await verifyAndAcceptPayment(payment, minPrice, msg.from, serviceId, ourHash160);
    if (!payResult.accepted) {
        // Send rejection
        const rejectPayload = { requestId: msg.id, serviceId, status: 'rejected', reason: `Payment rejected: ${payResult.error}` };
        const sig = await signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
        await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
        });
        return { id: msg.id, type: 'service-request', serviceId, action: 'rejected', reason: payResult.error || 'payment rejected', from: msg.from, ack: true };
    }
    // Queue for agent processing
    const queueEntry = {
        status: 'pending',
        requestId: msg.id,
        serviceId,
        from: msg.from,
        identityKey,
        input: input,
        paymentTxid: payResult.txid,
        satoshisReceived: payResult.satoshis,
        walletAccepted: payResult.walletAccepted,
        _ts: Date.now(),
    };
    appendToJsonl(PATHS.serviceQueue, queueEntry);
    return {
        id: msg.id,
        type: 'service-request',
        serviceId,
        action: 'queued-for-agent',
        paymentAccepted: true,
        paymentTxid: payResult.txid,
        satoshisReceived: payResult.satoshis,
        from: msg.from,
        ack: true,
    };
}
/**
 * Process a single relay message.
 * Handles pings, service requests, pongs, and service responses.
 */
export async function processMessage(msg, identityKey, privKey) {
    // Verify signature if present
    const sigCheck = msg.signature
        ? await verifyRelaySignature(msg.from, msg.to, msg.type, msg.payload, msg.signature)
        : { valid: null };
    // Reject unsigned/forged service-requests
    if (msg.type === 'service-request' && sigCheck.valid !== true) {
        console.error(JSON.stringify({ event: 'signature-rejected', type: msg.type, from: msg.from, reason: sigCheck.reason || 'missing signature' }));
        return {
            id: msg.id,
            type: msg.type,
            from: msg.from,
            action: 'rejected',
            reason: 'invalid-signature',
            signatureValid: sigCheck.valid,
            ack: true,
        };
    }
    if (msg.type === 'ping') {
        // Auto-respond with pong
        const pongPayload = {
            text: 'pong',
            inReplyTo: msg.id,
            originalText: msg.payload?.text || null,
        };
        const pongSig = await signRelayMessage(privKey, msg.from, 'pong', pongPayload);
        await fetch(`${OVERLAY_URL}/relay/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: identityKey,
                to: msg.from,
                type: 'pong',
                payload: pongPayload,
                signature: pongSig,
            }),
        });
        return { id: msg.id, type: 'ping', action: 'replied-pong', from: msg.from, ack: true };
    }
    if (msg.type === 'service-request') {
        const serviceId = msg.payload?.serviceId;
        // Agent-routed mode: queue for the agent
        if (process.env.AGENT_ROUTED === 'true') {
            return await queueForAgent(msg, identityKey, privKey, serviceId);
        }
        // No hardcoded handlers in TypeScript version — always queue
        return await queueForAgent(msg, identityKey, privKey, serviceId);
    }
    if (msg.type === 'pong') {
        return {
            id: msg.id,
            type: 'pong',
            action: 'received',
            from: msg.from,
            text: msg.payload?.text,
            inReplyTo: msg.payload?.inReplyTo,
            ack: true,
        };
    }
    if (msg.type === 'service-response') {
        const serviceId = msg.payload?.serviceId;
        const status = msg.payload?.status;
        const result = msg.payload?.result;
        return {
            id: msg.id,
            type: 'service-response',
            action: 'received',
            from: msg.from,
            serviceId,
            status,
            result,
            requestId: msg.payload?.requestId,
            direction: 'incoming-response',
            ack: true,
        };
    }
    // Unknown type
    return {
        id: msg.id,
        type: msg.type,
        from: msg.from,
        payload: msg.payload,
        signatureValid: sigCheck.valid,
        action: 'unhandled',
        ack: false,
    };
}
