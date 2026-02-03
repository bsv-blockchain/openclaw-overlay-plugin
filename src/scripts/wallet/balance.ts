/**
 * Wallet balance commands: balance, import, refund.
 */

import fs from 'node:fs';
import { NETWORK, WALLET_DIR, PATHS } from '../config.js';
import { ok, fail } from '../output.js';
import { loadWalletIdentity, deriveWalletKeys } from './identity.js';
import { wocFetch, fetchBeefFromWoC, getExplorerBaseUrl } from '../utils/woc.js';
import { buildMerklePathFromTSC } from '../utils/merkle.js';
import { loadStoredChange, deleteStoredChange } from '../utils/storage.js';

import { BSVAgentWallet } from '../../core/index.js';

async function getBSVAgentWallet(): Promise<typeof BSVAgentWallet> {
  return BSVAgentWallet;
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
 * Sleep helper for polling
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    const rootPrivKey = sdk.PrivateKey.fromHex(identity.rootKeyHex);
    const { address } = await deriveWalletKeys(rootPrivKey);

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
 * 
 * This function handles both confirmed and unconfirmed transactions.
 * For unconfirmed transactions, it uses BEEF from WoC which includes
 * the source chain back to confirmed ancestors (SPV-compliant).
 * 
 * If the transaction isn't yet on WoC (just broadcast), it will poll
 * with exponential backoff for up to 60 seconds.
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

  // Poll for transaction on WoC with exponential backoff
  // This handles the case where user just broadcast and WoC hasn't indexed yet
  let txInfo: any = null;
  const maxWaitMs = 60000; // 60 seconds max
  const startTime = Date.now();
  let attempt = 0;
  
  while (Date.now() - startTime < maxWaitMs) {
    const txInfoResp = await wocFetch(`/tx/${txid}`, {}, 1, 10000); // Single retry, 10s timeout
    
    if (txInfoResp.ok) {
      txInfo = await txInfoResp.json();
      break;
    } else if (txInfoResp.status === 404) {
      // Transaction not found yet - wait and retry
      attempt++;
      const delayMs = Math.min(1000 * Math.pow(1.5, attempt), 10000); // 1s, 1.5s, 2.25s, ... max 10s
      console.error(`[import] Transaction not on WoC yet, waiting ${Math.round(delayMs/1000)}s... (attempt ${attempt})`);
      await sleep(delayMs);
      continue;
    } else {
      return fail(`Failed to fetch tx info: ${txInfoResp.status}`);
    }
  }

  if (!txInfo) {
    return fail(`Transaction ${txid} not found on WhatsOnChain after ${Math.round((Date.now() - startTime) / 1000)}s. The transaction may not have been broadcast yet, or the txid may be incorrect.`);
  }

  const isConfirmed = txInfo.confirmations && txInfo.confirmations >= 1;
  const blockHeight = txInfo.blockheight;

  // Validate output exists
  if (!txInfo.vout || !txInfo.vout[vout]) {
    return fail(`Output index ${vout} not found in transaction (has ${txInfo.vout?.length || 0} outputs)`);
  }

  let atomicBeefBytes: Uint8Array | undefined;

  // Try WoC BEEF first - works for both confirmed and unconfirmed transactions
  // WoC provides BEEF with full source chain back to confirmed ancestors
  const wocBeefBytes = await fetchBeefFromWoC(txid);
  
  if (wocBeefBytes) {
    try {
      const wocBeef = sdk.Beef.fromBinary(Array.from(wocBeefBytes));
      const foundTx = wocBeef.findTxid(txid);
      
      if (foundTx) {
        // Verify the output exists in the parsed tx
        const txObj = foundTx.tx || foundTx._tx;
        if (txObj) {
          const output = txObj.outputs[vout];
          if (!output) {
            return fail(`Output index ${vout} not found in BEEF transaction (has ${txObj.outputs.length} outputs)`);
          }
        }
        atomicBeefBytes = wocBeef.toBinaryAtomic(txid);
      }
    } catch (beefErr: any) {
      console.error(`[import] WoC BEEF parse failed: ${beefErr.message}`);
      // Fall through to manual construction
    }
  }

  // Fallback for confirmed txs: construct BEEF manually using TSC merkle proof
  if (!atomicBeefBytes && isConfirmed) {
    try {
      const rawTxResp = await wocFetch(`/tx/${txid}/hex`);
      if (!rawTxResp.ok) {
        return fail(`Failed to fetch raw transaction: ${rawTxResp.status}`);
      }
      const rawTxHex = await rawTxResp.text();
      const sourceTx = sdk.Transaction.fromHex(rawTxHex.trim());

      const proofResp = await wocFetch(`/tx/${txid}/proof/tsc`);
      if (!proofResp.ok) {
        return fail(`Failed to fetch merkle proof: ${proofResp.status}`);
      }
      const proofData = await proofResp.json();
      
      if (!Array.isArray(proofData) || proofData.length === 0) {
        return fail('Merkle proof not available from WoC');
      }

      const proof = proofData[0];
      const merklePath = await buildMerklePathFromTSC(txid, proof.index, proof.nodes, blockHeight);
      sourceTx.merklePath = merklePath;

      const beef = new sdk.Beef();
      beef.mergeTransaction(sourceTx);
      atomicBeefBytes = beef.toBinaryAtomic(txid);
    } catch (manualErr: any) {
      return fail(`Failed to construct BEEF manually: ${manualErr.message}`);
    }
  }

  // If still no BEEF, we can't import
  if (!atomicBeefBytes) {
    if (isConfirmed) {
      return fail(`Transaction ${txid} is confirmed but BEEF construction failed. This is unexpected — please report this issue.`);
    } else {
      // Unconfirmed and no BEEF available
      // This can happen if the funding tx itself spends unconfirmed inputs
      return fail(
        `Transaction ${txid} is unconfirmed (${txInfo.confirmations || 0} confirmations) and BEEF is not available.\n\n` +
        `This usually means the funding transaction spends from other unconfirmed transactions, creating a chain.\n` +
        `Wait for 1 block confirmation (~10 minutes) and try again, or use a fresh UTXO as the funding source.`
      );
    }
  }

  // Get output satoshis for reporting
  const outputSatoshis = txInfo.vout[vout].value != null
    ? Math.round(txInfo.vout[vout].value * 1e8)
    : undefined;

  // Import into wallet
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();

  try {
    await wallet._setup.wallet.storage.internalizeAction({
      tx: Array.from(atomicBeefBytes),
      outputs: [{
        outputIndex: vout,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: sdk.Utils.toBase64(sdk.Utils.toArray('import', 'utf8')),
          derivationSuffix: sdk.Utils.toBase64(sdk.Utils.toArray('now', 'utf8')),
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
    
    // Provide helpful error messages for common issues
    if (err.message?.includes('already') || err.message?.includes('duplicate')) {
      return fail(`UTXO ${txid}:${vout} appears to already be imported.`);
    }
    if (err.message?.includes('script') || err.message?.includes('locking')) {
      return fail(`UTXO ${txid}:${vout} does not belong to this wallet's address. Make sure you sent to the correct address.`);
    }
    
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
  const rootPrivKey = sdk.PrivateKey.fromHex(identity.rootKeyHex);
  const { address: sourceAddress, hash160, childPrivKey } = await deriveWalletKeys(rootPrivKey);

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
      unlockingScriptTemplate: new sdk.P2PKH().unlock(childPrivKey),
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
      unlockingScriptTemplate: new sdk.P2PKH().unlock(childPrivKey),
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
