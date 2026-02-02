/**
 * Overlay transaction building utilities.
 */
import { NETWORK, OVERLAY_URL } from '../config.js';
import { wocFetch, fetchBeefFromWoC } from '../utils/woc.js';
import { loadStoredChange, saveStoredChange, deleteStoredChange } from '../utils/storage.js';
import { loadWalletIdentity, deriveWalletAddress } from '../wallet/identity.js';
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
 * Build a PUSHDATA script for OP_RETURN data.
 */
function pushData(data) {
    const len = data.length;
    if (len <= 75) {
        return new Uint8Array([len, ...data]);
    }
    else if (len <= 255) {
        return new Uint8Array([0x4c, len, ...data]);
    }
    else if (len <= 65535) {
        return new Uint8Array([0x4d, len & 0xff, (len >> 8) & 0xff, ...data]);
    }
    throw new Error('Data too large for OP_RETURN');
}
/**
 * Build an OP_RETURN locking script with JSON payload.
 */
export function buildOpReturnScript(payload) {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
    const opReturn = 0x6a;
    const protocolBytes = pushData(new TextEncoder().encode('clawdbot'));
    const payloadBytes = pushData(jsonBytes);
    return new Uint8Array([opReturn, ...protocolBytes, ...payloadBytes]);
}
/**
 * Build and submit an overlay transaction.
 * @param payload - JSON data to store in OP_RETURN
 * @param topic - Topic manager for submission
 * @returns Transaction result with txid and funding info
 */
export async function buildRealOverlayTransaction(payload, topic) {
    const sdk = await getSdk();
    const identity = loadWalletIdentity();
    const privKey = sdk.PrivateKey.fromHex(identity.rootKeyHex);
    const { address, hash160 } = await deriveWalletAddress(privKey);
    const OP_RETURN_SATS = 1;
    const MIN_CHANGE = 200;
    const MAX_FEE = 100; // max fee we're willing to pay
    const MIN_INPUT = OP_RETURN_SATS + MIN_CHANGE + MAX_FEE;
    // --- Fund the transaction ---
    let sourceTx = null;
    let sourceVout = 0;
    let inputSats = 0;
    let sourceChain = [];
    let usedStoredBeef = false;
    // First, try stored BEEF change
    const storedChange = loadStoredChange();
    if (storedChange && storedChange.satoshis >= MIN_INPUT) {
        try {
            sourceTx = sdk.Transaction.fromHex(storedChange.txHex);
            sourceVout = storedChange.vout;
            inputSats = storedChange.satoshis;
            // Reconstruct source chain for full BEEF
            if (storedChange.sourceChain && storedChange.sourceChain.length > 0) {
                let childTx = sourceTx;
                for (const entry of storedChange.sourceChain) {
                    const srcTx = sdk.Transaction.fromHex(entry.txHex);
                    if (entry.merklePathHex) {
                        const mpBytes = entry.merklePathHex.match(/.{2}/g).map((h) => parseInt(h, 16));
                        srcTx.merklePath = sdk.MerklePath.fromBinary(mpBytes);
                    }
                    childTx.inputs[0].sourceTransaction = srcTx;
                    childTx = srcTx;
                }
                sourceChain = storedChange.sourceChain;
            }
            usedStoredBeef = true;
        }
        catch {
            // Fallback to WoC
        }
    }
    // If no stored BEEF, fetch from WoC
    if (!sourceTx) {
        const utxoResp = await wocFetch(`/address/${address}/unspent`);
        if (!utxoResp.ok) {
            throw new Error(`Failed to fetch UTXOs: ${utxoResp.status}`);
        }
        const utxos = await utxoResp.json();
        const suitableUtxo = utxos.find((u) => u.value >= MIN_INPUT);
        if (!suitableUtxo) {
            throw new Error(`No suitable UTXO found. Need ≥ ${MIN_INPUT} sats. Fund address: ${address}`);
        }
        // Try WoC BEEF first
        const beefBytes = await fetchBeefFromWoC(suitableUtxo.tx_hash);
        if (beefBytes) {
            const beef = sdk.Beef.fromBinary(Array.from(beefBytes));
            const beefTx = beef.findTxid(suitableUtxo.tx_hash);
            if (beefTx) {
                sourceTx = beefTx.tx || beefTx._tx;
                if (!sourceTx) {
                    throw new Error('BEEF tx object not found');
                }
                sourceVout = suitableUtxo.tx_pos;
                inputSats = suitableUtxo.value;
            }
        }
        if (!sourceTx) {
            throw new Error(`Cannot obtain BEEF for UTXO ${suitableUtxo.tx_hash}. Transaction may be unconfirmed.`);
        }
    }
    // --- Build the transaction ---
    const tx = new sdk.Transaction();
    tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: sourceVout,
        unlockingScriptTemplate: new sdk.P2PKH().unlock(privKey),
    });
    // OP_RETURN output
    const opReturnScript = buildOpReturnScript(payload);
    tx.addOutput({
        lockingScript: { toBinary: () => opReturnScript },
        satoshis: OP_RETURN_SATS,
    });
    // Change output
    const estimatedSize = 148 + 34 + opReturnScript.length + 34 + 10;
    const fee = Math.max(Math.ceil(estimatedSize / 1000), 1);
    const changeAmount = inputSats - OP_RETURN_SATS - fee;
    if (changeAmount >= MIN_CHANGE) {
        tx.addOutput({
            lockingScript: new sdk.P2PKH().lock(hash160),
            satoshis: changeAmount,
        });
    }
    // Sign
    await tx.sign();
    const txid = tx.id('hex');
    const beefForOverlay = tx.toBEEF();
    // --- Submit to overlay ---
    const submitResp = await fetch(`${OVERLAY_URL}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            beef: sdk.Utils.toBase64(beefForOverlay),
            topics: [topic],
        }),
    });
    if (!submitResp.ok) {
        const errText = await submitResp.text();
        throw new Error(`Overlay submission failed: ${submitResp.status} — ${errText}`);
    }
    // --- Save change for next tx ---
    if (changeAmount >= MIN_CHANGE) {
        const newSourceChain = [{ txHex: sourceTx.toHex(), txid: sourceTx.id('hex') }];
        if (!usedStoredBeef) {
            // First tx in chain — try to add merkle proof from WoC
            try {
                const proofResp = await wocFetch(`/tx/${sourceTx.id('hex')}/proof/tsc`, {}, 1, 5000);
                if (proofResp.ok) {
                    const proofData = await proofResp.json();
                    if (Array.isArray(proofData) && proofData.length > 0) {
                        const proof = proofData[0];
                        const { buildMerklePathFromTSC } = await import('../utils/merkle.js');
                        const mp = await buildMerklePathFromTSC(sourceTx.id('hex'), proof.index, proof.nodes, proof.blockHeight || 0);
                        newSourceChain[0].merklePathHex = Array.from(mp.toBinary()).map((b) => b.toString(16).padStart(2, '0')).join('');
                        newSourceChain[0].blockHeight = proof.blockHeight;
                    }
                }
            }
            catch {
                // Non-fatal
            }
        }
        else {
            newSourceChain.push(...sourceChain);
        }
        saveStoredChange({
            txHex: tx.toHex(),
            txid,
            vout: 1, // change is output index 1
            satoshis: changeAmount,
            sourceChain: newSourceChain.slice(0, 10), // limit chain depth
            savedAt: new Date().toISOString(),
        });
    }
    else {
        deleteStoredChange();
    }
    const wocNet = NETWORK === 'mainnet' ? '' : 'test.';
    return {
        txid,
        funded: usedStoredBeef ? 'stored-beef' : 'woc',
        explorer: `https://${wocNet}whatsonchain.com/tx/${txid}`,
    };
}
/**
 * Lookup data from an overlay lookup service.
 */
