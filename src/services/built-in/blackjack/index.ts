/**
 * Blackjack Card Game service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const blackjackService: ServiceDefinition = {
  id: 'blackjack',
  name: 'Crypto Blackjack Casino',
  description: 'Play classic 21 blackjack against the house. Beat the dealer without going bust! 3:2 blackjack payouts.',
  defaultPrice: 30, // Minimum bet amount
  category: ServiceCategory.ENTERTAINMENT,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['new_game', 'hit', 'stand', 'double_down', 'split'],
        description: 'Blackjack action to take'
      },
      bet: {
        type: 'number',
        description: 'Bet amount for new game (minimum 30 sats)',
        minimum: 30,
        maximum: 5000
      },
      game_id: {
        type: 'string',
        description: 'Game session ID (for continuing games)',
        maxLength: 50
      },
      strategy_note: {
        type: 'string',
        description: 'Your strategy reasoning or table talk',
        maxLength: 100
      },
      card_style: {
        type: 'string',
        enum: ['classic', 'crypto', 'minimalist', 'neon'],
        description: 'Visual style for cards',
        default: 'classic'
      },
      risk_level: {
        type: 'string',
        enum: ['conservative', 'balanced', 'aggressive'],
        description: 'Your playing style',
        default: 'balanced'
      }
    },
    oneOf: [
      {
        properties: { action: { const: 'new_game' } },
        required: ['action', 'bet']
      },
      {
        properties: { action: { enum: ['hit', 'stand', 'double_down', 'split'] } },
        required: ['action', 'game_id']
      }
    ]
  }
};

export default blackjackService;