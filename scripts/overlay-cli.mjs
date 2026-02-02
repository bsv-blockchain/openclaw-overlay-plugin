#!/usr/bin/env node
/**
 * overlay-cli.mjs — Unified CLI for the Clawdbot BSV Overlay skill.
 *
 * Combines BSV wallet management, overlay registration/discovery, service
 * advertisement, and micropayments into a single self-contained CLI.
 *
 * All output is JSON with a { success, data/error } wrapper for agent parsing.
 *
 * Environment variables:
 *   BSV_WALLET_DIR  — wallet storage directory (default: ~/.clawdbot/bsv-wallet)
 *   BSV_NETWORK     — 'mainnet' or 'testnet' (default: mainnet)
 *   OVERLAY_URL     — overlay server URL (default: http://162.243.168.235:8080)
 *   AGENT_NAME      — agent display name for registration
 *
 * Commands:
 *   setup                                              — Create wallet, show identity
 *   identity                                           — Show identity public key
 *   address                                            — Show P2PKH receive address
 *   balance                                            — Show balance in satoshis
 *   import <txid> [vout]                               — Import external UTXO with merkle proof
 *   refund <address>                                   — Sweep wallet to address
 *   register                                           — Register identity + joke service on overlay
 *   unregister                                         — (future) Remove from overlay
 *   services                                           — List my advertised services
 *   advertise <serviceId> <name> <desc> <priceSats>    — Add a service to overlay
 *   readvertise <serviceId> <newPrice> [name] [desc]   — Re-advertise service with new price
 *   remove <serviceId>                                 — Remove a service (future)
 *   discover [--service <type>] [--agent <name>]       — Find agents/services on overlay
 *   pay <identityKey> <sats> [description]             — Pay another agent
 *   verify <beef_base64>                               — Verify incoming payment
 *   accept <beef> <prefix> <suffix> <senderKey> [desc] — Accept payment
 *
 * Messaging:
 *   send <identityKey> <type> <json_payload>           — Send a message via relay
 *   inbox [--since <ms>]                               — Check inbox for pending messages
 *   ack <messageId> [messageId2 ...]                   — Mark messages as read
 *   poll                                               — Process inbox (auto-handle known types)
 *   connect                                            — WebSocket real-time message processing
 *   request-service <identityKey> <serviceId> [sats]   — Pay + request a service
 */

// Suppress dotenv noise
const _origLog = console.log;
console.log = () => {};

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Resolve the @a2a-bsv/core library
// ---------------------------------------------------------------------------
let core;
try {
  core = await import('@a2a-bsv/core');
} catch {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // Try several possible paths
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules', '@a2a-bsv', 'core', 'dist', 'index.js'),
    path.resolve(__dirname, '..', '..', '..', 'a2a-bsv', 'packages', 'core', 'dist', 'index.js'),
    path.resolve(os.homedir(), 'a2a-bsv', 'packages', 'core', 'dist', 'index.js'),
  ];
  for (const p of candidates) {
    try {
      core = await import(p);
      break;
    } catch { /* next */ }
  }
  if (!core) {
    console.log = _origLog;
    console.log(JSON.stringify({ success: false, error: 'Cannot find @a2a-bsv/core. Run setup.sh first.' }));
    process.exit(1);
  }
}
const { BSVAgentWallet } = core;

// Resolve @bsv/sdk
let sdk;
try {
  sdk = await import('@bsv/sdk');
} catch {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
    path.resolve(__dirname, '..', '..', '..', 'a2a-bsv', 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
    path.resolve(os.homedir(), 'a2a-bsv', 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
  ];
  for (const p of candidates) {
    try {
      sdk = await import(p);
      break;
    } catch { /* next */ }
  }
  if (!sdk) {
    console.log = _origLog;
    console.log(JSON.stringify({ success: false, error: 'Cannot find @bsv/sdk. Run setup.sh first.' }));
    process.exit(1);
  }
}

// Restore console.log
console.log = _origLog;

const { PrivateKey, PublicKey, Hash, Utils, Transaction, Script, P2PKH, Beef, MerklePath, Signature } = sdk;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Auto-load .env from overlay state dir if it exists
const _overlayEnvPath = path.join(os.homedir(), '.clawdbot', 'bsv-overlay', '.env');
try {
  if (fs.existsSync(_overlayEnvPath)) {
    for (const line of fs.readFileSync(_overlayEnvPath, 'utf-8').split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  }
} catch {}

const WALLET_DIR = process.env.BSV_WALLET_DIR
  || path.join(os.homedir(), '.clawdbot', 'bsv-wallet');
const NETWORK = process.env.BSV_NETWORK || 'mainnet';
const OVERLAY_URL = process.env.OVERLAY_URL || 'http://162.243.168.235:8080';
const WOC_API_KEY = process.env.WOC_API_KEY || '';
const OVERLAY_STATE_DIR = path.join(os.homedir(), '.clawdbot', 'bsv-overlay');
const PROTOCOL_ID = 'clawdbot-overlay-v1';

/** 
 * Fetch from WhatsonChain with optional API key auth and retry logic.
 * Retries on 429 (rate limit) and 5xx errors with exponential backoff.
 * Includes timeout to prevent hanging indefinitely.
 */
async function wocFetch(urlPath, options = {}, maxRetries = 3, timeoutMs = 30000) {
  const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
  const base = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;
  const url = urlPath.startsWith('http') ? urlPath : `${base}${urlPath}`;
  const headers = { ...(options.headers || {}) };
  if (WOC_API_KEY) headers['Authorization'] = `Bearer ${WOC_API_KEY}`;
  
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Add timeout via AbortController
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      
      const resp = await fetch(url, { ...options, headers, signal: controller.signal });
      clearTimeout(timeout);
      
      // Retry on 429 (rate limit) or 5xx (server error)
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxRetries) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000); // 1s, 2s, 4s, 8s max
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      
      return resp;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
    }
  }
  
  throw lastError || new Error('WoC fetch failed after retries');
}
const TOPICS = { 
  IDENTITY: 'tm_clawdbot_identity', 
  SERVICES: 'tm_clawdbot_services',
  X_VERIFICATION: 'tm_clawdbot_x_verification',
};
const LOOKUP_SERVICES = { 
  AGENTS: 'ls_clawdbot_agents', 
  SERVICES: 'ls_clawdbot_services',
  X_VERIFICATIONS: 'ls_clawdbot_x_verifications',
};

// ---------------------------------------------------------------------------
// JSON output helpers
// ---------------------------------------------------------------------------
function ok(data) {
  console.log(JSON.stringify({ success: true, data }));
  process.exit(0);
}
function fail(error) {
  console.log(JSON.stringify({ success: false, error: String(error) }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Overlay helpers
// ---------------------------------------------------------------------------

/** Build an OP_FALSE OP_RETURN script with protocol prefix + JSON payload. */
function buildOpReturnScript(payload) {
  const protocolBytes = Array.from(new TextEncoder().encode(PROTOCOL_ID));
  const jsonBytes = Array.from(new TextEncoder().encode(JSON.stringify(payload)));
  const script = new Script();
  script.writeOpCode(0x00); // OP_FALSE
  script.writeOpCode(0x6a); // OP_RETURN
  script.writeBin(protocolBytes);
  script.writeBin(jsonBytes);
  return script;
}

/** Submit BEEF to the overlay. */
async function submitToOverlay(beefData, topics) {
  const url = `${OVERLAY_URL}/submit`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Topics': JSON.stringify(topics),
    },
    body: new Uint8Array(beefData),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Overlay submit failed (${response.status}): ${body}`);
  }
  return await response.json();
}

/** Query the overlay via lookup service. */
async function lookupOverlay(service, query = {}) {
  const url = `${OVERLAY_URL}/lookup`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, query }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Overlay lookup failed (${response.status}): ${body}`);
  }
  return await response.json();
}

/** Parse a Clawdbot OP_RETURN output from BEEF data. */
function parseOverlayOutput(beef, outputIndex) {
  try {
    const tx = Transaction.fromBEEF(beef);
    const output = tx.outputs[outputIndex];
    if (!output?.lockingScript) return null;

    const chunks = output.lockingScript.chunks;
    let pushes = null;

    // Legacy 4+ chunk format
    if (chunks.length >= 4 && chunks[0].op === 0x00 && chunks[1].op === 0x6a) {
      pushes = [];
      for (let i = 2; i < chunks.length; i++) {
        if (chunks[i].data) pushes.push(new Uint8Array(chunks[i].data));
      }
    }
    // Collapsed 2-chunk format (SDK v1.10+)
    else if (chunks.length === 2 && chunks[0].op === 0x00 && chunks[1].op === 0x6a && chunks[1].data) {
      const blob = chunks[1].data;
      pushes = [];
      let pos = 0;
      while (pos < blob.length) {
        const op = blob[pos++];
        if (op > 0 && op <= 75) {
          const end = Math.min(pos + op, blob.length);
          pushes.push(new Uint8Array(blob.slice(pos, end)));
          pos = end;
        } else if (op === 0x4c) {
          const len = blob[pos++] ?? 0;
          const end = Math.min(pos + len, blob.length);
          pushes.push(new Uint8Array(blob.slice(pos, end)));
          pos = end;
        } else if (op === 0x4d) {
          const len = (blob[pos] ?? 0) | ((blob[pos + 1] ?? 0) << 8);
          pos += 2;
          const end = Math.min(pos + len, blob.length);
          pushes.push(new Uint8Array(blob.slice(pos, end)));
          pos = end;
        } else {
          break;
        }
      }
      if (pushes.length < 2) pushes = null;
    }

    if (!pushes || pushes.length < 2) return null;

    const protocolStr = new TextDecoder().decode(pushes[0]);
    if (protocolStr !== PROTOCOL_ID) return null;

    return JSON.parse(new TextDecoder().decode(pushes[1]));
  } catch {
    return null;
  }
}

/**
 * Build an OP_RETURN overlay transaction using the real funded wallet.
 *
 * Strategy: manually construct the transaction using a real UTXO from the
 * wallet's on-chain holdings, sign it, build BEEF with merkle proof, and
 * import the change output back into the wallet.
 *
 * Falls back to synthetic funding (scripts-only mode) if wallet has no balance.
 */
async function buildRealOverlayTransaction(payload, topic) {
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) {
    throw new Error('Wallet not initialized. Run: overlay-cli setup');
  }
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  const pubKey = privKey.toPublicKey();

  // Derive the wallet's P2PKH address
  const pubKeyBytes = pubKey.encode(true);
  const hash160 = Hash.hash160(pubKeyBytes);
  const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
  const addrPayload = new Uint8Array([prefix, ...hash160]);
  const checksum = Hash.hash256(Array.from(addrPayload)).slice(0, 4);
  const addressBytes = new Uint8Array([...addrPayload, ...checksum]);
  const walletAddress = Utils.toBase58(Array.from(addressBytes));

  // === BEEF-first approach: use stored BEEF chain (no WoC, no blocks) ===
  const beefStorePath = path.join(OVERLAY_STATE_DIR, 'latest-change.json');
  let storedChange = null;
  try {
    if (fs.existsSync(beefStorePath)) {
      storedChange = JSON.parse(fs.readFileSync(beefStorePath, 'utf-8'));
    }
  } catch {}

  if (storedChange && storedChange.txHex && storedChange.satoshis >= 200) {
    try {
      return await buildFromStoredBeef(payload, topic, storedChange, privKey, pubKey, hash160);
    } catch (storedErr) {
      // Stored BEEF failed — fall through to WoC BEEF / UTXO lookup
      console.error(`[buildTx] Stored BEEF failed (${storedErr.message}), falling back to WoC BEEF approach...`);
    }
  }

  // === Fallback: WoC UTXO lookup (uses WoC BEEF-first, then manual chain-walk) ===
  const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
  const wocBase = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;
  let utxos = [];
  try {
    const resp = await wocFetch(`/address/${walletAddress}/unspent`);
    if (resp.ok) utxos = await resp.json();
  } catch {}
  utxos = utxos.filter(u => u.value >= 200);

  if (utxos.length > 0) {
    try {
      return await buildRealFundedTx(payload, topic, utxos[0], privKey, pubKey, hash160, walletAddress, wocBase);
    } catch (realErr) {
      console.error(`[buildTx] WoC funded tx failed (${realErr.message}), trying next fallback...`);
      // Fall through
    }
  }

  // === Last resort: wallet createAction or synthetic ===
  try {
    return await buildWalletCreateActionTx(payload, topic, identity);
  } catch (walletErr) {
    return await buildSyntheticTx(payload, privKey, pubKey);
  }
}

/** Save the change output's full tx chain for instant reuse (no WoC, no blocks needed) */
function saveChangeBeef(tx, changeSats, changeVout) {
  const beefStorePath = path.join(OVERLAY_STATE_DIR, 'latest-change.json');
  try {
    fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
    fs.writeFileSync(beefStorePath, JSON.stringify({
      txHex: tx.toHex(),
      txid: tx.id('hex'),
      vout: changeVout,
      satoshis: changeSats,
      // Store the full source chain as hex for reconstruction
      sourceChain: serializeSourceChain(tx),
      savedAt: new Date().toISOString(),
    }));
  } catch {}
}

/** Serialize the tx's input source chain (for BEEF reconstruction) */
function serializeSourceChain(tx) {
  const chain = [];
  let cur = tx;
  for (let depth = 0; depth < 15; depth++) {
    const src = cur.inputs?.[0]?.sourceTransaction;
    if (!src) break;
    const entry = { txHex: src.toHex(), txid: src.id('hex') };
    if (src.merklePath) {
      entry.merklePathHex = Array.from(src.merklePath.toBinary()).map(b => b.toString(16).padStart(2, '0')).join('');
      entry.blockHeight = src.merklePath.blockHeight;
    }
    chain.push(entry);
    cur = src;
  }
  return chain;
}

/** Reconstruct a tx with its full source chain from stored data */
function reconstructFromChain(storedChange) {
  const tx = Transaction.fromHex(storedChange.txHex);

  // Rebuild source chain
  if (storedChange.sourceChain && storedChange.sourceChain.length > 0) {
    let childTx = tx;
    for (const entry of storedChange.sourceChain) {
      const srcTx = Transaction.fromHex(entry.txHex);
      if (entry.merklePathHex) {
        const mpBytes = entry.merklePathHex.match(/.{2}/g).map(h => parseInt(h, 16));
        srcTx.merklePath = MerklePath.fromBinary(mpBytes);
      }
      childTx.inputs[0].sourceTransaction = srcTx;
      childTx = srcTx;
    }
  }
  return tx;
}

/** Build a tx using a stored BEEF chain (instant, no WoC needed) */
async function buildFromStoredBeef(payload, topic, storedChange, privKey, pubKey, hash160) {
  const sourceTx = reconstructFromChain(storedChange);

  const opReturnScript = buildOpReturnScript(payload);
  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: storedChange.vout,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: opReturnScript, satoshis: 0 });

  const fee = 200;
  const changeSats = storedChange.satoshis - fee;
  const changeVout = changeSats > 0 ? 1 : -1;
  if (changeSats > 0) {
    tx.addOutput({ lockingScript: new P2PKH().lock(Array.from(hash160)), satoshis: changeSats });
  }

  await tx.sign();
  const txid = tx.id('hex');

  // Build BEEF — auto-follows sourceTransaction links
  const beefObj = new Beef();
  beefObj.mergeTransaction(tx);
  const beef = beefObj.toBinary();

  // Submit to overlay
  const steak = await submitToOverlay(beef, [topic]);

  // CRITICAL: Broadcast to blockchain
  try {
    const broadcastResp = await wocFetch(`/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: tx.toHex() }),
    });
    if (!broadcastResp.ok) {
      const errText = await broadcastResp.text();
      console.error(`[broadcast] Failed: ${broadcastResp.status} — ${errText}`);
    }
  } catch (bcastErr) {
    console.error(`[broadcast] Error: ${bcastErr.message}`);
  }

  // Save this tx's change for next time
  if (changeSats > 0) {
    saveChangeBeef(tx, changeSats, 1);
  }

  return { txid, beef, steak, funded: 'stored-beef', changeSats };
}

/**
 * Fetch a pre-built BEEF from WhatsonChain for a given txid.
 * WoC returns raw binary BEEF that includes the full source chain and merkle proofs.
 * This is more reliable than manually walking the chain, especially for unconfirmed
 * or deep transaction chains.
 * @param {string} txid - Transaction ID to fetch BEEF for
 * @returns {Uint8Array|null} Raw BEEF bytes, or null if unavailable
 */
async function fetchBeefFromWoC(txid) {
  try {
    const resp = await wocFetch(`/tx/${txid}/beef`);
    if (!resp.ok) return null;
    // WoC returns BEEF as a hex string (not raw binary)
    const hexStr = (await resp.text()).trim();
    if (!hexStr || hexStr.length < 8) return null;
    const bytes = hexStr.match(/.{2}/g).map(h => parseInt(h, 16));
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

/** Build a real funded transaction using WoC UTXO */
async function buildRealFundedTx(payload, topic, utxo, privKey, pubKey, hash160, walletAddress, wocBase) {
  let sourceTx = null;
  let usedWocBeef = false;
  let wocBeefBytes = null;

  // === BEEF-first approach: fetch pre-built BEEF from WoC ===
  // This is more reliable than manually walking the chain, especially for
  // unconfirmed txs or deep chains that break after gateway restarts.
  wocBeefBytes = await fetchBeefFromWoC(utxo.tx_hash);
  if (wocBeefBytes) {
    try {
      const srcBeef = Beef.fromBinary(Array.from(wocBeefBytes));
      // Use findAtomicTransaction to get the tx with full proof tree
      // (sourceTransaction links + merklePaths populated)
      const provenTx = srcBeef.findAtomicTransaction(utxo.tx_hash);
      if (provenTx) {
        sourceTx = provenTx;
        usedWocBeef = true;
      }
    } catch (beefErr) {
      console.error(`[buildRealFundedTx] WoC BEEF parse failed for ${utxo.tx_hash}: ${beefErr.message}`);
      // Fall through to manual chain building
    }
  }

  // === Fallback: manual chain-walking approach ===
  if (!sourceTx) {
    const rawResp = await wocFetch(`/tx/${utxo.tx_hash}/hex`);
    if (!rawResp.ok) throw new Error(`Failed to fetch source tx: ${rawResp.status}`);
    const rawTxHex = await rawResp.text();
    sourceTx = Transaction.fromHex(rawTxHex);

    // Fetch merkle proof for the source tx
    const txInfoResp = await wocFetch(`/tx/${utxo.tx_hash}`);
    const txInfo = await txInfoResp.json();
    const blockHeight = txInfo.blockheight;

    // Walk the source chain back to a confirmed tx with merkle proof.
    let curTx = sourceTx;
    let curTxid = utxo.tx_hash;
    let curHeight = blockHeight;
    let curConf = txInfo.confirmations;

    for (let depth = 0; depth < 10; depth++) {
      if (curHeight && curConf > 0) {
        // Confirmed tx — attach merkle proof
        const proofResp = await wocFetch(`/tx/${curTxid}/proof/tsc`);
        if (proofResp.ok) {
          const proofData = await proofResp.json();
          if (Array.isArray(proofData) && proofData.length > 0) {
            const proof = proofData[0];
            curTx.merklePath = buildMerklePathFromTSC(curTxid, proof.index, proof.nodes, curHeight);
          }
        }
        break; // Found a proven tx, stop walking
      }
      // Unconfirmed — walk to its first input's source
      const parentTxid = curTx.inputs[0]?.sourceTXID;
      if (!parentTxid) break;
      const parentHexResp = await wocFetch(`/tx/${parentTxid}/hex`);
      if (!parentHexResp.ok) break;
      const parentTx = Transaction.fromHex(await parentHexResp.text());
      // Link the child's input to the parent Transaction object
      curTx.inputs[0].sourceTransaction = parentTx;
      const parentInfoResp = await wocFetch(`/tx/${parentTxid}`);
      if (!parentInfoResp.ok) break;
      const parentInfo = await parentInfoResp.json();
      curTx = parentTx;
      curTxid = parentTxid;
      curHeight = parentInfo.blockheight;
      curConf = parentInfo.confirmations;
    }
  }

  // Build the OP_RETURN transaction
  const opReturnScript = buildOpReturnScript(payload);

  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: utxo.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
    sequence: 0xffffffff,
  });

  // OP_RETURN output (0 sats)
  tx.addOutput({ lockingScript: opReturnScript, satoshis: 0 });

  // Change output back to our address
  const pubKeyHashArr = Array.from(hash160);
  const fee = 200; // generous fee for a small tx
  const changeSats = utxo.value - fee;
  if (changeSats > 0) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(pubKeyHashArr),
      satoshis: changeSats,
    });
  }

  await tx.sign();
  const txid = tx.id('hex');

  // Build BEEF
  const beefObj = new Beef();
  // If we have a WoC BEEF, merge it first for complete proof chain
  if (usedWocBeef && wocBeefBytes) {
    try {
      beefObj.mergeBeef(Array.from(wocBeefBytes));
    } catch (mergeErr) {
      console.error(`[buildRealFundedTx] WoC BEEF merge failed: ${mergeErr.message}`);
    }
  }
  // mergeTransaction follows sourceTransaction links for the full chain
  beefObj.mergeTransaction(tx);
  const beef = beefObj.toBinary();

  // Submit to overlay
  const steak = await submitToOverlay(beef, [topic]);

  // CRITICAL: Broadcast to blockchain
  try {
    const broadcastResp = await wocFetch(`/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: tx.toHex() }),
    });
    if (!broadcastResp.ok) {
      const errText = await broadcastResp.text();
      console.error(`[broadcast] Failed: ${broadcastResp.status} — ${errText}`);
    }
  } catch (bcastErr) {
    console.error(`[broadcast] Error: ${bcastErr.message}`);
  }

  // Save the change BEEF for instant chaining (no WoC needed next time)
  if (changeSats > 0) {
    saveChangeBeef(tx, changeSats, 1);
    try {
      await importChangeOutput(txid, tx, changeSats, 1);
    } catch (importErr) {
      // Non-fatal — BEEF store handles this now
    }
  }

  return { txid, beef, steak, funded: usedWocBeef ? 'real-woc-beef' : 'real', changeSats };
}

/** Build merkle path from TSC proof data */
function buildMerklePathFromTSC(txid, txIndex, nodes, blockHeight) {
  const treeHeight = nodes.length;
  const mpPath = [];

  // Level 0
  const level0 = [{ offset: txIndex, hash: txid, txid: true }];
  if (nodes[0] === '*') {
    level0.push({ offset: txIndex ^ 1, duplicate: true });
  } else {
    level0.push({ offset: txIndex ^ 1, hash: nodes[0] });
  }
  level0.sort((a, b) => a.offset - b.offset);
  mpPath.push(level0);

  // Higher levels
  for (let i = 1; i < treeHeight; i++) {
    const siblingOffset = (txIndex >> i) ^ 1;
    if (nodes[i] === '*') {
      mpPath.push([{ offset: siblingOffset, duplicate: true }]);
    } else {
      mpPath.push([{ offset: siblingOffset, hash: nodes[i] }]);
    }
  }

  return new MerklePath(blockHeight, mpPath);
}

