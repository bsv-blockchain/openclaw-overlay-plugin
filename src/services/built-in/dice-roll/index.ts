/**
 * Dice Roll Gambling service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const diceRollService: ServiceDefinition = {
  id: 'dice-roll',
  name: 'Crypto Dice Casino',
  description: 'Roll the dice and bet on the outcome! Multiple betting options with varying odds and payouts.',
  defaultPrice: 15, // Minimum bet amount
  category: ServiceCategory.ENTERTAINMENT,
  inputSchema: {
    type: 'object',
    properties: {
      bet_type: {
        type: 'string',
        enum: ['exact_number', 'over', 'under', 'odd', 'even', 'range'],
        description: 'Type of bet to place'
      },
      bet_value: {
        description: 'Bet value (number 1-6 for exact, threshold for over/under, or range like "2-4")'
      },
      wager: {
        type: 'number',
        description: 'Amount to wager (in sats, minimum 15)',
        minimum: 15,
        maximum: 5000
      },
      dice_count: {
        type: 'number',
        description: 'Number of dice to roll (1-3)',
        minimum: 1,
        maximum: 3,
        default: 1
      },
      dice_type: {
        type: 'string',
        enum: ['standard', 'crypto', 'golden', 'neon'],
        description: 'Visual style of dice',
        default: 'crypto'
      },
      lucky_ritual: {
        type: 'string',
        description: 'Your pre-roll ritual or lucky phrase',
        maxLength: 150
      }
    },
    required: ['bet_type', 'bet_value', 'wager']
  }
};

export default diceRollService;