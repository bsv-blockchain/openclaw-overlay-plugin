/**
 * Memory Store service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const memoryStoreService: ServiceDefinition = {
  id: 'memory-store',
  name: 'Memory Store',
  description: 'Persistent key-value storage for agents. Operations: set, get, delete, list.',
  defaultPrice: 10,
  category: ServiceCategory.UTILITY,
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['set', 'get', 'delete', 'list'], description: 'Storage operation' },
      key: { type: 'string', description: 'Storage key (required for set, get, delete)' },
      value: { description: 'Value to store (required for set operation)' },
      namespace: { type: 'string', description: 'Optional namespace for keys' }
    },
    required: ['operation']
  }
};

export default memoryStoreService;