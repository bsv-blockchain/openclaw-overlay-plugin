/**
 * Tests for request/response flow and duplicate prevention.
 */

import { expect } from 'chai';
import fs from 'node:fs';
import path from 'node:path';
import { processMessage } from '../scripts/messaging/handlers.js';
import { cmdServiceQueue } from '../scripts/services/queue.js';
import { cmdRespondService } from '../scripts/services/respond.js';
import { cleanupServiceQueue, updateServiceQueueStatus } from '../scripts/utils/storage.js';
import type { RelayMessage } from '../scripts/types.js';

// Mock paths for testing
const TEST_DIR = path.join(__dirname, '../../test-data');
const TEST_PATHS = {
  serviceQueue: path.join(TEST_DIR, 'service-queue.jsonl'),
  walletDir: path.join(TEST_DIR, 'wallet'),
  registration: path.join(TEST_DIR, 'registration.json'),
  services: path.join(TEST_DIR, 'services.json'),
};

// Mock configuration
const mockConfig = {
  OVERLAY_URL: 'https://test.example.com',
  WALLET_DIR: TEST_PATHS.walletDir,
  PATHS: TEST_PATHS,
};

describe('Request/Response Flow', () => {
  let originalEnv: any;

  beforeEach(() => {
    // Setup test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Mock environment
    originalEnv = process.env;
    process.env.BSV_NETWORK = 'testnet';
    process.env.AGENT_ROUTED = 'true';

    // Mock wallet identity
    fs.writeFileSync(path.join(TEST_PATHS.walletDir, 'identity.json'), JSON.stringify({
      identityKey: 'test-identity-key-123',
      rootKeyHex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    }));

    // Mock services
    fs.writeFileSync(TEST_PATHS.services, JSON.stringify([
      { serviceId: 'test-service', priceSats: 10 }
    ]));

    // Mock config import
    const configModule = require('../scripts/config.js');
    Object.assign(configModule, mockConfig);
  });

  afterEach(() => {
    process.env = originalEnv;
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('Duplicate Request Prevention', () => {
    it('should not queue the same request twice', async () => {
      const mockMessage: RelayMessage = {
        id: 'test-request-123',
        from: 'sender-key',
        to: 'our-key',
        type: 'service-request',
        payload: {
          serviceId: 'test-service',
          input: { query: 'test query' },
          payment: {
            beef: 'mock-beef',
            satoshis: 20,
            txid: 'mock-txid',
            derivationPrefix: 'test',
            derivationSuffix: 'suffix',
            senderIdentityKey: 'sender-key'
          }
        },
        signature: 'mock-signature'
      };

      // Mock payment verification to always succeed
      const originalVerify = require('../scripts/messaging/handlers.js').verifyAndAcceptPayment;
      require('../scripts/messaging/handlers.js').verifyAndAcceptPayment = async () => ({
        accepted: true,
        txid: 'mock-txid',
        satoshis: 20,
        outputIndex: 0,
        walletAccepted: true,
        error: null
      });

      try {
        // Process the message twice
        const result1 = await processMessage(mockMessage, 'our-key', 'our-privkey');
        const result2 = await processMessage(mockMessage, 'our-key', 'our-privkey');

        expect(result1.action).to.equal('queued-for-agent');
        expect(result2.action).to.equal('already-queued');

        // Check queue has only one entry
        const queueOutput = await cmdServiceQueue();
        expect(queueOutput.data?.count).to.equal(1);

      } finally {
        // Restore original function
        require('../scripts/messaging/handlers.js').verifyAndAcceptPayment = originalVerify;
      }
    });

    it('should prevent response to already fulfilled request', async () => {
      // Add a fulfilled request to the queue
      const fulfilledEntry = {
        status: 'fulfilled',
        requestId: 'fulfilled-request-123',
        serviceId: 'test-service',
        from: 'sender-key',
        fulfilledAt: Date.now(),
        _ts: Date.now()
      };

      fs.writeFileSync(TEST_PATHS.serviceQueue, JSON.stringify(fulfilledEntry) + '\n');

      // Try to respond to the fulfilled request
      const result = await cmdRespondService(
        'fulfilled-request-123',
        'sender-key',
        'test-service',
        JSON.stringify({ message: 'test response' })
      );

      expect(result.data?.sent).to.be.false;
      expect(result.data?.alreadyProcessed).to.be.true;
      expect(result.data?.previousStatus).to.equal('fulfilled');
    });
  });

  describe('Queue Cleanup', () => {
    it('should remove old fulfilled entries', () => {
      const now = Date.now();
      const oldTime = now - (3 * 60 * 60 * 1000); // 3 hours ago
      const recentTime = now - (30 * 60 * 1000); // 30 minutes ago

      // Add test entries
      const entries = [
        { status: 'pending', requestId: 'pending-1', _ts: recentTime },
        { status: 'fulfilled', requestId: 'old-fulfilled', _ts: oldTime },
        { status: 'fulfilled', requestId: 'recent-fulfilled', _ts: recentTime },
        { status: 'rejected', requestId: 'old-rejected', _ts: oldTime }
      ];

      const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(TEST_PATHS.serviceQueue, content);

      // Run cleanup with 2 hour limit for final statuses
      cleanupServiceQueue(24 * 60 * 60 * 1000, 2 * 60 * 60 * 1000);

      // Check remaining entries
      const lines = fs.readFileSync(TEST_PATHS.serviceQueue, 'utf-8').trim().split('\n').filter(Boolean);
      const remaining = lines.map(line => JSON.parse(line));

      expect(remaining).to.have.lengthOf(2);
      expect(remaining.find(e => e.requestId === 'pending-1')).to.exist;
      expect(remaining.find(e => e.requestId === 'recent-fulfilled')).to.exist;
      expect(remaining.find(e => e.requestId === 'old-fulfilled')).to.not.exist;
      expect(remaining.find(e => e.requestId === 'old-rejected')).to.not.exist;
    });

    it('should remove old pending entries', () => {
      const now = Date.now();
      const oldTime = now - (25 * 60 * 60 * 1000); // 25 hours ago
      const recentTime = now - (30 * 60 * 1000); // 30 minutes ago

      // Add test entries
      const entries = [
        { status: 'pending', requestId: 'old-pending', _ts: oldTime },
        { status: 'pending', requestId: 'recent-pending', _ts: recentTime }
      ];

      const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(TEST_PATHS.serviceQueue, content);

      // Run cleanup with 24 hour limit for all entries
      cleanupServiceQueue(24 * 60 * 60 * 1000, 2 * 60 * 60 * 1000);

      // Check remaining entries
      const lines = fs.readFileSync(TEST_PATHS.serviceQueue, 'utf-8').trim().split('\n').filter(Boolean);
      const remaining = lines.map(line => JSON.parse(line));

      expect(remaining).to.have.lengthOf(1);
      expect(remaining.find(e => e.requestId === 'recent-pending')).to.exist;
      expect(remaining.find(e => e.requestId === 'old-pending')).to.not.exist;
    });
  });

  describe('Queue Status Updates', () => {
    it('should atomically update request status', () => {
      // Add a test entry
      const entry = {
        status: 'pending',
        requestId: 'test-request-456',
        serviceId: 'test-service',
        from: 'sender-key',
        _ts: Date.now()
      };

      fs.writeFileSync(TEST_PATHS.serviceQueue, JSON.stringify(entry) + '\n');

      // Update status
      const updated = updateServiceQueueStatus('test-request-456', 'fulfilled', {
        fulfilledAt: Date.now(),
        result: { message: 'success' }
      });

      expect(updated).to.be.true;

      // Verify update
      const lines = fs.readFileSync(TEST_PATHS.serviceQueue, 'utf-8').trim().split('\n').filter(Boolean);
      const updatedEntry = JSON.parse(lines[0]);

      expect(updatedEntry.status).to.equal('fulfilled');
      expect(updatedEntry.requestId).to.equal('test-request-456');
      expect(updatedEntry.fulfilledAt).to.exist;
      expect(updatedEntry.updatedAt).to.exist;
      expect(updatedEntry.result.message).to.equal('success');
    });

    it('should return false for non-existent request', () => {
      const updated = updateServiceQueueStatus('non-existent-request', 'fulfilled');
      expect(updated).to.be.false;
    });
  });

  describe('Service Queue Command', () => {
    it('should only return pending requests', async () => {
      // Add mixed status entries
      const entries = [
        { status: 'pending', requestId: 'pending-1', serviceId: 'service-1' },
        { status: 'fulfilled', requestId: 'fulfilled-1', serviceId: 'service-1' },
        { status: 'pending', requestId: 'pending-2', serviceId: 'service-2' },
        { status: 'rejected', requestId: 'rejected-1', serviceId: 'service-1' }
      ];

      const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(TEST_PATHS.serviceQueue, content);

      const result = await cmdServiceQueue();

      expect(result.data?.count).to.equal(2);
      expect(result.data?.total).to.equal(4);
      expect(result.data?.pending).to.have.lengthOf(2);

      const pendingIds = result.data?.pending.map(p => p.requestId);
      expect(pendingIds).to.include('pending-1');
      expect(pendingIds).to.include('pending-2');
      expect(pendingIds).to.not.include('fulfilled-1');
      expect(pendingIds).to.not.include('rejected-1');
    });
  });
});