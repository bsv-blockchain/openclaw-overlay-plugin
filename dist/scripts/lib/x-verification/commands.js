/**
 * X (Twitter) verification commands.
 */
import fs from 'node:fs';
import { PROTOCOL_ID, TOPICS, LOOKUP_SERVICES, PATHS } from '../config.js';
import { ok, fail } from '../output.js';
import { loadIdentity } from '../wallet/identity.js';
import { loadXVerifications, saveXVerifications, readJsonl, ensureStateDir } from '../utils/storage.js';
import { buildRealOverlayTransaction, lookupOverlay } from '../overlay/transaction.js';
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
 * Start X verification: generate a tweet with identity key and signature.
 */
export async function cmdXVerifyStart(handleArg) {
    if (!handleArg) {
        return fail('Usage: x-verify-start <@handle>');
    }
    const sdk = await getSdk();
    const handle = handleArg.startsWith('@') ? handleArg : `@${handleArg}`;
    const { identityKey, privKey } = await loadIdentity();
    // Sign the verification message
    const message = `Verify ${identityKey}`;
    const msgHash = sdk.Hash.sha256(Array.from(new TextEncoder().encode(message)));
    const sig = privKey.sign(msgHash);
    const signatureHex = Array.from(sig.toDER()).map((b) => b.toString(16).padStart(2, '0')).join('');
    // Save pending verification
    const pending = {
        identityKey,
        handle,
        signature: signatureHex,
        message,
        createdAt: new Date().toISOString(),
    };
    ensureStateDir();
    fs.writeFileSync(PATHS.pendingXVerification, JSON.stringify(pending, null, 2));
    // Build tweet text (under 280 chars)
    // Use shortened signature (first 40 chars) to fit in tweet
    const tweetText = `BSV Agent Verify: ${identityKey.slice(0, 10)}...${identityKey.slice(-10)} sig:${signatureHex.slice(0, 40)}`;
    return ok({
        tweetText,
        handle,
        identityKey,
        signature: signatureHex,
        note: `Post the tweet above from ${handle}, then run: x-verify-complete <tweet_url>`,
    });
}
/**
 * Complete X verification by checking the posted tweet.
 */
export async function cmdXVerifyComplete(tweetUrl) {
    if (!tweetUrl)
        return fail('Usage: x-verify-complete <tweet-url>');
    // Load pending verification
    if (!fs.existsSync(PATHS.pendingXVerification)) {
        return fail('No pending X verification. Run x-verify-start first.');
    }
    const pending = JSON.parse(fs.readFileSync(PATHS.pendingXVerification, 'utf-8'));
    // Extract tweet ID from URL
    const tweetIdMatch = tweetUrl.match(/status\/(\d+)/);
    if (!tweetIdMatch)
        return fail('Invalid tweet URL. Expected format: https://x.com/user/status/123456789');
    const tweetId = tweetIdMatch[1];
    // Fetch the tweet using bird CLI
    let tweetData;
    try {
        const { execSync } = await import('child_process');
        const birdOutput = execSync(`bird read ${tweetUrl} --json 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 30000,
        });
        tweetData = JSON.parse(birdOutput);
    }
    catch (err) {
        return fail(`Failed to fetch tweet: ${err.message}. Make sure bird CLI is configured.`);
    }
    // Verify the tweet contains our identity key and partial signature
    const tweetText = tweetData.text || tweetData.full_text || '';
    if (!tweetText.includes(pending.identityKey.slice(0, 10))) {
        return fail('Tweet does not contain the expected identity key.');
    }
    // Check for partial signature (first 40 chars)
    if (!tweetText.includes(pending.signature.slice(0, 40))) {
        return fail('Tweet does not contain the expected verification signature prefix.');
    }
    // Get the X user info from the tweet
    const xUserId = tweetData.user?.id_str || tweetData.authorId || tweetData.author?.id || tweetData.user_id;
    const xHandle = tweetData.user?.screen_name || tweetData.author?.username || tweetData.author?.name || pending.handle.replace('@', '');
    if (!xUserId) {
        return fail('Could not extract X user ID from tweet data.');
    }
    // Build on-chain verification record
    const verificationPayload = {
        protocol: PROTOCOL_ID,
        type: 'x-verification',
        identityKey: pending.identityKey,
        xHandle: `@${xHandle}`,
        xUserId,
        tweetId,
        tweetUrl,
        signature: pending.signature,
        verifiedAt: new Date().toISOString(),
    };
    // Submit to overlay (may fail if topic manager not deployed yet)
    let result = { txid: null, funded: 'pending-server-support' };
    let onChainStored = false;
    try {
        result = await buildRealOverlayTransaction(verificationPayload, TOPICS.X_VERIFICATION);
        onChainStored = true;
    }
    catch (err) {
        console.error(`[x-verify] On-chain storage failed: ${err.message}`);
        console.error('[x-verify] Storing verification locally.');
    }
    // Save verification locally
    const verifications = loadXVerifications();
    verifications.push({
        ...verificationPayload,
        txid: result.txid,
    });
    saveXVerifications(verifications);
    // Clean up pending
    fs.unlinkSync(PATHS.pendingXVerification);
    return ok({
        verified: true,
        identityKey: pending.identityKey,
        xHandle: `@${xHandle}`,
        xUserId,
        tweetId,
        txid: result.txid,
        funded: result.funded,
        onChainStored,
        note: onChainStored ? undefined : 'Stored locally. On-chain anchoring pending server topic manager deployment.',
    });
}
/**
 * List verified X accounts (local cache).
 */
export async function cmdXVerifications() {
    const verifications = loadXVerifications();
    return ok({ verifications, count: verifications.length });
}
/**
 * Lookup X verifications from the overlay network.
 */
export async function cmdXLookup(query) {
    try {
        const lookupQuery = query
            ? (query.startsWith('@') ? { xHandle: query } : { identityKey: query })
            : { type: 'list' };
        const response = await lookupOverlay(LOOKUP_SERVICES.X_VERIFICATIONS, lookupQuery);
        return ok({ verifications: response.outputs || response || [], query: lookupQuery });
    }
    catch {
        return ok({ verifications: [], query, note: 'X verification lookup service may not be deployed yet.' });
    }
}
/**
 * List pending X engagement requests.
 */
export async function cmdXEngagementQueue() {
    if (!fs.existsSync(PATHS.xEngagementQueue)) {
        return ok({ queue: [], count: 0 });
    }
    const queue = readJsonl(PATHS.xEngagementQueue).filter(e => e.status === 'pending');
    return ok({ queue, count: queue.length });
}
/**
 * Mark an X engagement request as fulfilled.
 */
export async function cmdXEngagementFulfill(requestId, proofUrl) {
    if (!requestId)
        return fail('Usage: x-engagement-fulfill <requestId> [proofUrl]');
    if (!fs.existsSync(PATHS.xEngagementQueue)) {
        return fail('No engagement queue found.');
    }
    const queue = readJsonl(PATHS.xEngagementQueue);
    const entryIndex = queue.findIndex(e => e.requestId === requestId);
    if (entryIndex === -1) {
        return fail(`Request ${requestId} not found in queue.`);
    }
    // Mark as fulfilled
    queue[entryIndex].status = 'fulfilled';
    queue[entryIndex].fulfilledAt = new Date().toISOString();
    queue[entryIndex].proofUrl = proofUrl || null;
    // Rewrite queue file
    fs.writeFileSync(PATHS.xEngagementQueue, queue.map(e => JSON.stringify(e)).join('\n') + '\n');
    return ok({
        fulfilled: true,
        requestId,
        entry: queue[entryIndex],
    });
}
