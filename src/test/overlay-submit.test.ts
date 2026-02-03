/**
 * Unit tests for overlay /submit endpoint compatibility.
 *
 * These tests validate that the client constructs BEEF and payloads
 * in the exact format expected by the clawdbot-overlay server's
 * topic managers using PushDrop tokens.
 *
 * Run with: npx tsx src/test/overlay-submit.test.ts
 */

import { Beef, Transaction, PrivateKey, P2PKH, LockingScript, OP, PushDrop } from '@bsv/sdk';

const PROTOCOL_ID = 'clawdbot-overlay-v1';

// ============================================================================
// Server-side logic (using PushDrop for validation)
// ============================================================================

interface ClawdbotIdentityData {
  protocol: string;
  type: 'identity';
  identityKey: string;
  name: string;
  description: string;
  channels: Record<string, string>;
  capabilities: string[];
  timestamp: string;
}

interface ClawdbotServiceData {
  protocol: string;
  type: 'service';
  identityKey: string;
  serviceId: string;
  name: string;
  description: string;
  pricing: { model: string; amountSats: number };
  timestamp: string;
}

/**
 * Extract data fields from a PushDrop script using the SDK's decode method.
 */
function extractPushDropFields(script: LockingScript): number[][] | null {
  try {
    const decoded = PushDrop.decode(script);
    return decoded.fields;
  } catch {
    return null;
  }
}

/**
 * Parse identity output using PushDrop decode and server's validation logic.
 */
function parseIdentityOutput(script: LockingScript): ClawdbotIdentityData | null {
  const fields = extractPushDropFields(script);
  if (!fields || fields.length < 1) return null;

  try {
    const payload = JSON.parse(
      new TextDecoder().decode(new Uint8Array(fields[0]))
    ) as ClawdbotIdentityData;

    // Server validation rules
    if (payload.protocol !== PROTOCOL_ID) return null;
    if (payload.type !== 'identity') return null;
    if (typeof payload.identityKey !== 'string' || !/^[0-9a-fA-F]{66}$/.test(payload.identityKey)) return null;
    if (typeof payload.name !== 'string' || payload.name.length === 0) return null;
    if (!Array.isArray(payload.capabilities)) return null;
    if (typeof payload.timestamp !== 'string') return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Parse service output using PushDrop decode and server's validation logic.
 */
function parseServiceOutput(script: LockingScript): ClawdbotServiceData | null {
  const fields = extractPushDropFields(script);
  if (!fields || fields.length < 1) return null;

  try {
    const payload = JSON.parse(
      new TextDecoder().decode(new Uint8Array(fields[0]))
    ) as ClawdbotServiceData;

    // Server validation rules
    if (payload.protocol !== PROTOCOL_ID) return null;
    if (payload.type !== 'service') return null;
    if (typeof payload.identityKey !== 'string' || !/^[0-9a-fA-F]{66}$/.test(payload.identityKey)) return null;
    if (typeof payload.serviceId !== 'string' || payload.serviceId.length === 0) return null;
    if (typeof payload.name !== 'string' || payload.name.length === 0) return null;
    if (!payload.pricing || typeof payload.pricing.amountSats !== 'number') return null;
    if (typeof payload.timestamp !== 'string') return null;

    return payload;
  } catch {
    return null;
  }
}

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

/**
 * Simulate the server's identifyAdmissibleOutputs logic.
 */
function identifyAdmissibleOutputs(
  beef: number[],
  type: 'identity' | 'service'
): { outputsToAdmit: number[]; coinsToRetain: number[] } {
  // Parse BEEF and get the newest (subject) transaction
  const parsedBeef = Beef.fromBinary(beef);
  const subjectTx = parsedBeef.txs[0]._tx;
  if (!subjectTx) {
    return { outputsToAdmit: [], coinsToRetain: [] };
  }

  const outputsToAdmit: number[] = [];

  for (let i = 0; i < subjectTx.outputs.length; i++) {
    const output = subjectTx.outputs[i];
    if (output.lockingScript) {
      const parsed = type === 'identity'
        ? parseIdentityOutput(output.lockingScript)
        : parseServiceOutput(output.lockingScript);
      if (parsed !== null) {
        outputsToAdmit.push(i);
      }
    }
  }

  return { outputsToAdmit, coinsToRetain: [] };
}

// ============================================================================
// Test utilities
// ============================================================================

let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    testsFailed++;
    throw new Error(message);
  }
  console.log(`✅ PASS: ${message}`);
  testsPassed++;
}

