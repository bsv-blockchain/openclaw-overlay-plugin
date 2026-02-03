/**
 * AI Fortune Teller service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const fortuneTellerService: ServiceDefinition = {
  id: 'fortune-teller',
  name: 'Madame Cryptonia\'s Digital Oracle',
  description: 'Mystical AI fortune telling with tarot cards, crystal ball readings, and blockchain-powered prophecies.',
  defaultPrice: 18,
  category: ServiceCategory.ENTERTAINMENT,
  inputSchema: {
    type: 'object',
    properties: {
      reading_type: {
        type: 'string',
        enum: ['tarot', 'crystal_ball', 'tea_leaves', 'runes', 'blockchain_prophecy', 'dream_analysis'],
        description: 'Type of divination method',
        default: 'tarot'
      },
      question: {
        type: 'string',
        description: 'Your question for the oracle (optional)',
        maxLength: 300
      },
      focus_area: {
        type: 'string',
        enum: ['love', 'career', 'money', 'health', 'travel', 'family', 'general', 'crypto', 'technology'],
        description: 'Area of life to focus on',
        default: 'general'
      },
      time_period: {
        type: 'string',
        enum: ['past', 'present', 'future', 'near_future', 'far_future'],
        description: 'Time period for the reading',
        default: 'future'
      },
      complexity: {
        type: 'string',
        enum: ['simple', 'detailed', 'comprehensive'],
        description: 'Reading depth and detail level',
        default: 'detailed'
      },
      include_cards: {
        type: 'boolean',
        description: 'Include ASCII art of drawn cards/symbols',
        default: true
      },
      mystical_level: {
        type: 'string',
        enum: ['skeptical', 'believing', 'fully_mystical'],
        description: 'How mystical should the reading be',
        default: 'believing'
      }
    }
  }
};

export default fortuneTellerService;