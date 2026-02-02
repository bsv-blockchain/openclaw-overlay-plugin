/**
 * Wallet balance commands: balance, import, refund.
 */

import fs from 'node:fs';
import { NETWORK, WALLET_DIR, OVERLAY_STATE_DIR, PATHS } from '../config.js';
import { ok, fail } from '../output.js';
import { loadWalletIdentity, deriveWalletAddress } from './identity.js';
import { wocFetch, fetchBeefFromWoC, getExplorerBaseUrl } from '../utils/woc.js';
import { buildMerklePathFromTSC } from '../utils/merkle.js';
import { loadStoredChange, deleteStoredChange } from '../utils/storage.js';

// Dynamic import for BSVAgentWallet
let _BSVAgentWallet: any = null;

async function getBSVAgentWallet(): Promise<any> {
  if (_BSVAgentWallet) return _BSVAgentWallet;

  try {
    const core = await import('@a2a-bsv/core');
    _BSVAgentWallet = core.BSVAgentWallet;
    return _BSVAgentWallet;
  } catch {
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
      } catch {
        // Try next
      }
    }
    throw new Error('Cannot find @a2a-bsv/core. Run setup.sh first.');
  }
}

// Dynamic import for @bsv/sdk
let _sdk: any = null;

async function getSdk(): Promise<any> {
  if (_sdk) return _sdk;

  try {
    _sdk = await import('@bsv/sdk');
    return _sdk;
  } catch {
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
      } catch {
        // Try next
      }
    }
    throw new Error('Cannot find @bsv/sdk. Run setup.sh first.');
  }
}

/**
 * Balance command: show wallet balance.
 */
export async function cmdBalance(): Promise<never> {
  const BSVAgentWallet = await getBSVAgentWallet();
  const sdk = await getSdk();

  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const total = await wallet.getBalance();
  await wallet.destroy();

  // Also check on-chain balance via WoC for completeness
  let onChain: { address: string; confirmed: number; unconfirmed: number } | null = null;
  try {
    const identity = loadWalletIdentity();
    const privKey = sdk.PrivateKey.fromHex(identity.rootKeyHex);
    const { address } = await deriveWalletAddress(privKey);

    const resp = await wocFetch(`/address/${address}/balance`);
    if (resp.ok) {
      const bal = await resp.json();
      onChain = {
        address,
        confirmed: bal.confirmed,
        unconfirmed: bal.unconfirmed,
      };
    }
  } catch {
    // Non-fatal
  }

  return ok({ walletBalance: total, onChain });
}

/**
 * Import command: import external UTXO with merkle proof.
 */
