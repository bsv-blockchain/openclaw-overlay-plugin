/**
 * Service loader implementation.
 *
 * This dynamically loads services from directories, supporting both
 * built-in services and custom user services.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceDefinition, ServiceLoader } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Default service loader implementation.
 */
export class DefaultServiceLoader implements ServiceLoader {
  private builtInDir: string;
  private customDir: string;

  constructor() {
    // Built-in services directory
    this.builtInDir = path.resolve(__dirname, 'built-in');

    // Custom services directory (in user's config dir)
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.customDir = path.join(homeDir, '.openclaw', 'services');
  }

  /**
   * Load services from a directory.
   */
  async loadFromDirectory(directory: string): Promise<ServiceDefinition[]> {
    if (!fs.existsSync(directory)) {
      return [];
    }

    const services: ServiceDefinition[] = [];
    const entries = fs.readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        const serviceDefinition = await this.loadServiceFromDirectory(
          path.join(directory, entry.name)
        );
        if (serviceDefinition) {
          services.push(serviceDefinition);
        }
      } catch (error) {
        console.warn(`Failed to load service from ${entry.name}:`, error);
      }
    }

    return services;
  }

  /**
   * Load all built-in services.
   */
  async loadBuiltInServices(): Promise<ServiceDefinition[]> {
    return this.loadFromDirectory(this.builtInDir);
  }

  /**
   * Load custom user services.
   */
  async loadCustomServices(): Promise<ServiceDefinition[]> {
    return this.loadFromDirectory(this.customDir);
  }

  /**
   * Load all services (built-in + custom).
   */
  async loadAllServices(): Promise<ServiceDefinition[]> {
    const [builtIn, custom] = await Promise.all([
      this.loadBuiltInServices(),
      this.loadCustomServices()
    ]);

    return [...builtIn, ...custom];
  }

  /**
   * Load a service definition from a directory.
   */
  private async loadServiceFromDirectory(serviceDir: string): Promise<ServiceDefinition | null> {
    const indexPath = path.join(serviceDir, 'index.ts');
    const jsIndexPath = path.join(serviceDir, 'index.js');
    const promptPath = path.join(serviceDir, 'prompt.md');

    // Check if index file exists (TypeScript or JavaScript)
    let modulePath: string;
    if (fs.existsSync(indexPath)) {
      modulePath = indexPath;
    } else if (fs.existsSync(jsIndexPath)) {
      modulePath = jsIndexPath;
    } else {
      throw new Error(`No index.ts or index.js found in ${serviceDir}`);
    }

    try {
      // Dynamic import the service module
      const serviceModule = await import(modulePath);
      const serviceDefinition = serviceModule.default || serviceModule;

      if (!serviceDefinition || typeof serviceDefinition !== 'object') {
        throw new Error('Service must export a default ServiceDefinition object');
      }

      // Validate required fields
      if (!serviceDefinition.id) {
        throw new Error('Service definition must have an id');
      }

      // Add prompt file path if it exists
      if (fs.existsSync(promptPath)) {
        serviceDefinition.promptFile = promptPath;
      }

      return serviceDefinition as ServiceDefinition;
    } catch (error) {
      throw new Error(`Failed to import service from ${modulePath}: ${error}`);
    }
  }

  /**
   * Create a new custom service directory.
   */
  createCustomServiceDirectory(serviceId: string): string {
    const serviceDir = path.join(this.customDir, serviceId);

    // Ensure custom services directory exists
    fs.mkdirSync(this.customDir, { recursive: true });

    // Create service directory
    if (fs.existsSync(serviceDir)) {
      throw new Error(`Service directory ${serviceId} already exists`);
    }

    fs.mkdirSync(serviceDir);
    return serviceDir;
  }

  /**
   * Create a basic service template.
   */
  createServiceTemplate(serviceId: string, options: {
    name: string;
    description: string;
    defaultPrice: number;
    category?: string;
    hasHandler?: boolean;
  }): void {
    const serviceDir = this.createCustomServiceDirectory(serviceId);

    // Create index.ts
    const indexContent = this.generateServiceTemplate(serviceId, options);
    fs.writeFileSync(path.join(serviceDir, 'index.ts'), indexContent);

    // Create prompt.md
    const promptContent = this.generatePromptTemplate(serviceId, options);
    fs.writeFileSync(path.join(serviceDir, 'prompt.md'), promptContent);

    // Create handler.ts if requested
    if (options.hasHandler) {
      const handlerContent = this.generateHandlerTemplate(serviceId, options);
      fs.writeFileSync(path.join(serviceDir, 'handler.ts'), handlerContent);
    }
  }

  /**
   * Generate service definition template.
   */
  private generateServiceTemplate(serviceId: string, options: {
    name: string;
    description: string;
    defaultPrice: number;
    category?: string;
    hasHandler?: boolean;
  }): string {
    return `/**
 * ${options.name} service definition.
 */

import { ServiceDefinition${options.hasHandler ? ', ServiceHandler' : ''} } from '../../types.js';
${options.hasHandler ? `import { ${serviceId.replace(/-/g, '')}Handler } from './handler.js';` : ''}

const ${serviceId.replace(/-/g, '')}Service: ServiceDefinition = {
  id: '${serviceId}',
  name: '${options.name}',
  description: '${options.description}',
  defaultPrice: ${options.defaultPrice},${options.category ? `\n  category: '${options.category}',` : ''}
  inputSchema: {
    type: 'object',
    properties: {
      // Define your input schema here
      query: {
        type: 'string',
        description: 'Query or input for the service'
      }
    },
    required: ['query']
  }${options.hasHandler ? `,\n  handler: ${serviceId.replace(/-/g, '')}Handler` : ''}
};

export default ${serviceId.replace(/-/g, '')}Service;
`;
  }

  /**
   * Generate prompt template.
   */
  private generatePromptTemplate(serviceId: string, options: {
    name: string;
    description: string;
  }): string {
    return `# ${options.name} Service

You are processing a request for the "${serviceId}" service.

## Service Description
${options.description}

## Input
The user has provided the following input:
\`\`\`json
{{input}}
\`\`\`

## Instructions
Process the user's request and provide a helpful response based on the service description.
Format your response as a structured result that can be easily parsed and used.

## Response Format
Provide your response in this format:
\`\`\`json
{
  "result": "your processed result here",
  "metadata": {
    "processingTime": "time taken",
    "version": "1.0"
  }
}
\`\`\`
`;
  }

  /**
   * Generate handler template.
   */
  private generateHandlerTemplate(serviceId: string, options: {
    name: string;
  }): string {
    return `/**
 * ${options.name} service handler.
 */

import { ServiceHandler, ValidationResult, ServiceContext, ServiceResult } from '../../types.js';

export const ${serviceId.replace(/-/g, '')}Handler: ServiceHandler = {
  /**
   * Validate service input.
   */
  validate(input: any): ValidationResult {
    if (!input || typeof input !== 'object') {
      return { valid: false, error: 'Input must be an object' };
    }

    if (!input.query || typeof input.query !== 'string') {
      return { valid: false, error: 'Query must be a non-empty string' };
    }

    // Add more validation as needed
    return { valid: true, sanitized: input };
  },

  /**
   * Process the service request.
   */
  async process(input: any, context: ServiceContext): Promise<ServiceResult> {
    try {
      const startTime = Date.now();

      // Your service logic here
      const result = {
        query: input.query,
        response: 'This is a template response. Implement your logic here.',
        timestamp: new Date().toISOString()
      };

      const processingTime = Date.now() - startTime;

      return {
        success: true,
        data: result,
        metadata: {
          processingTime,
          version: '1.0'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
};
`;
  }

  /**
   * Get the built-in services directory.
   */
  getBuiltInDirectory(): string {
    return this.builtInDir;
  }

  /**
   * Get the custom services directory.
   */
  getCustomDirectory(): string {
    return this.customDir;
  }

  /**
   * Check if a service directory exists.
   */
  serviceExists(serviceId: string, inCustom = false): boolean {
    const baseDir = inCustom ? this.customDir : this.builtInDir;
    return fs.existsSync(path.join(baseDir, serviceId));
  }
}

/**
 * Global service loader instance.
 */
export const serviceLoader = new DefaultServiceLoader();