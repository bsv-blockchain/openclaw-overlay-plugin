/**
 * Slot Machine service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const slotsService: ServiceDefinition = {
  id: 'slots',
  name: 'Crypto Slots Bonanza',
  description: 'Spin the crypto reels for massive payouts! 3-reel classic slots with bonus features and progressive jackpots.',
  defaultPrice: 25, // Base spin cost
  category: ServiceCategory.ENTERTAINMENT,
  inputSchema: {
    type: 'object',
    properties: {
      spin_type: {
        type: 'string',
        enum: ['standard', 'bonus', 'max_bet', 'turbo'],
        description: 'Type of spin to make',
        default: 'standard'
      },
      bet_amount: {
        type: 'number',
        description: 'Bet per spin (25, 50, 100, 250 sats)',
        enum: [25, 50, 100, 250],
        default: 25
      },
      machine_theme: {
        type: 'string',
        enum: ['classic_fruit', 'crypto_coins', 'space_adventure', 'lucky_sevens'],
        description: 'Slot machine theme',
        default: 'crypto_coins'
      },
      paylines: {
        type: 'number',
        description: 'Number of paylines to activate (1, 3, 5)',
        enum: [1, 3, 5],
        default: 3
      },
      lucky_charm: {
        type: 'string',
        description: 'Your lucky charm or ritual',
        maxLength: 100
      },
      autoplay: {
        type: 'number',
        description: 'Number of automatic spins (1-10)',
        minimum: 1,
        maximum: 10,
        default: 1
      },
      jackpot_dream: {
        type: 'string',
        description: 'What would you do with a jackpot win?',
        maxLength: 150
      }
    },
    required: ['bet_amount']
  }
};

export default slotsService;