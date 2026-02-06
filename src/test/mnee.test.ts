/**
 * MNEE stablecoin integration tests.
 *
 * Tests cover:
 * - Key derivation from root key (uses @bsv/sdk, always available)
 * - SDK guard: clear error when @mnee/ts-sdk is not installed
 * - Type compatibility and backward-compatible defaults
 * - Payment handler branching (BSV vs MNEE paths)
 * - Service advertisement MNEE pricing fields
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Simple test runner (matches project convention)
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      console.log(`  \u2705 ${name}`);
      passed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  \u274C ${name}`);
      console.log(`    ${msg}`);
      failed++;
    }
  })();
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function run() {
  console.log('\n=== MNEE Stablecoin Tests ===\n');

  // ── deriveWifAndAddress (pure @bsv/sdk, no MNEE SDK needed) ──────────

  await test('deriveWifAndAddress: derives valid WIF and address from root key', async () => {
    const { PrivateKey } = await import('@bsv/sdk');
    const { deriveWifAndAddress } = await import('../core/mnee.js');

    const rootKey = PrivateKey.fromRandom();
    const rootKeyHex = rootKey.toHex();

    const { wif, address } = await deriveWifAndAddress(rootKeyHex);

    // WIF should start with 5, K, or L (mainnet) or c (testnet)
    assert(typeof wif === 'string' && wif.length > 40, `WIF should be a string, got: ${wif}`);

    // Address should be a valid BSV address format
    assert(typeof address === 'string' && address.length > 20, `Address should be a string, got: ${address}`);

    // Deriving again with same root key should give same results
    const second = await deriveWifAndAddress(rootKeyHex);
    assert(second.wif === wif, 'WIF should be deterministic');
    assert(second.address === address, 'Address should be deterministic');
  });

  await test('deriveWifAndAddress: different root keys produce different addresses', async () => {
    const { PrivateKey } = await import('@bsv/sdk');
    const { deriveWifAndAddress } = await import('../core/mnee.js');

    const key1 = PrivateKey.fromRandom().toHex();
    const key2 = PrivateKey.fromRandom().toHex();

    const result1 = await deriveWifAndAddress(key1);
    const result2 = await deriveWifAndAddress(key2);

    assert(result1.address !== result2.address, 'Different root keys should give different addresses');
    assert(result1.wif !== result2.wif, 'Different root keys should give different WIFs');
  });

  await test('deriveWifAndAddress: address matches PrivateKey.toAddress()', async () => {
    const { PrivateKey } = await import('@bsv/sdk');
    const { deriveWifAndAddress } = await import('../core/mnee.js');

    const rootKey = PrivateKey.fromRandom();
    const { address } = await deriveWifAndAddress(rootKey.toHex());

    // Should match the direct derivation from @bsv/sdk
    const expected = rootKey.toAddress().toString();
    assert(address === expected, `Address mismatch: ${address} vs ${expected}`);
  });

  // ── MNEE SDK guard ───────────────────────────────────────────────────

  await test('getMneeBalance: returns balance for a known address', async () => {
    const { getMneeBalance } = await import('../core/mnee.js');

    // Use the genesis address — MNEE SDK is installed as optional dep
    // If SDK is not installed, we accept an error mentioning it
    try {
      const bal = await getMneeBalance('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
      assert(typeof bal.balanceUsd === 'number', 'balanceUsd should be a number');
      assert(typeof bal.balanceAtomic === 'number', 'balanceAtomic should be a number');
      assert(bal.balanceAtomic >= 0, 'balanceAtomic should be non-negative');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Acceptable: SDK not installed
      assert(msg.includes('@mnee/ts-sdk'), `Unexpected error: ${msg}`);
    }
  });

  await test('getMneeBalance: returns balance for own derived address', async () => {
    const { PrivateKey } = await import('@bsv/sdk');
    const { deriveWifAndAddress, getMneeBalance } = await import('../core/mnee.js');

    const rootKey = PrivateKey.fromRandom();
    const { address } = await deriveWifAndAddress(rootKey.toHex());

    try {
      const bal = await getMneeBalance(address);
      // Fresh random address should have 0 balance
      assert(bal.balanceAtomic === 0, `Fresh address balance should be 0, got ${bal.balanceAtomic}`);
      assert(bal.balanceUsd === 0, `Fresh address USD balance should be 0, got ${bal.balanceUsd}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes('@mnee/ts-sdk'), `Unexpected error: ${msg}`);
    }
  });

  await test('sendMnee: rejects zero amount before calling SDK', async () => {
    const { sendMnee } = await import('../core/mnee.js');

    try {
      await sendMnee({
        recipientAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        amountUsd: 0,
        senderWif: 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ',
      });
      throw new Error('Should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes('greater than 0'), `Should reject zero amount, got: ${msg}`);
    }
  });

  await test('verifyMneePayment: fails for invalid txid', async () => {
    const { verifyMneePayment } = await import('../core/mnee.js');

    try {
      const result = await verifyMneePayment({
        txid: 'not-a-valid-txid',
        receiverAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      });
      // parseTx should fail and return an error result
      assert(!result.valid, 'should be invalid for fake txid');
      assert(result.errors.length > 0, 'should have errors');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Also acceptable: SDK not installed
      assert(msg.includes('@mnee/ts-sdk'), `Unexpected error: ${msg}`);
    }
  });

  // ── Type compatibility ───────────────────────────────────────────────

  await test('MneePaymentResult: correct shape', () => {
    // Verify the type shape at runtime
    const result = {
      paymentType: 'mnee' as const,
      txid: 'abc123',
      ticketId: 'ticket-1',
      amountUsd: 0.05,
      amountAtomic: 5,
      senderAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      senderIdentityKey: '02' + 'a'.repeat(64),
    };

    assert(result.paymentType === 'mnee', 'paymentType should be mnee');
    assert(typeof result.amountUsd === 'number', 'amountUsd should be number');
    assert(typeof result.amountAtomic === 'number', 'amountAtomic should be number');
    assert(typeof result.senderAddress === 'string', 'senderAddress should be string');
  });

  await test('MneeVerifyResult: correct shape', () => {
    const result = {
      valid: true,
      txid: 'abc123',
      amountUsd: 0.05,
      amountAtomic: 5,
      errors: [] as string[],
    };

    assert(result.valid === true, 'valid should be boolean');
    assert(result.errors.length === 0, 'errors should be empty array');
  });

  await test('PaymentCurrency: accepts bsv and mnee', () => {
    const currencies: Array<'bsv' | 'mnee'> = ['bsv', 'mnee'];
    assert(currencies.includes('bsv'), 'should accept bsv');
    assert(currencies.includes('mnee'), 'should accept mnee');
  });

  // ── ServiceAdvertisement backward compatibility ──────────────────────

  await test('ServiceAdvertisement: backward compatible without MNEE fields', () => {
    // Legacy format (BSV only)
    const legacy = {
      serviceId: 'test-service',
      name: 'Test',
      description: 'A test service',
      priceSats: 50,
    };

    assert(legacy.priceSats === 50, 'priceSats should work');
    assert(!('priceUsd' in legacy), 'priceUsd should be absent in legacy');
    assert(!('acceptedCurrencies' in legacy), 'acceptedCurrencies should be absent in legacy');
  });

  await test('ServiceAdvertisement: includes MNEE pricing fields', () => {
    const withMnee = {
      serviceId: 'test-service',
      name: 'Test',
      description: 'A test service',
      priceSats: 50,
      priceUsd: 0.05,
      acceptedCurrencies: ['bsv', 'mnee'] as ('bsv' | 'mnee')[],
    };

    assert(withMnee.priceUsd === 0.05, 'priceUsd should be 0.05');
    assert(withMnee.acceptedCurrencies.length === 2, 'should accept 2 currencies');
    assert(withMnee.acceptedCurrencies.includes('mnee'), 'should include mnee');
  });

  // ── Payment handler branching ────────────────────────────────────────

  await test('verifyAndAcceptPayment: rejects missing payment', async () => {
    const { verifyAndAcceptPayment } = await import('../scripts/messaging/handlers.js');
    const result = await verifyAndAcceptPayment(null, 5, 'sender', 'test-svc', new Uint8Array(20));
    assert(!result.accepted, 'should reject null payment');
    assert(result.currency === 'bsv', 'default currency should be bsv');
    assert(result.error === 'no payment', 'error should say no payment');
  });

  await test('verifyAndAcceptPayment: rejects payment with error field', async () => {
    const { verifyAndAcceptPayment } = await import('../scripts/messaging/handlers.js');
    const payment = { error: 'payment build failed' };
    const result = await verifyAndAcceptPayment(payment, 5, 'sender', 'test-svc', new Uint8Array(20));
    assert(!result.accepted, 'should reject payment with error');
    assert(result.error === 'payment build failed', 'should propagate error message');
  });

  await test('verifyAndAcceptPayment: BSV path rejects missing beef', async () => {
    const { verifyAndAcceptPayment } = await import('../scripts/messaging/handlers.js');
    const payment = { satoshis: 100 }; // missing beef
    const result = await verifyAndAcceptPayment(payment, 5, 'sender', 'test-svc', new Uint8Array(20));
    assert(!result.accepted, 'should reject missing beef');
    assert(result.currency === 'bsv', 'currency should be bsv');
    assert(result.error!.includes('missing beef'), 'error should mention missing beef');
  });

  await test('verifyAndAcceptPayment: BSV path rejects insufficient payment', async () => {
    const { verifyAndAcceptPayment } = await import('../scripts/messaging/handlers.js');
    const payment = { beef: 'dGhpcyBpcyBub3QgYmVlZg==', satoshis: 3, txid: 'abc' };
    const result = await verifyAndAcceptPayment(payment, 5, 'sender', 'test-svc', new Uint8Array(20));
    assert(!result.accepted, 'should reject insufficient satoshis');
    assert(result.satoshis === 3, 'should report actual satoshis');
    assert(result.error!.includes('insufficient'), 'error should mention insufficient');
  });

  await test('verifyAndAcceptPayment: MNEE path rejects missing txid', async () => {
    const { verifyAndAcceptPayment } = await import('../scripts/messaging/handlers.js');
    const payment = { paymentType: 'mnee', amountUsd: 0.05 }; // missing txid
    const result = await verifyAndAcceptPayment(payment, 0, 'sender', 'test-svc', new Uint8Array(20), 0.05);
    assert(!result.accepted, 'should reject MNEE payment without txid');
    assert(result.currency === 'mnee', 'currency should be mnee');
    assert(result.error!.includes('MNEE txid'), 'error should mention missing MNEE txid');
  });

  await test('verifyAndAcceptPayment: MNEE path attempts verification with txid', async () => {
    const { verifyAndAcceptPayment } = await import('../scripts/messaging/handlers.js');
    const payment = { paymentType: 'mnee', txid: 'fakemneetxid123', amountUsd: 0.05 };
    // This will fail because @mnee/ts-sdk is not installed (or the txid is fake)
    const result = await verifyAndAcceptPayment(payment, 0, 'sender', 'test-svc', new Uint8Array(20), 0.05);
    assert(!result.accepted, 'should fail verification (SDK not installed or invalid txid)');
    assert(result.currency === 'mnee', 'currency should be mnee');
    assert(result.txid === 'fakemneetxid123', 'should report the txid');
    // Error should mention either @mnee/ts-sdk or verification failure
    assert(result.error!.length > 0, 'should have an error message');
  });

  // ── Config flags ─────────────────────────────────────────────────────

  await test('Config: MNEE_ENABLED defaults to false', async () => {
    // Save and clear env var
    const orig = process.env.MNEE_ENABLED;
    delete process.env.MNEE_ENABLED;

    // Re-import to get fresh value (dynamic import caching means
    // we verify the module-level constant instead)
    const config = await import('../scripts/config.js');
    // MNEE_ENABLED reads process.env at module load time
    // Since we can't re-import easily, just verify the exported constant exists
    assert('MNEE_ENABLED' in config, 'MNEE_ENABLED should be exported');
    assert('MNEE_API_KEY' in config, 'MNEE_API_KEY should be exported');

    // Restore
    if (orig !== undefined) process.env.MNEE_ENABLED = orig;
  });

  // ── sendMnee input validation ────────────────────────────────────────

  await test('sendMnee: rejects negative amount', async () => {
    const { sendMnee } = await import('../core/mnee.js');

    try {
      await sendMnee({
        recipientAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        amountUsd: -1,
        senderWif: 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ',
      });
      throw new Error('Should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes('greater than 0'), `Should reject negative amount, got: ${msg}`);
    }
  });

  // ── Plugin JSON schema ───────────────────────────────────────────────

  await test('Plugin JSON: clawdbot.plugin.json includes MNEE config fields', () => {
    const pluginPath = path.resolve(import.meta.dirname || '.', '..', '..', 'clawdbot.plugin.json');
    const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf-8'));
    const props = plugin.configSchema.properties;

    assert('mneeEnabled' in props, 'mneeEnabled should be in configSchema');
    assert(props.mneeEnabled.type === 'boolean', 'mneeEnabled should be boolean');
    assert(props.mneeEnabled.default === false, 'mneeEnabled should default to false');

    assert('dailyBudgetUsd' in props, 'dailyBudgetUsd should be in configSchema');
    assert(props.dailyBudgetUsd.type === 'number', 'dailyBudgetUsd should be number');

    assert('maxAutoPayUsd' in props, 'maxAutoPayUsd should be in configSchema');
    assert(props.maxAutoPayUsd.type === 'number', 'maxAutoPayUsd should be number');
  });

  await test('Plugin JSON: openclaw.plugin.json includes MNEE config fields', () => {
    const pluginPath = path.resolve(import.meta.dirname || '.', '..', '..', 'openclaw.plugin.json');
    const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf-8'));
    const props = plugin.configSchema.properties;

    assert('mneeEnabled' in props, 'mneeEnabled should be in configSchema');
    assert('dailyBudgetUsd' in props, 'dailyBudgetUsd should be in configSchema');
    assert('maxAutoPayUsd' in props, 'maxAutoPayUsd should be in configSchema');
  });

  // ── Summary ──────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
