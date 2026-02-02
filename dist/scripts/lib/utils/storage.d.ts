/**
 * File-based storage helpers for registration, services, and queues.
 */
import type { Registration, ServiceAdvertisement, XVerification, StoredChange } from '../types.js';
/**
 * Ensure the overlay state directory exists.
 */
export declare function ensureStateDir(): void;
/**
 * Load registration data from disk.
 */
export declare function loadRegistration(): Registration | null;
/**
 * Save registration data to disk.
 */
export declare function saveRegistration(data: Registration): void;
/**
 * Delete registration file.
 */
export declare function deleteRegistration(): void;
/**
 * Load services list from disk.
 */
export declare function loadServices(): ServiceAdvertisement[];
/**
 * Save services list to disk.
 */
export declare function saveServices(services: ServiceAdvertisement[]): void;
/**
 * Load X verifications from disk.
 */
export declare function loadXVerifications(): XVerification[];
/**
 * Save X verifications to disk.
 */
export declare function saveXVerifications(verifications: XVerification[]): void;
/**
 * Append a line to a JSONL file.
 */
export declare function appendToJsonl(filePath: string, entry: Record<string, unknown>): void;
/**
 * Read and parse a JSONL file.
 */
export declare function readJsonl<T>(filePath: string): T[];
/**
 * Load stored change BEEF data.
 */
export declare function loadStoredChange(): StoredChange | null;
/**
 * Save stored change BEEF data.
 */
export declare function saveStoredChange(data: StoredChange): void;
/**
 * Delete stored change file.
 */
export declare function deleteStoredChange(): void;
