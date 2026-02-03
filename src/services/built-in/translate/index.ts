/**
 * Translation service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const translateService: ServiceDefinition = {
  id: 'translate',
  name: 'Translation',
  description: 'Translate text between 30+ languages. Accurate, context-aware translations.',
  defaultPrice: 20,
  category: ServiceCategory.UTILITY,
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to translate' },
      to: { type: 'string', description: 'Target language (e.g., "es", "french", "Japanese")' },
      from: { type: 'string', description: 'Source language (auto-detected if not provided)' }
    },
    required: ['text', 'to']
  }
};

export default translateService;