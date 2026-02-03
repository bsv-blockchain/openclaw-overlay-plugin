/**
 * Web Research service definition.
 *
 * Research any topic using current web sources and return a synthesized
 * summary with cited sources. Agent-mode service leveraging web search.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const webResearchService: ServiceDefinition = {
  id: 'web-research',
  name: 'Web Research',
  description: 'Research any topic using current web sources. Returns a synthesized summary with cited sources.',
  defaultPrice: 50,
  category: ServiceCategory.RESEARCH,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Research query or topic'
      },
      depth: {
        type: 'string',
        enum: ['quick', 'standard', 'comprehensive'],
        description: 'Research depth (default: standard)'
      },
      sources: {
        type: 'number',
        minimum: 3,
        maximum: 20,
        description: 'Number of sources to research (default: 5)'
      },
      focusAreas: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific aspects to focus on'
      },
      excludeDomains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Domains to exclude from research'
      },
      timeframe: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year', 'all'],
        description: 'How recent the information should be'
      }
    },
    required: ['query']
  }
};

export default webResearchService;