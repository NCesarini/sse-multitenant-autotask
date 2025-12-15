/**
 * Type declarations for @apigrate/autotask-restapi
 * 
 * This library doesn't ship with TypeScript definitions,
 * so we provide minimal types here for compilation.
 */

declare module '@apigrate/autotask-restapi' {
  export class AutotaskRestApi {
    constructor(username: string, secret: string, integrationCode: string);
    
    // Dynamic entity accessors (e.g., client.Companies, client.Tickets, etc.)
    [entityName: string]: any;
  }
  
  export default AutotaskRestApi;
}