export async function cmdImport(txidArg: string | undefined, voutStr?: string): Promise<never> {
  if (!txidArg) {
    return fail('Usage: import <txid> [vout]');
  }

  const vout = parseInt(voutStr || '0', 10);
  const txid = txidArg.toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(txid)) {
    return fail('Invalid txid — must be 64 hex characters');
  }

  const sdk = await getSdk();
  const BSVAgentWallet = await getBSVAgentWallet();

  // Check confirmation status
  const txInfoResp = await wocFetch(`/tx/${txid}`);
  if (!txInfoResp.ok) {
    return fail(`Failed to fetch tx info: ${txInfoResp.status}`);
  }
  const txInfo = await txInfoResp.json();

  const isConfirmed = txInfo.confirmations && txInfo.confirmations >= 1;
  const blockHeight = txInfo.blockheight;

  let atomicBeefBytes: Uint8Array;

  if (isConfirmed) {
    // Confirmed path: use merkle proof
    const rawTxResp = await wocFetch(`/tx/${txid}/hex`);
    if (!rawTxResp.ok) {
      return fail(`Failed to fetch raw tx: ${rawTxResp.status}`);
    }
    const rawTxHex = await rawTxResp.text();
    const sourceTx = sdk.Transaction.fromHex(rawTxHex);
    const output = sourceTx.outputs[vout];
    if (!output) {
      return fail(`Output index ${vout} not found (tx has ${sourceTx.outputs.length} outputs)`);
    }

    // Try WoC BEEF first (even for confirmed — it's more reliable)
    let usedWocBeef = false;
    const wocBeefBytes = await fetchBeefFromWoC(txid);
    if (wocBeefBytes) {
      try {
        const wocBeef = sdk.Beef.fromBinary(Array.from(wocBeefBytes));
        const foundTx = wocBeef.findTxid(txid);
        if (foundTx) {
          atomicBeefBytes = wocBeef.toBinaryAtomic(txid);
          usedWocBeef = true;
        }
      } catch (beefErr: any) {
        console.error(`[cmdImport] WoC BEEF parse failed for confirmed tx: ${beefErr.message}`);
      }
    }

    // Fallback: manual TSC proof
    if (!usedWocBeef) {
      const proofResp = await wocFetch(`/tx/${txid}/proof/tsc`);
      if (!proofResp.ok) {
        return fail(`Failed to fetch merkle proof: ${proofResp.status}`);
      }
      const proofData = await proofResp.json();
      if (!Array.isArray(proofData) || proofData.length === 0) {
        return fail('No merkle proof available');
      }

      const proof = proofData[0];
      const merklePath = await buildMerklePathFromTSC(txid, proof.index, proof.nodes, blockHeight);
      sourceTx.merklePath = merklePath;

      const beef = new sdk.Beef();
      beef.mergeTransaction(sourceTx);
      atomicBeefBytes = beef.toBinaryAtomic(txid);
    }
  } else {
    // Unconfirmed path: try WoC BEEF (includes source chain back to confirmed ancestor)
    const wocBeefBytes = await fetchBeefFromWoC(txid);
    if (wocBeefBytes) {
      try {
        const wocBeef = sdk.Beef.fromBinary(Array.from(wocBeefBytes));
        const foundTx = wocBeef.findTxid(txid);
        if (!foundTx) {
          return fail(`Transaction ${txid} is unconfirmed and WoC BEEF does not contain it. Wait for 1+ confirmation.`);
        }
        // Verify the output exists
        const txObj = foundTx.tx || foundTx._tx;
        if (txObj) {
          const output = txObj.outputs[vout];
          if (!output) {
            return fail(`Output index ${vout} not found (tx has ${txObj.outputs.length} outputs)`);
          }
        }
        atomicBeefBytes = wocBeef.toBinaryAtomic(txid);
      } catch (beefErr: any) {
        return fail(`Transaction ${txid} is unconfirmed (${txInfo.confirmations || 0} confirmations) and WoC BEEF failed: ${beefErr.message}. Wait for 1+ confirmation.`);
      }
    } else {
      return fail(`Transaction ${txid} is unconfirmed (${txInfo.confirmations || 0} confirmations) and no BEEF available from WoC. Wait for 1+ confirmation.`);
    }
  }

  // Fetch output satoshis for reporting
  let outputSatoshis = txInfo.vout?.[vout]?.value != null
    ? Math.round(txInfo.vout[vout].value * 1e8)
    : undefined;

  // Import into wallet
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();

  try {
    await wallet._setup.wallet.storage.internalizeAction({
      tx: atomicBeefBytes!,
      outputs: [{
        outputIndex: vout,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: sdk.Utils.toBase64(Array.from(new TextEncoder().encode('imported'))),
          derivationSuffix: sdk.Utils.toBase64(Array.from(new TextEncoder().encode(txid.slice(0, 16)))),
          senderIdentityKey: identityKey,
        },
      }],
      description: 'External funding import',
    });

    const balance = await wallet.getBalance();
    await wallet.destroy();

    const explorerBase = getExplorerBaseUrl();
    return ok({
      txid,
      vout,
      satoshis: outputSatoshis,
      blockHeight: blockHeight || null,
      confirmations: txInfo.confirmations || 0,
      imported: true,
      unconfirmed: !isConfirmed,
      balance,
      explorer: `${explorerBase}/tx/${txid}`,
    });
  } catch (err: any) {
    await wallet.destroy();
    return fail(`Failed to import UTXO: ${err.message}`);
  }
}

/**
 * Refund command: sweep wallet to an address.
 */
