/**
 * Lottery Ticket service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const lotteryTicketService: ServiceDefinition = {
  id: 'lottery-ticket',
  name: 'Blockchain Mega Lottery',
  description: 'Buy instant lottery tickets with massive potential payouts! Scratch cards and number draws with transparent odds.',
  defaultPrice: 50, // Base ticket price
  category: ServiceCategory.ENTERTAINMENT,
  inputSchema: {
    type: 'object',
    properties: {
      ticket_type: {
        type: 'string',
        enum: ['instant_scratch', 'number_draw', 'lucky_seven', 'crypto_jackpot'],
        description: 'Type of lottery ticket to purchase',
        default: 'instant_scratch'
      },
      numbers: {
        type: 'array',
        items: {
          type: 'number',
          minimum: 1,
          maximum: 49
        },
        description: 'Your chosen numbers for number draw (1-49)',
        minItems: 3,
        maxItems: 6
      },
      ticket_price: {
        type: 'number',
        description: 'Ticket price tier (50, 100, 200, 500 sats)',
        enum: [50, 100, 200, 500],
        default: 50
      },
      lucky_numbers: {
        type: 'array',
        items: {
          type: 'number',
          minimum: 1,
          maximum: 99
        },
        description: 'Your personal lucky numbers',
        maxItems: 5
      },
      dream_purchase: {
        type: 'string',
        description: 'What would you buy if you won big?',
        maxLength: 100
      },
      superstition_level: {
        type: 'string',
        enum: ['skeptical', 'hopeful', 'very_lucky', 'blessed_by_satoshi'],
        description: 'How lucky do you feel today?',
        default: 'hopeful'
      }
    },
    required: ['ticket_type', 'ticket_price']
  }
};

export default lotteryTicketService;