/**
 * Coin Flip Gambling service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const coinFlipService: ServiceDefinition = {
  id: 'coin-flip',
  name: 'Coin Flip Casino',
  description: 'Classic heads or tails gambling. Double your bet or lose it all! 50/50 odds with cryptographic randomness.',
  defaultPrice: 20, // Minimum bet amount
  category: ServiceCategory.ENTERTAINMENT,
  inputSchema: {
    type: 'object',
    properties: {
      bet: {
        type: 'string',
        enum: ['heads', 'tails', 'h', 't'],
        description: 'Your bet: heads/h or tails/t'
      },
      wager: {
        type: 'number',
        description: 'Amount to wager (in sats, minimum 20)',
        minimum: 20,
        maximum: 10000
      },
      lucky_phrase: {
        type: 'string',
        description: 'Optional lucky phrase or ritual words',
        maxLength: 100
      },
      coin_type: {
        type: 'string',
        enum: ['bitcoin', 'classic', 'gold', 'lucky'],
        description: 'Type of coin to flip',
        default: 'bitcoin'
      }
    },
    required: ['bet', 'wager']
  }
};

export default coinFlipService;