export async function cmdRefund(targetAddress: string | undefined): Promise<never> {
  if (!targetAddress) {
    return fail('Usage: refund <address>');
  }

  if (!fs.existsSync(PATHS.walletIdentity)) {
    return fail('Wallet not initialized. Run: setup');
  }

  const sdk = await getSdk();
  const identity = loadWalletIdentity();
  const privKey = sdk.PrivateKey.fromHex(identity.rootKeyHex);
  const { address: sourceAddress, hash160 } = await deriveWalletAddress(privKey);

  // Refund sweeps all funds — needs WoC to discover all UTXOs (manual command)
  const utxoResp = await wocFetch(`/address/${sourceAddress}/unspent`);
  if (!utxoResp.ok) {
    return fail(`Failed to fetch UTXOs: ${utxoResp.status}`);
  }
  const utxos = await utxoResp.json();
  if (!utxos || utxos.length === 0) {
    return fail(`No UTXOs found for ${sourceAddress}`);
  }

  // Also include stored BEEF change if available (may not be on-chain yet)
  const storedChange = loadStoredChange();
  let storedBeefTx: { stored: any; tx: any } | null = null;
  let storedBeefIncluded = false;

  if (storedChange && storedChange.satoshis > 0 && !utxos.some((u: any) => u.tx_hash === storedChange.txid)) {
    try {
      // Reconstruct tx from stored chain
      const tx = sdk.Transaction.fromHex(storedChange.txHex);
      if (storedChange.sourceChain && storedChange.sourceChain.length > 0) {
        let childTx = tx;
        for (const entry of storedChange.sourceChain) {
          const srcTx = sdk.Transaction.fromHex(entry.txHex);
          if (entry.merklePathHex) {
            const mpBytes = entry.merklePathHex.match(/.{2}/g)!.map((h: string) => parseInt(h, 16));
            srcTx.merklePath = sdk.MerklePath.fromBinary(mpBytes);
          }
          childTx.inputs[0].sourceTransaction = srcTx;
          childTx = srcTx;
        }
      }
      storedBeefTx = { stored: storedChange, tx };
    } catch {
      // Ignore errors reconstructing stored change
    }
  }

  const tx = new sdk.Transaction();
  let totalInput = 0;

  // Add stored BEEF input first (has full source chain, no WoC needed)
  if (storedBeefTx) {
    tx.addInput({
      sourceTransaction: storedBeefTx.tx,
      sourceOutputIndex: storedBeefTx.stored.vout,
      unlockingScriptTemplate: new sdk.P2PKH().unlock(privKey),
    });
    totalInput += storedBeefTx.stored.satoshis;
    storedBeefIncluded = true;
  }

  // Add WoC UTXOs
  const sourceTxCache: Record<string, string> = {};
  for (const utxo of utxos) {
    if (!sourceTxCache[utxo.tx_hash]) {
      const txResp = await wocFetch(`/tx/${utxo.tx_hash}/hex`);
      if (!txResp.ok) continue; // skip on error, non-fatal for sweep
      sourceTxCache[utxo.tx_hash] = await txResp.text();
    }
    const srcTx = sdk.Transaction.fromHex(sourceTxCache[utxo.tx_hash]);
    tx.addInput({
      sourceTransaction: srcTx,
      sourceOutputIndex: utxo.tx_pos,
      unlockingScriptTemplate: new sdk.P2PKH().unlock(privKey),
    });
    totalInput += utxo.value;
  }

  if (totalInput === 0) {
    return fail('No spendable funds found');
  }

  const targetDecoded = sdk.Utils.fromBase58(targetAddress);
  const targetHash160 = targetDecoded.slice(1, 21);
  tx.addOutput({
    lockingScript: new sdk.P2PKH().lock(targetHash160),
    satoshis: totalInput,
  });

  const inputCount = tx.inputs.length;
  const estimatedSize = inputCount * 148 + 34 + 10;
  const fee = Math.max(Math.ceil(estimatedSize / 1000), 100);
  if (totalInput <= fee) {
    return fail(`Total value (${totalInput} sats) ≤ fee (${fee} sats)`);
  }
  tx.outputs[0].satoshis = totalInput - fee;

  await tx.sign();
  const txid = tx.id('hex');

  // Broadcast (required for refund — funds leave the overlay)
  const broadcastResp = await wocFetch(`/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: tx.toHex() }),
  });

  if (!broadcastResp.ok) {
    const errText = await broadcastResp.text();
    return fail(`Broadcast failed: ${broadcastResp.status} — ${errText}`);
  }

  // Clear stored BEEF since we swept everything
  deleteStoredChange();

  const broadcastResult = await broadcastResp.text();
  const explorerBase = getExplorerBaseUrl();

  return ok({
    txid: broadcastResult.replace(/"/g, '').trim(),
    satoshisSent: totalInput - fee,
    fee,
    inputCount,
    totalInput,
    from: sourceAddress,
    to: targetAddress,
    storedBeefIncluded,
    network: NETWORK,
    explorer: `${explorerBase}/tx/${txid}`,
  });
}