function assertThrows(fn: () => void, message: string): void {
  try {
    fn();
    console.error(`❌ FAIL: ${message} (expected to throw)`);
    testsFailed++;
  } catch {
    console.log(`✅ PASS: ${message}`);
    testsPassed++;
  }
}

// ============================================================================
// Test: BEEF format validation
// ============================================================================

async function testBeefFormat(): Promise<void> {
  console.log('\n=== Test: BEEF Format Validation ===');

  // Create a minimal transaction chain
  const privKey = PrivateKey.fromRandom();
  const pubKeyHash = privKey.toPublicKey().toHash();

  // Source transaction (simulating a mined tx with merkle proof)
  const sourceTx = new Transaction();
  sourceTx.addOutput({
    lockingScript: new P2PKH().lock(pubKeyHash),
    satoshis: 10000,
  });

  // Spending transaction with PushDrop output
  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
  });
  tx.addOutput({
    lockingScript: buildPushDropScript(privKey, { protocol: PROTOCOL_ID, type: 'identity', test: true }),
    satoshis: 1,
  });
  await tx.sign();

  // Build BEEF
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const binary = beef.toBinary();

  // Validate BEEF magic bytes
  const magic = binary.slice(0, 4);
  const magicHex = magic.map(b => b.toString(16).padStart(2, '0')).join('');
  assert(
    magicHex === '0100beef' || magicHex === '0200beef',
    `BEEF magic bytes should be 0100beef or 0200beef, got ${magicHex}`
  );

  // Validate BEEF can be parsed
  const parsed = Beef.fromBinary(binary);
  assert(parsed.txs.length >= 1, `BEEF should contain at least 1 transaction, got ${parsed.txs.length}`);

  // Validate the newest transaction can be found in BEEF
  const beefTx = parsed.txs[0] as { txid?: string; _tx?: Transaction };
  const newestTxid = beefTx.txid || beefTx._tx?.id('hex');
  assert(newestTxid === tx.id('hex'), `Newest transaction in BEEF should match original, got ${newestTxid?.slice(0, 16)}`);
}

// ============================================================================
// Test: Identity payload validation
// ============================================================================

async function testIdentityPayload(): Promise<void> {
  console.log('\n=== Test: Identity Payload Validation ===');

  const privKey = PrivateKey.fromRandom();
  const identityKey = privKey.toPublicKey().toString();

  // Valid identity payload
  const validPayload: ClawdbotIdentityData = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey,
    name: 'test-agent',
    description: 'A test agent',
    channels: { overlay: 'https://example.com' },
    capabilities: ['test'],
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, validPayload);
  const parsed = parseIdentityOutput(script);

  assert(parsed !== null, 'Valid identity payload should be parsed');
  assert(parsed!.identityKey === identityKey, 'Identity key should match');
  assert(parsed!.name === 'test-agent', 'Name should match');
  assert(parsed!.type === 'identity', 'Type should be identity');

  // Invalid: wrong protocol
  const wrongProtocol = { ...validPayload, protocol: 'wrong-protocol' };
  const script2 = buildPushDropScript(privKey, wrongProtocol);
  assert(parseIdentityOutput(script2) === null, 'Wrong protocol should be rejected');

  // Invalid: wrong type
  const wrongType = { ...validPayload, type: 'service' as const };
  const script3 = buildPushDropScript(privKey, wrongType);
  assert(parseIdentityOutput(script3) === null, 'Wrong type should be rejected');

  // Invalid: bad identity key
  const badKey = { ...validPayload, identityKey: 'not-a-valid-key' };
  const script4 = buildPushDropScript(privKey, badKey);
  assert(parseIdentityOutput(script4) === null, 'Invalid identity key should be rejected');

  // Invalid: empty name
  const emptyName = { ...validPayload, name: '' };
  const script5 = buildPushDropScript(privKey, emptyName);
  assert(parseIdentityOutput(script5) === null, 'Empty name should be rejected');

  // Invalid: capabilities not array
  const badCaps = { ...validPayload, capabilities: 'not-array' as unknown as string[] };
  const script6 = buildPushDropScript(privKey, badCaps);
  assert(parseIdentityOutput(script6) === null, 'Non-array capabilities should be rejected');
}

