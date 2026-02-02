/**
 * Service response commands.
 */
/**
 * Respond to a service request.
 */
export declare function cmdRespondService(requestId: string | undefined, recipientKey: string | undefined, serviceId: string | undefined, resultJson: string | undefined): Promise<never>;
/**
 * Respond to a research request with results.
 */
export declare function cmdResearchRespond(resultJsonPath: string | undefined): Promise<never>;
