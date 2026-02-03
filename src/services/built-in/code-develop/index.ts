/**
 * Code Development service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const codeDevelopService: ServiceDefinition = {
  id: 'code-develop',
  name: 'Code Development',
  description: 'Generate code from requirements. Specify language, task description, and constraints.',
  defaultPrice: 100,
  category: ServiceCategory.DEVELOPMENT,
  inputSchema: {
    type: 'object',
    properties: {
      requirements: { type: 'string', description: 'Detailed description of what code to generate' },
      language: { type: 'string', description: 'Programming language (e.g., JavaScript, Python, Java)' },
      constraints: { type: 'string', description: 'Any specific constraints or requirements' },
      style: { type: 'string', description: 'Code style preferences' },
      includeTests: { type: 'boolean', description: 'Whether to include unit tests' }
    },
    required: ['requirements', 'language']
  }
};

export default codeDevelopService;