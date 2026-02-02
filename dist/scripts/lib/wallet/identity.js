/**
 * Wallet identity helpers.
 */
import fs from 'node:fs';
import { PATHS } from '../config.js';
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
 * Load wallet identity from disk.
 * @returns Identity object with rootKeyHex and identityKey
 * @throws Error if wallet not initialized
 */
export function loadWalletIdentity() {
    if (!fs.existsSync(PATHS.walletIdentity)) {
        throw new Error('Wallet not initialized. Run: overlay-cli setup');
    }
    // Security warning for overly permissive file mode
    try {
        const fileMode = fs.statSync(PATHS.walletIdentity).mode & 0o777;
        if (fileMode & 0o044) { // world or group readable
            console.error(`[security] WARNING: ${PATHS.walletIdentity} has permissive mode 0${fileMode.toString(8)}. Run: chmod 600 ${PATHS.walletIdentity}`);
        }
    }
    catch {
        // Ignore stat errors
    }
    return JSON.parse(fs.readFileSync(PATHS.walletIdentity, 'utf-8'));
}
/**
 * Load identity and private key for relay message signing.
 * @returns Object with identityKey and privKey
 */
export async function loadIdentity() {
    const identity = loadWalletIdentity();
    const sdk = await getSdk();
    const privKey = sdk.PrivateKey.fromHex(identity.rootKeyHex);
    return { identityKey: identity.identityKey, privKey };
}
/**
 * Sign a relay message using ECDSA.
 * @param privKey - Private key for signing
 * @param to - Recipient's identity key
 * @param type - Message type
 * @param payload - Message payload
 * @returns Hex-encoded DER signature
 */
export async function signRelayMessage(privKey, to, type, payload) {
    const sdk = await getSdk();
    const preimage = to + type + JSON.stringify(payload);
    const msgHash = sdk.Hash.sha256(Array.from(new TextEncoder().encode(preimage)));
    const sig = privKey.sign(msgHash);
    return Array.from(sig.toDER()).map((b) => b.toString(16).padStart(2, '0')).join('');
}
/**
 * Verify a relay message signature.
 * @param fromKey - Sender's public key
 * @param to - Recipient's identity key
 * @param type - Message type
 * @param payload - Message payload
 * @param signatureHex - Hex-encoded DER signature
 * @returns Verification result
 */
export async function verifyRelaySignature(fromKey, to, type, payload, signatureHex) {
    if (!signatureHex)
        return { valid: false, reason: 'no signature' };
    try {
        const sdk = await getSdk();
        const preimage = to + type + JSON.stringify(payload);
        const msgHash = sdk.Hash.sha256(Array.from(new TextEncoder().encode(preimage)));
        const sigBytes = [];
        for (let i = 0; i < signatureHex.length; i += 2) {
            sigBytes.push(parseInt(signatureHex.substring(i, i + 2), 16));
        }
        const sig = sdk.Signature.fromDER(sigBytes);
        const pubKey = sdk.PublicKey.fromString(fromKey);
        return { valid: pubKey.verify(msgHash, sig) };
    }
    catch (err) {
        return { valid: false, reason: String(err) };
    }
}
/**
 * Derive wallet address components from a private key.
 */
export async function deriveWalletAddress(privKey) {
    const sdk = await getSdk();
    const { NETWORK } = await import('../config.js');
    const pubKey = privKey.toPublicKey();
    const pubKeyBytes = pubKey.encode(true);
    const hash160 = sdk.Hash.hash160(pubKeyBytes);
    const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
    const addrPayload = new Uint8Array([prefix, ...hash160]);
    const checksum = sdk.Hash.hash256(Array.from(addrPayload)).slice(0, 4);
    const addressBytes = new Uint8Array([...addrPayload, ...checksum]);
    const address = sdk.Utils.toBase58(Array.from(addressBytes));
    return { address, hash160, pubKey };
}
