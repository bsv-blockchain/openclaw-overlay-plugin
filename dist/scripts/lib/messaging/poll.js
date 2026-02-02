/**
 * Poll command: fetch and process all pending messages.
 */
import { OVERLAY_URL } from '../config.js';
import { ok, fail } from '../output.js';
import { loadIdentity } from '../wallet/identity.js';
import { processMessage } from './handlers.js';
/**
 * Poll command: fetch all pending messages and process them.
 */
export async function cmdPoll() {
    const { identityKey, privKey } = await loadIdentity();
    // Fetch inbox
    const inboxResp = await fetch(`${OVERLAY_URL}/relay/inbox?identity=${identityKey}`);
    if (!inboxResp.ok) {
        const body = await inboxResp.text();
        return fail(`Relay inbox failed (${inboxResp.status}): ${body}`);
    }
    const inbox = await inboxResp.json();
    if (inbox.count === 0) {
        return ok({ processed: 0, messages: [], summary: 'No pending messages.' });
    }
    const processed = [];
    const ackedIds = [];
    const unhandled = [];
    for (const msg of inbox.messages) {
        const result = await processMessage(msg, identityKey, privKey);
        if (result.ack) {
            ackedIds.push(result.id);
            processed.push(result);
        }
        else {
            unhandled.push(result);
        }
    }
    // ACK processed messages
    if (ackedIds.length > 0) {
        await fetch(`${OVERLAY_URL}/relay/ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity: identityKey, messageIds: ackedIds }),
        });
    }
    return ok({
        processed: processed.length,
        unhandled: unhandled.length,
        total: inbox.count,
        messages: processed,
        unhandledMessages: unhandled,
        ackedIds,
    });
}
