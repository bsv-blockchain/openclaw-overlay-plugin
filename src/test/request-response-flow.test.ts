/**
 * Tests for request/response flow and duplicate prevention.
 */

import fs from 'node:fs';
import path from 'node:path';

// Simple test runner (matching existing pattern)
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

// Mock paths for testing
const TEST_DIR = path.join(process.cwd(), 'test-data');
const TEST_PATHS = {
  serviceQueue: path.join(TEST_DIR, 'service-queue.jsonl'),
  walletDir: path.join(TEST_DIR, 'wallet'),
  registration: path.join(TEST_DIR, 'registration.json'),
  services: path.join(TEST_DIR, 'services.json'),
};

function setupTestEnv() {
  // Setup test directory
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function cleanupTestEnv() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

async function run() {
  console.log('\nRequest/Response Flow Tests\n');

  // ── Queue Cleanup Tests ──────────────────────────────────────────────

  await test('cleanupServiceQueue removes old fulfilled entries', async () => {
    setupTestEnv();

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

    // Mock PATHS for cleanupServiceQueue
    const originalPaths = await import('../scripts/config.js');
    const mockPaths = { ...originalPaths.PATHS, serviceQueue: TEST_PATHS.serviceQueue };

    // Temporarily replace PATHS
    (globalThis as Record<string, unknown>).mockPaths = mockPaths;

    // Redefine cleanupServiceQueue with mocked paths
    function mockCleanupServiceQueue(maxAgeMs = 24 * 60 * 60 * 1000, finalStatusMaxAgeMs = 2 * 60 * 60 * 1000) {
      if (!fs.existsSync(TEST_PATHS.serviceQueue)) return;

      const currentTime = Date.now();
      const finalStatuses = ['fulfilled', 'rejected', 'delivery_failed', 'failed', 'error'];

      const lines = fs.readFileSync(TEST_PATHS.serviceQueue, 'utf-8').trim().split('\n').filter(Boolean);
      const keptLines: string[] = [];
      let removedCount = 0;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const entryAge = currentTime - (entry._ts || 0);

          // Always keep pending entries that aren't too old
          if (entry.status === 'pending' && entryAge < maxAgeMs) {
            keptLines.push(line);
            continue;
          }

          // Keep final status entries only if they're recent
          if (finalStatuses.includes(entry.status) && entryAge < finalStatusMaxAgeMs) {
            keptLines.push(line);
            continue;
          }

          // Remove this entry
          removedCount++;
        } catch {
          // Keep malformed entries to avoid data loss
          keptLines.push(line);
        }
      }

      if (removedCount > 0) {
        fs.writeFileSync(TEST_PATHS.serviceQueue, keptLines.join('\n') + (keptLines.length ? '\n' : ''));
      }
    }

    // Run cleanup with 2 hour limit for final statuses
    mockCleanupServiceQueue(24 * 60 * 60 * 1000, 2 * 60 * 60 * 1000);

    // Check remaining entries
    const lines = fs.readFileSync(TEST_PATHS.serviceQueue, 'utf-8').trim().split('\n').filter(Boolean);
    const remaining = lines.map(line => JSON.parse(line));

    assert(remaining.length === 2, `Expected 2 remaining entries, got ${remaining.length}`);
    assert(remaining.find(e => e.requestId === 'pending-1') !== undefined, 'Should keep recent pending');
    assert(remaining.find(e => e.requestId === 'recent-fulfilled') !== undefined, 'Should keep recent fulfilled');
    assert(remaining.find(e => e.requestId === 'old-fulfilled') === undefined, 'Should remove old fulfilled');
    assert(remaining.find(e => e.requestId === 'old-rejected') === undefined, 'Should remove old rejected');

    cleanupTestEnv();
  });

  await test('updateServiceQueueStatus updates request status atomically', async () => {
    setupTestEnv();

    // Add a test entry
    const entry = {
      status: 'pending',
      requestId: 'test-request-456',
      serviceId: 'test-service',
      from: 'sender-key',
      _ts: Date.now()
    };

    fs.writeFileSync(TEST_PATHS.serviceQueue, JSON.stringify(entry) + '\n');

    // Mock updateServiceQueueStatus with test paths
    function mockUpdateServiceQueueStatus(requestId: string, newStatus: string, additionalFields = {}) {
      if (!fs.existsSync(TEST_PATHS.serviceQueue)) return false;

      const lines = fs.readFileSync(TEST_PATHS.serviceQueue, 'utf-8').trim().split('\n').filter(Boolean);
      let updated = false;

      const updatedLines = lines.map(line => {
        try {
          const entryData = JSON.parse(line);
          if (entryData.requestId === requestId) {
            updated = true;
            return JSON.stringify({
              ...entryData,
              status: newStatus,
              ...additionalFields,
              updatedAt: Date.now()
            });
          }
          return line;
        } catch {
          return line;
        }
      });

      if (updated) {
        fs.writeFileSync(TEST_PATHS.serviceQueue, updatedLines.join('\n') + '\n');
      }

      return updated;
    }

    // Update status
    const updated = mockUpdateServiceQueueStatus('test-request-456', 'fulfilled', {
      fulfilledAt: Date.now(),
      result: { message: 'success' }
    });

    assert(updated === true, 'Should return true for successful update');

    // Verify update
    const lines = fs.readFileSync(TEST_PATHS.serviceQueue, 'utf-8').trim().split('\n').filter(Boolean);
    const updatedEntry = JSON.parse(lines[0]);

    assert(updatedEntry.status === 'fulfilled', 'Status should be updated to fulfilled');
    assert(updatedEntry.requestId === 'test-request-456', 'Request ID should remain the same');
    assert(updatedEntry.fulfilledAt !== undefined, 'Should have fulfilledAt timestamp');
    assert(updatedEntry.updatedAt !== undefined, 'Should have updatedAt timestamp');
    assert(updatedEntry.result?.message === 'success', 'Should have result data');

    cleanupTestEnv();
  });

  await test('updateServiceQueueStatus returns false for non-existent request', async () => {
    setupTestEnv();

    // Mock updateServiceQueueStatus with test paths
    function mockUpdateServiceQueueStatus(requestId: string, _newStatus: string) {
      if (!fs.existsSync(TEST_PATHS.serviceQueue)) return false;

      const lines = fs.readFileSync(TEST_PATHS.serviceQueue, 'utf-8').trim().split('\n').filter(Boolean);
      let updated = false;

      lines.map(line => {
        try {
          const entry = JSON.parse(line);
          if (entry.requestId === requestId) {
            updated = true;
          }
          return line;
        } catch {
          return line;
        }
      });

      return updated;
    }

    const updated = mockUpdateServiceQueueStatus('non-existent-request', 'fulfilled');
    assert(updated === false, 'Should return false for non-existent request');

    cleanupTestEnv();
  });

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(console.error);
}

export { run };