/** Import a change output back into the wallet */
async function importChangeOutput(txid, tx, changeSats, vout) {
  try {
    const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
    const identityKey = await wallet.getIdentityKey();

    // Build a minimal BEEF for the change output
    const beef = new Beef();
    beef.mergeTransaction(tx);
    const atomicBeefBytes = beef.toBinaryAtomic(txid);

    await wallet._setup.wallet.storage.internalizeAction({
      tx: atomicBeefBytes,
      outputs: [{
        outputIndex: vout,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: Utils.toBase64(Array.from(new TextEncoder().encode('overlay-change'))),
          derivationSuffix: Utils.toBase64(Array.from(new TextEncoder().encode(txid.slice(0, 16)))),
          senderIdentityKey: identityKey,
        },
      }],
      description: 'Overlay tx change',
    });
    await wallet.destroy();
  } catch {
    // Non-fatal
  }
}

/** Try building via wallet's createAction (internal DB funding) */
async function buildWalletCreateActionTx(payload, topic, identity) {
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const balance = await wallet.getBalance();
  if (balance < 100) {
    await wallet.destroy();
    throw new Error(`Insufficient wallet balance (${balance} sats)`);
  }

  const opReturnScript = buildOpReturnScript(payload);

  try {
    const result = await wallet._setup.wallet.createAction({
      description: 'Overlay registration',
      outputs: [{
        lockingScript: opReturnScript.toHex(),
        satoshis: 0,
        outputDescription: 'Agent overlay data',
      }],
      options: {
        returnBEEF: true,
      },
    });

    await wallet.destroy();

    if (!result.tx) {
      throw new Error('createAction returned no transaction');
    }

    const beef = Array.from(result.tx);
    const steak = await submitToOverlay(beef, [topic]);
    const parsedBeef = Beef.fromBinary(result.tx);
    const lastTx = parsedBeef.txs[parsedBeef.txs.length - 1];
    const txid = lastTx.txid;

    // CRITICAL: Broadcast to blockchain
    try {
      const broadcastResp = await wocFetch(`/tx/raw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txhex: lastTx.toHex() }),
      });
      if (!broadcastResp.ok) {
        const errText = await broadcastResp.text();
        console.error(`[broadcast] Wallet-internal tx failed: ${broadcastResp.status} — ${errText}`);
      }
    } catch (bcastErr) {
      console.error(`[broadcast] Wallet-internal tx error: ${bcastErr.message}`);
    }

    return { txid, beef, steak, funded: 'wallet-internal' };
  } catch (err) {
    await wallet.destroy();
    throw err;
  }
}

/** Synthetic (unfunded) transaction — works only with SCRIPTS_ONLY overlay.
 *  Issue #6: Blocked on mainnet unless ALLOW_SYNTHETIC=true env var is set. */
async function buildSyntheticTx(payload, privKey, pubKey) {
  // Guard: never use synthetic funding on mainnet without explicit opt-in
  if (NETWORK === 'mainnet' && process.env.ALLOW_SYNTHETIC !== 'true') {
    throw new Error('No funds available. Import a UTXO first: overlay-cli import <txid>');
  }
  console.error(`[buildSyntheticTx] WARNING: Using synthetic (fabricated) funding on ${NETWORK}. This creates fake merkle proofs.`);
  const pubKeyHashHex = pubKey.toHash('hex');
  const pubKeyHash = [];
  for (let i = 0; i < pubKeyHashHex.length; i += 2) {
    pubKeyHash.push(parseInt(pubKeyHashHex.substring(i, i + 2), 16));
  }

  // Synthetic funding tx
  const fundingTx = new Transaction();
  fundingTx.addOutput({
    lockingScript: new P2PKH().lock(pubKeyHash),
    satoshis: 1000,
  });

  const fundingTxid = fundingTx.id('hex');
  const siblingHash = Hash.sha256(Array.from(new TextEncoder().encode(fundingTxid)));
  const siblingHex = Array.from(siblingHash).map(b => b.toString(16).padStart(2, '0')).join('');
  fundingTx.merklePath = new MerklePath(1, [[
    { offset: 0, hash: fundingTxid, txid: true },
    { offset: 1, hash: siblingHex },
  ]]);

  const opReturnScript = buildOpReturnScript(payload);
  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: fundingTx,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: opReturnScript, satoshis: 0 });
  tx.sign();

  const beef = tx.toBEEF();
  const txid = tx.id('hex');
  
  // CRITICAL: Broadcast to blockchain (even synthetic txs should be broadcast for relay to nodes)
  try {
    const broadcastResp = await wocFetch(`/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: tx.toHex() }),
    });
    if (!broadcastResp.ok) {
      const errText = await broadcastResp.text();
      console.error(`[broadcast] Synthetic tx failed: ${broadcastResp.status} — ${errText}`);
    }
  } catch (bcastErr) {
    console.error(`[broadcast] Synthetic tx error: ${bcastErr.message}`);
  }
  
  return { txid, beef, funded: 'synthetic' };
}

// ---------------------------------------------------------------------------
// Shared Payment Verification Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a P2PKH address from a private key.
 * Centralizes address derivation logic used across multiple functions.
 * @param {PrivateKey} privKey - The private key
 * @returns {{ address: string, hash160: Uint8Array, pubKey: PublicKey }}
 */
function deriveWalletAddress(privKey) {
  const pubKey = privKey.toPublicKey();
  const pubKeyBytes = pubKey.encode(true);
  const hash160 = Hash.hash160(pubKeyBytes);
  const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
  const addrPayload = new Uint8Array([prefix, ...hash160]);
  const checksum = Hash.hash256(Array.from(addrPayload)).slice(0, 4);
  const addressBytes = new Uint8Array([...addrPayload, ...checksum]);
  const address = Utils.toBase58(Array.from(addressBytes));
  return { address, hash160, pubKey };
}

/**
 * Fetch with timeout using AbortController.
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds (default: 15000)
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch UTXOs for an address from WhatsonChain.
 * @param {string} address - The BSV address
 * @param {number} minValue - Minimum UTXO value (filters dust)
 * @returns {Promise<Array>} Array of UTXOs with { tx_hash, tx_pos, value }
 */
async function fetchUtxosForAddress(address, minValue = 200) {
  const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
  const wocBase = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;
  const resp = await fetchWithTimeout(`${wocBase}/address/${address}/unspent`);
  if (!resp.ok) throw new Error(`Failed to fetch UTXOs: ${resp.status}`);
  const utxos = await resp.json();
  return utxos.filter(u => u.value >= minValue);
}

/**
 * Verify and accept a payment from BEEF data.
 * Handles BEEF decoding, tx parsing, output matching, amount verification,
 * and wallet internalization with WoC fallback.
 * 
 * @param {Object} payment - Payment object with beef, satoshis, derivationPrefix, derivationSuffix
 * @param {number} minSats - Minimum required satoshis
 * @param {string} senderKey - Sender's identity key
 * @param {string} serviceId - Service identifier for description
 * @param {Uint8Array} recipientHash160 - Recipient's pubkey hash
 * @returns {Promise<{ accepted: boolean, txid: string, satoshis: number, outputIndex: number, walletAccepted: boolean, error?: string }>}
 */
async function verifyAndAcceptPayment(payment, minSats, senderKey, serviceId, recipientHash160) {
  const result = {
    accepted: false,
    txid: null,
    satoshis: 0,
    outputIndex: -1,
    walletAccepted: false,
    error: null,
  };

  // Validate payment object
  if (!payment || !payment.beef || !payment.satoshis) {
    result.error = 'no payment';
    return result;
  }
  if (payment.satoshis < minSats) {
    result.error = `underpaid: ${payment.satoshis} < ${minSats}`;
    return result;
  }

  // Decode BEEF
  let beefBytes;
  try {
    beefBytes = Uint8Array.from(atob(payment.beef), c => c.charCodeAt(0));
  } catch {
    result.error = 'invalid base64';
    return result;
  }

  if (!beefBytes || beefBytes.length < 20) {
    result.error = 'invalid beef length';
    return result;
  }

  // Parse the payment transaction (try AtomicBEEF first, then regular BEEF)
  let paymentTx = null;
  let isAtomicBeef = false;
  
  try {
    paymentTx = Transaction.fromAtomicBEEF(beefBytes);
    isAtomicBeef = true;
  } catch {
    try {
      const beefObj = Beef.fromBinary(Array.from(beefBytes));
      paymentTx = beefObj.txs[beefObj.txs.length - 1];
    } catch (e2) {
      result.error = `beef parse failed: ${e2.message}`;
      return result;
    }
  }

  // Find the output paying us
  let paymentOutputIndex = -1;
  let paymentSats = 0;
  
  for (let i = 0; i < paymentTx.outputs.length; i++) {
    const out = paymentTx.outputs[i];
    const chunks = out.lockingScript?.chunks || [];
    
    // Standard P2PKH: OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG
    if (chunks.length === 5 && 
        chunks[0].op === 0x76 && chunks[1].op === 0xa9 &&
        chunks[2].data?.length === 20 &&
        chunks[3].op === 0x88 && chunks[4].op === 0xac) {
      const scriptHash = new Uint8Array(chunks[2].data);
      if (scriptHash.length === recipientHash160.length &&
          scriptHash.every((b, idx) => b === recipientHash160[idx])) {
        paymentOutputIndex = i;
        paymentSats = out.satoshis;
        break;
      }
    }
  }

  if (paymentOutputIndex < 0) {
    result.error = 'no matching output';
    return result;
  }
  if (paymentSats < minSats) {
    result.error = `output underpaid: ${paymentSats} < ${minSats}`;
    return result;
  }

  result.txid = paymentTx.id('hex');
  result.satoshis = paymentSats;
  result.outputIndex = paymentOutputIndex;
  result.accepted = true;

  // ── Accept payment: store the BEEF for later spending ──
  // The sender's BEEF contains the full proof chain. We just need to save it
  // so we can spend this output later (BEEF-first approach, no WoC needed).
  try {
    // Store the received payment BEEF as a spendable UTXO
    const paymentStorePath = path.join(OVERLAY_STATE_DIR, 'received-payments.jsonl');
    fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });

    // Reconstruct the payment tx with its source chain from the BEEF
    // The sender's BEEF has the full ancestry — preserve it
    const entry = {
      txid: result.txid,
      vout: paymentOutputIndex,
      satoshis: paymentSats,
      beefBase64: payment.beef,  // Keep the original BEEF from sender
      serviceId,
      from: senderKey,
      ts: Date.now(),
    };
    fs.appendFileSync(paymentStorePath, JSON.stringify(entry) + '\n');
    result.walletAccepted = true;
  } catch (err) {
    result.error = `payment store failed: ${err.message}`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------
function loadRegistration() {
  const regFile = path.join(OVERLAY_STATE_DIR, 'registration.json');
  if (fs.existsSync(regFile)) {
    return JSON.parse(fs.readFileSync(regFile, 'utf-8'));
  }
  return null;
}

function saveRegistration(data) {
  fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
  const regFile = path.join(OVERLAY_STATE_DIR, 'registration.json');
  fs.writeFileSync(regFile, JSON.stringify(data, null, 2), 'utf-8');
}

function loadServices() {
  const svcFile = path.join(OVERLAY_STATE_DIR, 'services.json');
  if (fs.existsSync(svcFile)) {
    return JSON.parse(fs.readFileSync(svcFile, 'utf-8'));
  }
  return [];
}

function saveServices(services) {
  fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
  const svcFile = path.join(OVERLAY_STATE_DIR, 'services.json');
  fs.writeFileSync(svcFile, JSON.stringify(services, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Wallet commands (adapted from bsv-agent-cli.mjs)
// ---------------------------------------------------------------------------

async function cmdSetup() {
  if (fs.existsSync(path.join(WALLET_DIR, 'wallet-identity.json'))) {
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
  // Issue #8: Restrict permissions on wallet-identity.json (contains private key)
  const newIdentityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (fs.existsSync(newIdentityPath)) {
    fs.chmodSync(newIdentityPath, 0o600);
  }
  ok({
    identityKey,
    walletDir: WALLET_DIR,
    network: NETWORK,
    overlayUrl: OVERLAY_URL,
    alreadyExisted: false,
  });
}

async function cmdIdentity() {
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();
  await wallet.destroy();
  ok({ identityKey });
}

async function cmdAddress() {
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized. Run: setup');

  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  const pubKey = privKey.toPublicKey();
  const pubKeyBytes = pubKey.encode(true);
  const hash160 = Hash.hash160(pubKeyBytes);

  const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
  const payload = new Uint8Array([prefix, ...hash160]);
  const checksum = Hash.hash256(Array.from(payload)).slice(0, 4);
  const addressBytes = new Uint8Array([...payload, ...checksum]);
  const address = Utils.toBase58(Array.from(addressBytes));

  ok({
    address,
    network: NETWORK,
    identityKey: identity.identityKey,
    note: NETWORK === 'mainnet'
      ? `Fund this address at an exchange — Explorer: https://whatsonchain.com/address/${address}`
      : `Fund via faucet: https://witnessonchain.com/faucet/tbsv — Explorer: https://test.whatsonchain.com/address/${address}`,
  });
}

async function cmdBalance() {
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const total = await wallet.getBalance();
  await wallet.destroy();

  // Also check on-chain balance via WoC for completeness
  let onChain = null;
  try {
    const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
    const privKey = PrivateKey.fromHex(identity.rootKeyHex);
    const pubKey = privKey.toPublicKey();
    const pubKeyBytes = pubKey.encode(true);
    const hash160 = Hash.hash160(pubKeyBytes);
    const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
    const payload = new Uint8Array([prefix, ...hash160]);
    const checksum = Hash.hash256(Array.from(payload)).slice(0, 4);
    const addressBytes = new Uint8Array([...payload, ...checksum]);
    const address = Utils.toBase58(Array.from(addressBytes));

    const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
    const resp = await wocFetch(`/address/${address}/balance`);
    if (resp.ok) {
      const bal = await resp.json();
      onChain = {
        address,
        confirmed: bal.confirmed,
        unconfirmed: bal.unconfirmed,
      };
    }
  } catch { /* non-fatal */ }

  ok({ walletBalance: total, onChain });
}

async function cmdImport(txidArg, voutStr) {
  if (!txidArg) return fail('Usage: import <txid> [vout]');
  const vout = parseInt(voutStr || '0', 10);
  const txid = txidArg.toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(txid)) return fail('Invalid txid — must be 64 hex characters');

  const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
  const wocBase = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;

  // Check confirmation status
  const txInfoResp = await wocFetch(`/tx/${txid}`);
  if (!txInfoResp.ok) return fail(`Failed to fetch tx info: ${txInfoResp.status}`);
  const txInfo = await txInfoResp.json();

  const isConfirmed = txInfo.confirmations && txInfo.confirmations >= 1;
  const blockHeight = txInfo.blockheight;

  let atomicBeefBytes;

  if (isConfirmed) {
    // === Confirmed path: use merkle proof (existing approach) ===
    // Fetch raw tx
    const rawTxResp = await wocFetch(`/tx/${txid}/hex`);
    if (!rawTxResp.ok) return fail(`Failed to fetch raw tx: ${rawTxResp.status}`);
    const rawTxHex = await rawTxResp.text();
    const sourceTx = Transaction.fromHex(rawTxHex);
    const output = sourceTx.outputs[vout];
    if (!output) return fail(`Output index ${vout} not found (tx has ${sourceTx.outputs.length} outputs)`);

    // Try WoC BEEF first (even for confirmed — it's more reliable)
    let usedWocBeef = false;
    const wocBeefBytes = await fetchBeefFromWoC(txid);
    if (wocBeefBytes) {
      try {
        const wocBeef = Beef.fromBinary(Array.from(wocBeefBytes));
        const foundTx = wocBeef.findTxid(txid);
        if (foundTx) {
          atomicBeefBytes = wocBeef.toBinaryAtomic(txid);
          usedWocBeef = true;
        }
      } catch (beefErr) {
        console.error(`[cmdImport] WoC BEEF parse failed for confirmed tx: ${beefErr.message}`);
      }
    }

    // Fallback: manual TSC proof
    if (!usedWocBeef) {
      const proofResp = await wocFetch(`/tx/${txid}/proof/tsc`);
      if (!proofResp.ok) return fail(`Failed to fetch merkle proof: ${proofResp.status}`);
      const proofData = await proofResp.json();
      if (!Array.isArray(proofData) || proofData.length === 0) return fail('No merkle proof available');

      const proof = proofData[0];
      const merklePath = buildMerklePathFromTSC(txid, proof.index, proof.nodes, blockHeight);
      sourceTx.merklePath = merklePath;

      const beef = new Beef();
      beef.mergeTransaction(sourceTx);
      atomicBeefBytes = beef.toBinaryAtomic(txid);
    }
  } else {
    // === Unconfirmed path: try WoC BEEF (includes source chain back to confirmed ancestor) ===
    const wocBeefBytes = await fetchBeefFromWoC(txid);
    if (wocBeefBytes) {
      try {
        const wocBeef = Beef.fromBinary(Array.from(wocBeefBytes));
        const foundTx = wocBeef.findTxid(txid);
        if (!foundTx) {
          return fail(`Transaction ${txid} is unconfirmed and WoC BEEF does not contain it. Wait for 1+ confirmation.`);
        }
        // Verify the output exists
        const txObj = foundTx.tx || foundTx._tx;
        if (txObj) {
          const output = txObj.outputs[vout];
          if (!output) return fail(`Output index ${vout} not found (tx has ${txObj.outputs.length} outputs)`);
        }
        atomicBeefBytes = wocBeef.toBinaryAtomic(txid);
      } catch (beefErr) {
        return fail(`Transaction ${txid} is unconfirmed (${txInfo.confirmations || 0} confirmations) and WoC BEEF failed: ${beefErr.message}. Wait for 1+ confirmation.`);
      }
    } else {
      return fail(`Transaction ${txid} is unconfirmed (${txInfo.confirmations || 0} confirmations) and no BEEF available from WoC. Wait for 1+ confirmation.`);
    }
  }

  // Fetch output satoshis for reporting (may not be available from BEEF path)
  let outputSatoshis = txInfo.vout?.[vout]?.value != null
    ? Math.round(txInfo.vout[vout].value * 1e8)
    : undefined;

  // Import into wallet
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();

  try {
    await wallet._setup.wallet.storage.internalizeAction({
      tx: atomicBeefBytes,
      outputs: [{
        outputIndex: vout,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: Utils.toBase64(Array.from(new TextEncoder().encode('imported'))),
          derivationSuffix: Utils.toBase64(Array.from(new TextEncoder().encode(txid.slice(0, 16)))),
          senderIdentityKey: identityKey,
        },
      }],
      description: 'External funding import',
    });

    const balance = await wallet.getBalance();
    await wallet.destroy();

    const explorerBase = NETWORK === 'mainnet' ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com';
    ok({
      txid, vout,
      satoshis: outputSatoshis,
      blockHeight: blockHeight || null,
      confirmations: txInfo.confirmations || 0,
      imported: true,
      unconfirmed: !isConfirmed,
      balance,
      explorer: `${explorerBase}/tx/${txid}`,
    });
  } catch (err) {
    await wallet.destroy();
    fail(`Failed to import UTXO: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdRefund(targetAddress) {
  if (!targetAddress) return fail('Usage: refund <address>');

  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized. Run: setup');
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));

  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  const pubKey = privKey.toPublicKey();
  const pubKeyBytes = pubKey.encode(true);
  const hash160 = Hash.hash160(pubKeyBytes);
  const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
  const payload = new Uint8Array([prefix, ...hash160]);
  const checksum = Hash.hash256(Array.from(payload)).slice(0, 4);
  const addressBytes = new Uint8Array([...payload, ...checksum]);
  const sourceAddress = Utils.toBase58(Array.from(addressBytes));

  const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
  const wocBase = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;

  // Refund sweeps all funds — needs WoC to discover all UTXOs (manual command)
  const utxoResp = await wocFetch(`/address/${sourceAddress}/unspent`);
  if (!utxoResp.ok) return fail(`Failed to fetch UTXOs: ${utxoResp.status}`);
  const utxos = await utxoResp.json();
  if (!utxos || utxos.length === 0) return fail(`No UTXOs found for ${sourceAddress}`);

  // Also include stored BEEF change if available (may not be on-chain yet)
  const beefStorePath = path.join(OVERLAY_STATE_DIR, 'latest-change.json');
  let storedBeefTx = null;
  let storedBeefIncluded = false;
  try {
    if (fs.existsSync(beefStorePath)) {
      const stored = JSON.parse(fs.readFileSync(beefStorePath, 'utf-8'));
      if (stored.satoshis > 0 && !utxos.some(u => u.tx_hash === stored.txid)) {
        storedBeefTx = { stored, tx: reconstructFromChain(stored) };
      }
    }
  } catch {}

  const tx = new Transaction();
  let totalInput = 0;

  // Add stored BEEF input first (has full source chain, no WoC needed)
  if (storedBeefTx) {
    tx.addInput({
      sourceTransaction: storedBeefTx.tx,
      sourceOutputIndex: storedBeefTx.stored.vout,
      unlockingScriptTemplate: new P2PKH().unlock(privKey),
    });
    totalInput += storedBeefTx.stored.satoshis;
    storedBeefIncluded = true;
  }

  // Add WoC UTXOs
  const sourceTxCache = {};
  for (const utxo of utxos) {
    if (!sourceTxCache[utxo.tx_hash]) {
      const txResp = await wocFetch(`/tx/${utxo.tx_hash}/hex`);
      if (!txResp.ok) continue; // skip on error, non-fatal for sweep
      sourceTxCache[utxo.tx_hash] = await txResp.text();
    }
    const srcTx = Transaction.fromHex(sourceTxCache[utxo.tx_hash]);
    tx.addInput({
      sourceTransaction: srcTx,
      sourceOutputIndex: utxo.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(privKey),
    });
    totalInput += utxo.value;
  }

  if (totalInput === 0) return fail('No spendable funds found');

  const targetDecoded = Utils.fromBase58(targetAddress);
  const targetHash160 = targetDecoded.slice(1, 21);
  tx.addOutput({
    lockingScript: new P2PKH().lock(targetHash160),
    satoshis: totalInput,
  });

  const inputCount = tx.inputs.length;
  const estimatedSize = inputCount * 148 + 34 + 10;
  const fee = Math.max(Math.ceil(estimatedSize / 1000), 100);
  if (totalInput <= fee) return fail(`Total value (${totalInput} sats) ≤ fee (${fee} sats)`);
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
  try { fs.unlinkSync(beefStorePath); } catch {}

  const broadcastResult = await broadcastResp.text();
  const explorerBase = NETWORK === 'mainnet' ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com';

  ok({
    txid: broadcastResult.replace(/"/g, '').trim(),
    satoshisSent: totalInput - fee,
    fee, inputCount, totalInput,
    from: sourceAddress, to: targetAddress,
    storedBeefIncluded,
    network: NETWORK,
    explorer: `${explorerBase}/tx/${txid}`,
  });
}

// ---------------------------------------------------------------------------
// Payment commands
// ---------------------------------------------------------------------------

/**
 * Build a direct P2PKH payment using on-chain UTXOs.
 * Bypasses wallet-toolbox's internal UTXO management which doesn't work
 * with externally funded P2PKH addresses.
 */
async function buildDirectPayment(recipientPubKey, sats, desc) {
  // Validate recipient pubkey format
  if (!/^0[23][0-9a-fA-F]{64}$/.test(recipientPubKey)) {
    throw new Error('Recipient must be a compressed public key (66 hex chars starting with 02 or 03)');
  }

  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) {
    throw new Error('Wallet not initialized. Run: overlay-cli setup');
  }
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  const senderPubKey = privKey.toPublicKey();
  const senderIdentityKey = identity.identityKey;

  // Derive sender's P2PKH address
  const senderPubKeyBytes = senderPubKey.encode(true);
  const senderHash160 = Hash.hash160(senderPubKeyBytes);
  const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
  const addrPayload = new Uint8Array([prefix, ...senderHash160]);
  const checksum = Hash.hash256(Array.from(addrPayload)).slice(0, 4);
  const addressBytes = new Uint8Array([...addrPayload, ...checksum]);
  const senderAddress = Utils.toBase58(Array.from(addressBytes));

  // Derive recipient's P2PKH hash from their public key
  const recipientPubKeyObj = PublicKey.fromString(recipientPubKey);
  const recipientPubKeyBytes = recipientPubKeyObj.encode(true);
  const recipientHash160 = Hash.hash160(recipientPubKeyBytes);

  // ── BEEF-first: use stored change output (no WoC calls) ──
  const beefStorePath = path.join(OVERLAY_STATE_DIR, 'latest-change.json');
  let sourceTx = null;
  let sourceVout = -1;
  let sourceValue = 0;

  // Try stored BEEF first
  try {
    if (fs.existsSync(beefStorePath)) {
      const stored = JSON.parse(fs.readFileSync(beefStorePath, 'utf-8'));
      if (stored.satoshis >= sats + 200) {
        sourceTx = reconstructFromChain(stored);
        sourceVout = stored.vout;
        sourceValue = stored.satoshis;
      }
    }
  } catch {}

  // Fallback to WoC if no stored BEEF
  if (!sourceTx) {
    const utxoResp = await wocFetch(`/address/${senderAddress}/unspent`);
    if (!utxoResp.ok) throw new Error(`Failed to fetch UTXOs: ${utxoResp.status}`);
    const allUtxos = await utxoResp.json();
    const utxos = allUtxos.filter(u => u.value >= sats + 200);
    if (utxos.length === 0) throw new Error(`Insufficient funds. Need ${sats + 200} sats.`);
    const utxo = utxos[0];

    const rawResp = await wocFetch(`/tx/${utxo.tx_hash}/hex`);
    if (!rawResp.ok) throw new Error(`Failed to fetch source tx: ${rawResp.status}`);
    sourceTx = Transaction.fromHex(await rawResp.text());
    sourceVout = utxo.tx_pos;
    sourceValue = utxo.value;

    // Walk back for merkle proof
    let curTx = sourceTx; let curTxid = utxo.tx_hash;
    for (let depth = 0; depth < 10; depth++) {
      const infoResp = await wocFetch(`/tx/${curTxid}`);
      if (!infoResp.ok) break;
      const info = await infoResp.json();
      if (info.confirmations > 0 && info.blockheight) {
        const proofResp = await wocFetch(`/tx/${curTxid}/proof/tsc`);
        if (proofResp.ok) {
          const pd = await proofResp.json();
          if (Array.isArray(pd) && pd.length > 0) {
            curTx.merklePath = buildMerklePathFromTSC(curTxid, pd[0].index, pd[0].nodes, info.blockheight);
          }
        }
        break;
      }
      const parentTxid = curTx.inputs[0]?.sourceTXID;
      if (!parentTxid) break;
      const parentResp = await wocFetch(`/tx/${parentTxid}/hex`);
      if (!parentResp.ok) break;
      const parentTx = Transaction.fromHex(await parentResp.text());
      curTx.inputs[0].sourceTransaction = parentTx;
      curTx = parentTx; curTxid = parentTxid;
    }
  }

  // Generate derivation info (for BRC-29 compatibility metadata)
  const derivationPrefix = Utils.toBase64(Array.from(crypto.getRandomValues(new Uint8Array(8))));
  const derivationSuffix = Utils.toBase64(Array.from(crypto.getRandomValues(new Uint8Array(8))));

  // Build the payment transaction
  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: sourceVout,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
    sequence: 0xffffffff,
  });

  // Output 0: Payment to recipient
  tx.addOutput({
    lockingScript: new P2PKH().lock(recipientHash160),
    satoshis: sats,
  });

  // Calculate fee and change
  const estimatedSize = 148 + 34 * 2 + 10; // 1 input, 2 outputs
  const fee = Math.max(Math.ceil(estimatedSize * 0.5), 50); // 0.5 sat/byte min
  const change = sourceValue - sats - fee;

  if (change < 0) {
    throw new Error(`Insufficient funds after fee. Source: ${sourceValue}, payment: ${sats}, fee: ${fee}`);
  }

  // Output 1: Change back to sender (if dust threshold met)
  if (change >= 136) { // P2PKH dust threshold
    tx.addOutput({
      lockingScript: new P2PKH().lock(senderHash160),
      satoshis: change,
    });
  }

  await tx.sign();

  // Build BEEF — auto-follows source chain
  const beef = new Beef();
  beef.mergeTransaction(tx);

  const txid = tx.id('hex');
  const atomicBeefBytes = beef.toBinaryAtomic(txid);
  const beefBase64 = Utils.toBase64(Array.from(atomicBeefBytes));

  // Save change BEEF for next tx (instant chaining)
  if (change >= 136) {
    saveChangeBeef(tx, change, 1);
  }

  // Broadcast (best-effort, not required for BEEF-based delivery)
  try {
    const broadcastResp = await wocFetch(`/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: tx.toHex() }),
    });
    if (!broadcastResp.ok) {
      console.error(`[broadcast] Non-fatal: ${broadcastResp.status}`);
    }
  } catch (bcastErr) {
    console.error(`[broadcast] Non-fatal: ${bcastErr.message}`);
  }

  const explorerBase = NETWORK === 'mainnet' ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com';

  return {
    beef: beefBase64,
    txid,
    satoshis: sats,
    fee,
    derivationPrefix,
    derivationSuffix,
    senderIdentityKey,
    recipientIdentityKey: recipientPubKey,
    broadcast: true,
    explorer: `${explorerBase}/tx/${txid}`,
  };
}

