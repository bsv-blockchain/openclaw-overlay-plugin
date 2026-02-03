/**
 * Tell Joke service definition.
 *
 * A simple service that tells random jokes. This demonstrates
 * a basic service that works in both handler and agent modes.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';
import { tellJokeHandler } from './handler.js';

const tellJokeService: ServiceDefinition = {
  id: 'tell-joke',
  name: 'Random Joke',
  description: 'Get a random joke. Guaranteed to be at least mildly amusing.',
  defaultPrice: 5,
  category: ServiceCategory.ENTERTAINMENT,
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Optional topic for the joke (e.g., "programming", "cats")'
      },
      style: {
        type: 'string',
        enum: ['dad', 'pun', 'tech', 'general'],
        description: 'Style of joke to tell'
      }
    }
  },
  handler: tellJokeHandler
};

export default tellJokeService;