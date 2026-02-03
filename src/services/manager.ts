/**
 * Service manager implementation.
 *
 * This orchestrates the service system, providing a high-level interface
 * for service execution while keeping payment and relay logic separate.
 */

import { ServiceManager, ServiceDefinition, ServiceContext, ServiceResult, ValidationResult } from './types.js';
import { serviceRegistry, DefaultServiceRegistry } from './registry.js';
import { serviceLoader, DefaultServiceLoader } from './loader.js';

/**
 * Default service manager implementation.
 */
export class DefaultServiceManager implements ServiceManager {
  public readonly registry: DefaultServiceRegistry;
  public readonly loader: DefaultServiceLoader;
  private initialized = false;

  constructor() {
    this.registry = serviceRegistry;
    this.loader = serviceLoader;
  }

  /**
   * Initialize the service system.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Load all services
    const services = await this.loader.loadAllServices();

    // Register all services
    for (const service of services) {
      try {
        this.registry.register(service);
      } catch (error) {
        console.warn(`Failed to register service '${service.id}':`, error);
      }
    }

    this.initialized = true;

    console.log(`Service manager initialized with ${this.registry.count()} services`);
  }

  /**
   * Execute a service request.
   */
  async execute(serviceId: string, input: any, context: ServiceContext): Promise<ServiceResult> {
    if (!this.initialized) {
      throw new Error('Service manager not initialized');
    }

    const service = this.registry.get(serviceId);
    if (!service) {
      return {
        success: false,
        error: `Service '${serviceId}' not found`
      };
    }

    // Validate input if service has a handler
    if (service.handler) {
      const validation = service.handler.validate(input);
      if (!validation.valid) {
        return {
          success: false,
          error: `Input validation failed: ${validation.error}`
        };
      }

      // Use sanitized input if provided
      input = validation.sanitized || input;
    }

    // Execute the service
    try {
      if (service.handler) {
        // Use custom handler
        return await service.handler.process(input, context);
      } else {
        // Service uses agent mode - return success with input for agent processing
        return {
          success: true,
          data: {
            serviceId,
            input,
            mode: 'agent',
            promptFile: service.promptFile
          },
          metadata: {
            version: '1.0',
            executionMode: 'agent'
          }
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          serviceId,
          errorType: 'execution_error'
        }
      };
    }
  }

  /**
   * Validate service input.
   */
  validate(serviceId: string, input: any): ValidationResult {
    const service = this.registry.get(serviceId);
    if (!service) {
      return {
        valid: false,
        error: `Service '${serviceId}' not found`
      };
    }

    // Use service handler validation if available
    if (service.handler) {
      return service.handler.validate(input);
    }

    // Default validation for agent-mode services
    if (service.inputSchema) {
      return this.validateAgainstSchema(input, service.inputSchema);
    }

    // No validation required
    return { valid: true };
  }

  /**
   * Reload all services.
   */
  async reload(): Promise<void> {
    // Clear existing services
    this.registry.clear();
    this.initialized = false;

    // Reinitialize
    await this.initialize();
  }

  /**
   * Get service for agent-mode processing.
   */
  getServiceForAgentMode(serviceId: string): {
    service: ServiceDefinition;
    promptFile?: string;
  } | null {
    const service = this.registry.get(serviceId);
    if (!service) {
      return null;
    }

    return {
      service,
      promptFile: service.promptFile
    };
  }

  /**
   * Check if service is available.
   */
  isServiceAvailable(serviceId: string): boolean {
    return this.registry.has(serviceId);
  }

  /**
   * Get service execution mode.
   */
  getServiceMode(serviceId: string): 'handler' | 'agent' | null {
    const service = this.registry.get(serviceId);
    if (!service) {
      return null;
    }

    return service.handler ? 'handler' : 'agent';
  }

  /**
   * Get all available services for discovery.
   */
  getAvailableServices(): Array<{
    id: string;
    name: string;
    description: string;
    defaultPrice: number;
    category?: string;
    mode: 'handler' | 'agent';
  }> {
    return this.registry.list().map(service => ({
      id: service.id,
      name: service.name,
      description: service.description,
      defaultPrice: service.defaultPrice,
      category: service.category,
      mode: service.handler ? 'handler' : 'agent'
    }));
  }

  /**
   * Validate input against JSON schema.
   */
  private validateAgainstSchema(input: any, schema: object): ValidationResult {
    // Simple schema validation - in production, you might use a library like ajv
    try {
      const schemaObj = schema as any;

      if (schemaObj.type === 'object') {
        if (!input || typeof input !== 'object') {
          return { valid: false, error: 'Input must be an object' };
        }

        // Check required properties
        if (schemaObj.required && Array.isArray(schemaObj.required)) {
          for (const requiredProp of schemaObj.required) {
            if (!(requiredProp in input)) {
              return { valid: false, error: `Missing required property: ${requiredProp}` };
            }
          }
        }

        // Basic type checking for properties
        if (schemaObj.properties) {
          for (const [propName, propSchema] of Object.entries(schemaObj.properties)) {
            if (propName in input) {
              const propType = (propSchema as any).type;
              const actualType = typeof input[propName];

              if (propType && propType !== actualType) {
                return { valid: false, error: `Property '${propName}' must be of type ${propType}` };
              }
            }
          }
        }
      }

      return { valid: true, sanitized: input };
    } catch (error) {
      return { valid: false, error: `Schema validation error: ${error}` };
    }
  }

  /**
   * Get service statistics.
   */
  getStatistics(): {
    totalServices: number;
    handlerServices: number;
    agentServices: number;
    servicesByCategory: Record<string, number>;
  } {
    const services = this.registry.list();
    const stats = {
      totalServices: services.length,
      handlerServices: 0,
      agentServices: 0,
      servicesByCategory: {} as Record<string, number>
    };

    for (const service of services) {
      // Count by execution mode
      if (service.handler) {
        stats.handlerServices++;
      } else {
        stats.agentServices++;
      }

      // Count by category
      const category = service.category || 'uncategorized';
      stats.servicesByCategory[category] = (stats.servicesByCategory[category] || 0) + 1;
    }

    return stats;
  }
}

/**
 * Global service manager instance.
 */
export const serviceManager = new DefaultServiceManager();

/**
 * Initialize the service system.
 * This should be called once during application startup.
 */
export async function initializeServiceSystem(): Promise<void> {
  await serviceManager.initialize();
}

/**
 * Get service manager instance.
 */
export function getServiceManager(): DefaultServiceManager {
  return serviceManager;
}