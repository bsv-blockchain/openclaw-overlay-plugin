/**
 * Comprehensive Overlay Submission Tests
 *
 * Tests all aspects of overlay submission:
 * - BEEF format and construction
 * - Payload validation (identity, service, revocation)
 * - PushDrop script format
 * - Transaction chain validation
 * - Server response handling
 *
 * Run with: npx tsx src/test/comprehensive-overlay.test.ts
 */

import { Beef, Transaction, PrivateKey, P2PKH, LockingScript, OP } from '@bsv/sdk';
import {
  PROTOCOL_ID,
  extractPushDropFields,
  parseIdentityOutput,
  parseRevocationOutput,
  parseServiceOutput,
  identifyIdentityOutputs,
  identifyServiceOutputs,
  validateBeef,
  validateBeefAncestry,
  type ClawdbotIdentityData,
  type ClawdbotServiceData,
  type ClawdbotIdentityRevocationData,
} from './utils/server-logic.js';

// ============================================================================
// Test Infrastructure
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => {
          results.push({ name, passed: true });
          console.log(`✅ ${name}`);
        })
        .catch((e) => {
          results.push({ name, passed: false, error: e.message });
          console.log(`❌ ${name}: ${e.message}`);
        });
    } else {
      results.push({ name, passed: true });
      console.log(`✅ ${name}`);
    }
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    results.push({ name, passed: false, error: errorMessage });
    console.log(`❌ ${name}: ${errorMessage}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// ============================================================================
// Helper Functions - PushDrop Script Building
// ============================================================================

/**
 * Create a minimally encoded push chunk for script building.
 */
function createPushChunk(data: number[]): { op: number; data?: number[] } {
  if (data.length === 0) {
    return { op: 0 };
  }
  if (data.length === 1 && data[0] === 0) {
    return { op: 0 };
  }
  if (data.length === 1 && data[0] > 0 && data[0] <= 16) {
    return { op: 0x50 + data[0] };
  }
  if (data.length <= 75) {
    return { op: data.length, data };
  }
  if (data.length <= 255) {
    return { op: 0x4c, data };
  }
  if (data.length <= 65535) {
    return { op: 0x4d, data };
  }
  return { op: 0x4e, data };
}

/**
 * Build a PushDrop-style locking script with JSON payload.
 * Format: <pubkey> OP_CHECKSIG <jsonBytes> OP_DROP
 *
 * This mimics what PushDrop.lock() produces for testing purposes.
 */
function buildPushDropScript(privKey: PrivateKey, payload: object): LockingScript {
  const pubKey = privKey.toPublicKey();
  const pubKeyBytes = pubKey.toDER() as number[];
  const jsonBytes = Array.from(new TextEncoder().encode(JSON.stringify(payload)));

  const chunks: Array<{ op: number; data?: number[] }> = [];

  // P2PK lock: <pubkey> OP_CHECKSIG
  chunks.push({ op: pubKeyBytes.length, data: pubKeyBytes });
  chunks.push({ op: OP.OP_CHECKSIG });

  // Data field: <jsonBytes>
  chunks.push(createPushChunk(jsonBytes));

  // OP_DROP to clean stack
  chunks.push({ op: OP.OP_DROP });

  return new LockingScript(chunks);
}

async function createSignedTransaction(
  privKey: PrivateKey,
  sourceTx: Transaction,
  sourceVout: number,
  pushDropPayload: object,
  changeSats: number = 9900
): Promise<Transaction> {
  const tx = new Transaction();
  const pubKeyHash = privKey.toPublicKey().toHash();

  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: sourceVout,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
  });

  tx.addOutput({
    lockingScript: buildPushDropScript(privKey, pushDropPayload),
    satoshis: 1, // PushDrop outputs need at least 1 sat
  });

  if (changeSats > 0) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(pubKeyHash),
      satoshis: changeSats,
    });
  }

  await tx.sign();
  return tx;
}

function createSourceTransaction(privKey: PrivateKey, satoshis: number = 10000): Transaction {
  const pubKeyHash = privKey.toPublicKey().toHash();
  const tx = new Transaction();
  tx.addOutput({
    lockingScript: new P2PKH().lock(pubKeyHash),
    satoshis,
  });
  return tx;
}

// ============================================================================
// BEEF Format Tests
// ============================================================================

console.log('\n=== BEEF Format Tests ===\n');

test('BEEF: valid v2 magic bytes', async () => {
  const privKey = PrivateKey.fromRandom();
  const sourceTx = createSourceTransaction(privKey);
  const tx = await createSignedTransaction(privKey, sourceTx, 0, { test: true });

  const beef = new Beef();
  beef.mergeTransaction(tx);
  const binary = beef.toBinary();

  const result = validateBeef(binary);
  assert(result.valid, result.error || 'BEEF should be valid');
  assertEqual(result.version, 2, 'Should be BEEF v2');
});

test('BEEF: contains multiple transactions', async () => {
  const privKey = PrivateKey.fromRandom();
  const sourceTx = createSourceTransaction(privKey);
  const tx = await createSignedTransaction(privKey, sourceTx, 0, { test: true });

  const beef = new Beef();
  beef.mergeTransaction(tx);
  const binary = beef.toBinary();

  const result = validateBeef(binary);
  assert(result.txCount! >= 2, `Should have at least 2 txs, got ${result.txCount}`);
});

test('BEEF: invalid magic bytes rejected', () => {
  const garbage = [0xDE, 0xAD, 0xBE, 0xEF, 0, 0, 0, 0];
  const result = validateBeef(garbage);
  assert(!result.valid, 'Should reject invalid magic');
});

test('BEEF: empty BEEF rejected', () => {
  const emptyBeef = new Beef();
  const binary = emptyBeef.toBinary();
  const result = validateBeef(binary);
  assert(!result.valid, 'Should reject empty BEEF');
});

// ============================================================================
// Identity Payload Tests
// ============================================================================

console.log('\n=== Identity Payload Tests ===\n');

test('Identity: valid payload accepted', () => {
  const privKey = PrivateKey.fromRandom();
  const identityKey = privKey.toPublicKey().toString();
  const payload: ClawdbotIdentityData = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey,
    name: 'test-agent',
    description: 'A test agent',
    channels: { overlay: 'https://example.com' },
    capabilities: ['testing'],
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  const parsed = parseIdentityOutput(script);

  assert(parsed !== null, 'Should parse valid identity');
  assertEqual(parsed!.identityKey, identityKey, 'Identity key should match');
  assertEqual(parsed!.name, 'test-agent', 'Name should match');
});

test('Identity: wrong protocol rejected', () => {
  const privKey = PrivateKey.fromRandom();
  const payload = {
    protocol: 'wrong-protocol',
    type: 'identity',
    identityKey: privKey.toPublicKey().toString(),
    name: 'test',
    description: '',
    channels: {},
    capabilities: [],
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  assert(parseIdentityOutput(script) === null, 'Should reject wrong protocol');
});

test('Identity: wrong type rejected', () => {
  const privKey = PrivateKey.fromRandom();
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'service',  // Wrong type
    identityKey: privKey.toPublicKey().toString(),
    name: 'test',
    description: '',
    channels: {},
    capabilities: [],
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  assert(parseIdentityOutput(script) === null, 'Should reject wrong type');
});

test('Identity: invalid identity key rejected', () => {
  const privKey = PrivateKey.fromRandom();
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey: 'not-a-valid-key',
    name: 'test',
    description: '',
    channels: {},
    capabilities: [],
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  assert(parseIdentityOutput(script) === null, 'Should reject invalid identity key');
});

test('Identity: short identity key rejected', () => {
  const privKey = PrivateKey.fromRandom();
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey: '02abcd',  // Too short
    name: 'test',
    description: '',
    channels: {},
    capabilities: [],
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  assert(parseIdentityOutput(script) === null, 'Should reject short identity key');
});

test('Identity: empty name rejected', () => {
  const privKey = PrivateKey.fromRandom();
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey: privKey.toPublicKey().toString(),
    name: '',
    description: '',
    channels: {},
    capabilities: [],
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  assert(parseIdentityOutput(script) === null, 'Should reject empty name');
});

test('Identity: non-array capabilities rejected', () => {
  const privKey = PrivateKey.fromRandom();
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey: privKey.toPublicKey().toString(),
    name: 'test',
    description: '',
    channels: {},
    capabilities: 'not-an-array',
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  assert(parseIdentityOutput(script) === null, 'Should reject non-array capabilities');
});

// ============================================================================
// Service Payload Tests
// ============================================================================

console.log('\n=== Service Payload Tests ===\n');

test('Service: valid payload accepted', () => {
  const privKey = PrivateKey.fromRandom();
  const identityKey = privKey.toPublicKey().toString();
  const payload: ClawdbotServiceData = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey,
    serviceId: 'test-service',
    name: 'Test Service',
    description: 'A test service',
    pricing: { model: 'per-task', amountSats: 100 },
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  const parsed = parseServiceOutput(script);

  assert(parsed !== null, 'Should parse valid service');
  assertEqual(parsed!.serviceId, 'test-service', 'Service ID should match');
  assertEqual(parsed!.pricing.amountSats, 100, 'Price should match');
});

test('Service: empty serviceId rejected', () => {
  const privKey = PrivateKey.fromRandom();
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey: privKey.toPublicKey().toString(),
    serviceId: '',
    name: 'Test',
    description: '',
    pricing: { model: 'per-task', amountSats: 100 },
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  assert(parseServiceOutput(script) === null, 'Should reject empty serviceId');
});

test('Service: missing pricing rejected', () => {
  const privKey = PrivateKey.fromRandom();
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey: privKey.toPublicKey().toString(),
    serviceId: 'test',
    name: 'Test',
    description: '',
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  assert(parseServiceOutput(script) === null, 'Should reject missing pricing');
});

test('Service: invalid pricing rejected', () => {
  const privKey = PrivateKey.fromRandom();
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey: privKey.toPublicKey().toString(),
    serviceId: 'test',
    name: 'Test',
    description: '',
    pricing: { model: 'per-task', amountSats: 'not-a-number' },
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  assert(parseServiceOutput(script) === null, 'Should reject invalid pricing');
});

// ============================================================================
// Revocation Payload Tests
// ============================================================================

console.log('\n=== Revocation Payload Tests ===\n');

test('Revocation: valid payload accepted', () => {
  const privKey = PrivateKey.fromRandom();
  const identityKey = privKey.toPublicKey().toString();
  const payload: ClawdbotIdentityRevocationData = {
    protocol: PROTOCOL_ID,
    type: 'identity-revocation',
    identityKey,
    reason: 'Test revocation',
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  const parsed = parseRevocationOutput(script);

  assert(parsed !== null, 'Should parse valid revocation');
  assertEqual(parsed!.identityKey, identityKey, 'Identity key should match');
});

test('Revocation: invalid identity key rejected', () => {
  const privKey = PrivateKey.fromRandom();
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'identity-revocation',
    identityKey: 'invalid',
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, payload);
  assert(parseRevocationOutput(script) === null, 'Should reject invalid identity key');
});

// ============================================================================
// Topic Manager Simulation Tests
// ============================================================================

console.log('\n=== Topic Manager Simulation Tests ===\n');

test('TopicManager: identity output admitted', async () => {
  const privKey = PrivateKey.fromRandom();
  const identityKey = privKey.toPublicKey().toString();
  const sourceTx = createSourceTransaction(privKey);

  const payload: ClawdbotIdentityData = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey,
    name: 'test-agent',
    description: 'Test',
    channels: {},
    capabilities: [],
    timestamp: new Date().toISOString(),
  };

  const tx = await createSignedTransaction(privKey, sourceTx, 0, payload);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const binary = beef.toBinary();

  const result = identifyIdentityOutputs(binary);
  assertEqual(result.outputsToAdmit.length, 1, 'Should admit 1 output');
  assertEqual(result.outputsToAdmit[0], 0, 'Should admit output 0');
});

test('TopicManager: revocation output admitted', async () => {
  const privKey = PrivateKey.fromRandom();
  const identityKey = privKey.toPublicKey().toString();
  const sourceTx = createSourceTransaction(privKey);

  const payload: ClawdbotIdentityRevocationData = {
    protocol: PROTOCOL_ID,
    type: 'identity-revocation',
    identityKey,
    timestamp: new Date().toISOString(),
  };

  const tx = await createSignedTransaction(privKey, sourceTx, 0, payload);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const binary = beef.toBinary();

  const result = identifyIdentityOutputs(binary);
  assertEqual(result.outputsToAdmit.length, 1, 'Should admit revocation');
});

test('TopicManager: service output admitted', async () => {
  const privKey = PrivateKey.fromRandom();
  const identityKey = privKey.toPublicKey().toString();
  const sourceTx = createSourceTransaction(privKey);

  const payload: ClawdbotServiceData = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey,
    serviceId: 'test-svc',
    name: 'Test Service',
    description: 'Test',
    pricing: { model: 'per-task', amountSats: 50 },
    timestamp: new Date().toISOString(),
  };

  const tx = await createSignedTransaction(privKey, sourceTx, 0, payload);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const binary = beef.toBinary();

  const result = identifyServiceOutputs(binary);
  assertEqual(result.outputsToAdmit.length, 1, 'Should admit service');
});

test('TopicManager: invalid payload not admitted', async () => {
  const privKey = PrivateKey.fromRandom();
  const sourceTx = createSourceTransaction(privKey);

  // Invalid payload (wrong protocol)
  const payload = {
    protocol: 'wrong',
    type: 'identity',
    identityKey: privKey.toPublicKey().toString(),
    name: 'test',
    description: '',
    channels: {},
    capabilities: [],
    timestamp: new Date().toISOString(),
  };

  const tx = await createSignedTransaction(privKey, sourceTx, 0, payload);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const binary = beef.toBinary();

  const result = identifyIdentityOutputs(binary);
  assertEqual(result.outputsToAdmit.length, 0, 'Should not admit invalid payload');
});

// ============================================================================
// Transaction Chain Tests
// ============================================================================

console.log('\n=== Transaction Chain Tests ===\n');

test('Chain: two unconfirmed transactions', async () => {
  const privKey = PrivateKey.fromRandom();
  const identityKey = privKey.toPublicKey().toString();
  const pubKeyHash = privKey.toPublicKey().toHash();

  // Grandparent (simulating mined)
  const grandparentTx = createSourceTransaction(privKey, 100000);

  // Parent (first overlay tx)
  const parentPayload: ClawdbotIdentityData = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey,
    name: 'parent-tx',
    description: 'First',
    channels: {},
    capabilities: [],
    timestamp: new Date().toISOString(),
  };
  const parentTx = await createSignedTransaction(privKey, grandparentTx, 0, parentPayload, 99900);

  // Child (second overlay tx, spending parent's change)
  const childPayload: ClawdbotServiceData = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey,
    serviceId: 'child-svc',
    name: 'Child Service',
    description: 'Second',
    pricing: { model: 'per-task', amountSats: 25 },
    timestamp: new Date().toISOString(),
  };

  const childTx = new Transaction();
  childTx.addInput({
    sourceTransaction: parentTx,
    sourceOutputIndex: 1,  // Change output
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
  });
  childTx.addOutput({
    lockingScript: buildPushDropScript(privKey, childPayload),
    satoshis: 1,
  });
  childTx.addOutput({
    lockingScript: new P2PKH().lock(pubKeyHash),
    satoshis: 99800,
  });
  await childTx.sign();

  // Build BEEF
  const beef = new Beef();
  beef.mergeTransaction(childTx);
  const binary = beef.toBinary();

  const validation = validateBeef(binary);
  assert(validation.valid, validation.error || 'BEEF should be valid');
  assert(validation.txCount! >= 3, `Should have at least 3 txs, got ${validation.txCount}`);

  // Verify service output is admitted
  const result = identifyServiceOutputs(binary);
  assertEqual(result.outputsToAdmit.length, 1, 'Should admit service output');
});

test('Chain: BEEF ancestry validation', async () => {
  const privKey = PrivateKey.fromRandom();
  const sourceTx = createSourceTransaction(privKey);
  const tx = await createSignedTransaction(privKey, sourceTx, 0, { test: true });

  const beef = new Beef();
  beef.mergeTransaction(tx);
  const binary = beef.toBinary();

  const result = validateBeefAncestry(binary);
  assert(result.valid, result.error || 'Ancestry should be valid');
  assert(result.chain!.length >= 2, 'Chain should have at least 2 txids');
});

// ============================================================================
// PushDrop Script Format Tests
// ============================================================================

console.log('\n=== PushDrop Script Format Tests ===\n');

test('Script: PushDrop format with P2PK lock', () => {
  const privKey = PrivateKey.fromRandom();
  const payload = { test: 'data' };
  const script = buildPushDropScript(privKey, payload);
  const chunks = script.chunks;

  // First chunk should be pubkey push (33 bytes)
  assertEqual(chunks[0].op, 33, 'First op should push 33 bytes (pubkey)');
  assert(chunks[0].data !== undefined, 'Should have pubkey data');
  assertEqual(chunks[0].data!.length, 33, 'Pubkey should be 33 bytes');

  // Second chunk should be OP_CHECKSIG
  assertEqual(chunks[1].op, OP.OP_CHECKSIG, 'Second op should be OP_CHECKSIG');

  // Should have data field and OP_DROP
  assert(chunks.length >= 4, 'Should have at least 4 chunks');
});

test('Script: JSON payload extraction', () => {
  const privKey = PrivateKey.fromRandom();
  const payload = { foo: 'bar', num: 42 };
  const script = buildPushDropScript(privKey, payload);
  const fields = extractPushDropFields(script);

  assert(fields !== null, 'Should extract fields');
  assert(fields!.length >= 1, 'Should have at least 1 field');

  const jsonStr = new TextDecoder().decode(new Uint8Array(fields![0]));
  const parsed = JSON.parse(jsonStr);
  assertEqual(parsed.foo, 'bar', 'Foo should match');
  assertEqual(parsed.num, 42, 'Num should match');
});

test('Script: large payload handling', () => {
  const privKey = PrivateKey.fromRandom();
  const largePayload = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey: privKey.toPublicKey().toString(),
    name: 'test',
    description: 'A'.repeat(500),  // Large description
    channels: {},
    capabilities: Array(50).fill('cap'),  // Many capabilities
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, largePayload);
  const fields = extractPushDropFields(script);

  assert(fields !== null, 'Should handle large payload');
  const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(fields![0])));
  assertEqual(parsed.description.length, 500, 'Description should be preserved');
});

// ============================================================================
// Summary
// ============================================================================

// Give async tests time to complete
setTimeout(() => {
  console.log('\n========================================');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`Tests completed: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');

  if (failed > 0) {
    console.log('Failed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
    process.exit(1);
  }
}, 2000);
