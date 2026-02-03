/**
 * Roulette service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const rouletteService: ServiceDefinition = {
  id: 'roulette',
  name: 'Roulette',
  description: 'European roulette (single zero). Bet on: number 0-36, red/black, odd/even, high/low.',
  defaultPrice: 10,
  category: ServiceCategory.ENTERTAINMENT,
  inputSchema: {
    type: 'object',
    properties: {
      bet: {
        type: 'string',
        description: 'Bet type: specific number (0-36), red, black, odd, even, high (19-36), low (1-18), or dozen (1st, 2nd, 3rd)'
      },
      amount: {
        type: 'number',
        description: 'Bet amount (optional, for display purposes)',
        minimum: 1
      }
    },
    required: ['bet']
  }
};

export default rouletteService;