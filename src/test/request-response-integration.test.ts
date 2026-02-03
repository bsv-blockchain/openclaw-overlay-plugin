/**
 * Integration tests for the complete request/response flow.
 */

import { expect } from 'chai';
import fs from 'node:fs';
import path from 'node:path';
import { processMessage } from '../scripts/messaging/handlers.js';
import { cmdServiceQueue } from '../scripts/services/queue.js';
import { cmdRespondService } from '../scripts/services/respond.js';
import type { RelayMessage } from '../scripts/types.js';

// Mock paths for testing
const TEST_DIR = path.join(__dirname, '../../test-integration');
const TEST_PATHS = {
  serviceQueue: path.join(TEST_DIR, 'service-queue.jsonl'),
  walletDir: path.join(TEST_DIR, 'wallet'),
  registration: path.join(TEST_DIR, 'registration.json'),
  services: path.join(TEST_DIR, 'services.json'),
};

describe('Request/Response Integration', () => {
  let originalEnv: any;
  let originalFetch: any;

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

    // Mock wallet directory and identity
    fs.mkdirSync(TEST_PATHS.walletDir, { recursive: true });
    fs.writeFileSync(path.join(TEST_PATHS.walletDir, 'identity.json'), JSON.stringify({
      identityKey: 'integration-test-key',
      rootKeyHex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    }));

    // Mock services
    fs.writeFileSync(TEST_PATHS.services, JSON.stringify([
      { serviceId: 'code-review', priceSats: 50 },
      { serviceId: 'tell-joke', priceSats: 5 }
    ]));

    // Mock config import
    const configModule = require('../scripts/config.js');
    Object.assign(configModule.PATHS, TEST_PATHS);
    configModule.WALLET_DIR = TEST_PATHS.walletDir;

    // Mock fetch for relay communication
    originalFetch = global.fetch;
    global.fetch = async (url: string, options?: any) => {
      if (url.includes('/relay/send')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sent: true, messageId: 'mock-message-id' })
        };
      }
      return originalFetch(url, options);
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('Complete Request/Response Cycle', () => {
    it('should handle a complete service request cycle without duplicates', async () => {
      const requestId = 'integration-test-request-789';

      // Step 1: Incoming service request
      const serviceRequest: RelayMessage = {
        id: requestId,
        from: 'client-key-abc',
        to: 'integration-test-key',
        type: 'service-request',
        payload: {
          serviceId: 'code-review',
          input: { code: 'function test() { return true; }' },
          payment: {
            beef: 'mock-beef-data',
            satoshis: 50,
            txid: 'mock-payment-txid',
            derivationPrefix: 'test-prefix',
            derivationSuffix: 'test-suffix',
            senderIdentityKey: 'client-key-abc'
          }
        },
        signature: 'mock-signature'
      };

      // Mock payment verification
      const originalVerify = require('../scripts/messaging/handlers.js').verifyAndAcceptPayment;
      require('../scripts/messaging/handlers.js').verifyAndAcceptPayment = async () => ({
        accepted: true,
        txid: 'mock-payment-txid',
        satoshis: 50,
        outputIndex: 0,
        walletAccepted: true,
        error: null
      });

      try {
        // Process the service request
        const requestResult = await processMessage(
          serviceRequest,
          'integration-test-key',
          'integration-test-privkey'
        );

        expect(requestResult.action).to.equal('queued-for-agent');
        expect(requestResult.paymentAccepted).to.be.true;
        expect(requestResult.satoshisReceived).to.equal(50);

        // Step 2: Check pending requests
        const queueResult = await cmdServiceQueue();
        expect(queueResult.data?.count).to.equal(1);

        const pendingRequest = queueResult.data?.pending[0];
        expect(pendingRequest.requestId).to.equal(requestId);
        expect(pendingRequest.status).to.equal('pending');
        expect(pendingRequest.serviceId).to.equal('code-review');

        // Step 3: Respond to the request
        const serviceResponse = {
          review: 'The function looks good but could use error handling.',
          suggestions: ['Add input validation', 'Consider edge cases'],
          rating: 8
        };

        const respondResult = await cmdRespondService(
          requestId,
          'client-key-abc',
          'code-review',
          JSON.stringify(serviceResponse)
        );

        expect(respondResult.data?.sent).to.be.true;
        expect(respondResult.data?.requestId).to.equal(requestId);

        // Step 4: Verify request is marked as fulfilled
        const updatedQueue = await cmdServiceQueue();
        expect(updatedQueue.data?.count).to.equal(0); // No pending requests

        // Read the queue file directly to verify status
        const queueContent = fs.readFileSync(TEST_PATHS.serviceQueue, 'utf-8');
        const queueLines = queueContent.trim().split('\n').filter(Boolean);
        const queueEntry = JSON.parse(queueLines[0]);

        expect(queueEntry.status).to.equal('fulfilled');
        expect(queueEntry.requestId).to.equal(requestId);
        expect(queueEntry.fulfilledAt).to.exist;

        // Step 5: Try to process the same request again (should be prevented)
        const duplicateResult = await processMessage(
          serviceRequest,
          'integration-test-key',
          'integration-test-privkey'
        );

        expect(duplicateResult.action).to.equal('already-fulfilled');

        // Step 6: Try to respond again (should be prevented)
        const duplicateResponse = await cmdRespondService(
          requestId,
          'client-key-abc',
          'code-review',
          JSON.stringify({ duplicate: true })
        );

        expect(duplicateResponse.data?.sent).to.be.false;
        expect(duplicateResponse.data?.alreadyProcessed).to.be.true;

      } finally {
        // Restore original function
        require('../scripts/messaging/handlers.js').verifyAndAcceptPayment = originalVerify;
      }
    });

    it('should handle payment rejection and not wake agent', async () => {
      const requestId = 'payment-failed-request';

      const serviceRequest: RelayMessage = {
        id: requestId,
        from: 'poor-client-key',
        to: 'integration-test-key',
        type: 'service-request',
        payload: {
          serviceId: 'code-review',
          input: { code: 'test' },
          payment: {
            beef: 'insufficient-beef',
            satoshis: 10, // Too low for code-review (needs 50)
            txid: 'insufficient-txid'
          }
        },
        signature: 'mock-signature'
      };

      // Mock payment verification to fail
      const originalVerify = require('../scripts/messaging/handlers.js').verifyAndAcceptPayment;
      require('../scripts/messaging/handlers.js').verifyAndAcceptPayment = async () => ({
        accepted: false,
        txid: 'insufficient-txid',
        satoshis: 10,
        outputIndex: 0,
        walletAccepted: false,
        error: 'insufficient payment: 10 < 50'
      });

      try {
        const result = await processMessage(
          serviceRequest,
          'integration-test-key',
          'integration-test-privkey'
        );

        expect(result.action).to.equal('rejected');
        expect(result.reason).to.include('Payment rejected');

        // Verify queue has the rejected entry
        const queueContent = fs.readFileSync(TEST_PATHS.serviceQueue, 'utf-8');
        const queueLines = queueContent.trim().split('\n').filter(Boolean);
        const queueEntry = JSON.parse(queueLines[0]);

        expect(queueEntry.status).to.equal('rejected');
        expect(queueEntry.requestId).to.equal(requestId);
        expect(queueEntry.error).to.include('insufficient payment');

        // Verify no pending requests
        const queueResult = await cmdServiceQueue();
        expect(queueResult.data?.count).to.equal(0);

      } finally {
        require('../scripts/messaging/handlers.js').verifyAndAcceptPayment = originalVerify;
      }
    });

    it('should handle multiple different requests concurrently', async () => {
      // Create multiple different service requests
      const requests = [
        {
          id: 'concurrent-1',
          serviceId: 'tell-joke',
          satoshis: 5,
          input: { topic: 'programming' }
        },
        {
          id: 'concurrent-2',
          serviceId: 'code-review',
          satoshis: 50,
          input: { code: 'console.log("test");' }
        },
        {
          id: 'concurrent-3',
          serviceId: 'tell-joke',
          satoshis: 5,
          input: { topic: 'cats' }
        }
      ];

      // Mock payment verification to always succeed
      const originalVerify = require('../scripts/messaging/handlers.js').verifyAndAcceptPayment;
      require('../scripts/messaging/handlers.js').verifyAndAcceptPayment = async (payment, minSats) => ({
        accepted: true,
        txid: `mock-txid-${payment.satoshis}`,
        satoshis: payment.satoshis,
        outputIndex: 0,
        walletAccepted: true,
        error: null
      });

      try {
        // Process all requests
        const results = await Promise.all(
          requests.map(req => processMessage({
            id: req.id,
            from: `client-${req.id}`,
            to: 'integration-test-key',
            type: 'service-request',
            payload: {
              serviceId: req.serviceId,
              input: req.input,
              payment: {
                beef: `mock-beef-${req.id}`,
                satoshis: req.satoshis,
                txid: `payment-txid-${req.id}`
              }
            },
            signature: `sig-${req.id}`
          }, 'integration-test-key', 'integration-test-privkey'))
        );

        // Verify all were queued successfully
        results.forEach((result, index) => {
          expect(result.action).to.equal('queued-for-agent');
          expect(result.id).to.equal(requests[index].id);
        });

        // Check queue has all pending requests
        const queueResult = await cmdServiceQueue();
        expect(queueResult.data?.count).to.equal(3);
        expect(queueResult.data?.total).to.equal(3);

        // Respond to all requests
        const responses = await Promise.all([
          cmdRespondService('concurrent-1', 'client-concurrent-1', 'tell-joke',
                           JSON.stringify({ joke: 'Why do programmers prefer dark mode? Because light attracts bugs!' })),
          cmdRespondService('concurrent-2', 'client-concurrent-2', 'code-review',
                           JSON.stringify({ review: 'Simple console.log, looks good!', rating: 7 })),
          cmdRespondService('concurrent-3', 'client-concurrent-3', 'tell-joke',
                           JSON.stringify({ joke: 'What do you call a cat that works for Red Cross? A first-aid kit!' }))
        ]);

        // Verify all responses were sent
        responses.forEach(response => {
          expect(response.data?.sent).to.be.true;
        });

        // Verify no pending requests remain
        const finalQueue = await cmdServiceQueue();
        expect(finalQueue.data?.count).to.equal(0);

      } finally {
        require('../scripts/messaging/handlers.js').verifyAndAcceptPayment = originalVerify;
      }
    });
  });
});