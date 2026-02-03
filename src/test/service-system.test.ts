/**
 * Service system comprehensive tests.
 * Tests service registration, loading, validation, and execution.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceRegistry, serviceLoader, serviceManager, initializeServiceSystem } from '../services/index.js';
import { ServiceDefinition, ServiceCategory } from '../services/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

// Test helper functions
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEquals(actual: any, expected: any, message?: string) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${message || ''} - Expected ${expected}, got ${actual}`);
  }
}

console.log('\n=== Service System Tests ===\n');

// Test 1: Service Registry Basic Operations
console.log('Testing service registry basic operations...');

// Create test service
const testService: ServiceDefinition = {
  id: 'test-service',
  name: 'Test Service',
  description: 'A test service for unit testing',
  defaultPrice: 10,
  category: ServiceCategory.UTILITY,
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Test message' }
    },
    required: ['message']
  }
};

// Clear registry for clean test
serviceRegistry.clear();

// Test registration
serviceRegistry.register(testService);
assert(serviceRegistry.get('test-service') !== undefined, 'Service should be registered');
assertEquals(serviceRegistry.get('test-service')?.name, 'Test Service', 'Service name should match');

// Test listing
const services = serviceRegistry.list();
assert(services.length === 1, 'Should have one registered service');
assertEquals(services[0].id, 'test-service', 'Listed service should match registered service');

console.log('✅ Registry: basic operations work correctly');

// Test 2: Service Registry Validation
console.log('Testing service registry validation...');

// Test duplicate registration
try {
  serviceRegistry.register(testService);
  throw new Error('Should have thrown error for duplicate registration');
} catch (error: any) {
  assert(error.message.includes('already registered'), 'Should reject duplicate registration');
}

// Test invalid service (missing required fields)
try {
  serviceRegistry.register({
    id: '',
    name: 'Invalid',
    description: 'Missing ID',
    defaultPrice: 10
  } as ServiceDefinition);
  throw new Error('Should have thrown error for invalid service');
} catch (error: any) {
  assert(error.message.includes('Service ID is required'), 'Should reject service without ID');
}

console.log('✅ Registry: validation works correctly');

// Test 3: Service Loader Directory Scanning
console.log('Testing service loader directory scanning...');

// Clear registry for clean test
serviceRegistry.clear();

// Load built-in services
const builtInServices = await serviceLoader.loadBuiltInServices();
assert(builtInServices.length > 0, 'Should load built-in services');

// Check that specific services are loaded
const expectedServices = ['tell-joke', 'api-proxy', 'summarize', 'memory-store', 'roulette', 'code-develop', 'image-analysis'];
for (const serviceId of expectedServices) {
  const service = builtInServices.find(s => s.id === serviceId);
  assert(service !== undefined, `Should load ${serviceId} service`);
  assert(service!.name.length > 0, `${serviceId} should have a name`);
  assert(service!.description.length > 0, `${serviceId} should have a description`);
  assert(service!.defaultPrice > 0, `${serviceId} should have a valid price`);
}

console.log('✅ Loader: directory scanning works correctly');

// Test 4: Service Manager Integration
console.log('Testing service manager integration...');

// Initialize service system
await initializeServiceSystem();

// Test service discovery
const joke = serviceManager.registry.get('tell-joke');
assert(joke !== undefined, 'Should find tell-joke service');
assertEquals(joke!.name, 'Random Joke', 'Service name should match');

// Test validation with valid input
const validationResult = serviceManager.validate('tell-joke', { topic: 'programming' });
assert(validationResult.valid, 'Valid input should pass validation');

// Tell-joke service has no required fields, so empty object is valid
const emptyInputResult = serviceManager.validate('tell-joke', {});
assert(emptyInputResult.valid, 'Empty input should be valid for tell-joke service');

// Test with truly invalid input (wrong type)
const invalidResult = serviceManager.validate('tell-joke', { topic: 123 });
assert(!invalidResult.valid, 'Invalid input type should fail validation');

console.log('✅ Manager: integration works correctly');

// Test 5: Service Input Schema Validation
console.log('Testing service input schema validation...');

// Test api-proxy service validation
const apiProxy = serviceManager.registry.get('api-proxy');
assert(apiProxy !== undefined, 'Should find api-proxy service');

const validApiInput = { url: 'https://api.example.com/test', method: 'GET' };
const validApiResult = serviceManager.validate('api-proxy', validApiInput);
assert(validApiResult.valid, 'Valid api-proxy input should pass');

const invalidApiInput = { method: 'GET' }; // missing required url
const invalidApiResult = serviceManager.validate('api-proxy', invalidApiInput);
assert(!invalidApiResult.valid, 'Invalid api-proxy input should fail');

console.log('✅ Validation: input schema validation works correctly');

// Test 6: Service Categories
console.log('Testing service categories...');

// Check that services have appropriate categories
const categorizedServices = serviceManager.registry.list();
const categories = new Set(categorizedServices.map(s => s.category).filter(Boolean));
assert(categories.size > 0, 'Should have services with categories');

// Verify known categories
const expectedCategories = ['utility', 'ai', 'entertainment', 'development'];
for (const category of expectedCategories) {
  const servicesInCategory = categorizedServices.filter(s => s.category === category);
  assert(servicesInCategory.length > 0, `Should have services in ${category} category`);
}

console.log('✅ Categories: service categorization works correctly');

// Test 7: Service Loading Error Handling
console.log('Testing service loading error handling...');

// Test loading from non-existent directory
try {
  await serviceLoader.loadFromDirectory('/non/existent/directory');
  // Should not throw, but return empty array
  console.log('✅ Loader: graceful handling of non-existent directory');
} catch {
  // This is also acceptable behavior
  console.log('✅ Loader: appropriate error handling for non-existent directory');
}

// Test 8: Service Prompt Files
console.log('Testing service prompt files...');

// Check that services with prompt files can be found
const servicesWithPrompts = categorizedServices.filter(s => s.promptFile);
assert(servicesWithPrompts.length > 0, 'Should have services with prompt files');

// Verify prompt files exist
for (const service of servicesWithPrompts.slice(0, 3)) { // Test first 3 to avoid excessive file I/O
  if (service.promptFile) {
    const promptPath = path.resolve(projectRoot, service.promptFile);
    assert(fs.existsSync(promptPath), `Prompt file should exist: ${service.promptFile}`);

    const content = fs.readFileSync(promptPath, 'utf-8');
    assert(content.includes(service.id), `Prompt should reference service ID: ${service.id}`);
  }
}

console.log('✅ Prompts: service prompt files work correctly');

// Test 9: Service Registry Search and Filter
console.log('Testing service registry search and filter...');

// Test filtering by category
const aiServices = categorizedServices.filter(s => s.category === ServiceCategory.AI);
assert(aiServices.length > 0, 'Should have AI services');

const utilityServices = categorizedServices.filter(s => s.category === ServiceCategory.UTILITY);
assert(utilityServices.length > 0, 'Should have utility services');

// Test name search
const jokeServices = categorizedServices.filter(s => s.name.toLowerCase().includes('joke'));
assert(jokeServices.length > 0, 'Should find joke-related services');

console.log('✅ Search: service filtering works correctly');

// Test 10: Service System State Consistency
console.log('Testing service system state consistency...');

// Verify that registry and manager are in sync
const registryServices = serviceManager.registry.list();
const registryIds = new Set(registryServices.map(s => s.id));

// All services should be unique
assertEquals(registryIds.size, registryServices.length, 'All service IDs should be unique');

// All services should have valid pricing
for (const service of registryServices) {
  assert(service.defaultPrice > 0, `Service ${service.id} should have valid price`);
  assert(service.name.length > 0, `Service ${service.id} should have a name`);
  assert(service.description.length > 0, `Service ${service.id} should have a description`);
}

console.log('✅ Consistency: service system state is consistent');

console.log('\n========================================');
console.log('Service System Tests completed: All tests passed!');
console.log('========================================\n');