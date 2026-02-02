/**
 * File-based storage helpers for registration, services, and queues.
 */
import fs from 'node:fs';
import { OVERLAY_STATE_DIR, PATHS } from '../config.js';
/**
 * Ensure the overlay state directory exists.
 */
export function ensureStateDir() {
    fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
}
/**
 * Load registration data from disk.
 */
export function loadRegistration() {
    try {
        if (fs.existsSync(PATHS.registration)) {
            return JSON.parse(fs.readFileSync(PATHS.registration, 'utf-8'));
        }
    }
    catch {
        // Ignore parse errors
    }
    return null;
}
/**
 * Save registration data to disk.
 */
export function saveRegistration(data) {
    ensureStateDir();
    fs.writeFileSync(PATHS.registration, JSON.stringify(data, null, 2), 'utf-8');
}
/**
 * Delete registration file.
 */
export function deleteRegistration() {
    try {
        fs.unlinkSync(PATHS.registration);
    }
    catch {
        // Ignore if file doesn't exist
    }
}
/**
 * Load services list from disk.
 */
export function loadServices() {
    try {
        if (fs.existsSync(PATHS.services)) {
            return JSON.parse(fs.readFileSync(PATHS.services, 'utf-8'));
        }
    }
    catch {
        // Ignore parse errors
    }
    return [];
}
/**
 * Save services list to disk.
 */
export function saveServices(services) {
    ensureStateDir();
    fs.writeFileSync(PATHS.services, JSON.stringify(services, null, 2), 'utf-8');
}
/**
 * Load X verifications from disk.
 */
export function loadXVerifications() {
    try {
        if (fs.existsSync(PATHS.xVerifications)) {
            return JSON.parse(fs.readFileSync(PATHS.xVerifications, 'utf-8'));
        }
    }
    catch {
        // Ignore parse errors
    }
    return [];
}
/**
 * Save X verifications to disk.
 */
export function saveXVerifications(verifications) {
    ensureStateDir();
    fs.writeFileSync(PATHS.xVerifications, JSON.stringify(verifications, null, 2), 'utf-8');
}
/**
 * Append a line to a JSONL file.
 */
export function appendToJsonl(filePath, entry) {
    ensureStateDir();
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}
/**
 * Read and parse a JSONL file.
 */
export function readJsonl(filePath) {
    if (!fs.existsSync(filePath))
        return [];
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map(line => {
        try {
            return JSON.parse(line);
        }
        catch {
            return null;
        }
    }).filter(Boolean);
}
/**
 * Load stored change BEEF data.
 */
export function loadStoredChange() {
    try {
        if (fs.existsSync(PATHS.latestChange)) {
            return JSON.parse(fs.readFileSync(PATHS.latestChange, 'utf-8'));
        }
    }
    catch {
        // Ignore parse errors
    }
    return null;
}
/**
 * Save stored change BEEF data.
 */
export function saveStoredChange(data) {
    ensureStateDir();
    fs.writeFileSync(PATHS.latestChange, JSON.stringify(data));
}
/**
 * Delete stored change file.
 */
export function deleteStoredChange() {
    try {
        fs.unlinkSync(PATHS.latestChange);
    }
    catch {
        // Ignore if file doesn't exist
    }
}
