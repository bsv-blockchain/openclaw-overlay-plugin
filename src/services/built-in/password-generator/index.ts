/**
 * Password Generator service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const passwordGeneratorService: ServiceDefinition = {
  id: 'password-generator',
  name: 'Secure Password Generator',
  description: 'Generate cryptographically secure passwords with customizable complexity and requirements.',
  defaultPrice: 3,
  category: ServiceCategory.UTILITY,
  inputSchema: {
    type: 'object',
    properties: {
      length: {
        type: 'number',
        description: 'Password length',
        minimum: 8,
        maximum: 128,
        default: 16
      },
      includeUppercase: {
        type: 'boolean',
        description: 'Include uppercase letters (A-Z)',
        default: true
      },
      includeLowercase: {
        type: 'boolean',
        description: 'Include lowercase letters (a-z)',
        default: true
      },
      includeNumbers: {
        type: 'boolean',
        description: 'Include numbers (0-9)',
        default: true
      },
      includeSymbols: {
        type: 'boolean',
        description: 'Include special symbols (!@#$%^&*)',
        default: false
      },
      excludeAmbiguous: {
        type: 'boolean',
        description: 'Exclude ambiguous characters (0, O, l, 1)',
        default: false
      },
      count: {
        type: 'number',
        description: 'Number of passwords to generate',
        minimum: 1,
        maximum: 10,
        default: 1
      }
    }
  }
};

export default passwordGeneratorService;