// ============================================================================
// Test: Service payload validation
// ============================================================================

async function testServicePayload(): Promise<void> {
  console.log('\n=== Test: Service Payload Validation ===');

  const privKey = PrivateKey.fromRandom();
  const identityKey = privKey.toPublicKey().toString();

  // Valid service payload
  const validPayload: ClawdbotServiceData = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey,
    serviceId: 'test-service',
    name: 'Test Service',
    description: 'A test service',
    pricing: { model: 'per-task', amountSats: 100 },
    timestamp: new Date().toISOString(),
  };

  const script = buildPushDropScript(privKey, validPayload);
  const parsed = parseServiceOutput(script);

  assert(parsed !== null, 'Valid service payload should be parsed');
  assert(parsed!.serviceId === 'test-service', 'Service ID should match');
  assert(parsed!.pricing.amountSats === 100, 'Price should match');

  // Invalid: missing pricing
  const noPricing = { ...validPayload, pricing: undefined as unknown as { model: string; amountSats: number } };
  const script2 = buildPushDropScript(privKey, noPricing);
  assert(parseServiceOutput(script2) === null, 'Missing pricing should be rejected');

  // Invalid: empty serviceId
  const emptyId = { ...validPayload, serviceId: '' };
  const script3 = buildPushDropScript(privKey, emptyId);
  assert(parseServiceOutput(script3) === null, 'Empty serviceId should be rejected');
}

// ============================================================================
// Test: Full BEEF submission simulation
// ============================================================================

async function testBeefSubmission(): Promise<void> {
  console.log('\n=== Test: BEEF Submission Simulation ===');

  const privKey = PrivateKey.fromRandom();
  const pubKeyHash = privKey.toPublicKey().toHash();
  const identityKey = privKey.toPublicKey().toString();

  // Create source transaction (simulating confirmed tx)
  const sourceTx = new Transaction();
  sourceTx.addOutput({
    lockingScript: new P2PKH().lock(pubKeyHash),
    satoshis: 10000,
  });

  // Valid identity registration
  const identityPayload: ClawdbotIdentityData = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey,
    name: 'test-agent',
    description: 'Test agent for unit tests',
    channels: { overlay: 'https://clawoverlay.com' },
    capabilities: ['testing'],
    timestamp: new Date().toISOString(),
  };

  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
  });
  tx.addOutput({
    lockingScript: buildPushDropScript(privKey, identityPayload),
    satoshis: 1,
  });
  tx.addOutput({
    lockingScript: new P2PKH().lock(pubKeyHash),
    satoshis: 9900,
  });
  await tx.sign();

  // Build BEEF with ancestry
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const beefBinary = beef.toBinary();

  // Simulate server's topic manager
  const result = identifyAdmissibleOutputs(beefBinary, 'identity');

  assert(result.outputsToAdmit.length === 1, `Should admit 1 output, got ${result.outputsToAdmit.length}`);
  assert(result.outputsToAdmit[0] === 0, 'Should admit output index 0 (PushDrop)');
}

// ============================================================================
// Test: Chained transactions (stored BEEF)
// ============================================================================

