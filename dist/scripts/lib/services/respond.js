/**
 * Service response commands.
 */
import fs from 'node:fs';
import { OVERLAY_URL, PATHS } from '../config.js';
import { ok, fail } from '../output.js';
import { loadIdentity, signRelayMessage } from '../wallet/identity.js';
/**
 * Respond to a service request.
 */
export async function cmdRespondService(requestId, recipientKey, serviceId, resultJson) {
    if (!requestId || !recipientKey || !serviceId || !resultJson) {
        return fail('Usage: respond-service <requestId> <recipientKey> <serviceId> <resultJson>');
    }
    let result;
    try {
        result = JSON.parse(resultJson);
    }
    catch {
        return fail('resultJson must be valid JSON');
    }
    const { identityKey, privKey } = await loadIdentity();
    const responsePayload = {
        requestId,
        serviceId,
        status: 'fulfilled',
        result,
    };
    const sig = await signRelayMessage(privKey, recipientKey, 'service-response', responsePayload);
    const resp = await fetch(`${OVERLAY_URL}/relay/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: identityKey,
            to: recipientKey,
            type: 'service-response',
            payload: responsePayload,
            signature: sig,
        }),
    });
    if (!resp.ok)
        return fail(`Relay send failed: ${resp.status}`);
    // Mark as fulfilled in queue
    if (fs.existsSync(PATHS.serviceQueue)) {
        const lines = fs.readFileSync(PATHS.serviceQueue, 'utf-8').trim().split('\n').filter(Boolean);
        const updated = lines.map(line => {
            try {
                const entry = JSON.parse(line);
                if (entry.requestId === requestId) {
                    return JSON.stringify({ ...entry, status: 'fulfilled', fulfilledAt: Date.now() });
                }
                return line;
            }
            catch {
                return line;
            }
        });
        fs.writeFileSync(PATHS.serviceQueue, updated.join('\n') + '\n');
    }
    return ok({ sent: true, requestId, serviceId, to: recipientKey });
}
/**
 * Respond to a research request with results.
 */
export async function cmdResearchRespond(resultJsonPath) {
    if (!resultJsonPath)
        return fail('Usage: research-respond <resultJsonFile>');
    if (!fs.existsSync(resultJsonPath))
        return fail(`File not found: ${resultJsonPath}`);
    const result = JSON.parse(fs.readFileSync(resultJsonPath, 'utf-8'));
    const { requestId, from: recipientKey, query, research } = result;
    if (!requestId || !recipientKey || !research) {
        return fail('Result JSON must have: requestId, from, query, research');
    }
    const { identityKey, privKey } = await loadIdentity();
    const responsePayload = {
        requestId,
        serviceId: 'web-research',
        status: 'fulfilled',
        result: research,
        paymentAccepted: true,
        paymentTxid: result.paymentTxid || null,
        satoshisReceived: result.satoshisReceived || 0,
        walletAccepted: result.walletAccepted ?? true,
    };
    const sig = await signRelayMessage(privKey, recipientKey, 'service-response', responsePayload);
    const sendResp = await fetch(`${OVERLAY_URL}/relay/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: identityKey,
            to: recipientKey,
            type: 'service-response',
            payload: responsePayload,
            signature: sig,
        }),
    });
    if (!sendResp.ok) {
        return fail(`Failed to send response: ${await sendResp.text()}`);
    }
    const sendResult = await sendResp.json();
    // Remove from queue
    if (fs.existsSync(PATHS.researchQueue)) {
        const lines = fs.readFileSync(PATHS.researchQueue, 'utf-8').trim().split('\n').filter(Boolean);
        const remaining = lines.filter(l => {
            try {
                return JSON.parse(l).requestId !== requestId;
            }
            catch {
                return true;
            }
        });
        fs.writeFileSync(PATHS.researchQueue, remaining.length ? remaining.join('\n') + '\n' : '');
    }
    return ok({ responded: true, requestId, to: recipientKey, query, pushed: sendResult.pushed });
}
