/**
 * @a2a-bsv/core — Wallet tests
 *
 * These tests verify that BSVAgentWallet can be instantiated and its basic
 * methods are callable. Full integration tests require a funded testnet wallet.
 */

import { BSVAgentWallet } from '../core/index.js';
import { verifyPayment } from '../core/verify.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Simple test runner (no jest dependency needed)
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${name}`);
      console.log(`    ${msg}`);
      failed++;
    }
  })();
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function run() {
  console.log('@a2a-bsv/core tests\n');

  // ── Verify payment (pure, no wallet needed) ──────────────────────────

  await test('verifyPayment rejects empty beef', async () => {
    const result = await verifyPayment({ beef: '' });
    assert(!result.valid, 'should be invalid');
    assert(result.errors.length > 0, 'should have errors');
  });

  await test('verifyPayment rejects garbage base64', async () => {
    const result = await verifyPayment({ beef: 'dGhpcyBpcyBub3QgYmVlZg==' });
    assert(!result.valid, 'should be invalid');
    assert(result.errors.length > 0, 'should have errors');
  });

  await test('verifyPayment validates expectedSender format', async () => {
    const result = await verifyPayment({
      beef: 'dGhpcyBpcyBub3QgYmVlZg==',
      expectedSender: 'not-a-pubkey',
    });
    assert(!result.valid, 'should be invalid');
    assert(result.errors.length >= 2, 'should have both BEEF and sender errors');
    const hasSenderError = result.errors.some(e => e.includes('public key'));
    assert(hasSenderError, 'should flag invalid sender key');
  });

  // ── Wallet creation ──────────────────────────────────────────────────

  await test('BSVAgentWallet.create creates a wallet and identity file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-test-'));
    try {
      const wallet = await BSVAgentWallet.create({
        network: 'testnet',
        storageDir: tmpDir,
      });

      // Identity file should exist
      const identityPath = path.join(tmpDir, 'wallet-identity.json');
      assert(fs.existsSync(identityPath), 'identity file should exist');

      // Should have a valid identity key
      const identityKey = await wallet.getIdentityKey();
      assert(
        /^0[23][0-9a-f]{64}$/.test(identityKey),
        `identityKey should be compressed pubkey, got: ${identityKey}`,
      );

      // Balance should be 0 for a fresh wallet
      const balance = await wallet.getBalance();
      assert(balance === 0, `fresh wallet balance should be 0, got: ${balance}`);

      await wallet.destroy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('BSVAgentWallet.load loads an existing wallet', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-test-'));
    try {
      // Create first
      const wallet1 = await BSVAgentWallet.create({
        network: 'testnet',
        storageDir: tmpDir,
      });
      const key1 = await wallet1.getIdentityKey();
      await wallet1.destroy();

      // Load
      const wallet2 = await BSVAgentWallet.load({
        network: 'testnet',
        storageDir: tmpDir,
      });
      const key2 = await wallet2.getIdentityKey();
      await wallet2.destroy();

      assert(key1 === key2, `loaded wallet should have same identity key`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('BSVAgentWallet.load throws for missing wallet', async () => {
    const tmpDir = path.join(os.tmpdir(), 'a2a-nonexistent-' + Date.now());
    try {
      await BSVAgentWallet.load({ network: 'testnet', storageDir: tmpDir });
      throw new Error('Should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes('No wallet found'), `should say no wallet found, got: ${msg}`);
    }
  });

  await test('createPayment rejects address (requires pubkey)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-test-'));
    try {
      const wallet = await BSVAgentWallet.create({
        network: 'testnet',
        storageDir: tmpDir,
      });

      try {
        await wallet.createPayment({
          to: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // address, not pubkey
          satoshis: 100,
        });
        throw new Error('Should have thrown');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        assert(msg.includes('compressed public key'), `should require pubkey, got: ${msg}`);
      }

      await wallet.destroy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Summary ──────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