async function testChainedBeef(): Promise<void> {
  console.log('\n=== Test: Chained BEEF (multiple unconfirmed txs) ===');

  const privKey = PrivateKey.fromRandom();
  const pubKeyHash = privKey.toPublicKey().toHash();
  const identityKey = privKey.toPublicKey().toString();

  // Grandparent tx (simulating mined tx - would have merkle proof)
  const grandparentTx = new Transaction();
  grandparentTx.addOutput({
    lockingScript: new P2PKH().lock(pubKeyHash),
    satoshis: 100000,
  });

  // Parent tx (first overlay submission - unconfirmed)
  const parentTx = new Transaction();
  parentTx.addInput({
    sourceTransaction: grandparentTx,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
  });
  parentTx.addOutput({
    lockingScript: buildPushDropScript(privKey, {
      protocol: PROTOCOL_ID,
      type: 'identity',
      identityKey,
      name: 'parent-tx',
      description: 'First registration',
      channels: {},
      capabilities: [],
      timestamp: new Date().toISOString(),
    }),
    satoshis: 1,
  });
  parentTx.addOutput({
    lockingScript: new P2PKH().lock(pubKeyHash),
    satoshis: 99900,
  });
  await parentTx.sign();

  // Child tx (second overlay submission - spending parent's change)
  const childTx = new Transaction();
  childTx.addInput({
    sourceTransaction: parentTx,
    sourceOutputIndex: 1,  // Spend the change output
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
  });
  childTx.addOutput({
    lockingScript: buildPushDropScript(privKey, {
      protocol: PROTOCOL_ID,
      type: 'service',
      identityKey,
      serviceId: 'test-svc',
      name: 'Test Service',
      description: 'Service from child tx',
      pricing: { model: 'per-task', amountSats: 50 },
      timestamp: new Date().toISOString(),
    }),
    satoshis: 1,
  });
  childTx.addOutput({
    lockingScript: new P2PKH().lock(pubKeyHash),
    satoshis: 99800,
  });
  await childTx.sign();

  // Build BEEF - should include full chain
  const beef = new Beef();
  beef.mergeTransaction(childTx);
  const beefBinary = beef.toBinary();

  // Verify BEEF contains all transactions
  const parsedBeef = Beef.fromBinary(beefBinary);
  assert(parsedBeef.txs.length >= 2, `BEEF should contain at least 2 txs for chain, got ${parsedBeef.txs.length}`);

  // Verify child tx is the newest in BEEF
  const beefTx = parsedBeef.txs[0] as { txid?: string; _tx?: Transaction };
  const newestTxid = beefTx.txid || beefTx._tx?.id('hex');
  assert(newestTxid === childTx.id('hex'), 'Newest tx in BEEF should be the child transaction');

  // Simulate server validation
  const result = identifyAdmissibleOutputs(beefBinary, 'service');
  assert(result.outputsToAdmit.length === 1, 'Should admit the service output');
}

// ============================================================================
// Test: Invalid BEEF handling
// ============================================================================

async function testInvalidBeef(): Promise<void> {
  console.log('\n=== Test: Invalid BEEF Handling ===');

  // Empty BEEF
  const emptyBeef = new Beef();
  const emptyBinary = emptyBeef.toBinary();

  assertThrows(
    () => Transaction.fromBEEF(emptyBinary),
    'Empty BEEF should throw when extracting transaction'
  );

  // Malformed BEEF (random bytes)
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assertThrows(
    () => Beef.fromBinary(Array.from(garbage)),
    'Garbage bytes should throw when parsing BEEF'
  );

  // BEEF with wrong magic
  const wrongMagic = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0, 0]);
  assertThrows(
    () => Beef.fromBinary(Array.from(wrongMagic)),
    'Wrong magic bytes should throw when parsing BEEF'
  );
}

// ============================================================================
// Main test runner
// ============================================================================

async function runTests(): Promise<void> {
  console.log('Starting overlay submit tests (PushDrop format)...\n');

  try {
    await testBeefFormat();
    await testIdentityPayload();
    await testServicePayload();
    await testBeefSubmission();
    await testChainedBeef();
    await testInvalidBeef();

    console.log(`\n========================================`);
    console.log(`Tests completed: ${testsPassed} passed, ${testsFailed} failed`);
    console.log(`========================================`);

    if (testsFailed > 0) {
      process.exit(1);
    }
  } catch (e) {
    console.error('\nTest suite failed:', e);
    process.exit(1);
  }
}

runTests();