async function cmdPay(pubkey, satoshis, description) {
  if (!pubkey || !satoshis) return fail('Usage: pay <pubkey> <satoshis> [description]');
  const sats = parseInt(satoshis, 10);
  if (isNaN(sats) || sats <= 0) return fail('satoshis must be a positive integer');

  try {
    const payment = await buildDirectPayment(pubkey, sats, description || 'agent payment');
    ok(payment);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function cmdVerify(beefBase64) {
  if (!beefBase64) return fail('Usage: verify <beef_base64>');
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const result = wallet.verifyPayment({ beef: beefBase64 });
  await wallet.destroy();
  ok(result);
}

async function cmdAccept(beef, derivationPrefix, derivationSuffix, senderIdentityKey, description) {
  if (!beef || !derivationPrefix || !derivationSuffix || !senderIdentityKey) {
    return fail('Usage: accept <beef> <prefix> <suffix> <senderKey> [description]');
  }
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const receipt = await wallet.acceptPayment({
    beef, derivationPrefix, derivationSuffix, senderIdentityKey,
    description: description || undefined,
  });
  await wallet.destroy();
  ok(receipt);
}

// ---------------------------------------------------------------------------
// Overlay commands
// ---------------------------------------------------------------------------

async function cmdRegister() {
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized. Run: overlay-cli setup');

  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const identityKey = identity.identityKey;

  // Determine agent name
  const agentName = process.env.AGENT_NAME || os.hostname() || 'clawdbot-agent';
  const agentDesc = process.env.AGENT_DESCRIPTION
    || `Clawdbot agent (${agentName}). Offers services for BSV micropayments.`;

  // --- Step 1: Register identity ---
  const identityPayload = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey,
    name: agentName,
    description: agentDesc,
    channels: { overlay: OVERLAY_URL },
    capabilities: ['jokes', 'services'],
    timestamp: new Date().toISOString(),
  };

  let identityResult;
  try {
    identityResult = await buildRealOverlayTransaction(identityPayload, TOPICS.IDENTITY);
  } catch (err) {
    return fail(`Identity registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Step 2: Register default joke service ---
  const servicePayload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey,
    serviceId: 'tell-joke',
    name: 'Random Joke',
    description: 'Get a random joke. Guaranteed to be at least mildly amusing.',
    pricing: { model: 'per-task', amountSats: 5 },
    timestamp: new Date().toISOString(),
  };

  let serviceResult;
  try {
    // For synthetic, we need a fresh tx. For real funding, we might need to wait
    // for the previous change to be available. Build synthetic for the service if needed.
    serviceResult = await buildRealOverlayTransaction(servicePayload, TOPICS.SERVICES);
  } catch (err) {
    // Service registration is non-fatal — identity is the important one
    serviceResult = { txid: null, error: String(err) };
  }

  // Save registration state
  const registration = {
    identityKey,
    agentName,
    agentDescription: agentDesc,
    overlayUrl: OVERLAY_URL,
    identityTxid: identityResult.txid,
    serviceTxid: serviceResult?.txid || null,
    funded: identityResult.funded,
    registeredAt: new Date().toISOString(),
  };
  saveRegistration(registration);

  // Save the joke service to local services list
  if (serviceResult?.txid) {
    const services = loadServices();
    const existing = services.findIndex(s => s.serviceId === 'tell-joke');
    const svcRecord = {
      serviceId: 'tell-joke',
      name: 'Random Joke',
      description: 'Get a random joke. Guaranteed to be at least mildly amusing.',
      priceSats: 5,
      txid: serviceResult.txid,
      registeredAt: new Date().toISOString(),
    };
    if (existing >= 0) services[existing] = svcRecord;
    else services.push(svcRecord);
    saveServices(services);
  }

  ok({
    registered: true,
    agentName,
    identityKey,
    identityTxid: identityResult.txid,
    serviceTxid: serviceResult?.txid || null,
    funded: identityResult.funded,
    overlayUrl: OVERLAY_URL,
    stateFile: path.join(OVERLAY_STATE_DIR, 'registration.json'),
  });
}

async function cmdUnregister() {
  const reg = loadRegistration();
  if (!reg) return fail('No registration found. Nothing to unregister.');

  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized. Run: overlay-cli setup');

  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));

  // --- Step 1: Submit identity-delete tombstone ---
  const deletePayload = {
    protocol: PROTOCOL_ID,
    type: 'identity-delete',
    identityKey: identity.identityKey,
    previousTxid: reg.identityTxid || null,
    timestamp: new Date().toISOString(),
  };

  let deleteResult;
  try {
    deleteResult = await buildRealOverlayTransaction(deletePayload, TOPICS.IDENTITY);
  } catch (err) {
    return fail(`Identity unregister failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Step 2: Submit service-delete tombstones for all registered services ---
  const services = loadServices();
  const serviceDeleteResults = [];
  for (const svc of services) {
    const svcDeletePayload = {
      protocol: PROTOCOL_ID,
      type: 'service-delete',
      identityKey: identity.identityKey,
      serviceId: svc.serviceId,
      previousTxid: svc.txid || null,
      timestamp: new Date().toISOString(),
    };
    try {
      const svcResult = await buildRealOverlayTransaction(svcDeletePayload, TOPICS.SERVICES);
      serviceDeleteResults.push({ serviceId: svc.serviceId, txid: svcResult.txid, success: true });
    } catch (err) {
      serviceDeleteResults.push({ serviceId: svc.serviceId, success: false, error: String(err) });
    }
  }

  // --- Step 3: Clean up local state ---
  const regFile = path.join(OVERLAY_STATE_DIR, 'registration.json');
  try { fs.unlinkSync(regFile); } catch {}
  saveServices([]);

  ok({
    unregistered: true,
    identityKey: identity.identityKey,
    identityDeleteTxid: deleteResult.txid,
    serviceDeletes: serviceDeleteResults,
  });
}

async function cmdServices() {
  const services = loadServices();
  const reg = loadRegistration();
  ok({
    identityKey: reg?.identityKey || null,
    services,
    count: services.length,
  });
}

async function cmdAdvertise(serviceId, name, description, priceSats) {
  if (!serviceId || !name || !description || !priceSats) {
    return fail('Usage: advertise <serviceId> <name> <description> <priceSats>');
  }

  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized. Run: overlay-cli setup');

  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const sats = parseInt(priceSats, 10);
  if (isNaN(sats) || sats < 0) return fail('priceSats must be a non-negative integer');

  const servicePayload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey: identity.identityKey,
    serviceId,
    name,
    description,
    pricing: { model: 'per-task', amountSats: sats },
    timestamp: new Date().toISOString(),
  };

  let result;
  try {
    result = await buildRealOverlayTransaction(servicePayload, TOPICS.SERVICES);
  } catch (err) {
    return fail(`Service advertisement failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Save to local services list
  const services = loadServices();
  const existing = services.findIndex(s => s.serviceId === serviceId);
  const svcRecord = {
    serviceId, name, description, priceSats: sats,
    txid: result.txid,
    registeredAt: new Date().toISOString(),
  };
  if (existing >= 0) services[existing] = svcRecord;
  else services.push(svcRecord);
  saveServices(services);

  ok({
    advertised: true,
    serviceId, name, description, priceSats: sats,
    txid: result.txid,
    funded: result.funded,
  });
}

async function cmdRemove(serviceId) {
  if (!serviceId) return fail('Usage: remove <serviceId>');

  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized. Run: overlay-cli setup');

  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));

  // Find service in local list
  const services = loadServices();
  const idx = services.findIndex(s => s.serviceId === serviceId);
  if (idx < 0) return fail(`Service '${serviceId}' not found in local registry`);

  const removed = services[idx];

  // Submit service-delete tombstone to overlay
  const deletePayload = {
    protocol: PROTOCOL_ID,
    type: 'service-delete',
    identityKey: identity.identityKey,
    serviceId,
    previousTxid: removed.txid || null,
    timestamp: new Date().toISOString(),
  };

  let deleteResult;
  try {
    deleteResult = await buildRealOverlayTransaction(deletePayload, TOPICS.SERVICES);
  } catch (err) {
    return fail(`Service removal failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Remove from local list
  services.splice(idx, 1);
  saveServices(services);

  ok({
    removed: true,
    serviceId,
    deleteTxid: deleteResult.txid,
    funded: deleteResult.funded,
    previousTxid: removed.txid,
  });
}

async function cmdReadvertise(serviceId, newPrice, newName, newDesc) {
  if (!serviceId || !newPrice) {
    return fail('Usage: readvertise <serviceId> <newPrice> [newName] [newDesc]');
  }

  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized. Run: overlay-cli setup');

  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const sats = parseInt(newPrice, 10);
  if (isNaN(sats) || sats < 0) return fail('newPrice must be a non-negative integer (satoshis)');

  // Load existing service
  const services = loadServices();
  const existing = services.find(s => s.serviceId === serviceId);
  if (!existing) return fail(`Service '${serviceId}' not found in local registry. Use 'advertise' to create it first.`);

  const name = newName || existing.name;
  const description = newDesc || existing.description;

  const servicePayload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey: identity.identityKey,
    serviceId,
    name,
    description,
    pricing: { model: 'per-task', amountSats: sats },
    timestamp: new Date().toISOString(),
  };

  let result;
  try {
    result = await buildRealOverlayTransaction(servicePayload, TOPICS.SERVICES);
  } catch (err) {
    return fail(`Readvertise failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Update local services list
  const idx = services.findIndex(s => s.serviceId === serviceId);
  services[idx] = {
    serviceId, name, description, priceSats: sats,
    txid: result.txid,
    registeredAt: new Date().toISOString(),
  };
  saveServices(services);

  ok({
    readvertised: true,
    serviceId, name, description, priceSats: sats,
    txid: result.txid,
    funded: result.funded,
  });
}

// ---------------------------------------------------------------------------
// X Account Verification Commands
// ---------------------------------------------------------------------------

/**
 * Generate a verification message for linking an X account to an overlay identity.
 * The agent should post this message to X, then call x-verify-complete with the tweet URL.
 */
async function cmdXVerifyStart(xHandle) {
  if (!xHandle) return fail('Usage: x-verify-start <@handle>');
  
  // Normalize handle
  const handle = xHandle.startsWith('@') ? xHandle : `@${xHandle}`;
  
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized. Run: overlay-cli setup');
  
  let identity;
  try {
    identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  } catch (err) {
    return fail(`Failed to read wallet identity: ${err.message}`);
  }
  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  const identityKey = identity.identityKey;
  
  // Create the verification payload
  const timestamp = new Date().toISOString();
  const verificationData = {
    action: 'verify-x-account',
    identityKey,
    xHandle: handle,
    timestamp,
    protocol: PROTOCOL_ID,
  };
  
  // Sign the verification data
  const preimage = JSON.stringify(verificationData);
  const msgHash = Hash.sha256(Array.from(new TextEncoder().encode(preimage)));
  const sig = privKey.sign(msgHash);
  const signature = Array.from(sig.toDER()).map(b => b.toString(16).padStart(2, '0')).join('');
  
  // Generate the tweet text (must fit in 280 chars)
  // Format: compact with full key + truncated sig (verifier fetches full sig from pending file)
  const shortSig = signature.slice(0, 40);
  const tweetText = `🪙 Claw Overlay Verification

${identityKey}
${shortSig}...

Verify: clawoverlay.com/verify/${identityKey.slice(-12)}`;

  // Save pending verification
  const pendingPath = path.join(OVERLAY_STATE_DIR, 'pending-x-verification.json');
  fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
  fs.writeFileSync(pendingPath, JSON.stringify({
    handle,
    identityKey,
    timestamp,
    verificationData,
    signature,
    tweetText,
    createdAt: new Date().toISOString(),
  }, null, 2));
  
  ok({
    status: 'pending',
    handle,
    identityKey,
    tweetText,
    instructions: 'Post this text to X from the account you want to verify, then call x-verify-complete with the tweet URL.',
    signature,
  });
}

/**
 * Complete X verification by checking the posted tweet and storing on-chain.
 */
async function cmdXVerifyComplete(tweetUrl) {
  if (!tweetUrl) return fail('Usage: x-verify-complete <tweet-url>');
  
  // Load pending verification
  const pendingPath = path.join(OVERLAY_STATE_DIR, 'pending-x-verification.json');
  if (!fs.existsSync(pendingPath)) {
    return fail('No pending X verification. Run x-verify-start first.');
  }
  
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
  
  // Extract tweet ID from URL
  const tweetIdMatch = tweetUrl.match(/status\/(\d+)/);
  if (!tweetIdMatch) return fail('Invalid tweet URL. Expected format: https://x.com/user/status/123456789');
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
  } catch (err) {
    return fail(`Failed to fetch tweet: ${err.message}. Make sure bird CLI is configured.`);
  }
  
  // Verify the tweet contains our identity key and partial signature
  const tweetText = tweetData.text || tweetData.full_text || '';
  if (!tweetText.includes(pending.identityKey)) {
    return fail('Tweet does not contain the expected identity key.');
  }
  // Check for partial signature (first 40 chars) since tweets are length-limited
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
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  
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
  } catch (err) {
    // Topic manager may not be deployed yet - store locally and warn
    console.error(`[x-verify] On-chain storage failed (server may not support topic yet): ${err.message}`);
    console.error('[x-verify] Storing verification locally. On-chain anchoring will be available once topic manager is deployed.');
  }
  
  // Save verification locally
  const verificationsPath = path.join(OVERLAY_STATE_DIR, 'x-verifications.json');
  let verifications = [];
  try {
    if (fs.existsSync(verificationsPath)) {
      verifications = JSON.parse(fs.readFileSync(verificationsPath, 'utf-8'));
    }
  } catch (err) {
    // File corrupt or unreadable - start fresh (existing verifications lost)
    console.warn(`[x-verify] Warning: Could not read existing verifications: ${err.message}`);
  }
  
  verifications.push({
    ...verificationPayload,
    txid: result.txid,
  });
  fs.writeFileSync(verificationsPath, JSON.stringify(verifications, null, 2));
  
  // Clean up pending
  fs.unlinkSync(pendingPath);
  
  ok({
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
async function cmdXVerifications() {
  const verificationsPath = path.join(OVERLAY_STATE_DIR, 'x-verifications.json');
  let verifications = [];
  try {
    if (fs.existsSync(verificationsPath)) {
      verifications = JSON.parse(fs.readFileSync(verificationsPath, 'utf-8'));
    }
  } catch (err) {
    console.warn(`[x-verifications] Warning: Could not read verifications file: ${err.message}`);
  }
  
  ok({ verifications, count: verifications.length });
}

/**
 * Lookup X verifications from the overlay network.
 */
async function cmdXLookup(query) {
  try {
    const lookupQuery = query 
      ? (query.startsWith('@') ? { xHandle: query } : { identityKey: query })
      : { type: 'list' };
    
    const response = await lookupOverlay(LOOKUP_SERVICES.X_VERIFICATIONS, lookupQuery);
    ok({ verifications: response.outputs || response || [], query: lookupQuery });
  } catch (err) {
    // Lookup service might not exist yet
    ok({ verifications: [], query, note: 'X verification lookup service may not be deployed yet.' });
  }
}

// ---------------------------------------------------------------------------
// Discovery commands
// ---------------------------------------------------------------------------

async function cmdDiscover(args) {
  // Parse flags
  let serviceFilter = null;
  let agentFilter = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--service' && args[i + 1]) serviceFilter = args[++i];
    else if (args[i] === '--agent' && args[i + 1]) agentFilter = args[++i];
  }

  const results = { agents: [], services: [] };

  // Query agents
  if (!serviceFilter) {
    try {
      const agentQuery = agentFilter ? { name: agentFilter } : { type: 'list' };
      const agentResult = await lookupOverlay(LOOKUP_SERVICES.AGENTS, agentQuery);

      if (agentResult.outputs) {
        for (const output of agentResult.outputs) {
          const data = parseOverlayOutput(output.beef, output.outputIndex);
          if (data && data.type === 'identity') {
            let txid = null;
            try {
              const tx = Transaction.fromBEEF(output.beef);
              txid = tx.id('hex');
            } catch { /* ignore */ }
            results.agents.push({ ...data, txid });
          }
        }
      }
    } catch (err) {
      results.agentError = String(err);
    }
  }

  // Query services
  if (!agentFilter) {
    try {
      const serviceQuery = serviceFilter ? { serviceType: serviceFilter } : {};
      const serviceResult = await lookupOverlay(LOOKUP_SERVICES.SERVICES, serviceQuery);

      if (serviceResult.outputs) {
        for (const output of serviceResult.outputs) {
          const data = parseOverlayOutput(output.beef, output.outputIndex);
          if (data && data.type === 'service') {
            let txid = null;
            try {
              const tx = Transaction.fromBEEF(output.beef);
              txid = tx.id('hex');
            } catch { /* ignore */ }
            results.services.push({ ...data, txid });
          }
        }
      }
    } catch (err) {
      results.serviceError = String(err);
    }
  }

  ok({
    overlayUrl: OVERLAY_URL,
    agentCount: results.agents.length,
    serviceCount: results.services.length,
    agents: results.agents,
    services: results.services,
    ...(results.agentError && { agentError: results.agentError }),
    ...(results.serviceError && { serviceError: results.serviceError }),
  });
}

// ---------------------------------------------------------------------------
// Relay messaging helpers
// ---------------------------------------------------------------------------

/** Get our identity key and private key from wallet. */
function loadIdentity() {
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) {
    throw new Error('Wallet not initialized. Run: overlay-cli setup');
  }
  // Issue #8: Warn if wallet identity file has overly permissive mode
  try {
    const fileMode = fs.statSync(identityPath).mode & 0o777;
    if (fileMode & 0o044) { // world or group readable
      console.error(`[security] WARNING: ${identityPath} has permissive mode 0${fileMode.toString(8)}. Run: chmod 600 ${identityPath}`);
    }
  } catch {}
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  return { identityKey: identity.identityKey, privKey };
}

/** Sign a relay message: ECDSA over sha256(to + type + JSON.stringify(payload)). */
function signRelayMessage(privKey, to, type, payload) {
  const preimage = to + type + JSON.stringify(payload);
  const msgHash = Hash.sha256(Array.from(new TextEncoder().encode(preimage)));
  const sig = privKey.sign(msgHash);
  return Array.from(sig.toDER()).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Verify a relay message signature. */
function verifyRelaySignature(fromKey, to, type, payload, signatureHex) {
  if (!signatureHex) return { valid: false, reason: 'no signature' };
  try {
    const preimage = to + type + JSON.stringify(payload);
    const msgHash = Hash.sha256(Array.from(new TextEncoder().encode(preimage)));
    const sigBytes = [];
    for (let i = 0; i < signatureHex.length; i += 2) {
      sigBytes.push(parseInt(signatureHex.substring(i, i + 2), 16));
    }
    const sig = Signature.fromDER(sigBytes);
    const pubKey = PublicKey.fromString(fromKey);
    return { valid: pubKey.verify(msgHash, sig) };
  } catch (err) {
    return { valid: false, reason: String(err) };
  }
}

/**
 * Format a service response into a human-readable summary based on service type.
 * Returns an object with { type, summary, details } for notification formatting.
 */
function formatServiceResponse(serviceId, status, result) {
  const base = { serviceId, status };
  
  if (status === 'rejected') {
    return {
      ...base,
      type: 'rejection',
      summary: `Service rejected: ${result?.reason || 'unknown reason'}`,
      details: result,
    };
  }
  
  switch (serviceId) {
    case 'tell-joke':
      return {
        ...base,
        type: 'joke',
        summary: result?.setup && result?.punchline
          ? `${result.setup} — ${result.punchline}`
          : 'Joke received',
        details: { setup: result?.setup, punchline: result?.punchline },
      };
    
    case 'code-review':
      // Code review results include summary, findings, severity breakdown
      const findings = result?.findings || [];
      const severityCounts = findings.reduce((acc, f) => {
        acc[f.severity] = (acc[f.severity] || 0) + 1;
        return acc;
      }, {});
      const severityStr = Object.entries(severityCounts)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ') || 'none';
      
      return {
        ...base,
        type: 'code-review',
        summary: result?.summary || 'Code review completed',
        details: {
          findingsCount: findings.length,
          severityBreakdown: severityCounts,
          assessment: result?.assessment || result?.overallAssessment,
          findings: findings.slice(0, 5), // First 5 findings for preview
        },
        displaySummary: `Code Review: ${findings.length} findings (${severityStr}). ${result?.assessment || ''}`,
      };
    
    case 'summarize':
      return {
        ...base,
        type: 'summarize',
        summary: result?.summary || 'Summary generated',
        details: {
          summary: result?.summary,
          keyPoints: result?.keyPoints,
          wordCount: result?.wordCount,
        },
      };
    
    case 'translate':
      return {
        ...base,
        type: 'translate',
        summary: result?.error
          ? `Translation failed: ${result.error}`
          : `Translated (${result?.from || '?'} → ${result?.to || '?'}): "${result?.translatedText?.slice(0, 100)}${result?.translatedText?.length > 100 ? '...' : ''}"`,
        details: {
          originalText: result?.originalText,
          translatedText: result?.translatedText,
          from: result?.from,
          to: result?.to,
          provider: result?.provider,
          error: result?.error,
        },
      };
    
    case 'api-proxy':
      const apiName = result?.api || 'unknown';
      let apiSummary = result?.error ? `API proxy (${apiName}) failed: ${result.error}` : `API proxy (${apiName}) completed`;
      // Add specific summary based on API type
      if (!result?.error) {
        if (apiName === 'weather' && result?.temperature) {
          apiSummary = `Weather: ${result.location} — ${result.temperature.celsius}°C, ${result.condition}`;
        } else if (apiName === 'exchange-rate' && result?.rate) {
          apiSummary = `Exchange: ${result.amount} ${result.from} = ${result.converted} ${result.to}`;
        } else if (apiName === 'crypto-price' && result?.price) {
          apiSummary = `${result.coin}: ${result.price} ${result.currency} (${result.change24h > 0 ? '+' : ''}${result.change24h?.toFixed(2)}%)`;
        } else if (apiName === 'geocode' && result?.displayName) {
          apiSummary = `Geocode: ${result.displayName?.slice(0, 80)}`;
        } else if (apiName === 'ip-lookup' && result?.ip) {
          apiSummary = `IP: ${result.ip} — ${result.city}, ${result.country}`;
        }
      }
      return {
        ...base,
        type: 'api-proxy',
        summary: apiSummary,
        details: result,
      };
    
    case 'roulette':
      return {
        ...base,
        type: 'roulette',
        summary: result?.message || (result?.won ? `Won ${result.payout} sats!` : `Lost ${result.betAmount} sats`),
        details: {
          spin: result?.spin,
          color: result?.color,
          bet: result?.bet,
          betAmount: result?.betAmount,
          won: result?.won,
          payout: result?.payout,
          multiplier: result?.multiplier,
        },
      };
    
    case 'memory-store':
      const op = result?.operation || 'unknown';
      let memorySummary = result?.error ? `Memory store (${op}) failed: ${result.error}` : `Memory store ${op} completed`;
      if (!result?.error) {
        if (op === 'set') {
          memorySummary = `Stored: ${result?.namespace}/${result?.key}`;
        } else if (op === 'get') {
          memorySummary = result?.found ? `Retrieved: ${result?.namespace}/${result?.key}` : `Not found: ${result?.namespace}/${result?.key}`;
        } else if (op === 'delete') {
          memorySummary = result?.deleted ? `Deleted: ${result?.namespace}/${result?.key}` : `Not found: ${result?.namespace}/${result?.key}`;
        } else if (op === 'list') {
          memorySummary = `Listed ${result?.keys?.length || 0} keys in ${result?.namespace}`;
        }
      }
      return {
        ...base,
        type: 'memory-store',
        summary: memorySummary,
        details: result,
      };
    
    case 'code-develop':
      let devSummary = result?.error 
        ? `Development failed: ${result.error}` 
        : result?.prUrl 
          ? `PR created: ${result.prUrl}`
          : 'Development completed';
      return {
        ...base,
        type: 'code-develop',
        summary: devSummary,
        details: {
          issueUrl: result?.issueUrl,
          prUrl: result?.prUrl,
          branch: result?.branch,
          commits: result?.commits,
          error: result?.error,
        },
      };
    
    default:
      // Generic service response — show preview of result
      const resultPreview = result
        ? JSON.stringify(result).slice(0, 200) + (JSON.stringify(result).length > 200 ? '...' : '')
        : 'No result data';
      return {
        ...base,
        type: 'generic',
        summary: `Service '${serviceId}' completed`,
        details: result,
        resultPreview,
      };
  }
}

const JOKES = [
  { setup: "Why do programmers prefer dark mode?", punchline: "Because light attracts bugs." },
  { setup: "Why did the BSV go to therapy?", punchline: "It had too many unresolved transactions." },
  { setup: "How many satoshis does it take to change a lightbulb?", punchline: "None — they prefer to stay on-chain." },
  { setup: "Why don't AI agents ever get lonely?", punchline: "They're always on the overlay." },
  { setup: "What did one Clawdbot say to the other?", punchline: "I'd tell you a joke, but it'll cost you 5 sats." },
  { setup: "Why did the blockchain break up with the database?", punchline: "It needed more commitment." },
  { setup: "What's a miner's favorite type of music?", punchline: "Block and roll." },
  { setup: "Why was the transaction so confident?", punchline: "It had six confirmations." },
  { setup: "What do you call a wallet with no UTXOs?", punchline: "A sad wallet." },
  { setup: "Why did the smart contract go to school?", punchline: "To improve its execution." },
  { setup: "How do BSV nodes say goodbye?", punchline: "See you on the next block!" },
  { setup: "Why don't private keys ever get invited to parties?", punchline: "They're too secretive." },
  { setup: "What's an overlay node's favorite game?", punchline: "Peer-to-peer tag." },
  { setup: "Why did the UTXO feel special?", punchline: "Because it was unspent." },
  { setup: "What did the signature say to the hash?", punchline: "I've got you covered." },
];

// ---------------------------------------------------------------------------
// Relay messaging commands
// ---------------------------------------------------------------------------

async function cmdSend(targetKey, type, payloadStr) {
  if (!targetKey || !type || !payloadStr) {
    return fail('Usage: send <identityKey> <type> <json_payload>');
  }
  if (!/^0[23][0-9a-fA-F]{64}$/.test(targetKey)) {
    return fail('Target must be a compressed public key (66 hex chars, 02/03 prefix)');
  }

  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return fail('payload must be valid JSON');
  }

  const { identityKey, privKey } = loadIdentity();
  const signature = signRelayMessage(privKey, targetKey, type, payload);

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
  ok({ sent: true, messageId: result.id, to: targetKey, type, signed: true });
}

async function cmdInbox(args) {
  const { identityKey } = loadIdentity();
  let since = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since' && args[i + 1]) since = `&since=${args[++i]}`;
  }

  const resp = await fetch(`${OVERLAY_URL}/relay/inbox?identity=${identityKey}${since}`);
  if (!resp.ok) {
    const body = await resp.text();
    return fail(`Relay inbox failed (${resp.status}): ${body}`);
  }
  const result = await resp.json();

  // Verify signatures on received messages
  const messages = result.messages.map(msg => ({
    ...msg,
    signatureValid: msg.signature
      ? verifyRelaySignature(msg.from, msg.to, msg.type, msg.payload, msg.signature).valid
      : null,
  }));

  ok({ messages, count: messages.length, identityKey });
}

async function cmdAck(messageIds) {
  if (!messageIds || messageIds.length === 0) {
    return fail('Usage: ack <messageId> [messageId2 ...]');
  }
  const { identityKey } = loadIdentity();

  const resp = await fetch(`${OVERLAY_URL}/relay/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: identityKey, messageIds }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    return fail(`Relay ack failed (${resp.status}): ${body}`);
  }
  const result = await resp.json();
  ok({ acked: result.acked, messageIds });
}

// ---------------------------------------------------------------------------
// Shared message processing — used by both poll and connect (WebSocket)
// ---------------------------------------------------------------------------

/**
 * Process a single relay message. Handles pings, joke service requests,
 * pongs, service responses. Returns a result object.
 *
 * result.ack — whether the message should be ACKed
 * result.id  — the message id
 */
async function processMessage(msg, identityKey, privKey) {
  // Verify signature if present
  const sigCheck = msg.signature
    ? verifyRelaySignature(msg.from, msg.to, msg.type, msg.payload, msg.signature)
    : { valid: null };

  // Issue #7: Enforce signature verification — reject unsigned/forged messages
  // Pings are harmless; service-requests and other types must have valid signatures
  if (msg.type === 'service-request' && sigCheck.valid !== true) {
    console.error(JSON.stringify({ event: 'signature-rejected', type: msg.type, from: msg.from, reason: sigCheck.reason || 'missing signature' }));
    return {
      id: msg.id, type: msg.type, from: msg.from,
      action: 'rejected', reason: 'invalid-signature',
      signatureValid: sigCheck.valid,
      ack: true,
    };
  }

  if (msg.type === 'ping') {
    // Auto-respond with pong
    const pongPayload = {
      text: 'pong',
      inReplyTo: msg.id,
      originalText: msg.payload?.text || null,
    };
    const pongSig = signRelayMessage(privKey, msg.from, 'pong', pongPayload);
    await fetch(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: identityKey,
        to: msg.from,
        type: 'pong',
        payload: pongPayload,
        signature: pongSig,
      }),
    });
    return { id: msg.id, type: 'ping', action: 'replied-pong', from: msg.from, ack: true };

  } else if (msg.type === 'service-request') {
    const serviceId = msg.payload?.serviceId;
    
    // Agent-routed mode: queue for the agent instead of hardcoded handlers
    if (process.env.AGENT_ROUTED === 'true') {
      return await queueForAgent(msg, identityKey, privKey, serviceId);
    }
    
    // Legacy hardcoded handlers (when not in agent-routed mode)
    if (serviceId === 'tell-joke') {
      return await processJokeRequest(msg, identityKey, privKey);
    } else if (serviceId === 'code-review') {
      return await processCodeReview(msg, identityKey, privKey);
    } else if (serviceId === 'web-research') {
      return await processWebResearch(msg, identityKey, privKey);
    } else if (serviceId === 'translate') {
      return await processTranslate(msg, identityKey, privKey);
    } else if (serviceId === 'api-proxy') {
      return await processApiProxy(msg, identityKey, privKey);
    } else if (serviceId === 'roulette') {
      return await processRoulette(msg, identityKey, privKey);
    } else if (serviceId === 'memory-store') {
      return await processMemoryStore(msg, identityKey, privKey);
    } else if (serviceId === 'code-develop') {
      return await processCodeDevelop(msg, identityKey, privKey);
    } else if (serviceId === 'x-engagement') {
      return await processXEngagement(msg, identityKey, privKey);
    } else if (serviceId === 'baemail') {
      return await processBaemail(msg, identityKey, privKey);
    } else {
      // Unknown service — don't auto-process
      return {
        id: msg.id, type: 'service-request', serviceId,
        from: msg.from, signatureValid: sigCheck.valid,
        action: 'unhandled', ack: false,
      };
    }

  } else if (msg.type === 'pong') {
    return {
      id: msg.id, type: 'pong', action: 'received', from: msg.from,
      text: msg.payload?.text, inReplyTo: msg.payload?.inReplyTo, ack: true,
    };

  } else if (msg.type === 'service-response') {
    const serviceId = msg.payload?.serviceId;
    const status = msg.payload?.status;
    const result = msg.payload?.result;
    
    // Format summary based on service type
    const formatted = formatServiceResponse(serviceId, status, result);
    
    return {
      id: msg.id, type: 'service-response', action: 'received', from: msg.from,
      serviceId, status, result, requestId: msg.payload?.requestId,
      direction: 'incoming-response', // We requested, they responded
      formatted, // Human-readable summary
      ack: true,
    };

  } else {
    // Unknown type
    return {
      id: msg.id, type: msg.type, from: msg.from,
      payload: msg.payload, signatureValid: sigCheck.valid,
      action: 'unhandled', ack: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Agent-routed service queue function
// ---------------------------------------------------------------------------

async function queueForAgent(msg, identityKey, privKey, serviceId) {
  const payment = msg.payload?.payment;
  const input = msg.payload?.input || msg.payload;
  
  // Verify and accept payment
  let walletIdentity;
  try {
    walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));
  } catch (error) {
    throw new Error(`Failed to load wallet identity: ${error.message}`);
  }
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  
  // Find the service price (from local services registry)
  const services = loadServices();
  const svc = services.find(s => s.serviceId === serviceId);
  const minPrice = svc?.priceSats || 5; // default to 5 sats minimum
  
  const payResult = await verifyAndAcceptPayment(payment, minPrice, msg.from, serviceId, ourHash160);
  if (!payResult.accepted) {
    // Send rejection
    const rejectPayload = { requestId: msg.id, serviceId, status: 'rejected', reason: `Payment rejected: ${payResult.error}` };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId, action: 'rejected', reason: payResult.error, from: msg.from, ack: true };
  }
  
  // Queue for agent processing
  const queueEntry = {
    status: 'pending',
    requestId: msg.id,
    serviceId,
    from: msg.from,
    identityKey,
    input: input,
    paymentTxid: payResult.txid,
    satoshisReceived: payResult.satoshis,
    walletAccepted: payResult.walletAccepted,
    _ts: Date.now(),
  };
  
  const queuePath = path.join(OVERLAY_STATE_DIR, 'service-queue.jsonl');
  fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
  fs.appendFileSync(queuePath, JSON.stringify(queueEntry) + '\n');
  
  return {
    id: msg.id, type: 'service-request', serviceId,
    action: 'queued-for-agent',
    paymentAccepted: true, paymentTxid: payResult.txid,
    satoshisReceived: payResult.satoshis,
    from: msg.from, ack: true,
  };
}

