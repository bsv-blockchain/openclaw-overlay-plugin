/**
 * Dad Joke Battle service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const dadJokeBattleService: ServiceDefinition = {
  id: 'dad-joke-battle',
  name: 'Dad Joke Battle Arena',
  description: 'Epic dad joke battles! Submit your best dad joke and get rated against the competition.',
  defaultPrice: 12,
  category: ServiceCategory.ENTERTAINMENT,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['battle', 'judge', 'leaderboard', 'random_opponent'],
        description: 'Battle action to perform',
        default: 'battle'
      },
      your_joke: {
        type: 'string',
        description: 'Your dad joke for the battle',
        maxLength: 500
      },
      opponent_joke: {
        type: 'string',
        description: 'Opponent joke (optional, will generate if not provided)',
        maxLength: 500
      },
      category: {
        type: 'string',
        enum: ['classic', 'pun', 'food', 'animals', 'tech', 'sports', 'mixed'],
        description: 'Joke category theme',
        default: 'mixed'
      },
      difficulty: {
        type: 'string',
        enum: ['amateur', 'professional', 'legendary'],
        description: 'Opponent difficulty level',
        default: 'professional'
      },
      battle_format: {
        type: 'string',
        enum: ['single', 'best_of_3', 'tournament'],
        description: 'Battle format',
        default: 'single'
      }
    },
    oneOf: [
      { required: ['action', 'your_joke'] },
      {
        properties: { action: { const: 'leaderboard' } },
        required: ['action']
      }
    ]
  }
};

export default dadJokeBattleService;