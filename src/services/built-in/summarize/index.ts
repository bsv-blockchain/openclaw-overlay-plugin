/**
 * Summarize service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const summarizeService: ServiceDefinition = {
  id: 'summarize',
  name: 'Summarize',
  description: 'Summarize long text, articles, or documents into concise bullet points.',
  defaultPrice: 20,
  category: ServiceCategory.AI,
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to summarize' },
      maxLength: { type: 'number', description: 'Maximum length of summary' },
      format: { type: 'string', enum: ['bullets', 'paragraph'], description: 'Output format' }
    },
    required: ['text']
  }
};

export default summarizeService;