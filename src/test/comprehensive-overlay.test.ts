/**
 * Comprehensive Overlay Submission Tests
 * 
 * Tests all aspects of overlay submission:
 * - BEEF format and construction
 * - Payload validation (identity, service, revocation)
 * - OP_RETURN script format
 * - Transaction chain validation
 * - Server response handling
 * 
 * Run with: npx tsx src/test/comprehensive-overlay.test.ts
 */

import { Beef, Transaction, PrivateKey, P2PKH, Script, MerklePath } from '@bsv/sdk';
import {
  PROTOCOL_ID,
  extractOpReturnPushes,
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
  } catch (e: any) {
    results.push({ name, passed: false, error: e.message });
    console.log(`❌ ${name}: ${e.message}`);
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
// Helper Functions
// ============================================================================

function buildOpReturnScript(payload: object): Script {
  const protocolBytes = Array.from(new TextEncoder().encode(PROTOCOL_ID));
  const jsonBytes = Array.from(new TextEncoder().encode(JSON.stringify(payload)));

  const script = new Script();
  script.writeOpCode(0x00);   // OP_FALSE
  script.writeOpCode(0x6a);   // OP_RETURN
  script.writeBin(protocolBytes);
  script.writeBin(jsonBytes);

  return script;
}

function createMockMerklePath(txid: string, blockHeight: number = 100000): MerklePath {
  // Create a minimal valid merkle path
  return new MerklePath(blockHeight, [[{ hash: txid, offset: 0 }]]);
}

async function createSignedTransaction(
  privKey: PrivateKey,
  sourceTx: Transaction,
  sourceVout: number,
  opReturnPayload: object,
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
    lockingScript: buildOpReturnScript(opReturnPayload),
    satoshis: 0,
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
  const identityKey = PrivateKey.fromRandom().toPublicKey().toString();
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
  
  const script = buildOpReturnScript(payload);
  const parsed = parseIdentityOutput(script);
  
  assert(parsed !== null, 'Should parse valid identity');
  assertEqual(parsed!.identityKey, identityKey, 'Identity key should match');
  assertEqual(parsed!.name, 'test-agent', 'Name should match');
});

test('Identity: wrong protocol rejected', () => {
  const payload = {
    protocol: 'wrong-protocol',
    type: 'identity',
    identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
    name: 'test',
    description: '',
    channels: {},
    capabilities: [],
    timestamp: new Date().toISOString(),
  };
  
  const script = buildOpReturnScript(payload);
  assert(parseIdentityOutput(script) === null, 'Should reject wrong protocol');
});

test('Identity: wrong type rejected', () => {
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'service',  // Wrong type
    identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
    name: 'test',
    description: '',
    channels: {},
    capabilities: [],
    timestamp: new Date().toISOString(),
  };
  
  const script = buildOpReturnScript(payload);
  assert(parseIdentityOutput(script) === null, 'Should reject wrong type');
});

test('Identity: invalid identity key rejected', () => {
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
  
  const script = buildOpReturnScript(payload);
  assert(parseIdentityOutput(script) === null, 'Should reject invalid identity key');
});

test('Identity: short identity key rejected', () => {
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
  
  const script = buildOpReturnScript(payload);
  assert(parseIdentityOutput(script) === null, 'Should reject short identity key');
});

test('Identity: empty name rejected', () => {
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
    name: '',
    description: '',
    channels: {},
    capabilities: [],
    timestamp: new Date().toISOString(),
  };
  
  const script = buildOpReturnScript(payload);
  assert(parseIdentityOutput(script) === null, 'Should reject empty name');
});

test('Identity: non-array capabilities rejected', () => {
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
    name: 'test',
    description: '',
    channels: {},
    capabilities: 'not-an-array',
    timestamp: new Date().toISOString(),
  };
  
  const script = buildOpReturnScript(payload);
  assert(parseIdentityOutput(script) === null, 'Should reject non-array capabilities');
});

// ============================================================================
// Service Payload Tests
// ============================================================================

console.log('\n=== Service Payload Tests ===\n');

test('Service: valid payload accepted', () => {
  const identityKey = PrivateKey.fromRandom().toPublicKey().toString();
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
  
  const script = buildOpReturnScript(payload);
  const parsed = parseServiceOutput(script);
  
  assert(parsed !== null, 'Should parse valid service');
  assertEqual(parsed!.serviceId, 'test-service', 'Service ID should match');
  assertEqual(parsed!.pricing.amountSats, 100, 'Price should match');
});

