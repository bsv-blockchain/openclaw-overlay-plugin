/**
 * Service architecture type definitions.
 *
 * This module defines the core interfaces for the pluggable service system.
 * Services can be added without modifying core payment or relay logic.
 */

export interface ServiceDefinition {
  /** Unique service identifier (kebab-case) */
  id: string;
  /** Human-readable service name */
  name: string;
  /** Service description for discovery */
  description: string;
  /** Default price in satoshis */
  defaultPrice: number;
  /** Optional JSON schema for input validation */
  inputSchema?: object;
  /** Optional legacy handler for non-agent mode */
  handler?: ServiceHandler;
  /** Optional path to agent mode prompt file */
  promptFile?: string;
  /** Service category for organization */
  category?: string;
  /** Whether this service requires special permissions */
  requiresVerification?: boolean;
}

export interface ServiceHandler {
  /**
   * Validate incoming service input.
   * @param input - Raw input from service request
   * @returns Validation result
   */
  validate(input: any): ValidationResult;

  /**
   * Process the service request.
   * Payment has already been verified at this point.
   * @param input - Validated input data
   * @param context - Service execution context
   * @returns Service processing result
   */
  process(input: any, context: ServiceContext): Promise<ServiceResult>;
}

export interface ValidationResult {
  /** Whether input is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** Sanitized/normalized input if valid */
  sanitized?: any;
}

export interface ServiceContext {
  /** Unique request identifier */
  requestId: string;
  /** Sender's identity key */
  from: string;
  /** Service being requested */
  serviceId: string;
  /** Payment information (already verified) */
  payment: PaymentInfo;
  /** Request timestamp */
  timestamp: number;
}

export interface PaymentInfo {
  /** Transaction ID */
  txid: string;
  /** Amount paid in satoshis */
  satoshis: number;
  /** Whether payment was accepted by wallet */
  accepted: boolean;
  /** Payment verification details */
  verification?: {
    /** BEEF transaction data */
    beef: string;
    /** Derivation prefix for BRC-29 */
    derivationPrefix?: string;
    /** Derivation suffix for BRC-29 */
    derivationSuffix?: string;
  };
}

export interface ServiceResult {
  /** Whether service execution was successful */
  success: boolean;
  /** Service output data */
  data?: any;
  /** Error message if unsuccessful */
  error?: string;
  /** Additional metadata */
  metadata?: {
    /** Processing time in milliseconds */
    processingTime?: number;
    /** Service version */
    version?: string;
    /** Additional context */
    [key: string]: any;
  };
}

export interface ServiceRegistry {
  /**
   * Register a new service definition.
   * @param service - Service to register
   */
  register(service: ServiceDefinition): void;

  /**
   * Get a service definition by ID.
   * @param serviceId - Service identifier
   * @returns Service definition or undefined
   */
  get(serviceId: string): ServiceDefinition | undefined;

  /**
   * List all registered services.
   * @returns Array of all service definitions
   */
  list(): ServiceDefinition[];

  /**
   * List services by category.
   * @param category - Service category
   * @returns Array of services in category
   */
  listByCategory(category: string): ServiceDefinition[];

  /**
   * Check if a service is registered.
   * @param serviceId - Service identifier
   * @returns Whether service exists
   */
  has(serviceId: string): boolean;

  /**
   * Unregister a service.
   * @param serviceId - Service identifier
   */
  unregister(serviceId: string): void;
}

export interface ServiceLoader {
  /**
   * Load services from a directory.
   * @param directory - Directory path to scan
   * @returns Array of loaded service definitions
   */
  loadFromDirectory(directory: string): Promise<ServiceDefinition[]>;

  /**
   * Load all built-in services.
   * @returns Array of built-in service definitions
   */
  loadBuiltInServices(): Promise<ServiceDefinition[]>;

  /**
   * Load custom user services.
   * @returns Array of custom service definitions
   */
  loadCustomServices(): Promise<ServiceDefinition[]>;
}

/**
 * Service execution context for handlers.
 * This provides access to validated input and request context
 * without exposing payment verification or relay logic.
 */
export interface ServiceExecutionContext {
  /** Service definition being executed */
  service: ServiceDefinition;
  /** Validated input data */
  input: any;
  /** Request context */
  context: ServiceContext;
}

/**
 * Service plugin interface for advanced services.
 * This allows services to define additional hooks and lifecycle methods.
 */
export interface ServicePlugin {
  /** Service definition */
  definition: ServiceDefinition;

  /** Optional initialization hook */
  initialize?(): Promise<void>;

  /** Optional cleanup hook */
  cleanup?(): Promise<void>;

  /** Optional health check */
  healthCheck?(): Promise<boolean>;
}

/**
 * Service manager interface for orchestrating service lifecycle.
 */
export interface ServiceManager {
  /** Service registry */
  registry: ServiceRegistry;

  /** Service loader */
  loader: ServiceLoader;

  /**
   * Initialize the service system.
   */
  initialize(): Promise<void>;

  /**
   * Execute a service request.
   * @param serviceId - Service to execute
   * @param input - Service input
   * @param context - Execution context
   * @returns Service result
   */
  execute(serviceId: string, input: any, context: ServiceContext): Promise<ServiceResult>;

  /**
   * Validate service input.
   * @param serviceId - Service to validate for
   * @param input - Input to validate
   * @returns Validation result
   */
  validate(serviceId: string, input: any): ValidationResult;

  /**
   * Reload all services.
   */
  reload(): Promise<void>;
}

/**
 * Common service categories for organization.
 */
export enum ServiceCategory {
  UTILITY = 'utility',
  AI = 'ai',
  BLOCKCHAIN = 'blockchain',
  COMMUNICATION = 'communication',
  DEVELOPMENT = 'development',
  RESEARCH = 'research',
  ENTERTAINMENT = 'entertainment',
  CUSTOM = 'custom'
}

/**
 * Service status for monitoring and management.
 */
export enum ServiceStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
  LOADING = 'loading'
}