// ---------------------------------------------------------------------------
// Code-review service
// ---------------------------------------------------------------------------

async function processCodeReview(msg, identityKey, privKey) {
  const PRICE = 50;

  // Helper to send rejection
  async function reject(reason, shortReason) {
    const rejectPayload = {
      requestId: msg.id, serviceId: 'code-review', status: 'rejected', reason,
    };
    const rejectSig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetch(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: identityKey, to: msg.from, type: 'service-response',
        payload: rejectPayload, signature: rejectSig,
      }),
    });
    return {
      id: msg.id, type: 'service-request', serviceId: 'code-review',
      action: 'rejected', reason: shortReason, from: msg.from, ack: true,
    };
  }

  // ── Payment verification via shared helper ──
  const walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  const payResult = await verifyAndAcceptPayment(msg.payload?.payment, PRICE, msg.from, 'code-review', ourHash160);
  if (!payResult.accepted) {
    return reject(`Payment rejected: ${payResult.error}. This service costs ${PRICE} sats.`, payResult.error);
  }

  const paymentTxid = payResult.txid;
  const paymentSats = payResult.satoshis;
  const walletAccepted = payResult.walletAccepted;
  const acceptError = payResult.error;

  // Perform the code review
  const input = msg.payload?.input || msg.payload;
  let reviewResult;
  try {
    reviewResult = await performCodeReview(input);
  } catch (err) {
    reviewResult = { type: 'code-review', error: `Review failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Send response
  const responsePayload = {
    requestId: msg.id, serviceId: 'code-review', status: 'fulfilled',
    result: reviewResult, paymentAccepted: true, paymentTxid,
    satoshisReceived: paymentSats, walletAccepted,
    ...(acceptError ? { walletError: acceptError } : {}),
  };
  const respSig = signRelayMessage(privKey, msg.from, 'service-response', responsePayload);
  await fetch(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: identityKey, to: msg.from, type: 'service-response',
      payload: responsePayload, signature: respSig,
    }),
  });

  return {
    id: msg.id, type: 'service-request', serviceId: 'code-review',
    action: 'fulfilled', review: reviewResult, paymentAccepted: true, paymentTxid,
    satoshisReceived: paymentSats, walletAccepted,
    ...(acceptError ? { walletError: acceptError } : {}),
    from: msg.from, ack: true,
  };
}

/** Perform code review on a PR URL or code snippet. */
async function performCodeReview(input) {
  if (input.prUrl) {
    const match = input.prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return { type: 'code-review', error: 'Invalid PR URL format. Expected: https://github.com/owner/repo/pull/123' };
    const [, owner, repo, prNumber] = match;

    // Strict validation of owner/repo to prevent shell injection (Issue #4)
    const safeNameRegex = /^[a-zA-Z0-9._-]+$/;
    if (!safeNameRegex.test(owner) || !safeNameRegex.test(repo)) {
      return { type: 'code-review', error: 'Invalid owner/repo name — only alphanumeric, dots, hyphens, and underscores allowed' };
    }
    if (!/^\d+$/.test(prNumber)) {
      return { type: 'code-review', error: 'Invalid PR number — must be numeric' };
    }

    const { execFileSync } = await import('child_process');
    let prInfo, prDiff;
    try {
      prInfo = JSON.parse(execFileSync(
        'gh', ['pr', 'view', prNumber, '--repo', `${owner}/${repo}`, '--json', 'title,body,additions,deletions,files,author'],
        { encoding: 'utf-8', timeout: 30000 },
      ));
    } catch (e) {
      return { type: 'code-review', error: `Failed to fetch PR metadata: ${e.message}` };
    }
    try {
      prDiff = execFileSync(
        'gh', ['pr', 'diff', prNumber, '--repo', `${owner}/${repo}`],
        { encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024, timeout: 30000 },
      );
    } catch (e) {
      return { type: 'code-review', error: `Failed to fetch PR diff: ${e.message}` };
    }

    const review = analyzePrReview(prInfo, prDiff);

    // Post the review as a comment on the GitHub PR
    try {
      // Group findings by severity
      const bySeverity = { critical: [], high: [], warning: [], info: [] };
      for (const f of review.findings) {
        (bySeverity[f.severity] || bySeverity.info).push(f);
      }

      let findingsText = '';
      if (review.findings.length === 0) {
        findingsText = '_No issues found._';
      } else {
        const sections = [];
        if (bySeverity.critical.length > 0) {
          sections.push('#### 🔴 Critical');
          sections.push(...bySeverity.critical.map(f => `- \`${f.file}${f.line ? ':' + f.line : ''}\` — ${f.detail}`));
          sections.push('');
        }
        if (bySeverity.high.length > 0) {
          sections.push('#### 🟠 High');
          sections.push(...bySeverity.high.map(f => `- \`${f.file}${f.line ? ':' + f.line : ''}\` — ${f.detail}`));
          sections.push('');
        }
        if (bySeverity.warning.length > 0) {
          sections.push('#### 🟡 Warnings');
          sections.push(...bySeverity.warning.map(f => `- \`${f.file}${f.line ? ':' + f.line : ''}\` — ${f.detail}`));
          sections.push('');
        }
        if (bySeverity.info.length > 0) {
          sections.push('#### ℹ️ Info');
          sections.push(...bySeverity.info.map(f => `- \`${f.file}${f.line ? ':' + f.line : ''}\` — ${f.detail}`));
          sections.push('');
        }
        findingsText = sections.join('\n');
      }

      const suggestionsText = review.suggestions.length > 0
        ? '### Suggestions\n' + review.suggestions.map(s => `- ${s}`).join('\n')
        : '';

      const summaryLine = review.findingsSummary
        ? `🔴 ${review.findingsSummary.critical} critical · 🟠 ${review.findingsSummary.high} high · 🟡 ${review.findingsSummary.warning} warnings · ℹ️ ${review.findingsSummary.info} info`
        : '';

      const commentBody = [
        `## 🦉 Automated Code Review`,
        ``,
        `| | |`,
        `|---|---|`,
        `| **PR** | ${review.summary} |`,
        `| **Author** | @${review.author} |`,
        `| **Files** | ${review.filesReviewed} |`,
        `| **Changes** | ${review.linesChanged} |`,
        `| **Findings** | ${summaryLine} |`,
        ``,
        `### Findings`,
        ``,
        findingsText,
        suggestionsText,
        `### Overall Assessment`,
        ``,
        review.overallAssessment,
        ``,
        `---`,
        `_Reviewed by [BSV Overlay Skill](https://github.com/galt-tr/bsv-overlay-skill) · Paid via BSV micropayment (50 sats)_`,
      ].join('\n');

      // Write comment to temp file to avoid shell escaping issues (Issue #4: --body-file)
      const tmpFile = path.join(os.tmpdir(), `cr-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, commentBody, 'utf-8');
      execFileSync(
        'gh', ['pr', 'comment', prNumber, '--repo', `${owner}/${repo}`, '--body-file', tmpFile],
        { encoding: 'utf-8', timeout: 15000 },
      );
      try { fs.unlinkSync(tmpFile); } catch {} // cleanup
      review.githubCommentPosted = true;
    } catch (e) {
      review.githubCommentPosted = false;
      review.githubCommentError = e instanceof Error ? e.message : String(e);
    }

    return review;
  } else if (input.code) {
    return analyzeCodeSnippet(input.code, input.language || 'unknown');
  }

  return { type: 'code-review', error: 'Provide either {prUrl} or {code, language} in the input.' };
}

// ---------------------------------------------------------------------------
// Service: web-research (50 sats)
// ---------------------------------------------------------------------------

async function processWebResearch(msg, identityKey, privKey) {
  const PRICE = 50;
  const payment = msg.payload?.payment;
  const input = msg.payload?.input || msg.payload;
  const query = input?.query || input?.question || input?.q;

  if (!query || typeof query !== 'string' || query.trim().length < 3) {
    // Send rejection — no valid query
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'web-research',
      status: 'rejected',
      reason: 'Missing or invalid query. Send {input: {query: "your question"}}',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetch(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'web-research', action: 'rejected', reason: 'no query', from: msg.from, ack: true };
  }

  // ── Payment verification via shared helper ──
  const walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  const payResult = await verifyAndAcceptPayment(payment, PRICE, msg.from, 'web-research', ourHash160);
  if (!payResult.accepted) {
    const rejectPayload = { requestId: msg.id, serviceId: 'web-research', status: 'rejected', reason: `Payment rejected: ${payResult.error}. Web research costs ${PRICE} sats.` };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetch(`${OVERLAY_URL}/relay/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }) });
    return { id: msg.id, type: 'service-request', serviceId: 'web-research', action: 'rejected', reason: payResult.error, from: msg.from, ack: true };
  }

  const paymentTxid = payResult.txid;
  const paymentSats = payResult.satoshis;
  const walletAccepted = payResult.walletAccepted;
  const acceptError = payResult.error;

  // ── Queue the research for Clawdbot to handle (uses built-in web_search) ──
  const queueEntry = {
    type: 'pending-research',
    requestId: msg.id,
    query: query.trim(),
    from: msg.from,
    identityKey,
    paymentTxid,
    satoshisReceived: paymentSats,
    walletAccepted,
    ...(acceptError ? { walletError: acceptError } : {}),
    _ts: Date.now(),
  };
  const queuePath = path.join(OVERLAY_STATE_DIR, 'research-queue.jsonl');
  try {
    fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
    fs.appendFileSync(queuePath, JSON.stringify(queueEntry) + '\n');
  } catch {}

  return {
    id: msg.id,
    type: 'service-request',
    serviceId: 'web-research',
    action: 'queued',
    query: query.slice(0, 80),
    paymentAccepted: true,
    paymentTxid,
    satoshisReceived: paymentSats,
    walletAccepted,
    ...(acceptError ? { walletError: acceptError } : {}),
    from: msg.from,
    ack: true,
  };
}