test('Service: empty serviceId rejected', () => {
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
    serviceId: '',
    name: 'Test',
    description: '',
    pricing: { model: 'per-task', amountSats: 100 },
    timestamp: new Date().toISOString(),
  };
  
  const script = buildOpReturnScript(payload);
  assert(parseServiceOutput(script) === null, 'Should reject empty serviceId');
});

test('Service: missing pricing rejected', () => {
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
    serviceId: 'test',
    name: 'Test',
    description: '',
    timestamp: new Date().toISOString(),
  };
  
  const script = buildOpReturnScript(payload);
  assert(parseServiceOutput(script) === null, 'Should reject missing pricing');
});

test('Service: invalid pricing rejected', () => {
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
    serviceId: 'test',
    name: 'Test',
    description: '',
    pricing: { model: 'per-task', amountSats: 'not-a-number' },
    timestamp: new Date().toISOString(),
  };
  
  const script = buildOpReturnScript(payload);
  assert(parseServiceOutput(script) === null, 'Should reject invalid pricing');
});

// ============================================================================
// Revocation Payload Tests
// ============================================================================

console.log('\n=== Revocation Payload Tests ===\n');

test('Revocation: valid payload accepted', () => {
  const identityKey = PrivateKey.fromRandom().toPublicKey().toString();
  const payload: ClawdbotIdentityRevocationData = {
    protocol: PROTOCOL_ID,
    type: 'identity-revocation',
    identityKey,
    reason: 'Test revocation',
    timestamp: new Date().toISOString(),
  };
  
  const script = buildOpReturnScript(payload);
  const parsed = parseRevocationOutput(script);
  
  assert(parsed !== null, 'Should parse valid revocation');
  assertEqual(parsed!.identityKey, identityKey, 'Identity key should match');
});

test('Revocation: invalid identity key rejected', () => {
  const payload = {
    protocol: PROTOCOL_ID,
    type: 'identity-revocation',
    identityKey: 'invalid',
    timestamp: new Date().toISOString(),
  };
  
  const script = buildOpReturnScript(payload);
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
    lockingScript: buildOpReturnScript(childPayload),
    satoshis: 0,
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
// OP_RETURN Script Format Tests
// ============================================================================

console.log('\n=== OP_RETURN Script Format Tests ===\n');

test('Script: OP_FALSE OP_RETURN format', () => {
  const payload = { test: 'data' };
  const script = buildOpReturnScript(payload);
  const chunks = script.chunks;
  
  assertEqual(chunks[0].op, 0x00, 'First op should be OP_FALSE');
  assertEqual(chunks[1].op, 0x6a, 'Second op should be OP_RETURN');
  assert(chunks.length >= 4, 'Should have at least 4 chunks');
});

test('Script: protocol prefix encoding', () => {
  const payload = { test: 'data' };
  const script = buildOpReturnScript(payload);
  const pushes = extractOpReturnPushes(script);
  
  assert(pushes !== null, 'Should extract pushes');
  const protocolStr = new TextDecoder().decode(pushes![0]);
  assertEqual(protocolStr, PROTOCOL_ID, 'Protocol should match');
});

test('Script: JSON payload encoding', () => {
  const payload = { foo: 'bar', num: 42 };
  const script = buildOpReturnScript(payload);
  const pushes = extractOpReturnPushes(script);
  
  assert(pushes !== null, 'Should extract pushes');
  const jsonStr = new TextDecoder().decode(pushes![1]);
  const parsed = JSON.parse(jsonStr);
  assertEqual(parsed.foo, 'bar', 'Foo should match');
  assertEqual(parsed.num, 42, 'Num should match');
});

test('Script: large payload handling', () => {
  const largePayload = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
    name: 'test',
    description: 'A'.repeat(500),  // Large description
    channels: {},
    capabilities: Array(50).fill('cap'),  // Many capabilities
    timestamp: new Date().toISOString(),
  };
  
  const script = buildOpReturnScript(largePayload);
  const pushes = extractOpReturnPushes(script);
  
  assert(pushes !== null, 'Should handle large payload');
  const parsed = JSON.parse(new TextDecoder().decode(pushes![1]));
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
