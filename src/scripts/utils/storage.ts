/**
 * File-based storage helpers for registration, services, and queues.
 */

import fs from 'node:fs';
import { OVERLAY_STATE_DIR, PATHS } from '../config.js';
import type { Registration, ServiceAdvertisement, XVerification, StoredChange } from '../types.js';

/**
 * Ensure the overlay state directory exists.
 */
export function ensureStateDir(): void {
  fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
}

/**
 * Load registration data from disk.
 */
export function loadRegistration(): Registration | null {
  try {
    if (fs.existsSync(PATHS.registration)) {
      return JSON.parse(fs.readFileSync(PATHS.registration, 'utf-8'));
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Save registration data to disk.
 */
export function saveRegistration(data: Registration): void {
  ensureStateDir();
  fs.writeFileSync(PATHS.registration, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Delete registration file.
 */
export function deleteRegistration(): void {
  try {
    fs.unlinkSync(PATHS.registration);
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Load services list from disk.
 */
export function loadServices(): ServiceAdvertisement[] {
  try {
    if (fs.existsSync(PATHS.services)) {
      return JSON.parse(fs.readFileSync(PATHS.services, 'utf-8'));
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

/**
 * Save services list to disk.
 */
export function saveServices(services: ServiceAdvertisement[]): void {
  ensureStateDir();
  fs.writeFileSync(PATHS.services, JSON.stringify(services, null, 2), 'utf-8');
}

/**
 * Load X verifications from disk.
 */
export function loadXVerifications(): XVerification[] {
  try {
    if (fs.existsSync(PATHS.xVerifications)) {
      return JSON.parse(fs.readFileSync(PATHS.xVerifications, 'utf-8'));
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

/**
 * Save X verifications to disk.
 */
export function saveXVerifications(verifications: XVerification[]): void {
  ensureStateDir();
  fs.writeFileSync(PATHS.xVerifications, JSON.stringify(verifications, null, 2), 'utf-8');
}

/**
 * Append a line to a JSONL file.
 */
export function appendToJsonl(filePath: string, entry: Record<string, unknown>): void {
  ensureStateDir();
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

/**
 * Read and parse a JSONL file.
 */
export function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean) as T[];
}

/**
 * Load stored change BEEF data.
 */
export function loadStoredChange(): StoredChange | null {
  try {
    if (fs.existsSync(PATHS.latestChange)) {
      return JSON.parse(fs.readFileSync(PATHS.latestChange, 'utf-8'));
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Save stored change BEEF data.
 */
export function saveStoredChange(data: StoredChange): void {
  ensureStateDir();
  fs.writeFileSync(PATHS.latestChange, JSON.stringify(data));
}

/**
 * Delete stored change file.
 */
export function deleteStoredChange(): void {
  try {
    fs.unlinkSync(PATHS.latestChange);
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Clean up old entries from service queue.
 * Removes entries older than maxAgeMs or entries with final statuses older than finalStatusMaxAgeMs.
 */
export function cleanupServiceQueue(maxAgeMs: number = 24 * 60 * 60 * 1000, finalStatusMaxAgeMs: number = 2 * 60 * 60 * 1000): void {
  if (!fs.existsSync(PATHS.serviceQueue)) return;

  const now = Date.now();
  const finalStatuses = ['fulfilled', 'rejected', 'delivery_failed', 'failed', 'error'];

  const lines = fs.readFileSync(PATHS.serviceQueue, 'utf-8').trim().split('\n').filter(Boolean);
  const keptLines: string[] = [];
  let removedCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const entryAge = now - (entry._ts || 0);

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
    fs.writeFileSync(PATHS.serviceQueue, keptLines.join('\n') + (keptLines.length ? '\n' : ''));
    console.error(JSON.stringify({ event: 'queue-cleanup', removed: removedCount, kept: keptLines.length }));
  }
}

/**
 * Atomically update a service queue entry status.
 * Returns true if the entry was found and updated, false otherwise.
 */
export function updateServiceQueueStatus(
  requestId: string,
  newStatus: string,
  additionalFields: Record<string, any> = {}
): boolean {
  if (!fs.existsSync(PATHS.serviceQueue)) return false;

  const lines = fs.readFileSync(PATHS.serviceQueue, 'utf-8').trim().split('\n').filter(Boolean);
  let updated = false;

  const updatedLines = lines.map(line => {
    try {
      const entry = JSON.parse(line);
      if (entry.requestId === requestId) {
        updated = true;
        return JSON.stringify({
          ...entry,
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
    fs.writeFileSync(PATHS.serviceQueue, updatedLines.join('\n') + '\n');
  }

  return updated;
}