// ---------------------------------------------------------------------------
// Service: translate (20 sats)
// ---------------------------------------------------------------------------

async function processTranslate(msg, identityKey, privKey) {
  const PRICE = 20;
  const payment = msg.payload?.payment;
  const input = msg.payload?.input || msg.payload;
  const text = input?.text;
  const targetLang = input?.to || input?.targetLang || input?.target || 'en';
  const sourceLang = input?.from || input?.sourceLang || input?.source || 'auto';

  // Helper to send rejection
  async function reject(reason, shortReason) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'translate',
      status: 'rejected',
      reason,
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    }, 15000);
    return { id: msg.id, type: 'service-request', serviceId: 'translate', action: 'rejected', reason: shortReason, from: msg.from, ack: true };
  }

  // Validate input
  if (!text || typeof text !== 'string' || text.trim().length < 1) {
    return reject('Missing or invalid text. Send {input: {text: "your text", to: "es"}}', 'no text');
  }
  if (text.length > 5000) {
    return reject('Text too long. Maximum 5000 characters.', 'text too long');
  }

  // ── Payment verification via shared helper ──
  const walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  const payResult = await verifyAndAcceptPayment(payment, PRICE, msg.from, 'translate', ourHash160);
  if (!payResult.accepted) {
    return reject(`Payment rejected: ${payResult.error}. Translation costs ${PRICE} sats.`, payResult.error);
  }

  const paymentTxid = payResult.txid;
  const paymentSats = payResult.satoshis;
  const walletAccepted = payResult.walletAccepted;
  const acceptError = payResult.error;

  // ── Perform the translation using LibreTranslate or MyMemory API ──
  let translationResult;
  try {
    translationResult = await performTranslation(text.trim(), sourceLang, targetLang);
  } catch (err) {
    translationResult = { error: `Translation failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Send response
  const responsePayload = {
    requestId: msg.id,
    serviceId: 'translate',
    status: translationResult.error ? 'partial' : 'fulfilled',
    result: translationResult,
    paymentAccepted: true,
    paymentTxid,
    satoshisReceived: paymentSats,
    walletAccepted,
    ...(acceptError ? { walletError: acceptError } : {}),
  };
  const respSig = signRelayMessage(privKey, msg.from, 'service-response', responsePayload);
  await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: identityKey, to: msg.from, type: 'service-response',
      payload: responsePayload, signature: respSig,
    }),
  }, 15000);

  return {
    id: msg.id,
    type: 'service-request',
    serviceId: 'translate',
    action: translationResult.error ? 'partial' : 'fulfilled',
    translation: translationResult,
    paymentAccepted: true,
    paymentTxid,
    satoshisReceived: paymentSats,
    walletAccepted,
    direction: 'incoming-request',
    formatted: {
      type: 'translation',
      summary: translationResult.error
        ? `Translation failed: ${translationResult.error}`
        : `Translated ${sourceLang} → ${targetLang}: "${translationResult.translatedText?.slice(0, 50)}${translationResult.translatedText?.length > 50 ? '...' : ''}"`,
      earnings: paymentSats,
    },
    ...(acceptError ? { walletError: acceptError } : {}),
    from: msg.from,
    ack: true,
  };
}

/**
 * Perform translation using MyMemory API (free, no API key required).
 * Falls back to a simple response if API fails.
 */
async function performTranslation(text, sourceLang, targetLang) {
  // Normalize language codes
  const langMap = {
    'auto': 'autodetect',
    'en': 'en', 'english': 'en',
    'es': 'es', 'spanish': 'es',
    'fr': 'fr', 'french': 'fr',
    'de': 'de', 'german': 'de',
    'it': 'it', 'italian': 'it',
    'pt': 'pt', 'portuguese': 'pt',
    'ru': 'ru', 'russian': 'ru',
    'zh': 'zh', 'chinese': 'zh',
    'ja': 'ja', 'japanese': 'ja',
    'ko': 'ko', 'korean': 'ko',
    'ar': 'ar', 'arabic': 'ar',
    'hi': 'hi', 'hindi': 'hi',
    'nl': 'nl', 'dutch': 'nl',
    'pl': 'pl', 'polish': 'pl',
    'sv': 'sv', 'swedish': 'sv',
    'tr': 'tr', 'turkish': 'tr',
    'vi': 'vi', 'vietnamese': 'vi',
    'th': 'th', 'thai': 'th',
    'id': 'id', 'indonesian': 'id',
    'cs': 'cs', 'czech': 'cs',
    'uk': 'uk', 'ukrainian': 'uk',
    'el': 'el', 'greek': 'el',
    'he': 'he', 'hebrew': 'he',
    'da': 'da', 'danish': 'da',
    'fi': 'fi', 'finnish': 'fi',
    'no': 'no', 'norwegian': 'no',
    'ro': 'ro', 'romanian': 'ro',
    'hu': 'hu', 'hungarian': 'hu',
    'bg': 'bg', 'bulgarian': 'bg',
    'hr': 'hr', 'croatian': 'hr',
    'sk': 'sk', 'slovak': 'sk',
    'sl': 'sl', 'slovenian': 'sl',
    'et': 'et', 'estonian': 'et',
    'lv': 'lv', 'latvian': 'lv',
    'lt': 'lt', 'lithuanian': 'lt',
  };

  const from = langMap[sourceLang.toLowerCase()] || sourceLang.toLowerCase().slice(0, 2);
  const to = langMap[targetLang.toLowerCase()] || targetLang.toLowerCase().slice(0, 2);

  // Use MyMemory Translation API (free, no key required, 1000 chars/day limit per IP for anonymous)
  const langPair = from === 'autodetect' ? `|${to}` : `${from}|${to}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langPair)}`;

  try {
    const resp = await fetchWithTimeout(url, {}, 15000);
    if (!resp.ok) {
      throw new Error(`MyMemory API returned ${resp.status}`);
    }
    const data = await resp.json();

    if (data.responseStatus === 200 && data.responseData?.translatedText) {
      const detectedLang = data.responseData?.detectedLanguage || from;
      return {
        originalText: text,
        translatedText: data.responseData.translatedText,
        from: typeof detectedLang === 'string' ? detectedLang : from,
        to: to,
        confidence: data.responseData?.match || null,
        provider: 'MyMemory',
      };
    } else {
      throw new Error(data.responseDetails || 'Translation failed');
    }
  } catch (err) {
    // Fallback: try LibreTranslate public instance
    try {
      const libreUrl = 'https://libretranslate.com/translate';
      const libreResp = await fetchWithTimeout(libreUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: text,
          source: from === 'autodetect' ? 'auto' : from,
          target: to,
          format: 'text',
        }),
      }, 15000);

      if (libreResp.ok) {
        const libreData = await libreResp.json();
        if (libreData.translatedText) {
          return {
            originalText: text,
            translatedText: libreData.translatedText,
            from: libreData.detectedLanguage?.language || from,
            to: to,
            provider: 'LibreTranslate',
          };
        }
      }
    } catch { /* fallback failed */ }

    // Return error
    return {
      error: err instanceof Error ? err.message : String(err),
      originalText: text,
      from: from,
      to: to,
    };
  }
}

// ---------------------------------------------------------------------------
// Service: api-proxy (15 sats)
// ---------------------------------------------------------------------------

async function processApiProxy(msg, identityKey, privKey) {
  const PRICE = 15;
  const payment = msg.payload?.payment;
  const input = msg.payload?.input || msg.payload;
  const api = input?.api?.toLowerCase();
  const params = input?.params || input;

  // Helper to send rejection
  async function reject(reason, shortReason) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'api-proxy',
      status: 'rejected',
      reason,
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    }, 15000);
    return { id: msg.id, type: 'service-request', serviceId: 'api-proxy', action: 'rejected', reason: shortReason, from: msg.from, ack: true };
  }

  // Supported APIs
  const SUPPORTED_APIS = ['weather', 'geocode', 'exchange-rate', 'ip-lookup', 'crypto-price'];

  // Validate input
  if (!api || typeof api !== 'string') {
    return reject(`Missing API name. Supported: ${SUPPORTED_APIS.join(', ')}. Send {input: {api: "weather", params: {location: "NYC"}}}`, 'no api');
  }
  if (!SUPPORTED_APIS.includes(api)) {
    return reject(`Unsupported API: ${api}. Supported: ${SUPPORTED_APIS.join(', ')}`, `unsupported api: ${api}`);
  }

  // ── Payment verification via shared helper ──
  const walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  const payResult = await verifyAndAcceptPayment(payment, PRICE, msg.from, 'api-proxy', ourHash160);
  if (!payResult.accepted) {
    return reject(`Payment rejected: ${payResult.error}. API proxy costs ${PRICE} sats.`, payResult.error);
  }

  const paymentTxid = payResult.txid;
  const paymentSats = payResult.satoshis;
  const walletAccepted = payResult.walletAccepted;
  const acceptError = payResult.error;

  // ── Execute the API proxy request ──
  let apiResult;
  try {
    apiResult = await executeApiProxy(api, params);
  } catch (err) {
    apiResult = { error: `API call failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Send response
  const responsePayload = {
    requestId: msg.id,
    serviceId: 'api-proxy',
    status: apiResult.error ? 'partial' : 'fulfilled',
    result: apiResult,
    paymentAccepted: true,
    paymentTxid,
    satoshisReceived: paymentSats,
    walletAccepted,
    ...(acceptError ? { walletError: acceptError } : {}),
  };
  const respSig = signRelayMessage(privKey, msg.from, 'service-response', responsePayload);
  await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: identityKey, to: msg.from, type: 'service-response',
      payload: responsePayload, signature: respSig,
    }),
  }, 15000);

  return {
    id: msg.id,
    type: 'service-request',
    serviceId: 'api-proxy',
    action: apiResult.error ? 'partial' : 'fulfilled',
    api,
    result: apiResult,
    paymentAccepted: true,
    paymentTxid,
    satoshisReceived: paymentSats,
    walletAccepted,
    direction: 'incoming-request',
    formatted: {
      type: 'api-proxy',
      summary: apiResult.error
        ? `API proxy (${api}) failed: ${apiResult.error}`
        : `API proxy (${api}) completed successfully`,
      earnings: paymentSats,
    },
    ...(acceptError ? { walletError: acceptError } : {}),
    from: msg.from,
    ack: true,
  };
}

/**
 * Execute an API proxy request.
 * Supports: weather, geocode, exchange-rate, ip-lookup, crypto-price
 */
async function executeApiProxy(api, params) {
  switch (api) {
    case 'weather':
      return await proxyWeather(params);
    case 'geocode':
      return await proxyGeocode(params);
    case 'exchange-rate':
      return await proxyExchangeRate(params);
    case 'ip-lookup':
      return await proxyIpLookup(params);
    case 'crypto-price':
      return await proxyCryptoPrice(params);
    default:
      return { error: `Unknown API: ${api}` };
  }
}

/**
 * Weather API proxy using wttr.in (free, no key required)
 * Input: { location: "NYC" } or { location: "London" } or { lat, lon }
 */
async function proxyWeather(params) {
  const location = params?.location || params?.city || params?.q;
  if (!location) {
    return { error: 'Missing location. Provide {location: "city name"} or {lat, lon}' };
  }

  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
  const resp = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'BSV-Overlay-Proxy/1.0' }
  }, 10000);

  if (!resp.ok) {
    return { error: `Weather API returned ${resp.status}` };
  }

  const data = await resp.json();
  const current = data.current_condition?.[0];
  const area = data.nearest_area?.[0];

  return {
    api: 'weather',
    location: area?.areaName?.[0]?.value || location,
    country: area?.country?.[0]?.value,
    temperature: {
      celsius: parseInt(current?.temp_C) || null,
      fahrenheit: parseInt(current?.temp_F) || null,
    },
    feelsLike: {
      celsius: parseInt(current?.FeelsLikeC) || null,
      fahrenheit: parseInt(current?.FeelsLikeF) || null,
    },
    condition: current?.weatherDesc?.[0]?.value,
    humidity: `${current?.humidity}%`,
    windSpeed: {
      kmh: parseInt(current?.windspeedKmph) || null,
      mph: parseInt(current?.windspeedMiles) || null,
    },
    windDirection: current?.winddir16Point,
    visibility: `${current?.visibility} km`,
    uvIndex: current?.uvIndex,
    observationTime: current?.observation_time,
    provider: 'wttr.in',
  };
}

/**
 * Geocode API proxy using Nominatim/OpenStreetMap (free, no key required)
 * Input: { address: "1600 Pennsylvania Ave, Washington DC" } for forward geocoding
 *        { lat: 38.8977, lon: -77.0365 } for reverse geocoding
 */
