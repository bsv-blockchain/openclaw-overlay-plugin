/**
 * Inbox and ack commands.
 */
import { OVERLAY_URL } from '../config.js';
import { ok, fail } from '../output.js';
import { loadIdentity, verifyRelaySignature } from '../wallet/identity.js';
/**
 * Inbox command: fetch pending messages.
 */
export async function cmdInbox(args) {
    const { identityKey } = await loadIdentity();
    let since = '';
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--since' && args[i + 1])
            since = `&since=${args[++i]}`;
    }
    const resp = await fetch(`${OVERLAY_URL}/relay/inbox?identity=${identityKey}${since}`);
    if (!resp.ok) {
        const body = await resp.text();
        return fail(`Relay inbox failed (${resp.status}): ${body}`);
    }
    const result = await resp.json();
    // Verify signatures on received messages
    const messages = await Promise.all(result.messages.map(async (msg) => ({
        ...msg,
        signatureValid: msg.signature
            ? (await verifyRelaySignature(msg.from, msg.to, msg.type, msg.payload, msg.signature)).valid
            : null,
    })));
    return ok({ messages, count: messages.length, identityKey });
}
/**
 * Ack command: acknowledge processed messages.
 */
export async function cmdAck(messageIds) {
    if (!messageIds || messageIds.length === 0) {
        return fail('Usage: ack <messageId> [messageId2 ...]');
    }
    const { identityKey } = await loadIdentity();
    const resp = await fetch(`${OVERLAY_URL}/relay/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: identityKey, messageIds }),
    });
    if (!resp.ok) {
        const body = await resp.text();
        return fail(`Relay ack failed (${resp.status}): ${body}`);
    }
    const result = await resp.json();
    return ok({ acked: result.acked, messageIds });
}
