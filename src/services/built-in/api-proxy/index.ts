/**
 * API Proxy service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const apiProxyService: ServiceDefinition = {
  id: 'api-proxy',
  name: 'API Proxy',
  description: 'Proxy HTTP requests to external APIs. Input: {url, method, headers, body}.',
  defaultPrice: 15,
  category: ServiceCategory.UTILITY,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Target API URL' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method' },
      headers: { type: 'object', description: 'Request headers' },
      body: { description: 'Request body' },
      timeout: { type: 'number', description: 'Request timeout in ms' }
    },
    required: ['url']
  }
};

export default apiProxyService;