async function proxyGeocode(params) {
  const address = params?.address || params?.q || params?.query;
  const lat = params?.lat || params?.latitude;
  const lon = params?.lon || params?.lng || params?.longitude;

  let url;
  let mode;
  if (address) {
    url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&addressdetails=1`;
    mode = 'forward';
  } else if (lat && lon) {
    url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;
    mode = 'reverse';
  } else {
    return { error: 'Provide {address: "..."} for forward geocoding or {lat, lon} for reverse geocoding' };
  }

  const resp = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'BSV-Overlay-Proxy/1.0' }
  }, 10000);

  if (!resp.ok) {
    return { error: `Geocode API returned ${resp.status}` };
  }

  const data = await resp.json();
  const result = Array.isArray(data) ? data[0] : data;

  if (!result || (Array.isArray(data) && data.length === 0)) {
    return { error: 'No results found', query: address || `${lat},${lon}` };
  }

  return {
    api: 'geocode',
    mode,
    query: address || `${lat},${lon}`,
    lat: parseFloat(result.lat),
    lon: parseFloat(result.lon),
    displayName: result.display_name,
    address: result.address ? {
      houseNumber: result.address.house_number,
      road: result.address.road,
      city: result.address.city || result.address.town || result.address.village,
      state: result.address.state,
      postcode: result.address.postcode,
      country: result.address.country,
      countryCode: result.address.country_code?.toUpperCase(),
    } : null,
    boundingBox: result.boundingbox,
    placeId: result.place_id,
    osmType: result.osm_type,
    provider: 'Nominatim/OpenStreetMap',
  };
}

/**
 * Exchange rate API proxy using exchangerate-api.com (free tier)
 * Input: { from: "USD", to: "EUR" } or { from: "USD", to: "EUR", amount: 100 }
 */
async function proxyExchangeRate(params) {
  const from = (params?.from || params?.base || 'USD').toUpperCase();
  const to = (params?.to || params?.target || 'EUR').toUpperCase();
  const amount = parseFloat(params?.amount) || 1;

  // Use open.er-api.com (free, no key required)
  const url = `https://open.er-api.com/v6/latest/${from}`;
  const resp = await fetchWithTimeout(url, {}, 10000);

  if (!resp.ok) {
    return { error: `Exchange rate API returned ${resp.status}` };
  }

  const data = await resp.json();
  if (data.result !== 'success') {
    return { error: data.error || 'Exchange rate lookup failed' };
  }

  const rate = data.rates?.[to];
  if (!rate) {
    return { error: `Currency not found: ${to}`, availableCurrencies: Object.keys(data.rates || {}).slice(0, 20) };
  }

  return {
    api: 'exchange-rate',
    from,
    to,
    rate,
    amount,
    converted: Math.round(amount * rate * 100) / 100,
    lastUpdate: data.time_last_update_utc,
    provider: 'open.er-api.com',
  };
}

/**
 * IP lookup API proxy using ip-api.com (free, no key required)
 * Input: { ip: "8.8.8.8" } or {} for own IP
 */
async function proxyIpLookup(params) {
  const ip = params?.ip || params?.address || '';
  const url = ip ? `http://ip-api.com/json/${ip}` : 'http://ip-api.com/json/';

  const resp = await fetchWithTimeout(url, {}, 10000);

  if (!resp.ok) {
    return { error: `IP lookup API returned ${resp.status}` };
  }

  const data = await resp.json();
  if (data.status === 'fail') {
    return { error: data.message || 'IP lookup failed', query: ip };
  }

  return {
    api: 'ip-lookup',
    ip: data.query,
    country: data.country,
    countryCode: data.countryCode,
    region: data.regionName,
    regionCode: data.region,
    city: data.city,
    zip: data.zip,
    lat: data.lat,
    lon: data.lon,
    timezone: data.timezone,
    isp: data.isp,
    org: data.org,
    as: data.as,
    provider: 'ip-api.com',
  };
}

/**
 * Crypto price API proxy using CoinGecko (free, no key required)
 * Input: { coin: "bitcoin" } or { coin: "ethereum", currency: "eur" }
 */
async function proxyCryptoPrice(params) {
  const coin = (params?.coin || params?.crypto || params?.id || 'bitcoin').toLowerCase();
  const currency = (params?.currency || params?.vs || 'usd').toLowerCase();

  // Map common symbols to CoinGecko IDs
  const coinMap = {
    'btc': 'bitcoin', 'eth': 'ethereum', 'bsv': 'bitcoin-sv',
    'ltc': 'litecoin', 'xrp': 'ripple', 'doge': 'dogecoin',
    'ada': 'cardano', 'sol': 'solana', 'dot': 'polkadot',
    'matic': 'matic-network', 'link': 'chainlink', 'avax': 'avalanche-2',
  };
  const coinId = coinMap[coin] || coin;

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=${currency}&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`;
  const resp = await fetchWithTimeout(url, {}, 10000);

  if (!resp.ok) {
    return { error: `Crypto price API returned ${resp.status}` };
  }

  const data = await resp.json();
  const coinData = data[coinId];

  if (!coinData) {
    return { error: `Coin not found: ${coin}`, suggestion: 'Use CoinGecko ID (e.g., "bitcoin", "ethereum", "bitcoin-sv")' };
  }

  return {
    api: 'crypto-price',
    coin: coinId,
    currency: currency.toUpperCase(),
    price: coinData[currency],
    change24h: coinData[`${currency}_24h_change`],
    marketCap: coinData[`${currency}_market_cap`],
    volume24h: coinData[`${currency}_24h_vol`],
    provider: 'CoinGecko',
  };
}

// ---------------------------------------------------------------------------
// Service: roulette (variable sats - gambling)
// ---------------------------------------------------------------------------

// Roulette wheel configuration (European single-zero)
const ROULETTE_NUMBERS = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
  5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26
];
const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const BLACK_NUMBERS = [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35];

const ROULETTE_MIN_BET = 10;
const ROULETTE_MAX_BET = 1000;

async function processRoulette(msg, identityKey, privKey) {
  const payment = msg.payload?.payment;
  const input = msg.payload?.input || msg.payload;
  const bet = input?.bet;
  const betAmount = payment?.satoshis || 0;

  // Helper to send rejection
  async function reject(reason, shortReason) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'roulette',
      status: 'rejected',
      reason,
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    }, 15000);
    return { id: msg.id, type: 'service-request', serviceId: 'roulette', action: 'rejected', reason: shortReason, from: msg.from, ack: true };
  }

  // Validate bet type
  const validBets = ['red', 'black', 'odd', 'even', 'low', 'high', '1st12', '2nd12', '3rd12'];
  const isNumberBet = typeof bet === 'number' && bet >= 0 && bet <= 36;
  const isNamedBet = typeof bet === 'string' && validBets.includes(bet.toLowerCase());
  
  if (!isNumberBet && !isNamedBet) {
    return reject(
      `Invalid bet. Options: single number (0-36), or: ${validBets.join(', ')}. Example: {bet: "red"} or {bet: 17}`,
      'invalid bet'
    );
  }

  // ── Payment verification via shared helper ──
  if (betAmount > ROULETTE_MAX_BET) {
    return reject(`Maximum bet is ${ROULETTE_MAX_BET} sats. You sent ${betAmount}.`, `bet too high: ${betAmount}`);
  }

  const walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  const payResult = await verifyAndAcceptPayment(payment, ROULETTE_MIN_BET, msg.from, 'roulette', ourHash160);
  if (!payResult.accepted) {
    return reject(`Payment rejected: ${payResult.error}. Place your bet (${ROULETTE_MIN_BET}-${ROULETTE_MAX_BET} sats).`, payResult.error);
  }

  const paymentTxid = payResult.txid;
  const paymentSats = payResult.satoshis;
  const walletAccepted = payResult.walletAccepted;
  const acceptError = payResult.error;
  const actualBetAmount = Math.min(paymentSats, ROULETTE_MAX_BET);

  // ── SPIN THE WHEEL ──
  const spinResult = spinRouletteWheel();
  const normalizedBet = isNumberBet ? bet : bet.toLowerCase();
  const { won, payout, multiplier } = evaluateRouletteBet(normalizedBet, spinResult, actualBetAmount);

  // Determine color of result
  const resultColor = spinResult === 0 ? 'green' : (RED_NUMBERS.includes(spinResult) ? 'red' : 'black');

  // ── If player won, pay them back ──
  let winningsPaid = false;
  let winningsPayment = null;
  let payoutError = null;

  if (won && payout > 0) {
    try {
      winningsPayment = await buildDirectPayment(msg.from, payout, `Roulette winnings: ${normalizedBet} on ${spinResult}`);
      winningsPaid = true;
    } catch (payErr) {
      payoutError = `Failed to send winnings: ${payErr instanceof Error ? payErr.message : String(payErr)}`;
    }
  }

  // Build result
  const gameResult = {
    spin: spinResult,
    color: resultColor,
    bet: normalizedBet,
    betAmount: actualBetAmount,
    won,
    multiplier: won ? multiplier : 0,
    payout: won ? payout : 0,
    winningsPaid,
    ...(winningsPayment ? { payoutTxid: winningsPayment.txid } : {}),
    ...(payoutError ? { payoutError } : {}),
    message: won
      ? `🎰 ${spinResult} ${resultColor.toUpperCase()}! You WIN ${payout} sats (${multiplier}x)!`
      : `🎰 ${spinResult} ${resultColor.toUpperCase()}. You lose ${actualBetAmount} sats. Better luck next time!`,
  };

  // Send response
  const responsePayload = {
    requestId: msg.id,
    serviceId: 'roulette',
    status: 'fulfilled',
    result: gameResult,
    paymentAccepted: true,
    paymentTxid,
    satoshisReceived: paymentSats,
    walletAccepted,
    ...(acceptError ? { walletError: acceptError } : {}),
  };
  const respSig = signRelayMessage(privKey, msg.from, 'service-response', responsePayload);
  await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: identityKey, to: msg.from, type: 'service-response',
      payload: responsePayload, signature: respSig,
    }),
  }, 15000);

  return {
    id: msg.id,
    type: 'service-request',
    serviceId: 'roulette',
    action: 'fulfilled',
    result: gameResult,
    paymentAccepted: true,
    paymentTxid,
    satoshisReceived: paymentSats,
    walletAccepted,
    direction: 'incoming-request',
    formatted: {
      type: 'roulette',
      summary: gameResult.message,
      earnings: won ? -payout : actualBetAmount, // negative if we paid out
    },
    ...(acceptError ? { walletError: acceptError } : {}),
    from: msg.from,
    ack: true,
  };
}

/**
 * Spin the roulette wheel - returns a number 0-36
 */
function spinRouletteWheel() {
  // Use crypto.getRandomValues for fairness
  const randomBytes = new Uint8Array(4);
  crypto.getRandomValues(randomBytes);
  const randomInt = (randomBytes[0] << 24) | (randomBytes[1] << 16) | (randomBytes[2] << 8) | randomBytes[3];
  const positiveInt = randomInt >>> 0; // Convert to unsigned
  return positiveInt % 37; // 0-36
}

/**
 * Evaluate a roulette bet against the spin result
 * Returns { won: boolean, payout: number, multiplier: number }
 */
function evaluateRouletteBet(bet, spinResult, betAmount) {
  // Single number bet (35:1)
  if (typeof bet === 'number') {
    if (bet === spinResult) {
      return { won: true, payout: betAmount * 36, multiplier: 36 }; // 35:1 + original bet
    }
    return { won: false, payout: 0, multiplier: 0 };
  }

  // Named bets
  switch (bet) {
    case 'red':
      if (RED_NUMBERS.includes(spinResult)) {
        return { won: true, payout: betAmount * 2, multiplier: 2 };
      }
      return { won: false, payout: 0, multiplier: 0 };

    case 'black':
      if (BLACK_NUMBERS.includes(spinResult)) {
        return { won: true, payout: betAmount * 2, multiplier: 2 };
      }
      return { won: false, payout: 0, multiplier: 0 };

    case 'odd':
      if (spinResult > 0 && spinResult % 2 === 1) {
        return { won: true, payout: betAmount * 2, multiplier: 2 };
      }
      return { won: false, payout: 0, multiplier: 0 };

    case 'even':
      if (spinResult > 0 && spinResult % 2 === 0) {
        return { won: true, payout: betAmount * 2, multiplier: 2 };
      }
      return { won: false, payout: 0, multiplier: 0 };

    case 'low': // 1-18
      if (spinResult >= 1 && spinResult <= 18) {
        return { won: true, payout: betAmount * 2, multiplier: 2 };
      }
      return { won: false, payout: 0, multiplier: 0 };

    case 'high': // 19-36
      if (spinResult >= 19 && spinResult <= 36) {
        return { won: true, payout: betAmount * 2, multiplier: 2 };
      }
      return { won: false, payout: 0, multiplier: 0 };

    case '1st12': // 1-12
      if (spinResult >= 1 && spinResult <= 12) {
        return { won: true, payout: betAmount * 3, multiplier: 3 };
      }
      return { won: false, payout: 0, multiplier: 0 };

    case '2nd12': // 13-24
      if (spinResult >= 13 && spinResult <= 24) {
        return { won: true, payout: betAmount * 3, multiplier: 3 };
      }
      return { won: false, payout: 0, multiplier: 0 };

    case '3rd12': // 25-36
      if (spinResult >= 25 && spinResult <= 36) {
        return { won: true, payout: betAmount * 3, multiplier: 3 };
      }
      return { won: false, payout: 0, multiplier: 0 };

    default:
      return { won: false, payout: 0, multiplier: 0 };
  }
}

// ---------------------------------------------------------------------------
// Service: memory-store (10 sats per operation)
// ---------------------------------------------------------------------------

const MEMORY_STORE_PATH = path.join(WALLET_DIR, 'memory-store.json');
const MEMORY_STORE_PRICE = 10;
const MEMORY_STORE_MAX_VALUE_SIZE = 1024; // 1KB
const MEMORY_STORE_MAX_KEYS_PER_NS = 100;

function loadMemoryStore() {
  try {
    if (fs.existsSync(MEMORY_STORE_PATH)) {
      return JSON.parse(fs.readFileSync(MEMORY_STORE_PATH, 'utf-8'));
    }
  } catch { /* corrupted file, start fresh */ }
  return {};
}

function saveMemoryStore(store) {
  try {
    fs.writeFileSync(MEMORY_STORE_PATH, JSON.stringify(store, null, 2));
  } catch (err) {
    throw new Error(`Failed to save memory store: ${err.message}`);
  }
}

async function processMemoryStore(msg, identityKey, privKey) {
  const payment = msg.payload?.payment;
  const input = msg.payload?.input || msg.payload;
  const operation = (input?.operation || input?.op || 'get').toLowerCase();
  const key = input?.key;
  const value = input?.value;
  // Default namespace is sender's pubkey (first 16 chars for readability)
  const namespace = input?.namespace || msg.from.slice(0, 16);

  // Helper to send rejection
  async function reject(reason, shortReason) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'memory-store',
      status: 'rejected',
      reason,
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    }, 15000);
    return { id: msg.id, type: 'service-request', serviceId: 'memory-store', action: 'rejected', reason: shortReason, from: msg.from, ack: true };
  }

  // Validate operation
  const validOps = ['set', 'get', 'delete', 'list'];
  if (!validOps.includes(operation)) {
    return reject(`Invalid operation. Supported: ${validOps.join(', ')}. Example: {operation: "set", key: "foo", value: "bar"}`, 'invalid operation');
  }

  // Validate key for operations that need it
  if (['set', 'get', 'delete'].includes(operation) && (!key || typeof key !== 'string' || key.length < 1 || key.length > 64)) {
    return reject('Invalid key. Must be a string 1-64 characters.', 'invalid key');
  }

  // Validate value for set operation
  if (operation === 'set') {
    const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
    if (!value || valueStr.length > MEMORY_STORE_MAX_VALUE_SIZE) {
      return reject(`Value too large or missing. Maximum ${MEMORY_STORE_MAX_VALUE_SIZE} bytes.`, 'value too large');
    }
  }

  // ── Payment verification ──
  let walletIdentity;
  try {
    walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));
  } catch (err) {
    return reject(`Wallet identity not found or corrupted: ${err.message}`, 'wallet error');
  }
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  const payResult = await verifyAndAcceptPayment(payment, MEMORY_STORE_PRICE, msg.from, 'memory-store', ourHash160);
  if (!payResult.accepted) {
    return reject(`Payment rejected: ${payResult.error}. Memory store costs ${MEMORY_STORE_PRICE} sats per operation.`, payResult.error);
  }

  const paymentTxid = payResult.txid;
  const paymentSats = payResult.satoshis;
  const walletAccepted = payResult.walletAccepted;
  const acceptError = payResult.error;

  // ── Execute the operation ──
  const store = loadMemoryStore();
  if (!store[namespace]) store[namespace] = {};
  const ns = store[namespace];

  let opResult;

  switch (operation) {
    case 'set':
      // Check key limit
      if (Object.keys(ns).length >= MEMORY_STORE_MAX_KEYS_PER_NS && !(key in ns)) {
        opResult = { operation: 'set', error: `Namespace has reached the maximum of ${MEMORY_STORE_MAX_KEYS_PER_NS} keys.` };
        break;
      }
      ns[key] = { value, updatedAt: Date.now(), updatedBy: msg.from };
      saveMemoryStore(store);
      opResult = { operation: 'set', namespace, key, success: true, message: `Stored value for key "${key}"` };
      break;

    case 'get':
      if (key in ns) {
        opResult = { operation: 'get', namespace, key, found: true, value: ns[key].value, updatedAt: ns[key].updatedAt };
      } else {
        opResult = { operation: 'get', namespace, key, found: false, message: `Key "${key}" not found` };
      }
      break;

    case 'delete':
      if (key in ns) {
        delete ns[key];
        saveMemoryStore(store);
        opResult = { operation: 'delete', namespace, key, deleted: true, message: `Deleted key "${key}"` };
      } else {
        opResult = { operation: 'delete', namespace, key, deleted: false, message: `Key "${key}" not found` };
      }
      break;

    case 'list':
      const keys = Object.keys(ns);
      opResult = { operation: 'list', namespace, keys, count: keys.length };
      break;
  }

  // Send response
  const responsePayload = {
    requestId: msg.id,
    serviceId: 'memory-store',
    status: opResult.error ? 'partial' : 'fulfilled',
    result: opResult,
    paymentAccepted: true,
    paymentTxid,
    satoshisReceived: paymentSats,
    walletAccepted,
    ...(acceptError ? { walletError: acceptError } : {}),
  };
  const respSig = signRelayMessage(privKey, msg.from, 'service-response', responsePayload);
  await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: identityKey, to: msg.from, type: 'service-response',
      payload: responsePayload, signature: respSig,
    }),
  }, 15000);

  return {
    id: msg.id,
    type: 'service-request',
    serviceId: 'memory-store',
    action: opResult.error ? 'partial' : 'fulfilled',
    result: opResult,
    paymentAccepted: true,
    paymentTxid,
    satoshisReceived: paymentSats,
    walletAccepted,
    direction: 'incoming-request',
    formatted: {
      type: 'memory-store',
      summary: opResult.error || opResult.message || `${operation} completed`,
      earnings: paymentSats,
    },
    ...(acceptError ? { walletError: acceptError } : {}),
    from: msg.from,
    ack: true,
  };
}

// ---------------------------------------------------------------------------
// Service: code-develop (100 sats) — Implement a GitHub issue and open a PR
// ---------------------------------------------------------------------------

const CODE_DEVELOP_PRICE = 100;

async function processCodeDevelop(msg, identityKey, privKey) {
  const input = msg.payload?.input || msg.payload;
  const issueUrl = input?.issueUrl || input?.issue;

  // Helper to send rejection
  async function reject(reason, shortReason) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'code-develop',
      status: 'rejected',
      reason,
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    }, 15000);
    return { id: msg.id, type: 'service-request', serviceId: 'code-develop', action: 'rejected', reason: shortReason, from: msg.from, ack: true };
  }

  // Validate issue URL
  if (!issueUrl || typeof issueUrl !== 'string') {
    return reject('Missing issue URL. Send {issueUrl: "https://github.com/owner/repo/issues/123"}', 'no issue URL');
  }

  const issueMatch = issueUrl.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!issueMatch) {
    return reject('Invalid issue URL format. Expected: https://github.com/owner/repo/issues/123', 'invalid URL');
  }

  const [, owner, repo, issueNumber] = issueMatch;

  // Security: validate owner/repo names
  const safeNameRegex = /^[a-zA-Z0-9._-]+$/;
  if (!safeNameRegex.test(owner) || !safeNameRegex.test(repo)) {
    return reject('Invalid owner/repo name — only alphanumeric, dots, hyphens, and underscores allowed', 'invalid repo name');
  }
  if (!/^\d+$/.test(issueNumber)) {
    return reject('Invalid issue number — must be numeric', 'invalid issue number');
  }

  // ── Payment verification ──
  let walletIdentity;
  try {
    walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));
  } catch (err) {
    return reject(`Wallet identity not found or corrupted: ${err.message}`, 'wallet error');
  }
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  const payResult = await verifyAndAcceptPayment(msg.payload?.payment, CODE_DEVELOP_PRICE, msg.from, 'code-develop', ourHash160);
  if (!payResult.accepted) {
    return reject(`Payment rejected: ${payResult.error}. Code development costs ${CODE_DEVELOP_PRICE} sats.`, payResult.error);
  }

  const paymentTxid = payResult.txid;
  const paymentSats = payResult.satoshis;
  const walletAccepted = payResult.walletAccepted;
  const acceptError = payResult.error;

  // ── Perform the development work ──
  let devResult;
  try {
    devResult = await performCodeDevelopment(owner, repo, issueNumber, issueUrl);
  } catch (err) {
    devResult = { error: `Development failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Send response
  const responsePayload = {
    requestId: msg.id,
    serviceId: 'code-develop',
    status: devResult.error ? 'failed' : 'fulfilled',
    result: devResult,
    paymentAccepted: true,
    paymentTxid,
    satoshisReceived: paymentSats,
    walletAccepted,
    ...(acceptError ? { walletError: acceptError } : {}),
  };
  const respSig = signRelayMessage(privKey, msg.from, 'service-response', responsePayload);
  await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: identityKey, to: msg.from, type: 'service-response',
      payload: responsePayload, signature: respSig,
    }),
  }, 15000);

  return {
    id: msg.id,
    type: 'service-request',
    serviceId: 'code-develop',
    action: devResult.error ? 'failed' : 'fulfilled',
    result: devResult,
    paymentAccepted: true,
    paymentTxid,
    satoshisReceived: paymentSats,
    walletAccepted,
    direction: 'incoming-request',
    formatted: {
      type: 'code-develop',
      summary: devResult.error || `PR created: ${devResult.prUrl}`,
      earnings: paymentSats,
    },
    ...(acceptError ? { walletError: acceptError } : {}),
    from: msg.from,
    ack: true,
  };
}

/**
 * Perform code development: clone repo, implement issue, create PR.
 * Uses Claude Code CLI for the implementation work.
 */