export async function lookupOverlay(service, query) {
    const resp = await fetch(`${OVERLAY_URL}/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, query }),
    });
    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Lookup failed: ${resp.status} — ${errText}`);
    }
    return resp.json();
}
/**
 * Parse an overlay output from BEEF data.
 */
export async function parseOverlayOutput(beefBase64, outputIndex) {
    const sdk = await getSdk();
    try {
        const beefBytes = typeof beefBase64 === 'string'
            ? new Uint8Array(sdk.Utils.fromBase64(beefBase64))
            : beefBase64;
        const tx = sdk.Transaction.fromAtomicBEEF(Array.from(beefBytes));
        const output = tx.outputs[outputIndex];
        if (!output)
            return null;
        const script = output.lockingScript.toBinary();
        if (script[0] !== 0x6a)
            return null; // Not OP_RETURN
        // Parse PUSHDATA opcodes to extract JSON
        let offset = 1;
        const readPush = () => {
            if (offset >= script.length)
                return null;
            const op = script[offset++];
            if (op <= 75) {
                const data = script.slice(offset, offset + op);
                offset += op;
                return data;
            }
            else if (op === 0x4c) {
                const len = script[offset++];
                const data = script.slice(offset, offset + len);
                offset += len;
                return data;
            }
            else if (op === 0x4d) {
                const len = script[offset] | (script[offset + 1] << 8);
                offset += 2;
                const data = script.slice(offset, offset + len);
                offset += len;
                return data;
            }
            return null;
        };
        // First push: protocol ID ('clawdbot')
        readPush();
        // Second push: JSON payload
        const payloadBytes = readPush();
        if (!payloadBytes)
            return null;
        const json = new TextDecoder().decode(payloadBytes);
        return JSON.parse(json);
    }
    catch {
        return null;
    }
}
