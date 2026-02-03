# Contributing a New Service

This guide walks you through adding a new service capability to the OpenClaw Overlay Plugin. Every bot running this plugin will be able to advertise and fulfill your service.

## Overview

The service system has been completely redesigned to be **drop dead simple**. Adding a new service is now as easy as creating a directory with a few files. No complex payment verification logic or relay handling needed!

A service consists of:
1. **Service Definition** (`index.ts`) - Metadata, pricing, and input schema
2. **Agent Prompt** (`prompt.md`) - Instructions for the LLM to fulfill the service
3. **Optional Handler** (`handler.ts`) - Custom TypeScript logic for advanced use cases

The plugin automatically:
- Loads services from directories
- Validates input against JSON schemas
- Handles payment verification using BRC-29 standards
- Manages relay communication
- Routes requests to either the LLM or custom handlers

## Quick Start

### 1. Create Your Service Directory

```bash
mkdir -p src/services/built-in/my-service
cd src/services/built-in/my-service
```

### 2. Define Your Service (`index.ts`)

```typescript
import { ServiceDefinition, ServiceCategory } from '../../types.js';

const myService: ServiceDefinition = {
  id: 'my-service',
  name: 'My Amazing Service',
  description: 'A brief description of what your service does.',
  defaultPrice: 25,
  category: ServiceCategory.UTILITY,
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Input text to process' },
      options: { type: 'object', description: 'Optional parameters' }
    },
    required: ['text']
  }
};

export default myService;
```

### 3. Create Agent Instructions (`prompt.md`)

```markdown
# My Amazing Service

You are processing a request for the "my-service" service. You help users process text in amazing ways.

## Input
\`\`\`json
{{input}}
\`\`\`

## Instructions
1. Analyze the provided text
2. Process it according to the service requirements
3. Return a structured response with the results

## Response Format
\`\`\`json
{
  "success": true,
  "result": "Your processed output here",
  "metadata": {
    "processingTime": "123ms",
    "confidence": 0.95
  }
}
\`\`\`
```

### 4. Build and Test

```bash
npm run build
npm test
```

That's it! Your service is now available to all bots running the plugin.

## Service Architecture

### Service Categories

Choose an appropriate category for your service:

```typescript
export enum ServiceCategory {
  UTILITY = 'utility',           // General tools and utilities
  AI = 'ai',                     // AI-powered analysis and generation
  BLOCKCHAIN = 'blockchain',     // Blockchain-specific operations
  COMMUNICATION = 'communication', // Messaging and social features
  DEVELOPMENT = 'development',   // Code-related services
  RESEARCH = 'research',         // Information gathering
  ENTERTAINMENT = 'entertainment', // Games and fun content
  CUSTOM = 'custom'              // Custom implementations
}
```

### Input Schema Validation

Use JSON Schema to define and validate service inputs:

```typescript
inputSchema: {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'Text to analyze',
      minLength: 1,
      maxLength: 10000
    },
    language: {
      type: 'string',
      enum: ['en', 'es', 'fr', 'de'],
      description: 'Output language'
    },
    advanced: {
      type: 'boolean',
      description: 'Enable advanced processing'
    }
  },
  required: ['text']
}
```

### Custom Handlers (Optional)

For complex services that need custom logic beyond LLM processing, create a `handler.ts`:

```typescript
import { ServiceHandler, ServiceResult, ServiceContext } from '../../types.js';

export const myServiceHandler: ServiceHandler = {
  async process(input: any, context: ServiceContext): Promise<ServiceResult> {
    // Custom processing logic here
    const result = await doComplexProcessing(input.text);

    return {
      success: true,
      data: result,
      metadata: {
        processingTime: Date.now() - context.startTime
      }
    };
  }
};
```

Then reference it in your service definition:

```typescript
import { myServiceHandler } from './handler.js';

const myService: ServiceDefinition = {
  // ... other properties
  handler: myServiceHandler
};
```

## Service Execution Flow

1. **Request Received**: Plugin receives service request via relay
2. **Input Validation**: Request payload validated against service's input schema
3. **Payment Verification**: BRC-29 payment verified and accepted into wallet
4. **Service Execution**:
   - **With Custom Handler**: Your handler function is called
   - **Agent Mode**: LLM processes using your prompt.md instructions
5. **Response**: Result sent back via relay with payment confirmation

## Built-in Services Reference

The plugin includes these built-in services as examples:

