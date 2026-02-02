/**
 * Baemail commands - paid message forwarding service.
 */
import fs from 'node:fs';
import { PATHS } from '../config.js';
import { ok, fail } from '../output.js';
import { loadIdentity } from '../wallet/identity.js';
import { ensureStateDir } from '../utils/storage.js';
import { fetchWithTimeout } from '../utils/woc.js';
/**
 * Load baemail configuration.
 */
export function loadBaemailConfig() {
    try {
        if (fs.existsSync(PATHS.baemailConfig)) {
            return JSON.parse(fs.readFileSync(PATHS.baemailConfig, 'utf-8'));
        }
    }
    catch (err) {
        console.warn(`[baemail] Warning: Could not read config: ${err.message}`);
    }
    return null;
}
/**
 * Save baemail configuration.
 */
export function saveBaemailConfig(config) {
    ensureStateDir();
    fs.writeFileSync(PATHS.baemailConfig, JSON.stringify(config, null, 2));
}
/**
 * Setup baemail service with delivery channel and tier pricing.
 */
export async function cmdBaemailSetup(channel, standardStr, priorityStr, urgentStr) {
    if (!channel || !standardStr) {
        return fail('Usage: baemail-setup <channel> <standardSats> [prioritySats] [urgentSats]');
    }
    const standard = parseInt(standardStr, 10);
    const priority = priorityStr ? parseInt(priorityStr, 10) : standard * 2;
    const urgent = urgentStr ? parseInt(urgentStr, 10) : standard * 5;
    if (isNaN(standard) || standard < 1) {
        return fail('Standard rate must be a positive integer (sats)');
    }
    if (priority < standard) {
        return fail('Priority rate must be >= standard rate');
    }
    if (urgent < priority) {
        return fail('Urgent rate must be >= priority rate');
    }
    const config = {
        deliveryChannel: channel,
        tiers: { standard, priority, urgent },
        maxMessageLength: 4000,
        blocklist: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    saveBaemailConfig(config);
    return ok({
        configured: true,
        deliveryChannel: channel,
        tiers: config.tiers,
        note: `Advertise with: overlay-cli advertise baemail "Baemail" "Paid message forwarding. Pay ${standard}+ sats to reach me." ${standard}`,
    });
}
/**
 * View current baemail configuration.
 */
export async function cmdBaemailConfig() {
    const config = loadBaemailConfig();
    if (!config) {
        return fail('Baemail not configured. Run: baemail-setup <channel> <standardSats> [prioritySats] [urgentSats]');
    }
    return ok(config);
}
/**
 * Block a sender from using baemail.
 */
export async function cmdBaemailBlock(identityKey) {
    if (!identityKey)
        return fail('Usage: baemail-block <identityKey>');
    const config = loadBaemailConfig();
    if (!config) {
        return fail('Baemail not configured. Run baemail-setup first.');
    }
    if (!config.blocklist)
        config.blocklist = [];
    if (config.blocklist.includes(identityKey)) {
        return fail('Identity already blocked');
    }
    config.blocklist.push(identityKey);
    config.updatedAt = new Date().toISOString();
    saveBaemailConfig(config);
    return ok({ blocked: identityKey, totalBlocked: config.blocklist.length });
}
/**
 * Unblock a sender.
 */
export async function cmdBaemailUnblock(identityKey) {
    if (!identityKey)
        return fail('Usage: baemail-unblock <identityKey>');
    const config = loadBaemailConfig();
    if (!config) {
        return fail('Baemail not configured. Run baemail-setup first.');
    }
    if (!config.blocklist || !config.blocklist.includes(identityKey)) {
        return fail('Identity not in blocklist');
    }
    config.blocklist = config.blocklist.filter(k => k !== identityKey);
    config.updatedAt = new Date().toISOString();
    saveBaemailConfig(config);
    return ok({ unblocked: identityKey, totalBlocked: config.blocklist.length });
}
/**
 * View baemail delivery log.
 */
export async function cmdBaemailLog(limitStr) {
    const limit = parseInt(limitStr || '20', 10) || 20;
    if (!fs.existsSync(PATHS.baemailLog)) {
        return ok({ log: [], count: 0 });
    }
    const lines = fs.readFileSync(PATHS.baemailLog, 'utf-8').split('\n').filter(l => l.trim());
    const entries = lines.map(l => {
        try {
            return JSON.parse(l);
        }
        catch {
            return null;
        }
    }).filter(Boolean);
    const recent = entries.slice(-limit).reverse();
    return ok({ log: recent, count: entries.length, showing: recent.length });
}
/**
 * Refund a failed baemail delivery.
 */
export async function cmdBaemailRefund(requestId) {
    if (!requestId)
        return fail('Usage: baemail-refund <requestId>');
    if (!fs.existsSync(PATHS.baemailLog)) {
        return fail('No baemail log found');
    }
    // Find the entry
    const lines = fs.readFileSync(PATHS.baemailLog, 'utf-8').split('\n').filter(l => l.trim());
    const entries = lines.map((l, idx) => {
        try {
            return { ...JSON.parse(l), _lineIdx: idx };
        }
        catch {
            return null;
        }
    }).filter(Boolean);
    const entry = entries.find(e => e.requestId === requestId);
    if (!entry) {
        return fail(`Request ${requestId} not found in baemail log`);
    }
    if (entry.deliverySuccess) {
        return fail('This delivery was successful — no refund needed');
    }
    if (entry.refundStatus === 'completed') {
        return fail('Refund already processed for this request');
    }
    // Load wallet and SDK
    const { identityKey, privKey } = await loadIdentity();
    const walletIdentityRaw = fs.readFileSync(PATHS.walletIdentity, 'utf-8');
    const walletIdentity = JSON.parse(walletIdentityRaw);
    // Dynamic import SDK
    let sdk;
    try {
        sdk = await import('@bsv/sdk');
    }
    catch {
        return fail('Cannot load @bsv/sdk for refund transaction');
    }
    const { Transaction, P2PKH, PrivateKey, PublicKey, Hash } = sdk;
    // Calculate refund amount
    const refundSats = entry.paidSats - 1; // Keep 1 sat for tx fee
    if (refundSats < 1) {
        return fail('Amount too small to refund');
    }
    // Derive refund address from sender's identity key
    const senderPubKey = PublicKey.fromString(entry.from);
    const refundAddress = senderPubKey.toAddress().toString();
    try {
        // Load UTXOs
        const address = walletIdentity.address;
        const utxosResp = await fetchWithTimeout(`https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent`);
        const utxos = await utxosResp.json();
        if (!utxos || utxos.length === 0) {
            return fail('No UTXOs available for refund');
        }
        // Build transaction
        const tx = new Transaction();
        let totalInput = 0;
        const rootKey = PrivateKey.fromHex(walletIdentity.rootKeyHex);
        for (const utxo of utxos) {
            if (totalInput >= refundSats + 50)
                break;
            tx.addInput({
                sourceTXID: utxo.tx_hash,
                sourceOutputIndex: utxo.tx_pos,
                sourceSatoshis: utxo.value,
                script: new P2PKH().lock(rootKey.toPublicKey().toAddress()).toHex(),
                unlockingScriptTemplate: new P2PKH().unlock(rootKey),
            });
            totalInput += utxo.value;
        }
        if (totalInput < refundSats + 10) {
            return fail('Insufficient funds for refund');
        }
        // Refund output
        tx.addOutput({
            satoshis: refundSats,
            lockingScript: new P2PKH().lock(refundAddress),
        });
        // Change output
        const fee = 10;
        const change = totalInput - refundSats - fee;
        if (change > 1) {
            tx.addOutput({
                satoshis: change,
                lockingScript: new P2PKH().lock(rootKey.toPublicKey().toAddress()),
            });
        }
        await tx.sign();
        // Broadcast
        const broadcastResp = await fetchWithTimeout('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txhex: tx.toHex() }),
        });
        if (!broadcastResp.ok) {
            const errBody = await broadcastResp.text();
            return fail(`Broadcast failed: ${errBody}`);
        }
        const txid = tx.id('hex');
        // Update log entry
        const updatedLines = lines.map((l, idx) => {
            if (idx === entry._lineIdx) {
                const updated = { ...JSON.parse(l), refundStatus: 'completed', refundTxid: txid, refundedAt: new Date().toISOString() };
                return JSON.stringify(updated);
            }
            return l;
        });
        fs.writeFileSync(PATHS.baemailLog, updatedLines.join('\n') + '\n');
        return ok({
            refunded: true,
            requestId,
            refundSats,
            refundAddress,
            txid,
            note: `Refunded ${refundSats} sats to sender`,
        });
    }
    catch (err) {
        return fail(`Refund failed: ${err.message}`);
    }
}
