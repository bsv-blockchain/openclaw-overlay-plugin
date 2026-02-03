/**
 * Service registry implementation.
 *
 * This provides a centralized registry for all services, allowing
 * dynamic registration and discovery without modifying core code.
 */

import { ServiceDefinition, ServiceRegistry, ServiceCategory } from './types.js';

/**
 * Default service registry implementation.
 */
export class DefaultServiceRegistry implements ServiceRegistry {
  private services = new Map<string, ServiceDefinition>();

  /**
   * Register a new service definition.
   */
  register(service: ServiceDefinition): void {
    // Validate service definition
    this.validateServiceDefinition(service);

    // Check for duplicates
    if (this.services.has(service.id)) {
      throw new Error(`Service '${service.id}' is already registered`);
    }

    // Register the service
    this.services.set(service.id, { ...service });
  }

  /**
   * Get a service definition by ID.
   */
  get(serviceId: string): ServiceDefinition | undefined {
    return this.services.get(serviceId);
  }

  /**
   * List all registered services.
   */
  list(): ServiceDefinition[] {
    return Array.from(this.services.values());
  }

  /**
   * List services by category.
   */
  listByCategory(category: string): ServiceDefinition[] {
    return this.list().filter(service => service.category === category);
  }

  /**
   * Check if a service is registered.
   */
  has(serviceId: string): boolean {
    return this.services.has(serviceId);
  }

  /**
   * Unregister a service.
   */
  unregister(serviceId: string): void {
    this.services.delete(serviceId);
  }

  /**
   * Clear all services (useful for testing).
   */
  clear(): void {
    this.services.clear();
  }

  /**
   * Get service count.
   */
  count(): number {
    return this.services.size;
  }

  /**
   * Get services by price range.
   */
  getByPriceRange(minPrice: number, maxPrice: number): ServiceDefinition[] {
    return this.list().filter(
      service => service.defaultPrice >= minPrice && service.defaultPrice <= maxPrice
    );
  }

  /**
   * Search services by name or description.
   */
  search(query: string): ServiceDefinition[] {
    const lowerQuery = query.toLowerCase();
    return this.list().filter(service =>
      service.name.toLowerCase().includes(lowerQuery) ||
      service.description.toLowerCase().includes(lowerQuery) ||
      service.id.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Validate a service definition.
   */
  private validateServiceDefinition(service: ServiceDefinition): void {
    if (!service.id) {
      throw new Error('Service ID is required');
    }

    if (typeof service.id !== 'string' || service.id.trim().length === 0) {
      throw new Error('Service ID must be a non-empty string');
    }

    // Validate ID format (kebab-case)
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(service.id)) {
      throw new Error('Service ID must be in kebab-case format (lowercase, hyphens only)');
    }

    if (!service.name || typeof service.name !== 'string' || service.name.trim().length === 0) {
      throw new Error('Service name is required and must be a non-empty string');
    }

    if (!service.description || typeof service.description !== 'string' || service.description.trim().length === 0) {
      throw new Error('Service description is required and must be a non-empty string');
    }

    if (typeof service.defaultPrice !== 'number' || service.defaultPrice < 0 || !Number.isInteger(service.defaultPrice)) {
      throw new Error('Service defaultPrice must be a non-negative integer');
    }

    if (service.category && !Object.values(ServiceCategory).includes(service.category as ServiceCategory)) {
      throw new Error(`Invalid service category: ${service.category}`);
    }

    // Validate input schema if provided
    if (service.inputSchema && typeof service.inputSchema !== 'object') {
      throw new Error('Service inputSchema must be an object');
    }

    // Validate handler if provided
    if (service.handler) {
      if (typeof service.handler.validate !== 'function') {
        throw new Error('Service handler must have a validate function');
      }
      if (typeof service.handler.process !== 'function') {
        throw new Error('Service handler must have a process function');
      }
    }
  }
}

/**
 * Global service registry instance.
 */
export const serviceRegistry = new DefaultServiceRegistry();

/**
 * Utility functions for working with the service registry.
 */
export const ServiceRegistryUtils = {
  /**
   * Register multiple services at once.
   */
  registerMultiple(services: ServiceDefinition[]): void {
    for (const service of services) {
      serviceRegistry.register(service);
    }
  },

  /**
   * Get services that support a specific input type.
   */
  getServicesForInput(inputType: string): ServiceDefinition[] {
    return serviceRegistry.list().filter(service => {
      if (!service.inputSchema) return false;
      const schema = service.inputSchema as any;
      return schema.properties && schema.properties[inputType];
    });
  },

  /**
   * Validate service exists and return it.
   */
  requireService(serviceId: string): ServiceDefinition {
    const service = serviceRegistry.get(serviceId);
    if (!service) {
      throw new Error(`Service '${serviceId}' not found`);
    }
    return service;
  },

  /**
   * Get all service IDs.
   */
  getAllServiceIds(): string[] {
    return serviceRegistry.list().map(service => service.id);
  },

  /**
   * Check if any services are registered.
   */
  hasAnyServices(): boolean {
    return serviceRegistry.count() > 0;
  },

  /**
   * Get service statistics.
   */
  getStatistics(): {
    totalServices: number;
    servicesByCategory: Record<string, number>;
    priceRange: { min: number; max: number };
    servicesWithHandlers: number;
  } {
    const services = serviceRegistry.list();
    const servicesByCategory: Record<string, number> = {};
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let servicesWithHandlers = 0;

    for (const service of services) {
      // Count by category
      const category = service.category || 'uncategorized';
      servicesByCategory[category] = (servicesByCategory[category] || 0) + 1;

      // Track price range
      minPrice = Math.min(minPrice, service.defaultPrice);
      maxPrice = Math.max(maxPrice, service.defaultPrice);

      // Count services with handlers
      if (service.handler) {
        servicesWithHandlers++;
      }
    }

    return {
      totalServices: services.length,
      servicesByCategory,
      priceRange: {
        min: minPrice === Infinity ? 0 : minPrice,
        max: maxPrice === -Infinity ? 0 : maxPrice
      },
      servicesWithHandlers
    };
  }
};