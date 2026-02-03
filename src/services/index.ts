/**
 * Service system main exports.
 *
 * This is the main entry point for the service system, providing
 * a clean interface for the rest of the application.
 */

export * from './types.js';
export * from './registry.js';
export * from './loader.js';
export * from './manager.js';

// Re-export the main instances for easy access
export { serviceRegistry } from './registry.js';
export { serviceLoader } from './loader.js';
export { serviceManager, initializeServiceSystem, getServiceManager } from './manager.js';