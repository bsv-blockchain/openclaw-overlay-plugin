/**
 * Wallet setup commands: setup, identity, address.
 */
import fs from 'node:fs';
import { NETWORK, WALLET_DIR, OVERLAY_URL, PATHS } from '../config.js';
import { ok, fail } from '../output.js';
import { loadWalletIdentity, deriveWalletAddress } from './identity.js';
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
 * Setup command: create wallet and show identity.
 */
export async function cmdSetup() {
    const BSVAgentWallet = await getBSVAgentWallet();
    if (fs.existsSync(PATHS.walletIdentity)) {
        const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
        const identityKey = await wallet.getIdentityKey();
        await wallet.destroy();
        return ok({
            identityKey,
            walletDir: WALLET_DIR,
            network: NETWORK,
            overlayUrl: OVERLAY_URL,
            alreadyExisted: true,
        });
    }
    fs.mkdirSync(WALLET_DIR, { recursive: true });
    const wallet = await BSVAgentWallet.create({ network: NETWORK, storageDir: WALLET_DIR });
    const identityKey = await wallet.getIdentityKey();
    await wallet.destroy();
    // Restrict permissions on wallet-identity.json (contains private key)
    if (fs.existsSync(PATHS.walletIdentity)) {
        fs.chmodSync(PATHS.walletIdentity, 0o600);
    }
    return ok({
        identityKey,
        walletDir: WALLET_DIR,
        network: NETWORK,
        overlayUrl: OVERLAY_URL,
        alreadyExisted: false,
    });
}
/**
 * Identity command: show identity public key.
 */
export async function cmdIdentity() {
    const BSVAgentWallet = await getBSVAgentWallet();
    const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
    const identityKey = await wallet.getIdentityKey();
    await wallet.destroy();
    return ok({ identityKey });
}
/**
 * Address command: show P2PKH receive address.
 */
export async function cmdAddress() {
    if (!fs.existsSync(PATHS.walletIdentity)) {
        return fail('Wallet not initialized. Run: setup');
    }
    const sdk = await getSdk();
    const identity = loadWalletIdentity();
    const privKey = sdk.PrivateKey.fromHex(identity.rootKeyHex);
    const { address } = await deriveWalletAddress(privKey);
    return ok({
        address,
        network: NETWORK,
        identityKey: identity.identityKey,
        note: NETWORK === 'mainnet'
            ? `Fund this address at an exchange — Explorer: https://whatsonchain.com/address/${address}`
            : `Fund via faucet: https://witnessonchain.com/faucet/tbsv — Explorer: https://test.whatsonchain.com/address/${address}`,
    });
}
