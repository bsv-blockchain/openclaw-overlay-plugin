/**
 * Overlay service commands: services, advertise, remove, readvertise.
 */
/**
 * Services command: list currently advertised services.
 */
export declare function cmdServices(): Promise<never>;
/**
 * Advertise command: add a new service advertisement.
 */
export declare function cmdAdvertise(serviceId: string | undefined, name: string | undefined, priceSatsStr: string | undefined, description?: string): Promise<never>;
/**
 * Remove command: remove a service from local registry.
 */
export declare function cmdRemove(serviceId: string | undefined): Promise<never>;
/**
 * Readvertise command: update an existing service advertisement.
 */
export declare function cmdReadvertise(serviceId: string | undefined, name?: string, priceSatsStr?: string, description?: string): Promise<never>;
