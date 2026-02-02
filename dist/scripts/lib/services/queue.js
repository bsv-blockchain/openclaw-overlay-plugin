/**
 * Service queue commands.
 */
import fs from 'node:fs';
import { PATHS } from '../config.js';
import { ok } from '../output.js';
import { readJsonl } from '../utils/storage.js';
/**
 * Service queue command: list pending service requests.
 */
export async function cmdServiceQueue() {
    if (!fs.existsSync(PATHS.serviceQueue)) {
        return ok({ pending: [], count: 0 });
    }
    const entries = readJsonl(PATHS.serviceQueue);
    const pending = entries.filter(e => e.status === 'pending');
    return ok({ pending, count: pending.length, total: entries.length });
}
/**
 * Research queue command: list pending research requests.
 */
export async function cmdResearchQueue() {
    if (!fs.existsSync(PATHS.researchQueue)) {
        return ok({ pending: [] });
    }
    const entries = readJsonl(PATHS.researchQueue);
    return ok({ pending: entries, count: entries.length });
}