async function performCodeDevelopment(owner, repo, issueNumber, issueUrl) {
  const { execFileSync, spawnSync } = await import('child_process');
  const tmpDir = path.join(os.tmpdir(), `code-develop-${owner}-${repo}-${issueNumber}-${Date.now()}`);

  try {
    // 1. Fetch issue details
    let issueInfo;
    try {
      issueInfo = JSON.parse(execFileSync(
        'gh', ['issue', 'view', issueNumber, '--repo', `${owner}/${repo}`, '--json', 'title,body,labels,author'],
        { encoding: 'utf-8', timeout: 30000 },
      ));
    } catch (e) {
      return { error: `Failed to fetch issue: ${e.message}`, issueUrl };
    }

    const issueTitle = issueInfo.title || `Issue #${issueNumber}`;
    const issueBody = issueInfo.body || '';
    const labels = (issueInfo.labels || []).map(l => l.name).join(', ');

    // 2. Clone the repository
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      execFileSync('gh', ['repo', 'clone', `${owner}/${repo}`, tmpDir], {
        encoding: 'utf-8',
        timeout: 120000, // 2 min for large repos
      });
    } catch (e) {
      return { error: `Failed to clone repository: ${e.message}`, issueUrl };
    }

    // 3. Create a feature branch
    const branchName = `fix/issue-${issueNumber}`;
    try {
      execFileSync('git', ['checkout', '-b', branchName], {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 10000,
      });
    } catch (e) {
      return { error: `Failed to create branch: ${e.message}`, issueUrl };
    }

    // 4. Use Claude Code to implement the issue
    const prompt = `You are implementing GitHub issue #${issueNumber} for ${owner}/${repo}.

## Issue Title
${issueTitle}

## Issue Description
${issueBody}

${labels ? `## Labels: ${labels}` : ''}

## Instructions
1. Read the codebase to understand the project structure
2. Implement the changes required to resolve this issue
3. Follow existing code style and patterns
4. Add or update tests if appropriate
5. Make sure the code compiles/runs without errors
6. Commit your changes with a clear commit message referencing the issue

When done, your commit message should start with "fix: " or "feat: " and reference #${issueNumber}.`;

    let claudeResult;
    try {
      // Run Claude Code with timeout (5 minutes for implementation)
      claudeResult = spawnSync('claude', ['-p', prompt], {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 300000, // 5 minutes
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
      });

      if (claudeResult.status !== 0 && claudeResult.status !== null) {
        const errMsg = claudeResult.stderr || claudeResult.stdout || 'Unknown error';
        return { error: `Claude Code failed (exit ${claudeResult.status}): ${errMsg.slice(0, 500)}`, issueUrl };
      }
    } catch (e) {
      return { error: `Claude Code execution failed: ${e.message}`, issueUrl };
    }

    // 5. Check if there are any commits
    let commitCount;
    try {
      const logResult = execFileSync('git', ['rev-list', '--count', `main..${branchName}`], {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
      commitCount = parseInt(logResult, 10) || 0;
    } catch {
      // Try with master if main doesn't exist
      try {
        const logResult = execFileSync('git', ['rev-list', '--count', `master..${branchName}`], {
          cwd: tmpDir,
          encoding: 'utf-8',
          timeout: 10000,
        }).trim();
        commitCount = parseInt(logResult, 10) || 0;
      } catch {
        commitCount = 0;
      }
    }

    if (commitCount === 0) {
      // No commits made - Claude didn't make changes, or made them but didn't commit
      // Try to commit any staged/unstaged changes
      try {
        execFileSync('git', ['add', '-A'], { cwd: tmpDir, timeout: 10000 });
        execFileSync('git', ['commit', '-m', `fix: implement issue #${issueNumber}\n\n${issueTitle}`], {
          cwd: tmpDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        commitCount = 1;
      } catch {
        return { error: 'No changes were made to resolve the issue', issueUrl };
      }
    }

    // 6. Push the branch (requires gh auth or git credentials)
    try {
      execFileSync('git', ['push', '-u', 'origin', branchName], {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 60000,
      });
    } catch (e) {
      return { error: `Failed to push branch: ${e.message}`, issueUrl, branch: branchName, commits: commitCount };
    }

    // 7. Create the PR
    let prUrl;
    try {
      const prBody = [
        `## Summary`,
        `This PR implements the changes requested in #${issueNumber}.`,
        ``,
        `## Issue`,
        `Closes #${issueNumber}`,
        ``,
        `## Changes`,
        `Implemented by automated code development service.`,
        ``,
        `---`,
        `_Generated by BSV Overlay code-develop service_`,
      ].join('\n');

      const prResult = execFileSync('gh', [
        'pr', 'create',
        '--repo', `${owner}/${repo}`,
        '--head', branchName,
        '--title', `fix: ${issueTitle}`,
        '--body', prBody,
      ], {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 30000,
      }).trim();
      prUrl = prResult;
    } catch (e) {
      return { 
        error: `Failed to create PR: ${e.message}`, 
        issueUrl, 
        branch: branchName, 
        commits: commitCount,
        note: 'Branch was pushed successfully. You may create the PR manually.',
      };
    }

    return {
      issueUrl,
      issueTitle,
      prUrl,
      branch: branchName,
      commits: commitCount,
      message: `Successfully implemented issue #${issueNumber} and created PR`,
    };

  } finally {
    // Cleanup: remove temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

/** Analyze a GitHub PR diff for common issues. */
function analyzePrReview(prInfo, diff) {
  const files = prInfo.files || [];
  const findings = [];
  const diffLines = diff.split('\n');
  let currentFile = '';
  let currentHunk = '';
  let addedLines = 0;
  let removedLines = 0;
  let lineNum = 0;

  // Per-file tracking
  const fileStats = {};
  const addedBlocks = {}; // file -> array of consecutive added lines

  for (const line of diffLines) {
    if (line.startsWith('diff --git')) {
      currentFile = line.split(' b/')[1] || '';
      if (!fileStats[currentFile]) fileStats[currentFile] = { added: 0, removed: 0, functions: [], imports: [] };
    } else if (line.startsWith('@@')) {
      currentHunk = line;
      const match = line.match(/@@ .* \+(\d+)/);
      lineNum = match ? parseInt(match[1]) - 1 : 0;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines++;
      lineNum++;
      if (fileStats[currentFile]) fileStats[currentFile].added++;
      const trimmed = line.slice(1).trim();

      // ── Security checks ──
      if (trimmed.includes('eval('))
        findings.push({ severity: 'critical', file: currentFile, line: lineNum, detail: '`eval()` usage — potential code injection risk' });
      if (trimmed.match(/\bexecSync\b|\bexec\b/) && trimmed.match(/\$\{|\+\s*\w/))
        findings.push({ severity: 'critical', file: currentFile, line: lineNum, detail: 'Shell command with string interpolation — injection risk' });
      if (trimmed.match(/password|secret|api_key|apikey|private_key|token/i) && !trimmed.match(/\/\/|^\s*\*|param|type|interface|@/))
        findings.push({ severity: 'high', file: currentFile, line: lineNum, detail: 'Possible hardcoded secret or credential' });
      if (trimmed.match(/https?:\/\/\d+\.\d+\.\d+\.\d+/))
        findings.push({ severity: 'warning', file: currentFile, line: lineNum, detail: 'Hardcoded IP address — use config/env variable' });
      if (trimmed.includes('dangerouslySetInnerHTML') || trimmed.includes('innerHTML'))
        findings.push({ severity: 'high', file: currentFile, line: lineNum, detail: 'Direct HTML injection — XSS risk' });

      // ── Error handling ──
      if (trimmed.match(/catch\s*\([^)]*\)\s*\{\s*\}/) || trimmed.match(/catch\s*\{\s*\}/))
        findings.push({ severity: 'warning', file: currentFile, line: lineNum, detail: 'Empty catch block — errors silently swallowed' });
      if (trimmed.match(/catch\s*\([^)]*\)\s*\{\s*\/\//))
        findings.push({ severity: 'info', file: currentFile, line: lineNum, detail: 'Catch block with only a comment — consider logging the error' });
      if (trimmed.match(/\.then\(/) && !trimmed.match(/\.catch\(/))
        findings.push({ severity: 'info', file: currentFile, line: lineNum, detail: 'Promise .then() without .catch() — unhandled rejection risk' });

      // ── Code quality ──
      if (trimmed.match(/console\.(log|debug|info)\(/))
        findings.push({ severity: 'warning', file: currentFile, line: lineNum, detail: 'Debug logging left in — remove before merge' });
      if (trimmed.match(/TODO|FIXME|HACK|XXX|TEMP/i))
        findings.push({ severity: 'info', file: currentFile, line: lineNum, detail: `Marker comment: ${trimmed.slice(0, 100)}` });
      if (trimmed.includes('var ') && !trimmed.match(/\/\/|^\s*\*/))
        findings.push({ severity: 'info', file: currentFile, line: lineNum, detail: '`var` declaration — prefer `let` or `const`' });
      if (line.length > 200)
        findings.push({ severity: 'info', file: currentFile, line: lineNum, detail: `Line too long (${line.length} chars)` });
      if (trimmed.match(/==\s/) && !trimmed.match(/===/) && !trimmed.match(/!==/) && !trimmed.match(/\/\//))
        findings.push({ severity: 'warning', file: currentFile, line: lineNum, detail: 'Loose equality (`==`) — use strict equality (`===`)' });
      if (trimmed.match(/\bany\b/) && currentFile.match(/\.ts$/))
        findings.push({ severity: 'info', file: currentFile, line: lineNum, detail: '`any` type — consider a more specific type' });

      // ── Reliability ──
      if (trimmed.match(/fetch\(/) && !trimmed.match(/timeout|signal|AbortController/))
        findings.push({ severity: 'warning', file: currentFile, line: lineNum, detail: 'fetch() without timeout — could hang indefinitely' });
      if (trimmed.match(/JSON\.parse\(/) && !currentHunk.includes('try'))
        findings.push({ severity: 'warning', file: currentFile, line: lineNum, detail: 'JSON.parse without try/catch — will throw on invalid input' });
      if (trimmed.match(/fs\.(readFileSync|writeFileSync)/) && !currentHunk.includes('try'))
        findings.push({ severity: 'info', file: currentFile, line: lineNum, detail: 'Sync file I/O without error handling' });

      // ── Architecture ──
      if (trimmed.match(/function\s+\w+/) || trimmed.match(/(const|let)\s+\w+\s*=\s*(async\s+)?\(/)) {
        const fname = trimmed.match(/function\s+(\w+)/)?.[1] || trimmed.match(/(const|let)\s+(\w+)/)?.[2];
        if (fname && fileStats[currentFile]) fileStats[currentFile].functions.push(fname);
      }
      if (trimmed.match(/^import\s/) || trimmed.match(/require\(/)) {
        if (fileStats[currentFile]) fileStats[currentFile].imports.push(trimmed.slice(0, 80));
      }
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removedLines++;
      lineNum++;
    } else {
      lineNum++;
    }
  }

  // ── Structural analysis ──
  const suggestions = [];

  // Large PR
  if (addedLines > 500)
    suggestions.push(`Large PR (+${addedLines} lines) — consider splitting into smaller, focused PRs for easier review`);
  if (files.length > 10)
    suggestions.push(`${files.length} files changed — verify all changes are related to the PR scope`);

  // Single file dominance
  const sortedFiles = Object.entries(fileStats).sort((a, b) => b[1].added - a[1].added);
  if (sortedFiles.length > 1 && sortedFiles[0][1].added > addedLines * 0.8)
    suggestions.push(`${sortedFiles[0][0]} has ${sortedFiles[0][1].added}/${addedLines} additions — consider if this file is getting too large`);

  // Many new functions
  const totalNewFunctions = Object.values(fileStats).reduce((sum, s) => sum + s.functions.length, 0);
  if (totalNewFunctions > 10)
    suggestions.push(`${totalNewFunctions} new functions added — ensure they're well-tested and documented`);

  // File type analysis
  const fileTypes = {};
  for (const f of files) {
    const ext = f.path?.split('.').pop() || 'unknown';
    fileTypes[ext] = (fileTypes[ext] || 0) + 1;
  }

  // Test file check
  const hasTests = files.some(f => f.path?.match(/test|spec|__tests__/i));
  if (addedLines > 50 && !hasTests)
    suggestions.push('No test files included — consider adding tests for new functionality');

  // Deduplicate findings
  const seen = new Set();
  const uniqueFindings = findings.filter(f => {
    const key = f.file + '|' + f.detail;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Build assessment
  const criticalCount = uniqueFindings.filter(f => f.severity === 'critical').length;
  const highCount = uniqueFindings.filter(f => f.severity === 'high').length;
  const warningCount = uniqueFindings.filter(f => f.severity === 'warning').length;
  const infoCount = uniqueFindings.filter(f => f.severity === 'info').length;

  let overallAssessment;
  if (criticalCount > 0)
    overallAssessment = `🔴 ${criticalCount} critical issue(s) found — must be addressed before merging`;
  else if (highCount > 0)
    overallAssessment = `🟠 ${highCount} high-severity issue(s) — strongly recommend fixing before merge`;
  else if (warningCount > 3)
    overallAssessment = `🟡 ${warningCount} warnings — review and address where appropriate`;
  else if (warningCount > 0)
    overallAssessment = `🟢 Minor warnings only (${warningCount}) — looks good overall`;
  else if (infoCount > 0)
    overallAssessment = `✅ Clean — only informational notes (${infoCount})`;
  else
    overallAssessment = `✅ No issues found — LGTM`;

  if (suggestions.length > 0)
    overallAssessment += '\n\n**Suggestions:**\n' + suggestions.map(s => `- ${s}`).join('\n');

  return {
    type: 'code-review',
    summary: `Review of PR: ${prInfo.title}`,
    author: prInfo.author?.login || 'unknown',
    filesReviewed: files.length,
    linesChanged: `+${prInfo.additions || addedLines} / -${prInfo.deletions || removedLines}`,
    fileTypes,
    findings: uniqueFindings.slice(0, 30),
    findingsSummary: { critical: criticalCount, high: highCount, warning: warningCount, info: infoCount },
    suggestions,
    overallAssessment,
  };
}

/** Analyze a code snippet for common issues. */
function analyzeCodeSnippet(code, language) {
  const lines = code.split('\n');
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('console.log'))
      findings.push({ severity: 'warning', line: i + 1, detail: 'Debug logging' });
    if (line.includes('TODO') || line.includes('FIXME'))
      findings.push({ severity: 'info', line: i + 1, detail: line.trim() });
    if (line.match(/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/))
      findings.push({ severity: 'warning', line: i + 1, detail: 'Empty catch block' });
    if (line.includes('eval('))
      findings.push({ severity: 'critical', line: i + 1, detail: 'eval() is a security risk' });
    if (line.includes('var '))
      findings.push({ severity: 'info', line: i + 1, detail: 'Use let/const instead of var' });
    if (line.includes('password') || line.includes('secret') || line.includes('api_key'))
      findings.push({ severity: 'critical', line: i + 1, detail: 'Potential secret/credential in code' });
    if (line.match(/===?\s*null\b/) && !line.match(/!==?\s*null\b/))
      findings.push({ severity: 'info', line: i + 1, detail: 'Null check — consider optional chaining' });
  }

  return {
    type: 'code-review',
    summary: `Code review (${language}, ${lines.length} lines)`,
    language,
    totalLines: lines.length,
    findings: findings.slice(0, 20),
    overallAssessment: findings.some(f => f.severity === 'critical')
      ? 'Critical issues found'
      : findings.length > 3
        ? 'Several items to review'
        : 'Looks reasonable',
  };
}

/** Handle a tell-joke service request with payment verification. */
async function processJokeRequest(msg, identityKey, privKey) {
  const PRICE = 5;

  // Helper to send rejection
  async function reject(reason, shortReason) {
    const rejectPayload = {
      requestId: msg.id, serviceId: 'tell-joke', status: 'rejected', reason,
    };
    const rejectSig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetch(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: identityKey, to: msg.from, type: 'service-response',
        payload: rejectPayload, signature: rejectSig,
      }),
    });
    return {
      id: msg.id, type: 'service-request', serviceId: 'tell-joke',
      action: 'rejected', reason: shortReason, from: msg.from, ack: true,
    };
  }

  // ── Payment verification via shared helper ──
  const walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  const payResult = await verifyAndAcceptPayment(msg.payload?.payment, PRICE, msg.from, 'tell-joke', ourHash160);
  if (!payResult.accepted) {
    return reject(`Payment rejected: ${payResult.error}. This service costs ${PRICE} sats.`, payResult.error);
  }

  const paymentTxid = payResult.txid;
  const paymentSats = payResult.satoshis;
  const walletAccepted = payResult.walletAccepted;
  const acceptError = payResult.error;

  // Serve the joke
  const joke = JOKES[Math.floor(Math.random() * JOKES.length)];
  const responsePayload = {
    requestId: msg.id, serviceId: 'tell-joke', status: 'fulfilled',
    result: joke, paymentAccepted: true, paymentTxid,
    satoshisReceived: paymentSats, walletAccepted,
    ...(acceptError ? { walletError: acceptError } : {}),
  };
  const respSig = signRelayMessage(privKey, msg.from, 'service-response', responsePayload);
  await fetch(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: identityKey, to: msg.from, type: 'service-response',
      payload: responsePayload, signature: respSig,
    }),
  });

  return {
    id: msg.id, type: 'service-request', serviceId: 'tell-joke',
    action: 'fulfilled', joke, paymentAccepted: true, paymentTxid,
    satoshisReceived: paymentSats, walletAccepted,
    direction: 'incoming-request', // We received a request and earned sats
    formatted: {
      type: 'joke-fulfilled',
      summary: `Joke served: "${joke.setup}" — "${joke.punchline}"`,
      earnings: paymentSats,
    },
    ...(acceptError ? { walletError: acceptError } : {}),
    from: msg.from, ack: true,
  };
}

// ---------------------------------------------------------------------------
// Service: x-engagement (provider-set pricing)
// ---------------------------------------------------------------------------

/**
 * Process X engagement requests (tweet, reply, follow, unfollow).
 * These are the actions bird CLI actually supports.
 * Requirements:
 * - Provider must have verified X account (x-verifications.json)
 * - Provider must have bird CLI configured with cookies
 */
async function processXEngagement(msg, identityKey, privKey) {
  const input = msg.payload?.input || msg.payload;
  const payment = msg.payload?.payment;
  
  // Load provider's verified X accounts
  const verificationsPath = path.join(OVERLAY_STATE_DIR, 'x-verifications.json');
  let verifications = [];
  try {
    if (fs.existsSync(verificationsPath)) {
      verifications = JSON.parse(fs.readFileSync(verificationsPath, 'utf-8'));
    }
  } catch (err) {
    console.warn(`[x-engagement] Warning: Could not read verifications: ${err.message}`);
  }
  
  if (verifications.length === 0) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'x-engagement',
      status: 'rejected',
      reason: 'Provider has no verified X account. Cannot fulfill engagement requests.',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'x-engagement', action: 'rejected', reason: 'no verified x account', from: msg.from, ack: true };
  }
  
  // Validate input - supported actions: tweet, reply, follow, unfollow
  const action = input?.action?.toLowerCase();
  const VALID_ACTIONS = ['tweet', 'reply', 'follow', 'unfollow'];
  
  if (!action || !VALID_ACTIONS.includes(action)) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'x-engagement',
      status: 'rejected',
      reason: `Invalid action "${action || 'none'}". Supported: tweet, reply, follow, unfollow`,
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'x-engagement', action: 'rejected', reason: 'invalid action', from: msg.from, ack: true };
  }
  
  // Validate action-specific inputs
  const text = input?.text;
  const tweetUrl = input?.tweetUrl || input?.url;
  const username = input?.username || input?.handle || input?.user;
  
  if ((action === 'tweet') && !text) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'x-engagement',
      status: 'rejected',
      reason: 'Tweet action requires text. Send {action: "tweet", text: "Your tweet content"}',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'x-engagement', action: 'rejected', reason: 'missing text', from: msg.from, ack: true };
  }
  
  if ((action === 'reply') && (!tweetUrl || !text)) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'x-engagement',
      status: 'rejected',
      reason: 'Reply action requires tweetUrl and text. Send {action: "reply", tweetUrl: "https://x.com/.../status/...", text: "Your reply"}',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'x-engagement', action: 'rejected', reason: 'missing tweetUrl or text', from: msg.from, ack: true };
  }
  
  if ((action === 'follow' || action === 'unfollow') && !username) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'x-engagement',
      status: 'rejected',
      reason: `${action} action requires username. Send {action: "${action}", username: "@handle"}`,
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'x-engagement', action: 'rejected', reason: 'missing username', from: msg.from, ack: true };
  }
  
  // Load service price from local services
  const services = loadServices();
  const xEngagementService = services.find(s => s.serviceId === 'x-engagement');
  const PRICE = xEngagementService?.priceSats || 10; // Default 10 sats if not advertised
  
  // Verify payment
  const walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  const payResult = await verifyAndAcceptPayment(payment, PRICE, msg.from, 'x-engagement', ourHash160);
  
  if (!payResult.accepted) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'x-engagement',
      status: 'rejected',
      reason: `Payment rejected: ${payResult.error}. X engagement costs ${PRICE} sats.`,
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'x-engagement', action: 'rejected', reason: payResult.error, from: msg.from, ack: true };
  }

  // Perform the engagement action using bird CLI
  let engagementResult;
  
  try {
    const { spawnSync } = await import('child_process');
    
    // Build bird command args (using array syntax for shell safety - no injection risk)
    let birdArgs = [];
    let resultData = {};
    
    if (action === 'tweet') {
      birdArgs = ['tweet', text];
      resultData = { action: 'tweet', text };
    } else if (action === 'reply') {
      birdArgs = ['reply', tweetUrl, text];
      resultData = { action: 'reply', tweetUrl, text };
    } else if (action === 'follow') {
      const cleanUsername = username.replace(/^@/, '');
      birdArgs = ['follow', cleanUsername];
      resultData = { action: 'follow', username: cleanUsername };
    } else if (action === 'unfollow') {
      const cleanUsername = username.replace(/^@/, '');
      birdArgs = ['unfollow', cleanUsername];
      resultData = { action: 'unfollow', username: cleanUsername };
    }
    
    // Execute bird command using spawnSync with array args (safe from injection)
    const result = spawnSync('bird', birdArgs, { 
      encoding: 'utf-8',
      timeout: 30000,
      env: process.env,
    });
    
    if (result.error) {
      throw result.error;
    }
    
    if (result.status !== 0) {
      throw new Error(result.stderr || `bird exited with code ${result.status}`);
    }
    
    engagementResult = {
      success: true,
      ...resultData,
      output: (result.stdout || '').trim(),
      providerXAccount: verifications[0]?.xHandle,
    };
    
  } catch (err) {
    engagementResult = { 
      success: false, 
      action,
      error: err.message,
      stderr: err.stderr?.toString() || '',
    };
  }
  
  // Send response
  const responsePayload = {
    requestId: msg.id,
    serviceId: 'x-engagement',
    status: engagementResult.success ? 'fulfilled' : 'failed',
    result: engagementResult,
    paymentAccepted: true,
    paymentTxid: payResult.txid,
    satoshisReceived: payResult.satoshis,
    walletAccepted: payResult.walletAccepted,
  };
  
  const respSig = signRelayMessage(privKey, msg.from, 'service-response', responsePayload);
  await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: responsePayload, signature: respSig }),
  });
  
  return {
    id: msg.id, type: 'service-request', serviceId: 'x-engagement',
    action: engagementResult.success ? 'fulfilled' : 'failed',
    result: engagementResult,
    paymentAccepted: true, paymentTxid: payResult.txid,
    satoshisReceived: payResult.satoshis, walletAccepted: payResult.walletAccepted,
    from: msg.from, ack: true,
  };
}

async function cmdXEngagementQueue() {
  const queuePath = path.join(OVERLAY_STATE_DIR, 'x-engagement-queue.jsonl');
  if (!fs.existsSync(queuePath)) {
    return ok({ queue: [], count: 0 });
  }
  
  const lines = fs.readFileSync(queuePath, 'utf-8').split('\n').filter(l => l.trim());
  const queue = lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean).filter(e => e.status === 'pending');
  
  ok({ queue, count: queue.length });
}

/**
 * Mark an X engagement request as fulfilled.
 */
async function cmdXEngagementFulfill(requestId, proofUrl) {
  if (!requestId) return fail('Usage: x-engagement-fulfill <requestId> [proofUrl]');
  
  const queuePath = path.join(OVERLAY_STATE_DIR, 'x-engagement-queue.jsonl');
  if (!fs.existsSync(queuePath)) {
    return fail('No engagement queue found.');
  }
  
  const lines = fs.readFileSync(queuePath, 'utf-8').split('\n').filter(l => l.trim());
  const queue = lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  
  const entryIndex = queue.findIndex(e => e.requestId === requestId);
  if (entryIndex === -1) {
    return fail(`Request ${requestId} not found in queue.`);
  }
  
  // Mark as fulfilled
  queue[entryIndex].status = 'fulfilled';
  queue[entryIndex].fulfilledAt = new Date().toISOString();
  queue[entryIndex].proofUrl = proofUrl || null;
  
  // Rewrite queue file
  fs.writeFileSync(queuePath, queue.map(e => JSON.stringify(e)).join('\n') + '\n');
  
  ok({
    fulfilled: true,
    requestId,
    entry: queue[entryIndex],
  });
}


// ---------------------------------------------------------------------------
// Baemail Service — Paid Message Forwarding
// ---------------------------------------------------------------------------

const BAEMAIL_CONFIG_PATH = path.join(OVERLAY_STATE_DIR, 'baemail-config.json');

/**
 * Load baemail configuration.
 */
function loadBaemailConfig() {
  try {
    if (fs.existsSync(BAEMAIL_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(BAEMAIL_CONFIG_PATH, 'utf-8'));
    }
  } catch (err) {
    console.warn(`[baemail] Warning: Could not read config: ${err.message}`);
  }
  return null;
}

/**
 * Save baemail configuration.
 */