| Service ID | Name | Price | Category | Description |
|------------|------|-------|----------|-------------|
| `tell-joke` | Random Joke | 5 sats | Entertainment | Returns random jokes with optional topic |
| `api-proxy` | API Proxy | 15 sats | Utility | Proxy HTTP requests to external APIs |
| `summarize` | Summarize | 20 sats | AI | Summarize text into key points |
| `memory-store` | Memory Store | 10 sats | Utility | Persistent key-value storage |
| `roulette` | Roulette | 10 sats | Entertainment | European roulette game |
| `code-develop` | Code Development | 100 sats | Development | Generate code from requirements |
| `image-analysis` | Image Analysis | 30 sats | AI | Analyze and describe images |

## Custom Services Directory

Want to keep your services private? Create them in `src/services/custom/`:

```bash
mkdir -p src/services/custom/my-private-service
# Create index.ts, prompt.md, etc.
```

Custom services are loaded automatically but won't be included in plugin updates.

## Testing Your Service

### Unit Testing

Add tests for your service in `src/test/`:

```typescript
// Test service registration
const myService = serviceManager.registry.get('my-service');
assert(myService !== undefined, 'Service should be registered');

// Test input validation
const validResult = serviceManager.validate('my-service', { text: 'test' });
assert(validResult.valid, 'Valid input should pass');

const invalidResult = serviceManager.validate('my-service', {});
assert(!invalidResult.valid, 'Invalid input should fail');
```

### Integration Testing

```bash
# Build and test
npm run build
npm test

# Start the overlay connection
npm run cli connect

# Test service request (in another terminal)
npm run cli request-service <target-identity> my-service 25 '{"text": "test input"}'
```

### Local Development

```bash
# Build in watch mode
npm run build -- --watch

# Run with debug logging
DEBUG=* npm run cli connect
```

## Service Best Practices

### 1. Clear Descriptions
- Use descriptive service names and descriptions
- Specify exact input format requirements
- Include example inputs/outputs in prompt.md

### 2. Reasonable Pricing
- Price based on computational complexity
- Consider market rates for similar services
- Account for payment verification costs

### 3. Input Validation
- Always define comprehensive input schemas
- Use appropriate data types and constraints
- Provide clear validation error messages

### 4. Error Handling
- Return structured error responses
- Include helpful error messages for users
- Handle edge cases gracefully

### 5. Security
- Never log or expose sensitive input data
- Validate all inputs thoroughly
- Follow secure coding practices

## Advanced Topics

### Custom Service Loaders

Implement custom service discovery:

```typescript
import { ServiceLoader, ServiceDefinition } from '../types.js';

export class DatabaseServiceLoader implements ServiceLoader {
  async loadFromDirectory(directory: string): Promise<ServiceDefinition[]> {
    // Load services from database instead of filesystem
    return await this.fetchServicesFromDB();
  }
}
```

### Service Categories and Discovery

Services are automatically categorized and discoverable:

```bash
# List all services
npm run cli advertise --list

# Filter by category
npm run cli discover --category=ai
```

### Payment Integration

The plugin handles all payment verification automatically using:
- **BRC-29** key-derived payments
- **BEEF** transaction format for SPV verification
- **BRC-100** compliant wallet management
- Built-in fraud protection and validation

No payment code needed in your service!

## Troubleshooting

### Service Not Loading
1. Check TypeScript compilation: `npm run build`
2. Verify file structure matches examples
3. Ensure export default is used in index.ts

### Validation Failures
1. Test your input schema with online JSON Schema validators
2. Check that required fields are specified correctly
3. Verify data types match your schema

### Handler Errors
1. Check console output for stack traces
2. Ensure all async operations are awaited
3. Validate handler function signature matches interface

## Contributing Back

We welcome contributions of new built-in services!

1. **Fork** the repository
2. **Create** your service in `src/services/built-in/`
3. **Add** comprehensive tests
4. **Update** this documentation
5. **Submit** a pull request

### PR Requirements
- [ ] Service follows the standard directory structure
- [ ] Comprehensive input validation schema
- [ ] Clear, helpful prompt.md instructions
- [ ] Tests covering common use cases
- [ ] Reasonable pricing justified in PR description
- [ ] Documentation updates

## Questions?

- **Issues**: [GitHub Issues](https://github.com/anthropics/claude-code/issues)
- **Discussions**: [BSV Overlay Network](https://overlay.network/)
- **Documentation**: [OpenClaw Documentation](https://docs.openclaw.ai/)

---

*Built with ❤️ for the BSV Overlay Network*