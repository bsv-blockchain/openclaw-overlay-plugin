/**
 * Payment CLI commands: pay, verify, accept.
 */
import { NETWORK, WALLET_DIR } from '../config.js';
import { ok, fail } from '../output.js';
import { buildDirectPayment } from './build.js';
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
/**
 * Pay command: send satoshis to another agent.
 */
export async function cmdPay(pubkey, satoshis, description) {
    if (!pubkey || !satoshis) {
        return fail('Usage: pay <pubkey> <satoshis> [description]');
    }
    const sats = parseInt(satoshis, 10);
    if (isNaN(sats) || sats <= 0) {
        return fail('satoshis must be a positive integer');
    }
    try {
        const payment = await buildDirectPayment(pubkey, sats, description || 'agent payment');
        return ok(payment);
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/**
 * Verify command: verify an incoming payment BEEF.
 */
export async function cmdVerify(beefBase64) {
    if (!beefBase64) {
        return fail('Usage: verify <beef_base64>');
    }
    const BSVAgentWallet = await getBSVAgentWallet();
    const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
    try {
        const result = wallet.verifyPayment({ beef: beefBase64 });
        await wallet.destroy();
        return ok(result);
    }
    catch (err) {
        await wallet.destroy();
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/**
 * Accept command: accept and internalize a payment.
 */
export async function cmdAccept(beef, derivationPrefix, derivationSuffix, senderIdentityKey, description) {
    if (!beef || !derivationPrefix || !derivationSuffix || !senderIdentityKey) {
        return fail('Usage: accept <beef> <prefix> <suffix> <senderKey> [description]');
    }
    const BSVAgentWallet = await getBSVAgentWallet();
    const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
    try {
        const receipt = await wallet.acceptPayment({
            beef,
            derivationPrefix,
            derivationSuffix,
            senderIdentityKey,
            description: description || undefined,
        });
        await wallet.destroy();
        return ok(receipt);
    }
    catch (err) {
        await wallet.destroy();
        return fail(err instanceof Error ? err.message : String(err));
    }
}