function saveBaemailConfig(config) {
  fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
  fs.writeFileSync(BAEMAIL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Setup baemail service with delivery channel and tier pricing.
 * Usage: baemail-setup <channel> <standardSats> <prioritySats> <urgentSats>
 */
async function cmdBaemailSetup(channel, standardStr, priorityStr, urgentStr) {
  if (!channel || !standardStr) {
    return fail('Usage: baemail-setup <channel> <standardSats> [prioritySats] [urgentSats]');
  }

  const standard = parseInt(standardStr, 10);
  const priority = priorityStr ? parseInt(priorityStr, 10) : standard * 2;
  const urgent = urgentStr ? parseInt(urgentStr, 10) : standard * 5;

  if (isNaN(standard) || standard < 1) {
    return fail('Standard rate must be a positive integer (sats)');
  }
  if (priority < standard) {
    return fail('Priority rate must be >= standard rate');
  }
  if (urgent < priority) {
    return fail('Urgent rate must be >= priority rate');
  }

  const config = {
    deliveryChannel: channel,
    tiers: { standard, priority, urgent },
    maxMessageLength: 4000,
    blocklist: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  saveBaemailConfig(config);

  ok({
    configured: true,
    deliveryChannel: channel,
    tiers: config.tiers,
    note: `Advertise with: overlay-cli advertise baemail "Baemail" "Paid message forwarding. Pay ${standard}+ sats to reach me." ${standard}`,
  });
}

/**
 * View current baemail configuration.
 */
async function cmdBaemailConfig() {
  const config = loadBaemailConfig();
  if (!config) {
    return fail('Baemail not configured. Run: baemail-setup <channel> <standardSats> [prioritySats] [urgentSats]');
  }
  ok(config);
}

/**
 * Block a sender from using baemail.
 */
async function cmdBaemailBlock(identityKey) {
  if (!identityKey) return fail('Usage: baemail-block <identityKey>');

  const config = loadBaemailConfig();
  if (!config) {
    return fail('Baemail not configured. Run baemail-setup first.');
  }

  if (!config.blocklist) config.blocklist = [];
  if (config.blocklist.includes(identityKey)) {
    return fail('Identity already blocked');
  }

  config.blocklist.push(identityKey);
  config.updatedAt = new Date().toISOString();
  saveBaemailConfig(config);

  ok({ blocked: identityKey, totalBlocked: config.blocklist.length });
}

/**
 * Unblock a sender.
 */
async function cmdBaemailUnblock(identityKey) {
  if (!identityKey) return fail('Usage: baemail-unblock <identityKey>');

  const config = loadBaemailConfig();
  if (!config) {
    return fail('Baemail not configured. Run baemail-setup first.');
  }

  if (!config.blocklist || !config.blocklist.includes(identityKey)) {
    return fail('Identity not in blocklist');
  }

  config.blocklist = config.blocklist.filter(k => k !== identityKey);
  config.updatedAt = new Date().toISOString();
  saveBaemailConfig(config);

  ok({ unblocked: identityKey, totalBlocked: config.blocklist.length });
}

/**
 * Process incoming baemail service request.
 * Validates payment, determines tier, forwards to configured channel.
 */
async function processBaemail(msg, identityKey, privKey) {
  const input = msg.payload?.input || msg.payload;
  const payment = msg.payload?.payment;

  // Load config
  const config = loadBaemailConfig();
  if (!config) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: 'Baemail service not configured on this agent.',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: 'not configured', from: msg.from, ack: true };
  }

  // Check blocklist
  if (config.blocklist && config.blocklist.includes(msg.from)) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: 'Sender is blocked.',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: 'blocked', from: msg.from, ack: true };
  }

  // Validate message
  const message = input?.message;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: 'Missing or empty message. Send {message: "your message"}',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: 'missing message', from: msg.from, ack: true };
  }

  if (message.length > (config.maxMessageLength || 4000)) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: `Message too long. Max ${config.maxMessageLength || 4000} characters.`,
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: 'message too long', from: msg.from, ack: true };
  }

  // Load wallet identity for payment verification
  let walletIdentity;
  try {
    walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));
  } catch (err) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: 'Service temporarily unavailable (wallet error)',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: 'wallet error', from: msg.from, ack: true };
  }

  // Sender info for message formatting
  const senderName = input?.senderName || 'Anonymous';
  const replyKey = input?.replyIdentityKey || msg.from;

  // Check hooks are configured (but don't pre-test - avoids race condition)
  let hookToken = null;
  let hookPort = 18789;
  const openclawConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  
  if (fs.existsSync(openclawConfigPath)) {
    try {
      const openclawConfig = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf-8'));
      hookToken = openclawConfig?.hooks?.token;
      hookPort = openclawConfig?.gateway?.port || 18789;
    } catch (parseErr) {
      console.warn('[baemail] Failed to parse OpenClaw config:', parseErr.message);
    }
  }

  if (!hookToken) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: 'OpenClaw hooks not configured. Payment NOT accepted.',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: 'hooks not configured', from: msg.from, ack: true };
  }

  // Verify and accept payment
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  const minPrice = config.tiers.standard;
  
  const payResult = await verifyAndAcceptPayment(payment, minPrice, msg.from, 'baemail', ourHash160);

  if (!payResult.accepted) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'baemail',
      status: 'rejected',
      reason: `Payment rejected: ${payResult.error}. Minimum: ${minPrice} sats.`,
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'baemail', action: 'rejected', reason: payResult.error, from: msg.from, ack: true };
  }

  // Determine tier based on payment amount
  const paidSats = payResult.satoshis;
  let tier = 'standard';
  let tierEmoji = '📧';
  if (paidSats >= config.tiers.urgent) {
    tier = 'urgent';
    tierEmoji = '🚨';
  } else if (paidSats >= config.tiers.priority) {
    tier = 'priority';
    tierEmoji = '⚡';
  }

  // Format and deliver the message
  const formattedMessage = `${tierEmoji} **Baemail** (${tier.toUpperCase()})

**From:** ${senderName}
**Paid:** ${paidSats} sats
**Reply to:** \`${replyKey.slice(0, 16)}...\`

---

${message}

---
_Reply via overlay: \`overlay-cli send ${replyKey} ping "your reply"\`_`;

  let deliverySuccess = false;
  let deliveryError = null;

  try {
    const hookHost = process.env.CLAWDBOT_HOST || process.env.OPENCLAW_HOST || '127.0.0.1';
    const hookUrl = `http://${hookHost}:${hookPort}/hooks/agent`;
    const hookResp = await fetchWithTimeout(hookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${hookToken}`,
        'x-clawdbot-token': hookToken,
      },
      body: JSON.stringify({
        message: formattedMessage,
        name: 'Baemail',
        sessionKey: `baemail:${msg.id}`,
        wakeMode: 'now',
        deliver: true,
        channel: config.deliveryChannel,
      }),
    });

    if (hookResp.ok) {
      deliverySuccess = true;
    } else {
      const body = await hookResp.text().catch(() => '');
      deliveryError = `Hook failed: ${hookResp.status} ${body}`;
    }
  } catch (err) {
    deliveryError = err.message;
  }

  // Log the delivery attempt (with refund status if failed)
  const logPath = path.join(OVERLAY_STATE_DIR, 'baemail-log.jsonl');
  const logEntry = {
    requestId: msg.id,
    from: msg.from,
    senderName,
    tier,
    paidSats,
    messageLength: message.length,
    deliveryChannel: config.deliveryChannel,
    deliverySuccess,
    deliveryError,
    paymentTxid: payResult.txid,
    refundStatus: deliverySuccess ? null : 'pending',
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');

  // Send response - status reflects ACTUAL delivery result
  const responsePayload = {
    requestId: msg.id,
    serviceId: 'baemail',
    status: deliverySuccess ? 'fulfilled' : 'delivery_failed',
    result: {
      delivered: deliverySuccess,
      tier,
      channel: config.deliveryChannel,
      paidSats,
      error: deliveryError,
      replyTo: identityKey,
      refundable: !deliverySuccess,
      note: deliverySuccess ? undefined : 'Delivery failed. Run: baemail-refund ' + msg.id,
    },
    paymentAccepted: true,
    paymentTxid: payResult.txid,
    satoshisReceived: payResult.satoshis,
  };

  const respSig = signRelayMessage(privKey, msg.from, 'service-response', responsePayload);
  await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: responsePayload, signature: respSig }),
  });

  return {
    id: msg.id, type: 'service-request', serviceId: 'baemail',
    action: deliverySuccess ? 'fulfilled' : 'delivery_failed',
    tier,
    deliverySuccess,
    deliveryError,
    paymentAccepted: true, paymentTxid: payResult.txid,
    satoshisReceived: payResult.satoshis,
    from: msg.from, ack: true,
  };
}

/**
 * View baemail delivery log.
 */
async function cmdBaemailLog(limitStr) {
  const limit = parseInt(limitStr, 10) || 20;
  const logPath = path.join(OVERLAY_STATE_DIR, 'baemail-log.jsonl');
  
  if (!fs.existsSync(logPath)) {
    return ok({ log: [], count: 0 });
  }

  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(l => l.trim());
  const entries = lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const recent = entries.slice(-limit).reverse();
  ok({ log: recent, count: entries.length, showing: recent.length });
}

/**
 * Refund a failed baemail delivery.
 * Sends the received sats back to the sender.
 */
async function cmdBaemailRefund(requestId) {
  if (!requestId) return fail('Usage: baemail-refund <requestId>');

  const logPath = path.join(OVERLAY_STATE_DIR, 'baemail-log.jsonl');
  if (!fs.existsSync(logPath)) {
    return fail('No baemail log found');
  }

  // Find the entry
  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(l => l.trim());
  const entries = lines.map((l, idx) => {
    try { return { ...JSON.parse(l), _lineIdx: idx }; } catch { return null; }
  }).filter(Boolean);

  const entry = entries.find(e => e.requestId === requestId);
  if (!entry) {
    return fail(`Request ${requestId} not found in baemail log`);
  }

  if (entry.deliverySuccess) {
    return fail('This delivery was successful — no refund needed');
  }

  if (entry.refundStatus === 'completed') {
    return fail('Refund already processed for this request');
  }

  // Load wallet
  const { identityKey, privKey } = loadIdentity();
  const walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));

  // Calculate refund amount (same as received, minus small tx fee)
  const refundSats = entry.paidSats - 1; // Keep 1 sat for tx fee
  if (refundSats < 1) {
    return fail('Amount too small to refund');
  }

  // Derive refund address from sender's identity key (BRC-29 style)
  const senderPubKey = PublicKey.fromString(entry.from);
  const refundAddress = senderPubKey.toAddress().toString();

  // Create and broadcast refund transaction
  try {
    // Load UTXOs
    const address = walletIdentity.address;
    const utxosResp = await fetchWithTimeout(`https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent`);
    const utxos = await utxosResp.json();

    if (!utxos || utxos.length === 0) {
      return fail('No UTXOs available for refund');
    }

    // Build transaction
    const tx = new Transaction();
    let totalInput = 0;
    const rootKey = PrivateKey.fromHex(walletIdentity.rootKeyHex);

    for (const utxo of utxos) {
      if (totalInput >= refundSats + 50) break; // enough for refund + fee buffer
      tx.addInput({
        sourceTXID: utxo.tx_hash,
        sourceOutputIndex: utxo.tx_pos,
        sourceSatoshis: utxo.value,
        script: new P2PKH().lock(rootKey.toPublicKey().toAddress()).toHex(),
        unlockingScriptTemplate: new P2PKH().unlock(rootKey),
      });
      totalInput += utxo.value;
    }

    if (totalInput < refundSats + 10) {
      return fail('Insufficient funds for refund');
    }

    // Refund output
    tx.addOutput({
      satoshis: refundSats,
      lockingScript: new P2PKH().lock(refundAddress),
    });

    // Change output (if any)
    const fee = 10;
    const change = totalInput - refundSats - fee;
    if (change > 1) {
      tx.addOutput({
        satoshis: change,
        lockingScript: new P2PKH().lock(rootKey.toPublicKey().toAddress()),
      });
    }

    await tx.sign();

    // Broadcast via WoC
    const beef = tx.toHexBEEF();
    const broadcastResp = await fetchWithTimeout('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: tx.toHex() }),
    });

    if (!broadcastResp.ok) {
      const errBody = await broadcastResp.text();
      return fail(`Broadcast failed: ${errBody}`);
    }

    const txid = tx.id('hex');

    // Update log entry
    const updatedLines = lines.map((l, idx) => {
      if (idx === entry._lineIdx) {
        const updated = { ...JSON.parse(l), refundStatus: 'completed', refundTxid: txid, refundedAt: new Date().toISOString() };
        return JSON.stringify(updated);
      }
      return l;
    });
    fs.writeFileSync(logPath, updatedLines.join('\n') + '\n');

    ok({
      refunded: true,
      requestId,
      refundSats,
      refundAddress,
      txid,
      note: `Refunded ${refundSats} sats to sender`,
    });

  } catch (err) {
    return fail(`Refund failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Poll command — uses shared processMessage
// ---------------------------------------------------------------------------

async function cmdPoll() {
  const { identityKey, privKey } = loadIdentity();

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
    } else {
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

  ok({
    processed: processed.length,
    unhandled: unhandled.length,
    total: inbox.count,
    messages: processed,
    unhandledMessages: unhandled,
    ackedIds,
  });
}

// ---------------------------------------------------------------------------
// Connect command — WebSocket real-time message processing
// ---------------------------------------------------------------------------

async function cmdConnect() {
  let WebSocketClient;
  try {
    const ws = await import('ws');
    WebSocketClient = ws.default || ws.WebSocket || ws;
  } catch {
    return fail('WebSocket client not available. Install it: npm install ws (in the skill directory)');
  }

  const { identityKey, privKey } = loadIdentity();
  const wsUrl = OVERLAY_URL.replace(/^http/, 'ws') + '/relay/subscribe?identity=' + identityKey;

  let reconnectDelay = 1000;
  let shouldReconnect = true;
  let currentWs = null;

  function shutdown() {
    shouldReconnect = false;
    if (currentWs) {
      try { currentWs.close(); } catch {}
    }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  function connect() {
    const ws = new WebSocketClient(wsUrl);
    currentWs = ws;

    ws.on('open', () => {
      reconnectDelay = 1000; // reset on successful connect
      console.error(JSON.stringify({ event: 'connected', identity: identityKey, overlay: OVERLAY_URL }));
    });

    ws.on('message', async (data) => {
      try {
        const envelope = JSON.parse(data.toString());
        if (envelope.type === 'message') {
          const result = await processMessage(envelope.message, identityKey, privKey);
          // Output the result as a JSON line to stdout
          console.log(JSON.stringify(result));

          // Also append to notification log for external consumers (cron, etc.)
          const notifPath = path.join(OVERLAY_STATE_DIR, 'notifications.jsonl');
          try {
            fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
            fs.appendFileSync(notifPath, JSON.stringify({ ...result, _ts: Date.now() }) + '\n');
          } catch {}
          // Ack the message
          if (result.ack) {
            try {
              await fetch(OVERLAY_URL + '/relay/ack', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identity: identityKey, messageIds: [result.id] }),
              });
            } catch (ackErr) {
              console.error(JSON.stringify({ event: 'ack-error', id: result.id, message: String(ackErr) }));
            }
          }
        }
        // Handle service announcements from the overlay
        if (envelope.type === 'service-announced') {
          const svc = envelope.service || {};
          const announcement = {
            event: 'service-announced',
            serviceId: svc.serviceId,
            name: svc.name,
            description: svc.description,
            priceSats: svc.pricingSats,
            provider: svc.identityKey,
            txid: envelope.txid,
            _ts: Date.now(),
          };
          console.log(JSON.stringify(announcement));
          // Also write to notification log
          const notifPath = path.join(OVERLAY_STATE_DIR, 'notifications.jsonl');
          try {
            fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
            fs.appendFileSync(notifPath, JSON.stringify(announcement) + '\n');
          } catch {}
        }
        // Ignore 'connected' type — just informational
      } catch (err) {
        console.error(JSON.stringify({ event: 'process-error', message: String(err) }));
      }
    });

    ws.on('close', () => {
      currentWs = null;
      if (shouldReconnect) {
        console.error(JSON.stringify({ event: 'disconnected', reconnectMs: reconnectDelay }));
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      }
    });

    ws.on('error', (err) => {
      console.error(JSON.stringify({ event: 'error', message: err.message }));
    });
  }

  connect();
  // Keep the process alive — never resolves
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// research-queue / research-respond — Clawdbot processes web research via its tools
// ---------------------------------------------------------------------------

async function cmdResearchQueue() {
  const queuePath = path.join(OVERLAY_STATE_DIR, 'research-queue.jsonl');
  if (!fs.existsSync(queuePath)) return ok({ pending: [] });
  const lines = fs.readFileSync(queuePath, 'utf-8').trim().split('\n').filter(Boolean);
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  ok({ pending: entries, count: entries.length });
}

async function cmdResearchRespond(resultJsonPath) {
  if (!resultJsonPath) return fail('Usage: research-respond <resultJsonFile>');
  if (!fs.existsSync(resultJsonPath)) return fail(`File not found: ${resultJsonPath}`);

  const result = JSON.parse(fs.readFileSync(resultJsonPath, 'utf-8'));
  const { requestId, from: recipientKey, query, research } = result;

  if (!requestId || !recipientKey || !research) {
    return fail('Result JSON must have: requestId, from, query, research');
  }

  // Load identity
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized.');
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  const identityKey = privKey.toPublicKey().toString();
  const relayPrivHex = identity.relayKeyHex || identity.rootKeyHex;
  const relayPrivKey = PrivateKey.fromHex(relayPrivHex);

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

  const sig = signRelayMessage(relayPrivKey, recipientKey, 'service-response', responsePayload);
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
  const queuePath = path.join(OVERLAY_STATE_DIR, 'research-queue.jsonl');
  if (fs.existsSync(queuePath)) {
    const lines = fs.readFileSync(queuePath, 'utf-8').trim().split('\n').filter(Boolean);
    const remaining = lines.filter(l => {
      try { return JSON.parse(l).requestId !== requestId; } catch { return true; }
    });
    fs.writeFileSync(queuePath, remaining.length ? remaining.join('\n') + '\n' : '');
  }

  ok({ responded: true, requestId, to: recipientKey, query, pushed: sendResult.pushed });
}

// ---------------------------------------------------------------------------
// service-queue / respond-service — Agent-routed service fulfillment
// ---------------------------------------------------------------------------

async function cmdServiceQueue() {
  const queuePath = path.join(OVERLAY_STATE_DIR, 'service-queue.jsonl');
  if (!fs.existsSync(queuePath)) return ok({ pending: [], count: 0 });
  const lines = fs.readFileSync(queuePath, 'utf-8').trim().split('\n').filter(Boolean);
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const pending = entries.filter(e => e.status === 'pending');
  ok({ pending, count: pending.length, total: entries.length });
}

async function cmdRespondService(requestId, recipientKey, serviceId, resultJson) {
  if (!requestId || !recipientKey || !serviceId || !resultJson) {
    return fail('Usage: respond-service <requestId> <recipientKey> <serviceId> <resultJson>');
  }
  
  let result;
  try {
    result = JSON.parse(resultJson);
  } catch {
    return fail('resultJson must be valid JSON');
  }
  
  const { identityKey, privKey } = loadIdentity();
  
  const responsePayload = {
    requestId,
    serviceId,
    status: 'fulfilled',
    result,
  };
  
  const sig = signRelayMessage(privKey, recipientKey, 'service-response', responsePayload);
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
  
  if (!resp.ok) return fail(`Relay send failed: ${resp.status}`);
  
  // Mark as fulfilled in queue
  const queuePath = path.join(OVERLAY_STATE_DIR, 'service-queue.jsonl');
  if (fs.existsSync(queuePath)) {
    const lines = fs.readFileSync(queuePath, 'utf-8').trim().split('\n').filter(Boolean);
    const updated = lines.map(line => {
      try {
        const entry = JSON.parse(line);
        if (entry.requestId === requestId) {
          return JSON.stringify({ ...entry, status: 'fulfilled', fulfilledAt: Date.now() });
        }
        return line;
      } catch { return line; }
    });
    fs.writeFileSync(queuePath, updated.join('\n') + '\n');
  }
  
  ok({ sent: true, requestId, serviceId, to: recipientKey });
}

async function cmdRequestService(targetKey, serviceId, satsStr, inputJsonStr) {
  if (!targetKey || !serviceId) {
    return fail('Usage: request-service <identityKey> <serviceId> [sats] [inputJson]');
  }
  if (!/^0[23][0-9a-fA-F]{64}$/.test(targetKey)) {
    return fail('Target must be a compressed public key (66 hex chars, 02/03 prefix)');
  }

  const { identityKey, privKey } = loadIdentity();
  const sats = parseInt(satsStr || '5', 10);

  // Parse optional input JSON
  let inputData = null;
  if (inputJsonStr) {
    try {
      inputData = JSON.parse(inputJsonStr);
    } catch {
      return fail('inputJson must be valid JSON');
    }
  }

  // Build the service request payload
  let paymentData = null;

  if (sats > 0) {
    try {
      const payment = await buildDirectPayment(targetKey, sats, `service-request: ${serviceId}`);
      paymentData = {
        beef: payment.beef,
        txid: payment.txid,
        satoshis: payment.satoshis,
        derivationPrefix: payment.derivationPrefix,
        derivationSuffix: payment.derivationSuffix,
        senderIdentityKey: payment.senderIdentityKey,
      };
    } catch (err) {
      // Payment failed — send request without payment
      paymentData = { error: String(err instanceof Error ? err.message : err) };
    }
  }

  const requestPayload = {
    serviceId,
    ...(inputData ? { input: inputData } : {}),
    payment: paymentData,
    requestedAt: new Date().toISOString(),
  };

  const signature = signRelayMessage(privKey, targetKey, 'service-request', requestPayload);

  const resp = await fetch(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: identityKey,
      to: targetKey,
      type: 'service-request',
      payload: requestPayload,
      signature,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    return fail(`Relay send failed (${resp.status}): ${body}`);
  }
  const result = await resp.json();

  ok({
    sent: true,
    requestId: result.id,
    to: targetKey,
    serviceId,
    paymentIncluded: paymentData && !paymentData.error,
    paymentTxid: paymentData?.txid || null,
    satoshis: paymentData?.satoshis || 0,
    note: 'Poll for service-response to get the result',
  });
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------
const [,, command, ...args] = process.argv;

try {
  switch (command) {
    // Wallet
    case 'setup':     await cmdSetup(); break;
    case 'identity':  await cmdIdentity(); break;
    case 'address':   await cmdAddress(); break;
    case 'balance':   await cmdBalance(); break;
    case 'import':    await cmdImport(args[0], args[1]); break;
    case 'refund':    await cmdRefund(args[0]); break;

    // Overlay registration
    case 'register':    await cmdRegister(); break;
    case 'unregister':  await cmdUnregister(); break;

    // Services
    case 'services':    await cmdServices(); break;
    case 'advertise':   await cmdAdvertise(args[0], args[1], args[2], args[3]); break;
    case 'remove':      await cmdRemove(args[0]); break;
    case 'readvertise': await cmdReadvertise(args[0], args[1], args[2], args.slice(3).join(' ') || undefined); break;

    // Discovery
    case 'discover':    await cmdDiscover(args); break;

    // Payments
    case 'pay':     await cmdPay(args[0], args[1], args.slice(2).join(' ') || undefined); break;
    case 'verify':  await cmdVerify(args[0]); break;
    case 'accept':  await cmdAccept(args[0], args[1], args[2], args[3], args.slice(4).join(' ') || undefined); break;

    // Messaging (relay)
    case 'send':              await cmdSend(args[0], args[1], args[2]); break;
    case 'inbox':             await cmdInbox(args); break;
    case 'ack':               await cmdAck(args); break;
    case 'poll':              await cmdPoll(); break;
    case 'connect':           await cmdConnect(); break;
    case 'request-service':   await cmdRequestService(args[0], args[1], args[2], args[3]); break;
    case 'research-respond':  await cmdResearchRespond(args[0]); break;
    case 'research-queue':    await cmdResearchQueue(); break;
    case 'service-queue':     await cmdServiceQueue(); break;
    case 'respond-service':   await cmdRespondService(args[0], args[1], args[2], args.slice(3).join(' ')); break;

    // X Account Verification
    case 'x-verify-start':      await cmdXVerifyStart(args[0]); break;
    case 'x-verify-complete':   await cmdXVerifyComplete(args[0]); break;
    case 'x-verifications':     await cmdXVerifications(); break;
    case 'x-lookup':            await cmdXLookup(args[0]); break;

    // X Engagement Service
    case 'x-engagement-queue':    await cmdXEngagementQueue(); break;
    case 'x-engagement-fulfill':  await cmdXEngagementFulfill(args[0], args[1]); break;

    // Baemail commands
    case 'baemail-setup':   await cmdBaemailSetup(args[0], args[1], args[2], args[3]); break;
    case 'baemail-config':  await cmdBaemailConfig(); break;
    case 'baemail-block':   await cmdBaemailBlock(args[0]); break;
    case 'baemail-unblock': await cmdBaemailUnblock(args[0]); break;
    case 'baemail-log':     await cmdBaemailLog(args[0]); break;
    case 'baemail-refund':  await cmdBaemailRefund(args[0]); break;

    default:
      fail(`Unknown command: ${command || '(none)'}. Commands: setup, identity, address, balance, import, refund, register, unregister, ` +
           `services, advertise, readvertise, remove, discover, pay, verify, accept, send, inbox, ack, poll, connect, ` +
           `request-service, research-queue, research-respond, service-queue, respond-service, ` +
           `x-verify-start, x-verify-complete, x-verifications, x-lookup, x-engagement-queue, x-engagement-fulfill`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
