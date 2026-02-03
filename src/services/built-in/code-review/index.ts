/**
 * Code Review service definition.
 *
 * Provides thorough code review covering bugs, security issues, style,
 * performance, and improvement suggestions. This is an agent-mode service
 * that leverages the LLM's capabilities.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const codeReviewService: ServiceDefinition = {
  id: 'code-review',
  name: 'Code Review',
  description: 'Thorough code review covering bugs, security issues, style, performance, and improvement suggestions.',
  defaultPrice: 50,
  category: ServiceCategory.DEVELOPMENT,
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Code to review'
      },
      language: {
        type: 'string',
        description: 'Programming language (auto-detected if not provided)'
      },
      prUrl: {
        type: 'string',
        description: 'GitHub/GitLab PR URL to review instead of direct code'
      },
      focusAreas: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['security', 'performance', 'style', 'bugs', 'maintainability', 'testing']
        },
        description: 'Specific areas to focus the review on'
      },
      severity: {
        type: 'string',
        enum: ['basic', 'detailed', 'comprehensive'],
        description: 'Depth of review (default: detailed)'
      }
    },
    anyOf: [
      { required: ['code'] },
      { required: ['prUrl'] }
    ]
  }
  // No handler - this service uses agent mode for full LLM capabilities
};

export default codeReviewService;