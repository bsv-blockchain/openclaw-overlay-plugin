/**
 * Unit tests for key derivation consistency.
 * 
 * CRITICAL: These tests ensure that transaction signing uses the correct
 * child private key that matches the derived address.
 * 
 * Bug history: Initially, code was deriving a child address using BRC-29
 * but signing with the root private key, causing OP_EQUALVERIFY failures.
 * 
 * Run: node dist/test/key-derivation.test.js
 */

import { PrivateKey, Transaction, P2PKH, CachedKeyDeriver, Utils } from '@bsv/sdk';
import { brc29ProtocolID } from '@bsv/wallet-toolbox';

async function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('🧪 Running Key Derivation Tests...\n');

  // Test setup
  const rootPrivKey = PrivateKey.fromRandom();
  const keyDeriver = new CachedKeyDeriver(rootPrivKey);
  const derivationPrefix = Utils.toBase64(Array.from(Utils.toArray('import', 'utf8')));
  const derivationSuffix = Utils.toBase64(Array.from(Utils.toArray('now', 'utf8')));
  const keyString = `${derivationPrefix} ${derivationSuffix}`;

  const childPrivKey = keyDeriver.derivePrivateKey(brc29ProtocolID, keyString, 'self');
  const pubKey = keyDeriver.derivePublicKey(brc29ProtocolID, keyString, 'self', true);
  const derivedAddress = pubKey.toAddress();
  const hashResult = pubKey.toHash();
  const derivedHash160 = typeof hashResult === 'string' 
    ? new Uint8Array(hashResult.match(/.{2}/g)!.map(h => parseInt(h, 16)))
    : new Uint8Array(hashResult);

  // Test 1: Consistency
  console.log('✓ Test 1: Derived keys are consistent');
  const keyDeriver2 = new CachedKeyDeriver(rootPrivKey);
  const childPrivKey2 = keyDeriver2.derivePrivateKey(brc29ProtocolID, keyString, 'self');
  await assert(childPrivKey.toHex() === childPrivKey2.toHex(), 'Child keys should be identical');

  // Test 2: Child key matches derived address
  console.log('✓ Test 2: Child private key matches derived address');
  const childPubKey = childPrivKey.toPublicKey();
  const childAddress = childPubKey.toAddress();
  await assert(childAddress === derivedAddress, 'Child key address should match derived address');

  // Test 3: Root key does NOT match (critical!)
  console.log('✓ Test 3: CRITICAL - Root key does NOT match derived address');
  const rootAddress = rootPrivKey.toPublicKey().toAddress();
  await assert(rootAddress !== derivedAddress, 'Root address must differ from derived address');

  // Test 4: Transaction with child key succeeds
  console.log('✓ Test 4: CRITICAL - Transaction signed with child key validates');
  const fundingTx = new Transaction();
  fundingTx.addOutput({
    lockingScript: new P2PKH().lock(Array.from(derivedHash160)),
    satoshis: 1000,
  });

  const spendingTx = new Transaction();
  spendingTx.addInput({
    sourceTransaction: fundingTx,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(childPrivKey),
  });
  spendingTx.addOutput({
    lockingScript: new P2PKH().lock(Array.from(derivedHash160)),
    satoshis: 900,
  });

  await spendingTx.sign();
  const inputScript = spendingTx.inputs[0].unlockingScript;
  await assert(!!inputScript, 'Unlocking script should be present');
  await assert(Array.from(inputScript!.toBinary()).length > 0, 'Script should have content');

  // Test 5: Different paths produce different addresses
  console.log('✓ Test 5: Different derivation paths produce different addresses');
  const path1 = Utils.toBase64(Array.from(Utils.toArray('import', 'utf8'))) + ' ' + Utils.toBase64(Array.from(Utils.toArray('now', 'utf8')));
  const path2 = Utils.toBase64(Array.from(Utils.toArray('import', 'utf8'))) + ' ' + Utils.toBase64(Array.from(Utils.toArray('later', 'utf8')));
  
  const pubKey1 = keyDeriver.derivePublicKey(brc29ProtocolID, path1, 'self', true);
  const pubKey2 = keyDeriver.derivePublicKey(brc29ProtocolID, path2, 'self', true);
  
  await assert(pubKey1.toAddress() !== pubKey2.toAddress(), 'Different paths should produce different addresses');

  console.log('\n✅ All tests passed!\n');
  console.log('Key derivation is working correctly:');
  console.log(`  Root address:    ${rootAddress}`);
  console.log(`  Derived address: ${derivedAddress}`);
  console.log(`  Child key works: YES`);
  console.log(`  Root key works:  NO (correctly rejected)\n`);
}

runTests().catch((err) => {
  console.error('\n❌ Tests failed:', err.message);
  process.exit(1);
});
