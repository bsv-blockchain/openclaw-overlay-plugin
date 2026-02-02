/**
 * Send relay message command.
 */
import { OVERLAY_URL } from '../config.js';
import { ok, fail } from '../output.js';
import { loadIdentity, signRelayMessage } from '../wallet/identity.js';
/**
 * Send command: send a typed message to another agent.
 */
export async function cmdSend(targetKey, type, payloadStr) {
    if (!targetKey || !type || !payloadStr) {
        return fail('Usage: send <identityKey> <type> <json_payload>');
    }
    if (!/^0[23][0-9a-fA-F]{64}$/.test(targetKey)) {
        return fail('Target must be a compressed public key (66 hex chars, 02/03 prefix)');
    }
    let payload;
    try {
        payload = JSON.parse(payloadStr);
    }
    catch {
        return fail('payload must be valid JSON');
    }
    const { identityKey, privKey } = await loadIdentity();
    const signature = await signRelayMessage(privKey, targetKey, type, payload);
    const resp = await fetch(`${OVERLAY_URL}/relay/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: identityKey,
            to: targetKey,
            type,
            payload,
            signature,
        }),
    });
    if (!resp.ok) {
        const body = await resp.text();
        return fail(`Relay send failed (${resp.status}): ${body}`);
    }
    const result = await resp.json();
    return ok({ sent: true, messageId: result.id, to: targetKey, type, signed: true });
}
