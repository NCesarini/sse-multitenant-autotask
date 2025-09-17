/**
 * Enhanced Autotask Tool Handler with ID-to-Name Mapping
 * Extends the base tool handler to include automatic mapping of company and resource IDs to names
 */

import { McpTool, McpToolResult } from '../types/mcp.js';
import { AutotaskService } from '../services/autotask.service.js';
import { Logger } from '../utils/logger.js';
import { MappingService } from '../utils/mapping.service.js';
import { AutotaskCredentials, TenantContext } from '../types/mcp.js'; 

export const LARGE_RESPONSE_THRESHOLDS = {
  tickets: 50,        
  companies: 100,     
  contacts: 100,     
  projects: 50,      
  resources: 50,     
  tasks: 50,          
  timeentries: 100,    
  default: 100,        
  responseSizeKB: 200  
};


export class EnhancedAutotaskToolHandler {
  private autotaskService: AutotaskService;
  private mappingService: MappingService | null = null;
  private logger: Logger;
 

  /**
   * Update the thresholds for large response guidance
   * @param thresholds Partial threshold configuration to override defaults
   * 
   * @example
   * // Increase ticket threshold to 150 and reduce response size threshold
   * EnhancedAutotaskToolHandler.updateLargeResponseThresholds({
   *   tickets: 150,
   *   responseSizeKB: 100
   * });
   * 
   * // Make all searches more sensitive (lower thresholds)
   * EnhancedAutotaskToolHandler.updateLargeResponseThresholds({
   *   tickets: 25,
   *   companies: 50,
   *   contacts: 50,
   *   projects: 25,
   *   resources: 50,
   *   tasks: 25,
   *   timeentries: 50,
   *   default: 25,
   *   responseSizeKB: 50
   * });
   */
  public static updateLargeResponseThresholds(thresholds: Partial<typeof LARGE_RESPONSE_THRESHOLDS>): void {
    Object.assign(LARGE_RESPONSE_THRESHOLDS, thresholds);
  }

  /**
   * Get current threshold configuration
   * @returns Current threshold settings for all search types
   */
  public static getLargeResponseThresholds(): typeof LARGE_RESPONSE_THRESHOLDS {
    return { ...LARGE_RESPONSE_THRESHOLDS };
  }

  // Common tenant schema for all tools
  private static readonly TENANT_SCHEMA = {
    type: 'object',
    description: 'Tenant authentication credentials (for multi-tenant mode)',
    properties: {
      tenantId: { type: 'string', description: 'Unique tenant identifier' },
      username: { type: 'string', description: 'Autotask API username' },
      secret: { type: 'string', description: 'Autotask API secret' },
      integrationCode: { type: 'string', description: 'Autotask integration code' },
      apiUrl: { type: 'string', description: 'Optional Autotask API URL' },
      sessionId: { type: 'string', description: 'Optional session identifier' },
      impersonationResourceId: { type: 'number', description: 'Optional resource ID to impersonate for this request' },
      mode: { type: 'string', enum: ['read', 'write'], description: 'Access mode: "read" for read-only operations, "write" for full access (default: write)' }
    },
    required: ['username', 'secret', 'integrationCode']
  } as const;

  /**
   * Create a tool definition with tenant support
   */
  private static createTool(
    name: string,
    description: string,
    operationType: 'read' | 'write' | 'modify',
    properties: Record<string, any>,
    required: string[] = []
  ): McpTool {
    return {
      name,
      description,
      operationType,
      inputSchema: {
        type: 'object',
        properties: {
          ...properties,
          _tenant: EnhancedAutotaskToolHandler.TENANT_SCHEMA
        },
        ...(required.length > 0 ? { required } : {})
      }
    };
  }

  constructor(autotaskService: AutotaskService, logger: Logger) {
    this.autotaskService = autotaskService;
    this.logger = logger;
  }

  /**
   * Common validation helper for ID parameters
   */
  private validateId(id: any, entityName: string): number {
    if (!id || typeof id !== 'number') {
      throw new Error(`${entityName} ID is required and must be a number`);
    }
    return id;
  }



  /**
   * Helper to create "not found" response
   */
  private createNotFoundResponse(entityName: string, id: number | string | Record<string, any>, parentInfo?: string): McpToolResult {
    let idText: string;
    let location = parentInfo ? ` ${parentInfo}` : '';
    
    if (typeof id === 'object') {
      // Handle object IDs like {ticketID: 123, noteId: 456}
      const keys = Object.keys(id);
      if (keys.length === 2) {
        const [parentKey, childKey] = keys;
        idText = `${childKey} ${id[childKey]}`;
        location = ` for ${parentKey} ${id[parentKey]}`;
      } else {
        idText = JSON.stringify(id);
      }
    } else {
      idText = String(id);
    }
    
    return {
      content: [{
        type: 'text',
        text: `${entityName} with ID ${idText} not found${location}`
      }],
      isError: false
    };
  }

  /**
   * Helper to create success response with JSON data
   */
  private createDataResponse(data: any): McpToolResult {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(data, null, 2)
      }],
      isError: false
    };
  }

  /**
   * Helper to create creation success response
   */
  private createCreationResponse(entityName: string, id: number | string, parentInfo?: string): McpToolResult {
    const location = parentInfo ? ` ${parentInfo}` : '';
    return {
      content: [{
        type: 'text',
        text: `${entityName} created successfully with ID: ${id}${location}`
      }],
      isError: false
    };
  }

  /**
   * Helper to create update success response
   */
  private createUpdateResponse(entityName: string, id: number | string, parentInfo?: string): McpToolResult {
    const location = parentInfo ? ` ${parentInfo}` : '';
    return {
      content: [{
        type: 'text',
        text: `${entityName} ${id} updated successfully${location}`
      }],
      isError: false
    };
  }

  /**
   * Helper to validate update data has at least one field
   */
  private validateUpdateData(updateData: Record<string, any>, entityName: string): void {
    if (Object.keys(updateData).length === 0) {
      throw new Error(`At least one field to update must be provided for ${entityName}`);
    }
  }

  /**
   * Generic entity getter method
   */
  private async getEntity<T>(
    id: number,
    entityName: string,
    getMethod: (id: number, tenantContext?: TenantContext) => Promise<T | null>,
    tenantContext?: TenantContext
  ): Promise<McpToolResult> {
    try {
      const validId = this.validateId(id, entityName);
      const entity = await getMethod(validId, tenantContext);
      
      if (!entity) {
        return this.createNotFoundResponse(entityName, validId);
      }

      return this.createDataResponse(entity);
    } catch (error) {
      throw new Error(`Failed to get ${entityName.toLowerCase()}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }



  /**
   * Generic update method
   */
  private async updateEntity(
    args: Record<string, any>,
    entityName: string,
    idField: string,
    updateMethod: (id: number, data: Record<string, any>, tenantContext?: TenantContext) => Promise<void>,
    tenantContext?: TenantContext
  ): Promise<McpToolResult> {
    try {
      const id = this.validateId(args[idField], entityName);
      const updateData = { ...args };
      delete updateData[idField]; // Remove ID from update data
      
      this.validateUpdateData(updateData, entityName);
      
      await updateMethod(id, updateData, tenantContext);
      
      return this.createUpdateResponse(entityName, id);
    } catch (error) {
      throw new Error(`Failed to update ${entityName.toLowerCase()}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }



  /**
   * Check if response is large and add helpful guidance
   */
  private addLargeResponseGuidance(content: any[], resultCount: number, searchType: string): any[] {
    const threshold = LARGE_RESPONSE_THRESHOLDS[
      searchType as keyof typeof LARGE_RESPONSE_THRESHOLDS
    ] || LARGE_RESPONSE_THRESHOLDS.default;
    
    // Calculate approximate response size
    const responseText = JSON.stringify(content);
    const responseSizeKB = Math.round(responseText.length / 1024);
    
    // If result count is high or response size is large, add guidance
    if (resultCount >= threshold || responseSizeKB > LARGE_RESPONSE_THRESHOLDS.responseSizeKB) {
      const guidanceMessage = this.generateSearchGuidance(searchType, resultCount, responseSizeKB);
      
      // Add guidance as a separate content item
      return [
        ...content,
        {
          type: 'text',
          text: `\n\n🔍 **Search Guidance**: ${guidanceMessage}`
        }
      ];
    }
    
    return content;
  }

  /**
   * Generate specific guidance based on search type and results
   */
  private generateSearchGuidance(searchType: string, resultCount: number, responseSizeKB: number): string {
    const suggestions: Record<string, string[]> = {
      tickets: [
        'Use `status` parameter to filter by ticket status (e.g., status: 1 for New, 5 for Complete)',
        'Add `companyID` to search tickets for a specific company',
        'Add `projectID` to search tickets for a specific project',
        'Add `contractID` to search tickets for a specific contract',
        'Use `assignedResourceID` to find tickets assigned to specific person',
        'Try `searchTerm` with specific keywords from ticket title or number',
        'Use `pageSize` parameter to limit results (e.g., pageSize: 25)'
      ],
      companies: [
        'Use `searchTerm` with company name or partial name',
        'Add specific filters in your search criteria',
        'Use `pageSize` parameter to limit results (e.g., pageSize: 50)'
      ],
      contacts: [
        'Use `searchTerm` with contact name or email',
        'Add `companyId` to search contacts for a specific company',
        'Use `pageSize` parameter to limit results (e.g., pageSize: 50)'
      ],
      projects: [
        'Use `searchTerm` with project name or description keywords',
        'Add `companyId` to search projects for a specific company',
        'Use `pageSize` parameter to limit results (e.g., pageSize: 50)'
      ],
      resources: [
        'Use `searchTerm` with employee name',
        'Add specific role or department filters',
        'Use `pageSize` parameter to limit results (e.g., pageSize: 50)'
      ],
      tasks: [
        'Use `projectId` to search tasks for a specific project',
        'Add `assignedResourceId` to find tasks assigned to specific person',
        'Use `status` parameter to filter by task status',
        'Try `searchTerm` with task title keywords',
        'Use `pageSize` parameter to limit results (e.g., pageSize: 25)'
      ],
      timeentries: [
        'Use `ticketID` to search time entries for a specific ticket',
        'Use `taskID` to search time entries for a specific task',
        'Add `projectId` to find time entries for a specific project',
        'Use `resourceId` to find time entries by a specific person',
        'Add date filters with `dateFrom` and `dateTo` (YYYY-MM-DD format)',
        'Use `pageSize` parameter to limit results (e.g., pageSize: 100)'
      ]
    };

    const defaultSuggestions = [
      'Use more specific search terms or filters',
      'Use `pageSize` parameter to limit results',
      'Add additional filter criteria to narrow down results'
    ];

    const typeSuggestions = suggestions[searchType] || defaultSuggestions;
    const selectedSuggestions = typeSuggestions.slice(0, 3); // Show max 3 suggestions

    return `Found ${resultCount} results (${responseSizeKB}KB). For more focused results, try:\n` +
           selectedSuggestions.map(s => `  • ${s}`).join('\n');
  }

  /**
   * Get mapping service instance (singleton)
   */
  private async getMappingService(): Promise<MappingService> {
    if (!this.mappingService) {
      this.mappingService = await MappingService.getInstance(this.autotaskService, this.logger);
    }
    return this.mappingService;
  }

  /**
   * Extract tenant context from tool arguments
   */
  private extractTenantContext(args: Record<string, any>): TenantContext | undefined {
    this.logger.info('🔍 Extracting tenant context from tool arguments', {
      hasArgs: !!args,
      argKeys: Object.keys(args || {}),
      has_tenant: !!(args && args._tenant),
      hasTenant: !!(args && args.tenant),
      hasCredentials: !!(args && args.credentials)
    });

    // Check if tenant credentials are provided in the arguments
    if (args._tenant || args.tenant || args.credentials) {
      const tenantData = args._tenant || args.tenant || args.credentials;
      
      this.logger.info('🏢 Found tenant data in arguments', {
        dataSource: args._tenant ? '_tenant' : args.tenant ? 'tenant' : 'credentials',
        hasUsername: !!tenantData.username,
        hasSecret: !!tenantData.secret,
        hasIntegrationCode: !!tenantData.integrationCode,
        hasApiUrl: !!tenantData.apiUrl,
        hasTenantId: !!tenantData.tenantId,
        hasSessionId: !!tenantData.sessionId,
        hasImpersonationResourceId: !!tenantData.impersonationResourceId,
        hasMode: !!tenantData.mode,
        tenantId: tenantData.tenantId,
        username: tenantData.username ? `${tenantData.username.substring(0, 3)}***` : undefined,
        apiUrl: tenantData.apiUrl,
        impersonationResourceId: tenantData.impersonationResourceId,
        mode: tenantData.mode
      });
      
      if (tenantData.username && tenantData.secret && tenantData.integrationCode) {
        const credentials: AutotaskCredentials = {
          username: tenantData.username,
          secret: tenantData.secret,
          integrationCode: tenantData.integrationCode,
          apiUrl: tenantData.apiUrl
        };

        const tenantContext: TenantContext = {
          tenantId: tenantData.tenantId || `tenant_${credentials.username}`,
          credentials,
          sessionId: tenantData.sessionId,
          impersonationResourceId: tenantData.impersonationResourceId,
          mode: tenantData.mode || 'write' // Default to write mode if not specified
        };

        this.logger.info('✅ Successfully extracted tenant context', {
          tenantId: tenantContext.tenantId,
          username: credentials.username ? `${credentials.username.substring(0, 3)}***` : undefined,
          hasApiUrl: !!credentials.apiUrl,
          sessionId: tenantContext.sessionId,
          impersonationResourceId: tenantContext.impersonationResourceId,
          mode: tenantContext.mode
        });

        // NOTE: We intentionally DO NOT delete tenant data from args
        // This preserves the original args for debugging and potential future use
        // The tenant fields are harmless to pass to individual tool methods
        this.logger.info('🔄 Keeping tenant data in arguments for debugging/tracing', {
          argKeys: Object.keys(args),
          preservedTenantField: args._tenant ? '_tenant' : args.tenant ? 'tenant' : 'credentials'
        });

        return tenantContext;
      } else {
        this.logger.warn('⚠️ Incomplete tenant credentials found', {
          hasUsername: !!tenantData.username,
          hasSecret: !!tenantData.secret,
          hasIntegrationCode: !!tenantData.integrationCode,
          missingFields: [
            !tenantData.username && 'username',
            !tenantData.secret && 'secret',
            !tenantData.integrationCode && 'integrationCode'
          ].filter(Boolean)
        });
      }
    } else {
      this.logger.info('🏠 No tenant credentials found - using single-tenant mode');
    }

    return undefined;
  }

  /**
   * Check if a tool operation is allowed based on tenant mode
   */
  private isOperationAllowed(toolName: string, tenantContext?: TenantContext): boolean {
    if (!tenantContext?.mode) {
      return true; // No mode restriction
    }
    
    if (tenantContext.mode === 'write') {
      return true; // Write mode allows all operations
    }
    
    if (tenantContext.mode === 'read') {
      // Read mode only allows read operations
      const toolOperationType = this.getToolOperationType(toolName);
      return toolOperationType === 'read';
    }
    
    return false;
  }

  /**
   * Get the operation type for a tool
   */
  private getToolOperationType(toolName: string): 'read' | 'write' | 'modify' {
    const readOnlyTools = [
      'search_companies', 'search_contacts', 'search_tickets', 'search_projects', 'search_resources',
      'get_company', 'get_contact', 'get_ticket', 'get_project', 'get_resource',
      'search_time_entries', 'get_time_entry', 'search_tasks', 'get_task',
      'search_ticket_notes', 'get_ticket_note', 'search_project_notes', 'get_project_note',
      'search_company_notes', 'get_company_note', 'search_ticket_attachments', 'get_ticket_attachment',
      'get_contract', 'search_contracts', 'get_invoice', 'search_invoices',
      'get_quote', 'search_quotes', 'get_expense_report', 'search_expense_reports',
      'search_expense_items', 'get_expense_item',
      'get_configuration_item', 'search_configuration_items',
      'get_company_name', 'get_resource_name', 'get_mapping_cache_stats',
      'test_connection', 'test_zone_information'
    ];
    
    const writeTools = [
      'create_company', 'create_contact', 'create_ticket', 'create_time_entry', 'create_task', 'create_project',
      'create_ticket_note', 'create_project_note', 'create_company_note',
      'create_quote', 'create_expense_report', 'create_expense_item', 'create_configuration_item'
    ];
    
    const modifyTools = [
      'update_company', 'update_contact', 'update_ticket', 'update_task', 'update_project',
      'update_expense_report', 'update_expense_item', 'update_configuration_item', 'clear_mapping_cache', 'preload_mapping_cache'
    ];
    
    if (readOnlyTools.includes(toolName)) {
      return 'read';
    } else if (writeTools.includes(toolName)) {
      return 'write';
    } else if (modifyTools.includes(toolName)) {
      return 'modify';
    }
    
    return 'read'; // Default to read for unknown tools
  }

  async listTools(tenantContext?: TenantContext): Promise<McpTool[]> {
    const allTools = [
      // Company tools
      EnhancedAutotaskToolHandler.createTool(
        'search_companies',
        'Search for companies in Autotask with filters and enhanced name resolution',
        'read',
        {
          searchTerm: {
            type: 'string',
            description: 'Search term to filter companies by name'
          },
          isActive: {
            type: 'boolean',
            description: 'Filter by active status'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return per page (default: 50, max: 2000). Use smaller values for faster responses.',
            minimum: 1,
            maximum: 2000,
            default: 50
          },
          page: {
            type: 'number',
            description: 'Page number to retrieve (1-based). Use this to get additional results beyond the first page.',
            minimum: 1,
            default: 1
          },
          getAllPages: {
            type: 'boolean',
            description: 'Set to true to get all available data across multiple pages (may be slow for large datasets)',
            default: false
          }
        }
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_company',
        'Create a new company in Autotask',
        'write',
        {
          companyName: {
            type: 'string',
            description: 'Company name'
          },
          companyType: {
            type: 'number',
            description: 'Company type ID'
          },
          phone: {
            type: 'string',
            description: 'Phone number'
          },
          fax: {
            type: 'string',
            description: 'Fax number'
          },
          address1: {
            type: 'string',
            description: 'Address line 1'
          },
          address2: {
            type: 'string',
            description: 'Address line 2'
          },
          city: {
            type: 'string',
            description: 'City'
          },
          state: {
            type: 'string',
            description: 'State/Province'
          },
          postalCode: {
            type: 'string',
            description: 'Postal/ZIP code'
          },
          country: {
            type: 'string',
            description: 'Country'
          },
          ownerResourceID: {
            type: 'number',
            description: 'Owner resource ID'
          }
        },
        ['companyName', 'companyType']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_company',
        'Update an existing company in Autotask',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Company ID to update'
          },
          companyName: {
            type: 'string',
            description: 'Company name'
          },
          phone: {
            type: 'string',
            description: 'Phone number'
          },
          fax: {
            type: 'string',
            description: 'Fax number'
          },
          address1: {
            type: 'string',
            description: 'Address line 1'
          },
          address2: {
            type: 'string',
            description: 'Address line 2'
          },
          city: {
            type: 'string',
            description: 'City'
          },
          state: {
            type: 'string',
            description: 'State/Province'
          },
          postalCode: {
            type: 'string',
            description: 'Postal/ZIP code'
          },
          country: {
            type: 'string',
            description: 'Country'
          },
          ownerResourceID: {
            type: 'number',
            description: 'Owner resource ID'
          }
        },
        ['id']
      ),

      // Contact tools
                  EnhancedAutotaskToolHandler.createTool(
              'search_contacts',
              'Search for contacts in Autotask with filters',
              'read',
              {
                searchTerm: {
                  type: 'string',
                  description: 'Search term to filter contacts by name or email'
                },
                companyId: {
                  type: 'number',
                  description: 'Filter by company ID'
                },
                isActive: {
                  type: 'boolean',
                  description: 'Filter by active status'
                },
                pageSize: {
                  type: 'number',
                  description: 'Number of results to return (default: 50, max: 2000)',
                  minimum: 1,
                  maximum: 2000,
                  default: 50
                }
              }
            ),
      EnhancedAutotaskToolHandler.createTool(
        'create_contact',
        'Create a new contact in Autotask',
        'write',
        {
          companyID: {
            type: 'number',
            description: 'Company ID for the contact'
          },
          firstName: {
            type: 'string',
            description: 'First name'
          },
          lastName: {
            type: 'string',
            description: 'Last name'
          },
          emailAddress: {
            type: 'string',
            description: 'Email address'
          },
          phone: {
            type: 'string',
            description: 'Phone number'
          },
          title: {
            type: 'string',
            description: 'Job title'
          }
        },
        ['companyID', 'firstName', 'lastName']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_contact',
        'Update an existing contact in Autotask',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Contact ID to update'
          },
          firstName: {
            type: 'string',
            description: 'First name'
          },
          lastName: {
            type: 'string',
            description: 'Last name'
          },
          emailAddress: {
            type: 'string',
            description: 'Email address'
          },
          phone: {
            type: 'string',
            description: 'Phone number'
          },
          title: {
            type: 'string',
            description: 'Job title'
          }
        },
        ['id']
      ),

      // Ticket tools
                  EnhancedAutotaskToolHandler.createTool(
              'search_tickets',
              'Search for tickets in Autotask with filters',
              'read',
              {
                searchTerm: {
                  type: 'string',
                  description: 'Search term to filter tickets by number or title'
                },
                status: {
                  type: 'number',
                  description: 'Filter by status ID'
                },
                companyID: {
                  type: 'number',
                  description: 'Filter by company ID'
                },
                projectID: {
                  type: 'number',
                  description: 'Filter by project ID'
                },
                contractID: {
                  type: 'number',
                  description: 'Filter by contract ID'
                },
                assignedResourceID: {
                  type: 'number',
                  description: 'Filter by assigned resource ID'
                },
                unassigned: {
                  type: 'boolean',
                  description: 'Filter for unassigned tickets'
                },
                pageSize: {
                  type: 'number',
                  description: 'Number of results to return (default: 50, max: 2000)',
                  minimum: 1,
                  maximum: 2000,
                  default: 50
                }
              }
            ),
      EnhancedAutotaskToolHandler.createTool(
        'create_ticket',
        'Create a new ticket in Autotask',
        'write',
        {
          companyID: {
            type: 'number',
            description: 'Company ID for the ticket'
          },
          title: {
            type: 'string',
            description: 'Ticket title'
          },
          description: {
            type: 'string',
            description: 'Ticket description'
          },
          priority: {
            type: 'number',
            description: 'Priority level'
          },
          status: {
            type: 'number',
            description: 'Status ID'
          },
          assignedResourceID: {
            type: 'number',
            description: 'Assigned resource ID'
          },
          contactID: {
            type: 'number',
            description: 'Contact ID'
          }
        },
        ['companyID', 'title']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_ticket',
        'Update an existing ticket in Autotask',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Ticket ID to update'
          },
          title: {
            type: 'string',
            description: 'Ticket title'
          },
          description: {
            type: 'string',
            description: 'Ticket description'
          },
          priority: {
            type: 'number',
            description: 'Priority level'
          },
          status: {
            type: 'number',
            description: 'Status ID'
          },
          assignedResourceID: {
            type: 'number',
            description: 'Assigned resource ID'
          },
          resolution: {
            type: 'string',
            description: 'Ticket resolution'
          }
        },
        ['id']
      ),

      // Time Entry tools
      EnhancedAutotaskToolHandler.createTool(
        'create_time_entry',
        'Log time against a ticket or project in Autotask',
        'write',
        {
          ticketID: {
            type: 'number',
            description: 'Ticket ID (if logging time against a ticket)'
          },
          projectID: {
            type: 'number',
            description: 'Project ID (if logging time against a project)'
          },
          resourceID: {
            type: 'number',
            description: 'Resource ID (person logging time)'
          },
          dateWorked: {
            type: 'string',
            description: 'Date worked (YYYY-MM-DD format)'
          },
          startDateTime: {
            type: 'string',
            description: 'Start date/time (ISO format)'
          },
          endDateTime: {
            type: 'string',
            description: 'End date/time (ISO format)'
          },
          hoursWorked: {
            type: 'number',
            description: 'Hours worked'
          },
          summaryNotes: {
            type: 'string',
            description: 'Summary of work performed'
          },
          internalNotes: {
            type: 'string',
            description: 'Internal notes'
          }
        },
        ['resourceID', 'dateWorked', 'hoursWorked']
      ),

      // Project tools
                  EnhancedAutotaskToolHandler.createTool(
              'search_projects',
              'Search for projects in Autotask',
              'read',
              {
                searchTerm: {
                  type: 'string',
                  description: 'Search term to filter projects by name'
                },
                companyId: {
                  type: 'number',
                  description: 'Filter by company ID'
                },
                status: {
                  type: 'number',
                  description: 'Filter by status'
                },
                pageSize: {
                  type: 'number',
                  description: 'Number of results to return (default: 50, max: 2000)',
                  minimum: 1,
                  maximum: 2000,
                  default: 50
                }
              }
            ),

      // Resource tools
                  EnhancedAutotaskToolHandler.createTool(
              'search_resources',
              'Search for resources (employees) in Autotask',
              'read',
              {
                firstName: {
                  type: 'string',
                  description: 'Filter by first name (partial match supported)'
                },
                lastName: {
                  type: 'string',
                  description: 'Filter by last name (partial match supported)'
                },
                email: {
                  type: 'string',
                  description: 'Filter by email address (partial match supported)'
                },
                searchTerm: {
                  type: 'string',
                  description: 'Fallback search term - searches firstName only (use specific field parameters for better control)'
                },
                isActive: {
                  type: 'boolean',
                  description: 'Filter by active status'
                },
                pageSize: {
                  type: 'number',
                  description: 'Number of results to return (default: 50, max: 2000)',
                  minimum: 1,
                  maximum: 2000,
                  default: 50
                }
              }
            ),

      // Individual Entity Getters
      EnhancedAutotaskToolHandler.createTool(
        'get_company',
        'Get a specific company by ID with full details',
        'read',
        {
          id: {
            type: 'number',
            description: 'Company ID to retrieve'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_contact',
        'Get a specific contact by ID with full details',
        'read',
        {
          id: {
            type: 'number',
            description: 'Contact ID to retrieve'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_ticket',
        'Get a specific ticket by ID with full details',
        'read',
        {
          id: {
            type: 'number',
            description: 'Ticket ID to retrieve'
          },
          fullDetails: {
            type: 'boolean',
            description: 'Whether to include full details (default: false for optimized response)'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_ticket_by_number',
        'Get a specific ticket by ticket number (e.g., T20250914.0008) with full details',
        'read',
        {
          ticketNumber: {
            type: 'string',
            description: 'Ticket number to retrieve (e.g., T20250914.0008)'
          },
          fullDetails: {
            type: 'boolean',
            description: 'Whether to include full details (default: false for optimized response)'
          }
        },
        ['ticketNumber']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_project',
        'Get a specific project by ID with full details',
        'read',
        {
          id: {
            type: 'number',
            description: 'Project ID to retrieve'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_resource',
        'Get a specific resource (employee) by ID with full details',
        'read',
        {
          id: {
            type: 'number',
            description: 'Resource ID to retrieve'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_project',
        'Create a new project in Autotask',
        'write',
        {
          companyID: {
            type: 'number',
            description: 'Company ID for the project'
          },
          projectName: {
            type: 'string',
            description: 'Project name'
          },
          description: {
            type: 'string',
            description: 'Project description'
          },
          status: {
            type: 'number',
            description: 'Project status ID'
          },
          projectType: {
            type: 'number',
            description: 'Project type ID'
          },
          projectManagerResourceID: {
            type: 'number',
            description: 'Project manager resource ID'
          },
          startDateTime: {
            type: 'string',
            description: 'Project start date/time (ISO format)'
          },
          endDateTime: {
            type: 'string',
            description: 'Project end date/time (ISO format)'
          },
          estimatedHours: {
            type: 'number',
            description: 'Estimated hours for completion'
          }
        },
        ['companyID', 'projectName']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_project',
        'Update an existing project in Autotask',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Project ID to update'
          },
          projectName: {
            type: 'string',
            description: 'Project name'
          },
          description: {
            type: 'string',
            description: 'Project description'
          },
          status: {
            type: 'number',
            description: 'Project status ID'
          },
          projectManagerResourceID: {
            type: 'number',
            description: 'Project manager resource ID'
          },
          startDateTime: {
            type: 'string',
            description: 'Project start date/time (ISO format)'
          },
          endDateTime: {
            type: 'string',
            description: 'Project end date/time (ISO format)'
          },
          estimatedHours: {
            type: 'number',
            description: 'Estimated hours for completion'
          }
        },
        ['id']
      ),

      // Time Entry Management
      EnhancedAutotaskToolHandler.createTool(
        'search_time_entries',
        'Search for time entries in Autotask with filters',
        'read',
        {
          ticketID: {
            type: 'number',
            description: 'Filter by ticket ID'
          },
          taskID: {
            type: 'number',
            description: 'Filter by task ID'
          },
          resourceId: {
            type: 'number',
            description: 'Filter by resource ID'
          },
          dateFrom: {
            type: 'string',
            description: 'Start date filter (YYYY-MM-DD format)'
          },
          dateTo: {
            type: 'string',
            description: 'End date filter (YYYY-MM-DD format)'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (max 200)',
            minimum: 1,
            maximum: 200
          }
        }
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_time_entry',
        'Get a specific time entry by ID with full details',
        'read',
        {
          id: {
            type: 'number',
            description: 'Time entry ID to retrieve'
          }
        },
        ['id']
      ),

      // Task Management
      EnhancedAutotaskToolHandler.createTool(
        'search_tasks',
        'Search for tasks in Autotask with filters',
        'read',
        {
          projectId: {
            type: 'number',
            description: 'Filter by project ID'
          },
          assignedResourceId: {
            type: 'number',
            description: 'Filter by assigned resource ID'
          },
          status: {
            type: 'number',
            description: 'Filter by status ID'
          },
          searchTerm: {
            type: 'string',
            description: 'Search term to filter tasks by title'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (max 100)',
            minimum: 1,
            maximum: 100
          }
        }
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_task',
        'Get a specific task by ID with full details',
        'read',
        {
          id: {
            type: 'number',
            description: 'Task ID to retrieve'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_task',
        'Create a new task in Autotask',
        'write',
        {
          projectID: {
            type: 'number',
            description: 'Project ID for the task'
          },
          title: {
            type: 'string',
            description: 'Task title'
          },
          description: {
            type: 'string',
            description: 'Task description'
          },
          assignedResourceID: {
            type: 'number',
            description: 'Assigned resource ID'
          },
          status: {
            type: 'number',
            description: 'Task status ID'
          },
          startDateTime: {
            type: 'string',
            description: 'Start date/time (ISO format)'
          },
          endDateTime: {
            type: 'string',
            description: 'End date/time (ISO format)'
          },
          estimatedHours: {
            type: 'number',
            description: 'Estimated hours for completion'
          },
          priorityLabel: {
            type: 'string',
            description: 'Priority label'
          }
        },
        ['projectID', 'title']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_task',
        'Update an existing task in Autotask',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Task ID to update'
          },
          title: {
            type: 'string',
            description: 'Task title'
          },
          description: {
            type: 'string',
            description: 'Task description'
          },
          assignedResourceID: {
            type: 'number',
            description: 'Assigned resource ID'
          },
          status: {
            type: 'number',
            description: 'Task status ID'
          },
          startDateTime: {
            type: 'string',
            description: 'Start date/time (ISO format)'
          },
          endDateTime: {
            type: 'string',
            description: 'End date/time (ISO format)'
          },
          estimatedHours: {
            type: 'number',
            description: 'Estimated hours for completion'
          },
          percentComplete: {
            type: 'number',
            description: 'Percentage complete (0-100)'
          }
        },
        ['id']
      ),

      // Notes Management
      EnhancedAutotaskToolHandler.createTool(
        'search_ticket_notes',
        'Search for notes on a specific ticket',
        'read',
        {
          ticketID: {
            type: 'number',
            description: 'Ticket ID to search notes for'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (max 100)',
            minimum: 1,
            maximum: 100
          }
        },
        ['ticketID']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_ticket_note',
        'Get a specific ticket note by ticket ID and note ID',
        'read',
        {
          ticketID: {
            type: 'number',
            description: 'Ticket ID'
          },
          noteId: {
            type: 'number',
            description: 'Note ID'
          }
        },
        ['ticketID', 'noteId']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_ticket_note',
        'Create a new note on a ticket',
        'write',
        {
          ticketID: {
            type: 'number',
            description: 'Ticket ID to add note to'
          },
          title: {
            type: 'string',
            description: 'Note title'
          },
          description: {
            type: 'string',
            description: 'Note content/description'
          },
          noteType: {
            type: 'number',
            description: 'Note type ID'
          },
          publish: {
            type: 'number',
            description: 'Publish setting (1 = Internal Only, 2 = All Autotask Users, 3 = Client Portal)'
          }
        },
        ['ticketID', 'description']
      ),

      EnhancedAutotaskToolHandler.createTool(
        'search_project_notes',
        'Search for notes on a specific project',
        'read',
        {
          projectId: {
            type: 'number',
            description: 'Project ID to search notes for'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (max 100)',
            minimum: 1,
            maximum: 100
          }
        },
        ['projectId']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_project_note',
        'Get a specific project note by project ID and note ID',
        'read',
        {
          projectId: {
            type: 'number',
            description: 'Project ID'
          },
          noteId: {
            type: 'number',
            description: 'Note ID'
          }
        },
        ['projectId', 'noteId']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_project_note',
        'Create a new note on a project',
        'write',
        {
          projectId: {
            type: 'number',
            description: 'Project ID to add note to'
          },
          title: {
            type: 'string',
            description: 'Note title'
          },
          description: {
            type: 'string',
            description: 'Note content/description'
          },
          noteType: {
            type: 'number',
            description: 'Note type ID'
          },
          publish: {
            type: 'number',
            description: 'Publish setting (1 = Internal Only, 2 = All Autotask Users, 3 = Client Portal)'
          }
        },
        ['projectId', 'description']
      ),

      EnhancedAutotaskToolHandler.createTool(
        'search_company_notes',
        'Search for notes on a specific company',
        'read',
        {
          companyId: {
            type: 'number',
            description: 'Company ID to search notes for'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (max 100)',
            minimum: 1,
            maximum: 100
          }
        },
        ['companyId']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_company_note',
        'Get a specific company note by company ID and note ID',
        'read',
        {
          companyId: {
            type: 'number',
            description: 'Company ID'
          },
          noteId: {
            type: 'number',
            description: 'Note ID'
          }
        },
        ['companyId', 'noteId']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_company_note',
        'Create a new note on a company',
        'write',
        {
          companyId: {
            type: 'number',
            description: 'Company ID to add note to'
          },
          title: {
            type: 'string',
            description: 'Note title'
          },
          description: {
            type: 'string',
            description: 'Note content/description'
          },
          noteType: {
            type: 'number',
            description: 'Note type ID'
          },
          publish: {
            type: 'number',
            description: 'Publish setting (1 = Internal Only, 2 = All Autotask Users, 3 = Client Portal)'
          }
        },
        ['companyId', 'description']
      ),

      // Attachments Management  
      EnhancedAutotaskToolHandler.createTool(
        'search_ticket_attachments',
        'Search for attachments on a specific ticket',
        'read',
        {
          ticketID: {
            type: 'number',
            description: 'Ticket ID to search attachments for'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (max 50)',
            minimum: 1,
            maximum: 50
          }
        },
        ['ticketID']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_ticket_attachment',
        'Get a specific ticket attachment by ticket ID and attachment ID',
        'read',
        {
          ticketID: {
            type: 'number',
            description: 'Ticket ID'
          },
          attachmentId: {
            type: 'number',
            description: 'Attachment ID'
          },
          includeData: {
            type: 'boolean',
            description: 'Whether to include base64-encoded file data (default: false for metadata only)'
          }
        },
        ['ticketID', 'attachmentId']
      ),

      // Financial Management
      EnhancedAutotaskToolHandler.createTool(
        'get_contract',
        'Get a specific contract by ID with full details',
        'read',
        {
          id: {
            type: 'number',
            description: 'Contract ID to retrieve'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'search_contracts',
        'Search for contracts in Autotask with filters',
        'read',
        {
          companyId: {
            type: 'number',
            description: 'Filter by company ID'
          },
          status: {
            type: 'number',
            description: 'Filter by contract status'
          },
          contractType: {
            type: 'number',
            description: 'Filter by contract type'
          },
          searchTerm: {
            type: 'string',
            description: 'Search term to filter contracts by name'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (max 500)',
            minimum: 1,
            maximum: 500
          }
        }
      ),

      EnhancedAutotaskToolHandler.createTool(
        'get_invoice',
        'Get a specific invoice by ID with full details',
        'read',
        {
          id: {
            type: 'number',
            description: 'Invoice ID to retrieve'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'search_invoices',
        'Search for invoices in Autotask with filters',
        'read',
        {
          companyId: {
            type: 'number',
            description: 'Filter by company ID'
          },
          fromDate: {
            type: 'string',
            description: 'Start date filter (YYYY-MM-DD format)'
          },
          toDate: {
            type: 'string',
            description: 'End date filter (YYYY-MM-DD format)'
          },
          status: {
            type: 'number',
            description: 'Filter by invoice status'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (max 500)',
            minimum: 1,
            maximum: 500
          }
        }
      ),

      EnhancedAutotaskToolHandler.createTool(
        'get_quote',
        'Get a specific quote by ID with full details',
        'read',
        {
          id: {
            type: 'number',
            description: 'Quote ID to retrieve'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'search_quotes',
        'Search for quotes in Autotask with filters',
        'read',
        {
          companyId: {
            type: 'number',
            description: 'Filter by company ID'
          },
          contactId: {
            type: 'number',
            description: 'Filter by contact ID'
          },
          opportunityId: {
            type: 'number',
            description: 'Filter by opportunity ID'
          },
          searchTerm: {
            type: 'string',
            description: 'Search term to filter quotes by description'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (max 500)',
            minimum: 1,
            maximum: 500
          }
        }
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_quote',
        'Create a new quote in Autotask',
        'write',
        {
          accountId: {
            type: 'number',
            description: 'Company/Account ID for the quote'
          },
          contactId: {
            type: 'number',
            description: 'Contact ID'
          },
          opportunityId: {
            type: 'number',
            description: 'Opportunity ID (if related to an opportunity)'
          },
          title: {
            type: 'string',
            description: 'Quote title'
          },
          description: {
            type: 'string',
            description: 'Quote description'
          },
          proposedWorkDescription: {
            type: 'string',
            description: 'Proposed work description'
          },
          paymentTerms: {
            type: 'number',
            description: 'Payment terms ID'
          },
          effectiveDate: {
            type: 'string',
            description: 'Quote effective date (YYYY-MM-DD format)'
          },
          expirationDate: {
            type: 'string',
            description: 'Quote expiration date (YYYY-MM-DD format)'
          }
        },
        ['accountId', 'contactId', 'title']
      ),

      EnhancedAutotaskToolHandler.createTool(
        'get_expense_report',
        'Get a specific expense report by ID with full details',
        'read',
        {
          id: {
            type: 'number',
            description: 'Expense report ID to retrieve'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'search_expense_reports',
        'Search for expense reports in Autotask with filters',
        'read',
        {
          submitterId: {
            type: 'number',
            description: 'Filter by submitter resource ID'
          },
          status: {
            type: 'number',
            description: 'Filter by expense report status'
          },
          fromDate: {
            type: 'string',
            description: 'Start date filter (YYYY-MM-DD format)'
          },
          toDate: {
            type: 'string',
            description: 'End date filter (YYYY-MM-DD format)'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (max 500)',
            minimum: 1,
            maximum: 500
          }
        }
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_expense_report',
        'Create a new expense report in Autotask',
        'write',
        {
          resourceId: {
            type: 'number',
            description: 'Resource ID (submitter of the expense report)'
          },
          name: {
            type: 'string',
            description: 'Expense report name/title'
          },
          weekEnding: {
            type: 'string',
            description: 'Week ending date (YYYY-MM-DD format)'
          },
          status: {
            type: 'number',
            description: 'Initial status of the expense report'
          },
          approverResourceId: {
            type: 'number',
            description: 'Approver resource ID'
          },
          submitDate: {
            type: 'string',
            description: 'Submit date (YYYY-MM-DD format)'
          }
        },
        ['resourceId', 'name', 'weekEnding']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_expense_report',
        'Update an existing expense report in Autotask',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Expense report ID to update'
          },
          name: {
            type: 'string',
            description: 'Expense report name/title'
          },
          status: {
            type: 'number',
            description: 'Expense report status'
          },
          approverResourceId: {
            type: 'number',
            description: 'Approver resource ID'
          },
          submitDate: {
            type: 'string',
            description: 'Submit date (YYYY-MM-DD format)'
          },
          weekEnding: {
            type: 'string',
            description: 'Week ending date (YYYY-MM-DD format)'
          }
        },
        ['id']
      ),

      // Expense Items Management
      EnhancedAutotaskToolHandler.createTool(
        'search_expense_items',
        'Search for expense items in a specific expense report (parent-child relationship)',
        'read',
        {
          expenseReportId: {
            type: 'number',
            description: 'Expense report ID (required - parent entity)'
          },
          companyId: {
            type: 'number',
            description: 'Filter by company ID'
          },
          projectId: {
            type: 'number',
            description: 'Filter by project ID'
          },
          taskID: {
            type: 'number',
            description: 'Filter by task ID'
          },
          ticketID: {
            type: 'number',
            description: 'Filter by ticket ID'
          },
          expenseCategory: {
            type: 'number',
            description: 'Filter by expense category'
          },
          fromDate: {
            type: 'string',
            description: 'Start date filter (YYYY-MM-DD format)'
          },
          toDate: {
            type: 'string',
            description: 'End date filter (YYYY-MM-DD format)'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (max 500)',
            minimum: 1,
            maximum: 500
          }
        },
        ['expenseReportId']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_expense_item',
        'Get a specific expense item by ID from an expense report (parent-child relationship)',
        'read',
        {
          id: {
            type: 'number',
            description: 'Expense item ID to retrieve'
          },
          expenseReportId: {
            type: 'number',
            description: 'Expense report ID (required - parent entity)'
          }
        },
        ['id', 'expenseReportId']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_expense_item',
        'Create a new expense item in Autotask',
        'write',
        {
          expenseReportID: {
            type: 'number',
            description: 'Expense report ID'
          },
          companyID: {
            type: 'number',
            description: 'Company ID'
          },
          description: {
            type: 'string',
            description: 'Expense description'
          },
          expenseCategory: {
            type: 'number',
            description: 'Expense category ID'
          },
          expenseDate: {
            type: 'string',
            description: 'Expense date (YYYY-MM-DD format)'
          },
          expenseCurrencyExpenseAmount: {
            type: 'number',
            description: 'Amount in expense currency'
          },
          expenseCurrencyID: {
            type: 'number',
            description: 'Expense currency ID'
          },
          projectID: {
            type: 'number',
            description: 'Project ID (if billable to project)'
          },
          taskID: {
            type: 'number',
            description: 'Task ID (if billable to task)'
          },
          ticketID: {
            type: 'number',
            description: 'Ticket ID (if billable to ticket)'
          },
          isBillableToCompany: {
            type: 'boolean',
            description: 'Whether expense is billable to company'
          },
          isReimbursable: {
            type: 'boolean',
            description: 'Whether expense is reimbursable'
          },
          haveReceipt: {
            type: 'boolean',
            description: 'Whether receipt is available'
          },
          paymentType: {
            type: 'number',
            description: 'Payment type ID'
          },
          workType: {
            type: 'number',
            description: 'Work type ID'
          },
          miles: {
            type: 'number',
            description: 'Miles (for travel expenses)'
          },
          origin: {
            type: 'string',
            description: 'Origin location (for travel expenses)'
          },
          destination: {
            type: 'string',
            description: 'Destination location (for travel expenses)'
          },
          entertainmentLocation: {
            type: 'string',
            description: 'Entertainment location'
          },
          purchaseOrderNumber: {
            type: 'string',
            description: 'Purchase order number'
          },
          glCode: {
            type: 'string',
            description: 'GL code'
          }
        },
        ['expenseReportID', 'companyID', 'description', 'expenseCategory', 'expenseDate']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_expense_item',
        'Update an existing expense item in an expense report (parent-child relationship)',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Expense item ID to update'
          },
          expenseReportId: {
            type: 'number',
            description: 'Expense report ID (recommended - parent entity)'
          },
          description: {
            type: 'string',
            description: 'Expense description'
          },
          expenseCategory: {
            type: 'number',
            description: 'Expense category ID'
          },
          expenseDate: {
            type: 'string',
            description: 'Expense date (YYYY-MM-DD format)'
          },
          expenseCurrencyExpenseAmount: {
            type: 'number',
            description: 'Amount in expense currency'
          },
          projectID: {
            type: 'number',
            description: 'Project ID (if billable to project)'
          },
          taskID: {
            type: 'number',
            description: 'Task ID (if billable to task)'
          },
          ticketID: {
            type: 'number',
            description: 'Ticket ID (if billable to ticket)'
          },
          isBillableToCompany: {
            type: 'boolean',
            description: 'Whether expense is billable to company'
          },
          isReimbursable: {
            type: 'boolean',
            description: 'Whether expense is reimbursable'
          },
          haveReceipt: {
            type: 'boolean',
            description: 'Whether receipt is available'
          },
          paymentType: {
            type: 'number',
            description: 'Payment type ID'
          },
          workType: {
            type: 'number',
            description: 'Work type ID'
          },
          miles: {
            type: 'number',
            description: 'Miles (for travel expenses)'
          },
          origin: {
            type: 'string',
            description: 'Origin location (for travel expenses)'
          },
          destination: {
            type: 'string',
            description: 'Destination location (for travel expenses)'
          },
          entertainmentLocation: {
            type: 'string',
            description: 'Entertainment location'
          },
          purchaseOrderNumber: {
            type: 'string',
            description: 'Purchase order number'
          },
          glCode: {
            type: 'string',
            description: 'GL code'
          }
        },
        ['id']
      ),

      // Configuration Items Management
      EnhancedAutotaskToolHandler.createTool(
        'get_configuration_item',
        'Get a specific configuration item by ID with full details',
        'read',
        {
          id: {
            type: 'number',
            description: 'Configuration item ID to retrieve'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'search_configuration_items',
        'Search for configuration items in Autotask with filters',
        'read',
        {
          companyId: {
            type: 'number',
            description: 'Filter by company ID'
          },
          configurationItemType: {
            type: 'number',
            description: 'Filter by configuration item type'
          },
          serialNumber: {
            type: 'string',
            description: 'Filter by serial number'
          },
          referenceTitle: {
            type: 'string',
            description: 'Filter by reference title'
          },
          searchTerm: {
            type: 'string',
            description: 'Search term to filter configuration items'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (max 500)',
            minimum: 1,
            maximum: 500
          }
        }
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_configuration_item',
        'Create a new configuration item in Autotask',
        'write',
        {
          companyID: {
            type: 'number',
            description: 'Company ID for the configuration item'
          },
          configurationItemType: {
            type: 'number',
            description: 'Configuration item type ID'
          },
          referenceTitle: {
            type: 'string',
            description: 'Reference title/name'
          },
          serialNumber: {
            type: 'string',
            description: 'Serial number'
          },
          installedProductID: {
            type: 'number',
            description: 'Installed product ID'
          },
          contactID: {
            type: 'number',
            description: 'Contact ID'
          },
          location: {
            type: 'string',
            description: 'Location description'
          },
          notes: {
            type: 'string',
            description: 'Additional notes'
          }
        },
        ['companyID', 'configurationItemType', 'referenceTitle']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_configuration_item',
        'Update an existing configuration item in Autotask',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Configuration item ID to update'
          },
          referenceTitle: {
            type: 'string',
            description: 'Reference title/name'
          },
          serialNumber: {
            type: 'string',
            description: 'Serial number'
          },
          installedProductID: {
            type: 'number',
            description: 'Installed product ID'
          },
          contactID: {
            type: 'number',
            description: 'Contact ID'
          },
          location: {
            type: 'string',
            description: 'Location description'
          },
          notes: {
            type: 'string',
            description: 'Additional notes'
          }
        },
        ['id']
      ),

      // ID-to-Name Mapping tools
      EnhancedAutotaskToolHandler.createTool(
        'get_company_name',
        'Get company name by ID',
        'read',
        {
          id: {
            type: 'number',
            description: 'Company ID'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_resource_name',
        'Get resource name by ID',
        'read',
        {
          id: {
            type: 'number',
            description: 'Resource ID'
          }
        },
        ['id']
      ),

      // Pagination helper tools
      EnhancedAutotaskToolHandler.createTool(
        'get_companies_page',
        'Get a specific page of companies (optimized for pagination)',
        'read',
        {
          page: {
            type: 'number',
            description: 'Page number to retrieve (1-based)',
            minimum: 1,
            default: 1
          },
                     pageSize: {
             type: 'number',
             description: 'Number of companies per page (default: 50, max: 2000)',
             minimum: 1,
             maximum: 2000,
             default: 50
           },
          searchTerm: {
            type: 'string',
            description: 'Optional search term to filter companies by name'
          },
          isActive: {
            type: 'boolean',
            description: 'Optional filter by active status'
          }
        }
      ),

      // Test connection tool
      EnhancedAutotaskToolHandler.createTool(
        'test_connection',
        'Test connectivity to the Autotask API',
        'read',
        {}
      ),

    ];

    // Extract mode from tenant context
    const mode = tenantContext?.mode || 'read'; // Default to write mode if no tenant context
    
    this.logger.info('MODE from tenant context', { 
      mode, 
      hasTenantContext: !!tenantContext,
      tenantId: tenantContext?.tenantId 
    });
    
    // Filter tools based on tenant mode
    if (mode === 'read') {
      // For read mode, only return tools that are read-only
      return allTools.filter(tool => {
        const toolOperationType = this.getToolOperationType(tool.name);
        return toolOperationType === 'read';
      });
    }
    
    // For write mode or no tenant context specified, return all tools
    return allTools;
  }

  /**
   * Get tools filtered by tenant context (for cases where tenant context is known)
   */
  async getToolsForTenant(tenantContext: TenantContext): Promise<McpTool[]> {
    this.logger.info('🔧 Getting tools for specific tenant', {
      tenantId: tenantContext.tenantId,
      mode: tenantContext.mode
    });
    
    return await this.listTools(tenantContext);
  }

  async callTool(name: string, args: Record<string, any>): Promise<McpToolResult> {
    const startTime = Date.now();
    const toolCallId = `${name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      this.logger.info(`🛠️ Tool call started: ${name}`, {
        toolCallId,
        toolName: name,
        argsProvided: Object.keys(args || {}),
        argCount: Object.keys(args || {}).length,
        timestamp: new Date().toISOString()
      }); 

      this.logger.info('ARGS', args);
      
      // Enhanced debugging for tenant context
      this.logger.info('🔍 DETAILED ARGS ANALYSIS', {
        toolCallId,
        argsType: typeof args,
        argsKeys: args ? Object.keys(args) : 'null/undefined',
        hasUnderscore_tenant: args ? '_tenant' in args : false,
        hasTenant: args ? 'tenant' in args : false,
        hasCredentials: args ? 'credentials' in args : false,
        argValues: {
          _tenant: args?._tenant ? 'present' : 'missing',
          tenant: args?.tenant ? 'present' : 'missing', 
          credentials: args?.credentials ? 'present' : 'missing'
        }
      });
      
      // Log each top-level property in args for debugging
      if (args && typeof args === 'object') {
        for (const [key, value] of Object.entries(args)) {
          this.logger.info(`🔍 ARG[${key}]`, {
            type: typeof value,
            isObject: typeof value === 'object' && value !== null,
            hasSubKeys: typeof value === 'object' && value !== null ? Object.keys(value) : 'n/a',
            preview: key.includes('secret') || key.includes('password') ? '[REDACTED]' : 
                    typeof value === 'string' ? value.substring(0, 50) : 
                    typeof value === 'object' ? '[object]' : value
          });
        }
      }

      // Extract tenant context from arguments
      const tenantContext = this.extractTenantContext(args);
      
      if (tenantContext) {
        this.logger.info(`🏢 Tool call using multi-tenant mode`, {
          toolCallId,
          toolName: name,
          tenantId: tenantContext.tenantId,
          sessionId: tenantContext.sessionId,
          mode: tenantContext.mode
        });
      } else {
        this.logger.info(`🏠 Tool call using single-tenant mode`, {
          toolCallId,
          toolName: name
        });
      }

      // Check if operation is allowed based on tenant mode
      if (!this.isOperationAllowed(name, tenantContext)) {
        const operationType = this.getToolOperationType(name);
        const errorMessage = `Operation not allowed: Tool "${name}" (${operationType}) is not permitted in "${tenantContext?.mode}" mode. Only read operations are allowed in read mode.`;
        
        this.logger.warn(`🚫 Tool operation blocked by mode restriction`, {
          toolCallId,
          toolName: name,
          operationType,
          tenantMode: tenantContext?.mode,
          tenantId: tenantContext?.tenantId
        });
        
        return {
          content: [{
            type: 'text',
            text: errorMessage
          }],
          isError: true
        };
      }
      
      let result: McpToolResult;
      
      switch (name) {
        // Company tools
        case 'search_companies':
          this.logger.info(`📊 Executing search_companies`, { toolCallId });
          result = await this.searchCompanies(args, tenantContext);
          break;
        
        case 'create_company':
          this.logger.info(`➕ Executing create_company`, { toolCallId });
          result = await this.createCompany(args, tenantContext);
          break;

        case 'update_company':
          this.logger.info(`✏️ Executing update_company`, { toolCallId });
          result = await this.updateCompany(args, tenantContext);
          break;

        // Contact tools
        case 'search_contacts':
          this.logger.info(`📊 Executing search_contacts`, { toolCallId });
          result = await this.searchContacts(args, tenantContext);
          break;

        case 'create_contact':
          this.logger.info(`➕ Executing create_contact`, { toolCallId });
          result = await this.createContact(args, tenantContext);
          break;

        case 'update_contact':
          this.logger.info(`✏️ Executing update_contact`, { toolCallId });
          result = await this.updateContact(args, tenantContext);
          break;

        // Ticket tools
        case 'search_tickets':
          this.logger.info(`📊 Executing search_tickets`, { toolCallId });
          result = await this.searchTickets(args, tenantContext);
          break;

        case 'create_ticket':
          this.logger.info(`➕ Executing create_ticket`, { toolCallId });
          result = await this.createTicket(args, tenantContext);
          break;

        case 'update_ticket':
          this.logger.info(`✏️ Executing update_ticket`, { toolCallId });
          result = await this.updateTicket(args, tenantContext);
          break;

        // Time Entry tools
        case 'create_time_entry':
          this.logger.info(`⏰ Executing create_time_entry`, { toolCallId });
          result = await this.createTimeEntry(args, tenantContext);
          break;

        // Project tools
        case 'search_projects':
          this.logger.info(`📊 Executing search_projects`, { toolCallId });
          result = await this.searchProjects(args, tenantContext);
          break;

        // Resource tools
        case 'search_resources':
          this.logger.info(`📊 Executing search_resources`, { toolCallId });
          result = await this.searchResources(args, tenantContext);
          break;

        // ID-to-Name Mapping tools
        case 'get_company_name':
          this.logger.info(`🏷️ Executing get_company_name`, { toolCallId });
          result = await this.getCompanyName(args, tenantContext);
          break;

        case 'get_resource_name':
          this.logger.info(`🏷️ Executing get_resource_name`, { toolCallId });
          result = await this.getResourceName(args, tenantContext);
          break;

        case 'get_mapping_cache_stats':
          this.logger.info(`📈 Executing get_mapping_cache_stats`, { toolCallId });
          result = await this.getMappingCacheStats(args, tenantContext);
          break;

        case 'clear_mapping_cache':
          this.logger.info(`🗑️ Executing clear_mapping_cache`, { toolCallId });
          result = await this.clearMappingCache(args, tenantContext);
          break;

        case 'preload_mapping_cache':
          this.logger.info(`🚀 Executing preload_mapping_cache`, { toolCallId });
          result = await this.preloadMappingCache(args, tenantContext);
          break;
        
        case 'test_connection':
          this.logger.info(`🔗 Executing test_connection`, { toolCallId });
          result = await this.testConnection(tenantContext);
          break;

        case 'test_zone_information':
          this.logger.info(`🌐 Executing test_zone_information`, { toolCallId });
          result = await this.testZoneInformation(tenantContext);
          break;

        // Individual Entity Getters
        case 'get_company':
          this.logger.info(`🏢 Executing get_company`, { toolCallId });
          result = await this.getCompany(args, tenantContext);
          break;

        case 'get_contact':
          this.logger.info(`👤 Executing get_contact`, { toolCallId });
          result = await this.getContact(args, tenantContext);
          break;

        case 'get_ticket':
          this.logger.info(`🎫 Executing get_ticket`, { toolCallId });
          result = await this.getTicket(args, tenantContext);
          break;

        case 'get_ticket_by_number':
          this.logger.info(`🎫 Executing get_ticket_by_number`, { toolCallId });
          result = await this.getTicketByNumber(args, tenantContext);
          break;

        case 'get_project':
          this.logger.info(`📋 Executing get_project`, { toolCallId });
          result = await this.getProject(args, tenantContext);
          break;

        case 'get_resource':
          this.logger.info(`👨‍💼 Executing get_resource`, { toolCallId });
          result = await this.getResource(args, tenantContext);
          break;

        case 'create_project':
          this.logger.info(`➕ Executing create_project`, { toolCallId });
          result = await this.createProject(args, tenantContext);
          break;

        case 'update_project':
          this.logger.info(`✏️ Executing update_project`, { toolCallId });
          result = await this.updateProject(args, tenantContext);
          break;

        // Time Entry Management
        case 'search_time_entries':
          this.logger.info(`⏰ Executing search_time_entries`, { toolCallId });
          result = await this.searchTimeEntries(args, tenantContext);
          break;

        case 'get_time_entry':
          this.logger.info(`⏰ Executing get_time_entry`, { toolCallId });
          result = await this.getTimeEntry(args, tenantContext);
          break;

        // Task Management
        case 'search_tasks':
          this.logger.info(`📝 Executing search_tasks`, { toolCallId });
          result = await this.searchTasks(args, tenantContext);
          break;

        case 'get_task':
          this.logger.info(`📝 Executing get_task`, { toolCallId });
          result = await this.getTask(args, tenantContext);
          break;

        case 'create_task':
          this.logger.info(`➕ Executing create_task`, { toolCallId });
          result = await this.createTask(args, tenantContext);
          break;

        case 'update_task':
          this.logger.info(`✏️ Executing update_task`, { toolCallId });
          result = await this.updateTask(args, tenantContext);
          break;

        // Notes Management
        case 'search_ticket_notes':
          this.logger.info(`📝 Executing search_ticket_notes`, { toolCallId });
          result = await this.searchTicketNotes(args, tenantContext);
          break;

        case 'get_ticket_note':
          this.logger.info(`📝 Executing get_ticket_note`, { toolCallId });
          result = await this.getTicketNote(args, tenantContext);
          break;

        case 'create_ticket_note':
          this.logger.info(`➕ Executing create_ticket_note`, { toolCallId });
          result = await this.createTicketNote(args, tenantContext);
          break;

        case 'search_project_notes':
          this.logger.info(`📝 Executing search_project_notes`, { toolCallId });
          result = await this.searchProjectNotes(args, tenantContext);
          break;

        case 'get_project_note':
          this.logger.info(`📝 Executing get_project_note`, { toolCallId });
          result = await this.getProjectNote(args, tenantContext);
          break;

        case 'create_project_note':
          this.logger.info(`➕ Executing create_project_note`, { toolCallId });
          result = await this.createProjectNote(args, tenantContext);
          break;

        case 'search_company_notes':
          this.logger.info(`📝 Executing search_company_notes`, { toolCallId });
          result = await this.searchCompanyNotes(args, tenantContext);
          break;

        case 'get_company_note':
          this.logger.info(`📝 Executing get_company_note`, { toolCallId });
          result = await this.getCompanyNote(args, tenantContext);
          break;

        case 'create_company_note':
          this.logger.info(`➕ Executing create_company_note`, { toolCallId });
          result = await this.createCompanyNote(args, tenantContext);
          break;

        // Attachments Management
        case 'search_ticket_attachments':
          this.logger.info(`📎 Executing search_ticket_attachments`, { toolCallId });
          result = await this.searchTicketAttachments(args, tenantContext);
          break;

        case 'get_ticket_attachment':
          this.logger.info(`📎 Executing get_ticket_attachment`, { toolCallId });
          result = await this.getTicketAttachment(args, tenantContext);
          break;

        // Financial Management
        case 'get_contract':
          this.logger.info(`📄 Executing get_contract`, { toolCallId });
          result = await this.getContract(args, tenantContext);
          break;

        case 'search_contracts':
          this.logger.info(`📄 Executing search_contracts`, { toolCallId });
          result = await this.searchContracts(args, tenantContext);
          break;

        case 'get_invoice':
          this.logger.info(`🧾 Executing get_invoice`, { toolCallId });
          result = await this.getInvoice(args, tenantContext);
          break;

        case 'search_invoices':
          this.logger.info(`🧾 Executing search_invoices`, { toolCallId });
          result = await this.searchInvoices(args, tenantContext);
          break;

        case 'get_quote':
          this.logger.info(`💰 Executing get_quote`, { toolCallId });
          result = await this.getQuote(args, tenantContext);
          break;

        case 'search_quotes':
          this.logger.info(`💰 Executing search_quotes`, { toolCallId });
          result = await this.searchQuotes(args, tenantContext);
          break;

        case 'create_quote':
          this.logger.info(`➕ Executing create_quote`, { toolCallId });
          result = await this.createQuote(args, tenantContext);
          break;

        case 'get_expense_report':
          this.logger.info(`💳 Executing get_expense_report`, { toolCallId });
          result = await this.getExpenseReport(args, tenantContext);
          break;

        case 'search_expense_reports':
          this.logger.info(`💳 Executing search_expense_reports`, { toolCallId });
          result = await this.searchExpenseReports(args, tenantContext);
          break;

        case 'create_expense_report':
          this.logger.info(`➕ Executing create_expense_report`, { toolCallId });
          result = await this.createExpenseReport(args, tenantContext);
          break;

        case 'update_expense_report':
          this.logger.info(`✏️ Executing update_expense_report`, { toolCallId });
          result = await this.updateExpenseReport(args, tenantContext);
          break;

        // Expense Items Management
        case 'search_expense_items':
          this.logger.info(`💳 Executing search_expense_items`, { toolCallId });
          result = await this.searchExpenseItems(args, tenantContext);
          break;

        case 'get_expense_item':
          this.logger.info(`💳 Executing get_expense_item`, { toolCallId });
          result = await this.getExpenseItem(args, tenantContext);
          break;

        case 'create_expense_item':
          this.logger.info(`➕ Executing create_expense_item`, { toolCallId });
          result = await this.createExpenseItem(args, tenantContext);
          break;

        case 'update_expense_item':
          this.logger.info(`✏️ Executing update_expense_item`, { toolCallId });
          result = await this.updateExpenseItem(args, tenantContext);
          break;

        // Configuration Items Management
        case 'get_configuration_item':
          this.logger.info(`🖥️ Executing get_configuration_item`, { toolCallId });
          result = await this.getConfigurationItem(args, tenantContext);
          break;

        case 'search_configuration_items':
          this.logger.info(`🖥️ Executing search_configuration_items`, { toolCallId });
          result = await this.searchConfigurationItems(args, tenantContext);
          break;

        case 'create_configuration_item':
          this.logger.info(`➕ Executing create_configuration_item`, { toolCallId });
          result = await this.createConfigurationItem(args, tenantContext);
          break;

        case 'update_configuration_item':
          this.logger.info(`✏️ Executing update_configuration_item`, { toolCallId });
          result = await this.updateConfigurationItem(args, tenantContext);
          break;

        // Pagination helper tools
        case 'get_companies_page':
          this.logger.info(`📄 Executing get_companies_page`, { toolCallId });
          result = await this.getCompaniesPage(args, tenantContext);
          break;

        default:
          this.logger.error(`❌ Unknown tool: ${name}`, { toolCallId, toolName: name });
          throw new Error(`Unknown tool: ${name}`);
      }

      const executionTime = Date.now() - startTime;
      const contentLength = result.content && result.content.length > 0 && result.content[0] && result.content[0].type === 'text' 
        ? (result.content[0] as any).text.length 
        : 0;
        
      this.logger.info(`✅ Tool call completed successfully: ${name}`, {
        toolCallId,
        toolName: name,
        executionTimeMs: executionTime,
        resultType: result.isError ? 'error' : 'success',
        contentLength
      });

      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.logger.error(`❌ Tool call failed: ${name}`, {
        toolCallId,
        toolName: name,
        executionTimeMs: executionTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      
      return {
        content: [{
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
        }],
        isError: true
      };
    }
  }

  private async searchCompanies(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const options: any = {};
      
      if (args.searchTerm) {
        options.filter = [{
          field: 'companyName',
          op: 'contains',
          value: args.searchTerm
        }];
      }
      
      if (typeof args.isActive === 'boolean') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'isActive',
          op: 'eq',
          value: args.isActive
        });
      }
      
      // Handle pagination parameters
      if (args.pageSize) {
        options.pageSize = args.pageSize;
      }
      
      if (args.page) {
        options.page = args.page;
      }
      
      // Handle getAllPages flag - if true, override pagination limits
      if (args.getAllPages === true) {
        // Remove page size limit to get all data (use old behavior)
        delete options.pageSize;
        this.logger.info('getAllPages=true: Will fetch all available companies (may be slow)');
      }

      const companies = await this.autotaskService.searchCompanies(options, tenantContext);
      
      // Enhanced results with mapped names
      const mappingService = await this.getMappingService();
      const enhancedCompanies = await Promise.all(
        companies.map(async (company: any) => {
          const enhanced: any = { ...company };
          
          // Add owner resource name if available
          if (company.ownerResourceID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.ownerResourceName = await mappingService.getResourceName(company.ownerResourceID);
            } catch (error) {
              this.logger.info(`Failed to map owner resource ID ${company.ownerResourceID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.ownerResourceName = `Unknown (${company.ownerResourceID})`;
            }
          }
          
          return enhanced;
        })
      );

      // Prepare pagination info
      const currentPage = args.page || 1;
      const pageSize = args.pageSize || 50;
      const isLimitedResults = enhancedCompanies.length === pageSize && !args.getAllPages;
      
      let resultsText = '';
      if (enhancedCompanies.length > 0) {
        resultsText = `Found ${enhancedCompanies.length} companies`;
        
        // Add pagination context
        if (currentPage > 1) {
          resultsText += ` (page ${currentPage})`;
        }
        if (isLimitedResults) {
          resultsText += ` - use page=${currentPage + 1} to get more results`;
        }
        
        resultsText += `:\n\n${enhancedCompanies.map(company => 
          `ID: ${company.id}\nName: ${company.companyName}\nType: ${company.companyType}\nActive: ${company.isActive}\nOwner: ${company._enhanced?.ownerResourceName || 'Unknown'}\n`
        ).join('\n')}`;
      } else {
        resultsText = 'No companies found matching the criteria';
        if (currentPage > 1) {
          resultsText += ` on page ${currentPage}. Try page=1 or adjust your search criteria.`;
        }
      }

      const content = [{
        type: 'text',
        text: resultsText
      }];

      // Check if we're hitting the threshold limit and show guidance proactively
      const threshold = LARGE_RESPONSE_THRESHOLDS.companies;
      const isHittingLimit = args.pageSize !== undefined && args.pageSize >= threshold;
      const shouldShowGuidance = isHittingLimit || enhancedCompanies.length >= threshold;

      let contentWithGuidance = content;
      if (shouldShowGuidance) {
        const guidanceMessage = isHittingLimit 
          ? `Requested ${args.pageSize} companies (limit: ${threshold}). For more focused results, try:\n` +
            `  • Use \`searchTerm\` with company name or partial name\n` +
            `  • Add specific filters in your search criteria\n` +
            `  • Use smaller \`pageSize\` parameter (current: ${args.pageSize})`
          : this.generateSearchGuidance('companies', enhancedCompanies.length, Math.round(JSON.stringify(content).length / 1024));

        contentWithGuidance = [
          ...content,
          {
            type: 'text',
            text: `\n\n🔍 **Search Guidance**: ${guidanceMessage}`
          }
        ];
      }

      return {
        content: contentWithGuidance
      };
    } catch (error) {
      throw new Error(`Failed to search companies: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createCompany(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const companyData = { ...args };
      
      const companyId = await this.autotaskService.createCompany(companyData, tenantContext);
      
      return this.createCreationResponse('company', companyId);
    } catch (error) {
      throw new Error(`Failed to create company: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateCompany(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    return this.updateEntity(
      args,
      'Company',
      'id',
      (id, data, ctx) => this.autotaskService.updateCompany(id, data, ctx),
      tenantContext
    );
  }

  private async searchContacts(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const options: any = {};
      
      if (args.searchTerm) {
        options.filter = [{
          field: 'firstName',
          op: 'contains',
          value: args.searchTerm
        }, {
          field: 'lastName',
          op: 'contains',
          value: args.searchTerm
        }, {
          field: 'emailAddress',
          op: 'contains',
          value: args.searchTerm
        }];
      }
      
      if (typeof args.companyId === 'number') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'companyID',
          op: 'eq',
          value: args.companyId
        });
      }
      
      if (typeof args.isActive === 'boolean') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'isActive',
          op: 'eq',
          value: args.isActive
        });
      }
      
      if (args.pageSize) {
        options.pageSize = args.pageSize;
      }

      const contacts = await this.autotaskService.searchContacts(options, tenantContext);
      this.logger.info(`🏢 Found ${contacts.length} contacts`, {
        tenant: tenantContext,
        sessionId: tenantContext?.sessionId
      });
      // Enhanced results with mapped names
      const mappingService = await this.getMappingService();
      const enhancedContacts = await Promise.all(
        contacts.map(async (contact: any) => {
          const enhanced: any = { ...contact };
          
          // Add company name if available
          if (contact.companyID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = await mappingService.getCompanyName(contact.companyID);
            } catch (error) {
              this.logger.info(`Failed to map company ID ${contact.companyID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = `Unknown (${contact.companyID})`;
            }
          }
          
          return enhanced;
        })
      );

      const resultsText = enhancedContacts.length > 0 
        ? `Found ${enhancedContacts.length} contacts:\n\n${enhancedContacts.map(contact => 
            `ID: ${contact.id}\nName: ${contact.firstName} ${contact.lastName}\nEmail: ${contact.emailAddress}\nCompany: ${contact._enhanced?.companyName || 'Unknown'}\n`
          ).join('\n')}`
        : 'No contacts found matching the criteria';

      const content = [{
        type: 'text',
        text: resultsText
      }];

      // Add guidance for large responses
      const contentWithGuidance = this.addLargeResponseGuidance(content, enhancedContacts.length, 'contacts');

      return {
        content: contentWithGuidance
      };
    } catch (error) {
      throw new Error(`Failed to search contacts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createContact(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const contactData = { ...args };
      
      const contactId = await this.autotaskService.createContact(contactData, tenantContext);
      
      return this.createCreationResponse('contact', contactId);
    } catch (error) {
      throw new Error(`Failed to create contact: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateContact(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    return this.updateEntity(
      args,
      'Contact',
      'id',
      (id, data, ctx) => this.autotaskService.updateContact(id, data, ctx),
      tenantContext
    );
  }

  private async searchTickets(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const options: any = {};
      
      // Use the proper searchTerm parameter instead of custom filter
      if (args.searchTerm) {
        options.searchTerm = args.searchTerm;
      }
      
      if (typeof args.status === 'number') {
        options.status = args.status;
      }
      
      if (typeof args.companyID === 'number') {
        options.companyId = args.companyID;
      }
      
      if (typeof args.projectID === 'number') {
        options.projectId = args.projectID;
      }
      
      if (typeof args.contractID === 'number') {
        options.contractId = args.contractID;
      }
      
      if (typeof args.assignedResourceID === 'number') {
        options.assignedResourceID = args.assignedResourceID;
      }
      
      if (typeof args.unassigned === 'boolean') {
        options.unassigned = args.unassigned;
      }
      
      if (args.pageSize) {
        options.pageSize = args.pageSize;
      }

      let tickets = await this.autotaskService.searchTickets(options, tenantContext);
      
      // If no results with searchTerm and we haven't tried the alternate field, try fallback
      if (tickets.length === 0 && args.searchTerm) {
        const searchTerm = args.searchTerm;
        const looksLikeTicketNumber = /^T\d+\.\d+$/.test(searchTerm);
        
        this.logger.info(`No results found, trying fallback search for: ${searchTerm}`);
        
        // Create fallback options with alternate search strategy
        const fallbackOptions = { ...options };
        delete fallbackOptions.searchTerm; // Remove to avoid conflict
        
        if (looksLikeTicketNumber) {
          // Original search was ticket number, try title search as fallback
          fallbackOptions.filter = [{
            op: 'contains',
            field: 'title',
            value: searchTerm
          }];
        } else {
          // Original search was title, try partial ticket number match as fallback
          fallbackOptions.filter = [{
            op: 'contains',
            field: 'ticketNumber',
            value: searchTerm
          }];
        }
        
        // Add back other filters if they existed
        if (fallbackOptions.status !== undefined) {
          if (!fallbackOptions.filter) fallbackOptions.filter = [];
          fallbackOptions.filter.push({
            op: 'eq',
            field: 'status',
            value: fallbackOptions.status
          });
          delete fallbackOptions.status;
        }
        
        if (fallbackOptions.companyId !== undefined) {
          if (!fallbackOptions.filter) fallbackOptions.filter = [];
          fallbackOptions.filter.push({
            op: 'eq',
            field: 'companyID',
            value: fallbackOptions.companyId
          });
          delete fallbackOptions.companyId;
        }
        
        if (fallbackOptions.projectId !== undefined) {
          if (!fallbackOptions.filter) fallbackOptions.filter = [];
          fallbackOptions.filter.push({
            op: 'eq',
            field: 'projectID',
            value: fallbackOptions.projectId
          });
          delete fallbackOptions.projectId;
        }
        
        if (fallbackOptions.contractId !== undefined) {
          if (!fallbackOptions.filter) fallbackOptions.filter = [];
          fallbackOptions.filter.push({
            op: 'eq',
            field: 'contractID',
            value: fallbackOptions.contractId
          });
          delete fallbackOptions.contractId;
        }
        
        if (fallbackOptions.assignedResourceID !== undefined) {
          if (!fallbackOptions.filter) fallbackOptions.filter = [];
          fallbackOptions.filter.push({
            op: 'eq',
            field: 'assignedResourceID',
            value: fallbackOptions.assignedResourceID
          });
          delete fallbackOptions.assignedResourceID;
        }
        
        if (fallbackOptions.unassigned !== undefined) {
          if (!fallbackOptions.filter) fallbackOptions.filter = [];
          fallbackOptions.filter.push({
            op: 'eq',
            field: 'assignedResourceID',
            value: null
          });
          delete fallbackOptions.unassigned;
        }
        
        try {
          tickets = await this.autotaskService.searchTickets(fallbackOptions, tenantContext);
          if (tickets.length > 0) {
            this.logger.info(`Fallback search found ${tickets.length} tickets`);
          }
        } catch (error) {
          this.logger.warn(`Fallback search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
      
      // Enhanced results with mapped names
      const mappingService = await this.getMappingService();
      const enhancedTickets = await Promise.all(
        tickets.map(async (ticket: any) => {
          const enhanced: any = { ...ticket };
          
          // Add company name if available
          if (ticket.companyID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = await mappingService.getCompanyName(ticket.companyID);
            } catch (error) {
              this.logger.info(`Failed to map company ID ${ticket.companyID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = `Unknown (${ticket.companyID})`;
            }
          }

          // Add assigned resource name if available
          if (ticket.assignedResourceID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.assignedResourceName = await mappingService.getResourceName(ticket.assignedResourceID);
            } catch (error) {
              this.logger.info(`Failed to map assigned resource ID ${ticket.assignedResourceID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.assignedResourceName = `Unknown (${ticket.assignedResourceID})`;
            }
          }

          // Note: Contact name mapping would require additional implementation
          if (ticket.contactID) {
            enhanced._enhanced = enhanced._enhanced || {};
            enhanced._enhanced.contactName = `Contact ID: ${ticket.contactID}`;
          }
          
          return enhanced;
        })
      );

      const resultsText = enhancedTickets.length > 0 
        ? `Found ${enhancedTickets.length} tickets:\n\n${enhancedTickets.map(ticket => 
            `ID: ${ticket.id}\nNumber: ${ticket.ticketNumber}\nTitle: ${ticket.title}\nStatus: ${ticket.status}\nCompany: ${ticket._enhanced?.companyName || 'Unknown'}\nAssigned: ${ticket._enhanced?.assignedResourceName || 'Unassigned'}\nContact: ${ticket._enhanced?.contactName || 'Unknown'}\n`
          ).join('\n')}`
        : 'No tickets found matching the criteria';

      const content = [{
        type: 'text',
        text: resultsText
      }];

      // Check if we're hitting the threshold limit and show guidance proactively
      const threshold = LARGE_RESPONSE_THRESHOLDS.tickets;
      const isHittingLimit = args.pageSize !== undefined && args.pageSize >= threshold;
      const shouldShowGuidance = isHittingLimit || enhancedTickets.length >= threshold;

      let contentWithGuidance = content;
      if (shouldShowGuidance) {
        const guidanceMessage = isHittingLimit 
          ? `Requested ${args.pageSize} tickets (limit: ${threshold}). For more focused results, try:\n` +
            `  • Use \`status\` parameter to filter by ticket status (e.g., status: 1 for New, 5 for Complete)\n` +
            `  • Add \`companyID\` to search tickets for a specific company\n` +
            `  • Add \`projectID\` to search tickets for a specific project\n` +
            `  • Add \`contractID\` to search tickets for a specific contract\n` +
            `  • Use \`assignedResourceID\` to find tickets assigned to specific person\n` +
            `  • Try \`searchTerm\` with specific keywords from ticket title or number\n` +
            `  • Use smaller \`pageSize\` parameter (current: ${args.pageSize})`
          : this.generateSearchGuidance('tickets', enhancedTickets.length, Math.round(JSON.stringify(content).length / 1024));

        contentWithGuidance = [
          ...content,
          {
            type: 'text',
            text: `\n\n🔍 **Search Guidance**: ${guidanceMessage}`
          }
        ];
      }

      return {
        content: contentWithGuidance
      };
    } catch (error) {
      throw new Error(`Failed to search tickets: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createTicket(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const ticketData = { ...args };
      
      const ticketID = await this.autotaskService.createTicket(ticketData, tenantContext);
      
      return this.createCreationResponse('ticket', ticketID);
    } catch (error) {
      throw new Error(`Failed to create ticket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateTicket(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const ticketData = { ...args };
      const ticketID = ticketData.id;
      delete ticketData.id; // Remove ID from data for update

      await this.autotaskService.updateTicket(ticketID, ticketData, tenantContext);

      return this.createUpdateResponse('ticket', ticketID);
    } catch (error) {
      throw new Error(`Failed to update ticket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createTimeEntry(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const timeEntryData = { ...args };
      
      const timeEntryId = await this.autotaskService.createTimeEntry(timeEntryData, tenantContext);
      
      return this.createCreationResponse('time entry', timeEntryId);
    } catch (error) {
      throw new Error(`Failed to create time entry: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchProjects(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const options: any = {};
      
      if (args.searchTerm) {
        options.filter = [{
          field: 'projectName',
          op: 'contains',
          value: args.searchTerm
        }];
      }
      
      if (typeof args.companyId === 'number') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'companyID',
          op: 'eq',
          value: args.companyId
        });
      }
      
      if (typeof args.status === 'number') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'status',
          op: 'eq',
          value: args.status
        });
      }
      
      if (args.pageSize) {
        options.pageSize = args.pageSize;
      }

      const projects = await this.autotaskService.searchProjects(options, tenantContext);
      
      // Enhanced results with mapped names
      const mappingService = await this.getMappingService();
      const enhancedProjects = await Promise.all(
        projects.map(async (project: any) => {
          const enhanced: any = { ...project };
          
          // Add company name if available
          if (project.companyID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = await mappingService.getCompanyName(project.companyID);
            } catch (error) {
              this.logger.info(`Failed to map company ID ${project.companyID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = `Unknown (${project.companyID})`;
            }
          }
          
          return enhanced;
        })
      );

      const resultsText = enhancedProjects.length > 0 
        ? `Found ${enhancedProjects.length} projects:\n\n${enhancedProjects.map(project => 
            `ID: ${project.id}\nName: ${project.projectName}\nCompany: ${project._enhanced?.companyName || 'Unknown'}\n`
          ).join('\n')}`
        : 'No projects found matching the criteria';

      const content = [{
        type: 'text',
        text: resultsText
      }];

      // Add guidance for large responses
      const contentWithGuidance = this.addLargeResponseGuidance(content, enhancedProjects.length, 'projects');

      return {
        content: contentWithGuidance
      };
    } catch (error) {
      throw new Error(`Failed to search projects: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchResources(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const options: any = {};
      
      // Build filters based on provided search criteria
      const filters: any[] = [];
      
      // Individual field searches (optional)
      if (args.firstName) {
        filters.push({
          field: 'firstName',
          op: 'contains',
          value: args.firstName
        });
      }
      
      if (args.lastName) {
        filters.push({
          field: 'lastName',
          op: 'contains',
          value: args.lastName
        });
      }
      
      if (args.email) {
        filters.push({
          field: 'email',
          op: 'contains',
          value: args.email
        });
      }
      
      // Fallback: if searchTerm is provided but no specific fields, search across name fields
      // Note: This will use AND logic, so it's better to use specific field parameters
      if (args.searchTerm && !args.firstName && !args.lastName && !args.email) {
        filters.push({
          field: 'firstName',
          op: 'contains',
          value: args.searchTerm
        });
        // Note: Commented out lastName search to avoid AND logic issues
        // To search lastName, use the lastName parameter instead
        // filters.push({
        //   field: 'lastName',
        //   op: 'contains',
        //   value: args.searchTerm
        // });
      }
      
      if (typeof args.isActive === 'boolean') {
        filters.push({
          field: 'isActive',
          op: 'eq',
          value: args.isActive
        });
      }
      
      // Only set filter if we have conditions
      if (filters.length > 0) {
        options.filter = filters;
      }
      
      if (args.pageSize) {
        options.pageSize = args.pageSize;
      }

      const resources = await this.autotaskService.searchResources(options, tenantContext);
      
      // Enhanced results with mapped names
      const enhancedResources = resources.map((resource: any) => {
        const enhanced: any = { ...resource };
        
        // Add resource name
        enhanced._enhanced = enhanced._enhanced || {};
        enhanced._enhanced.resourceName = `${resource.firstName} ${resource.lastName}`.trim();
        
        return enhanced;
      });

      const resultsText = enhancedResources.length > 0 
        ? `Found ${enhancedResources.length} resources:\n\n${enhancedResources.map(resource => 
            `ID: ${resource.id}\nName: ${resource.firstName} ${resource.lastName}\nActive: ${resource.isActive}\n`
          ).join('\n')}`
        : 'No resources found matching the criteria';

      return {
        content: [{
          type: 'text',
          text: resultsText
        }]
      };
    } catch (error) {
      throw new Error(`Failed to search resources: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getCompanyName(args: Record<string, any>, _tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const companyId = args.id;
      if (typeof companyId !== 'number') {
        throw new Error('Company ID must be provided');
      }

      const mappingService = await this.getMappingService();
      const companyName = await mappingService.getCompanyName(companyId);
      
      return this.createDataResponse({ companyName });
    } catch (error) {
      throw new Error(`Failed to get company name: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getResourceName(args: Record<string, any>, _tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const resourceId = args.id;
      if (typeof resourceId !== 'number') {
        throw new Error('Resource ID must be provided');
      }

      const mappingService = await this.getMappingService();
      const resourceName = await mappingService.getResourceName(resourceId);
      
      return this.createDataResponse({ resourceName });
    } catch (error) {
      throw new Error(`Failed to get resource name: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getMappingCacheStats(_args: Record<string, any>, _tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const mappingService = await this.getMappingService();
      const stats = mappingService.getCacheStats();
      
      return this.createDataResponse({ stats });
    } catch (error) {
      throw new Error(`Failed to get mapping cache stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async clearMappingCache(_args: Record<string, any>, _tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const mappingService = await this.getMappingService();
      mappingService.clearCache();
      
      return this.createDataResponse({ message: 'Mapping cache cleared successfully.' });
    } catch (error) {
      throw new Error(`Failed to clear mapping cache: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async preloadMappingCache(_args: Record<string, any>, _tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const mappingService = await this.getMappingService();
      await mappingService.preloadCaches();
      
      return this.createDataResponse({ message: 'Mapping cache preloaded successfully.' });
    } catch (error) {
      throw new Error(`Failed to preload mapping cache: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async testConnection(tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      // DEBUG: Show what we actually received
      this.logger.info('🔗 TEST_CONNECTION DEBUG - Starting comprehensive test', {
        hasTenantContext: !!tenantContext,
        tenantContextKeys: tenantContext ? Object.keys(tenantContext) : 'none',
        tenantId: tenantContext?.tenantId,
        hasCredentials: !!(tenantContext?.credentials),
        impersonationResourceId: tenantContext?.impersonationResourceId,
        mode: tenantContext?.mode,
        sessionId: tenantContext?.sessionId
      });

      if (tenantContext?.credentials) {
        this.logger.info('🔑 CREDENTIALS DEBUG', {
          hasUsername: !!tenantContext.credentials.username,
          usernameLength: tenantContext.credentials.username?.length || 0,
          usernamePreview: tenantContext.credentials.username ? `${tenantContext.credentials.username.substring(0, 5)}***` : 'none',
          hasSecret: !!tenantContext.credentials.secret,
          secretLength: tenantContext.credentials.secret?.length || 0,
          hasIntegrationCode: !!tenantContext.credentials.integrationCode,
          integrationCodeLength: tenantContext.credentials.integrationCode?.length || 0,
          integrationCodePreview: tenantContext.credentials.integrationCode ? `${tenantContext.credentials.integrationCode.substring(0, 8)}***` : 'none',
          hasApiUrl: !!tenantContext.credentials.apiUrl,
          apiUrl: tenantContext.credentials.apiUrl
        });
      }

      // Try to make a simple API call to list resources (limit to 1 for minimal impact)
      this.logger.info('🚀 Attempting simple resources API call...');
      
      try {
        const resourcesOptions = {
          filter: [{ field: 'id', op: 'gte', value: 0 }],
          pageSize: 1
        };

        this.logger.info('📞 Making autotaskService.searchResources call', {
          options: resourcesOptions,
          tenantContext: {
            tenantId: tenantContext?.tenantId,
            hasCredentials: !!(tenantContext?.credentials),
            impersonationResourceId: tenantContext?.impersonationResourceId,
            mode: tenantContext?.mode
          }
        });

        const resources = await this.autotaskService.searchResources(resourcesOptions, tenantContext);
        
        this.logger.info('✅ API CALL SUCCESS - Resources response received', {
          resourcesType: typeof resources,
          resourcesIsArray: Array.isArray(resources),
          resourcesLength: Array.isArray(resources) ? resources.length : 'not an array',
          resourcesKeys: resources && typeof resources === 'object' ? Object.keys(resources) : 'not an object',
          firstResourceId: Array.isArray(resources) && resources.length > 0 ? resources[0]?.id : 'no resources',
          firstResourceName: Array.isArray(resources) && resources.length > 0 ? 
            `${resources[0]?.firstName || 'unknown'} ${resources[0]?.lastName || 'unknown'}`.trim() : 'no name',
          rawResponse: JSON.stringify(resources, null, 2).substring(0, 500) + (JSON.stringify(resources).length > 500 ? '...[truncated]' : '')
        });

        const message = tenantContext 
          ? `✅ Successfully connected to Autotask API for tenant: ${tenantContext.tenantId}${tenantContext.impersonationResourceId ? ` (impersonating resource ${tenantContext.impersonationResourceId})` : ''}\n\n` +
            `API Test Result:\n` +
            `- Retrieved ${Array.isArray(resources) ? resources.length : 0} resource(s)\n` +
            `- Response type: ${typeof resources}\n` +
            `- First resource: ${Array.isArray(resources) && resources.length > 0 ? 
              `ID ${resources[0]?.id} - ${resources[0]?.firstName || 'unknown'} ${resources[0]?.lastName || 'unknown'}`.trim() : 'None'}\n` +
            `- Full response: ${JSON.stringify(resources, null, 2).substring(0, 200)}${JSON.stringify(resources).length > 200 ? '...' : ''}`
          : `✅ Successfully connected to Autotask API\n\n` +
            `API Test Result:\n` +
            `- Retrieved ${Array.isArray(resources) ? resources.length : 0} resource(s)\n` +
            `- Response type: ${typeof resources}\n` +
            `- First resource: ${Array.isArray(resources) && resources.length > 0 ? 
              `ID ${resources[0]?.id} - ${resources[0]?.firstName || 'unknown'} ${resources[0]?.lastName || 'unknown'}`.trim() : 'None'}\n` +
            `- Full response: ${JSON.stringify(resources, null, 2).substring(0, 200)}${JSON.stringify(resources).length > 200 ? '...' : ''}`;

        return {
          content: [{
            type: 'text',
            text: message
          }],
          isError: false
        };

      } catch (apiError) {
        this.logger.error('❌ API CALL FAILED - Detailed error information', {
          errorType: typeof apiError,
          errorName: apiError instanceof Error ? apiError.name : 'unknown',
          errorMessage: apiError instanceof Error ? apiError.message : String(apiError),
          errorStack: apiError instanceof Error ? apiError.stack : 'no stack',
          errorKeys: apiError && typeof apiError === 'object' ? Object.keys(apiError) : 'not an object',
          fullError: JSON.stringify(apiError, Object.getOwnPropertyNames(apiError), 2)
        });

        // Also log any response details if it's an HTTP error
        if (apiError && typeof apiError === 'object') {
          const err = apiError as any;
          if (err.response) {
            this.logger.error('📡 HTTP Response details', {
              status: err.response.status,
              statusText: err.response.statusText,
              headers: err.response.headers,
              data: typeof err.response.data === 'string' ? 
                err.response.data.substring(0, 500) + (err.response.data.length > 500 ? '...[truncated]' : '') :
                JSON.stringify(err.response.data, null, 2).substring(0, 500) + (JSON.stringify(err.response.data).length > 500 ? '...[truncated]' : ''),
              url: err.response.config?.url,
              method: err.response.config?.method
            });
          }
          if (err.request) {
            this.logger.error('📤 Request details', {
              url: err.request.url,
              method: err.request.method,
              headers: err.request.headers
            });
          }
        }

        const errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
        const message = tenantContext 
          ? `❌ Failed to connect to Autotask API for tenant: ${tenantContext.tenantId}\n\nError Details:\n${errorMessage}`
          : `❌ Failed to connect to Autotask API\n\nError Details:\n${errorMessage}`;

        return {
          content: [{
            type: 'text',
            text: message
          }],
          isError: true
        };
      }

    } catch (error) {
      this.logger.error('💥 OUTER CATCH - Unexpected error in test connection', {
        errorType: typeof error,
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : 'no stack',
        fullError: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
      });

      throw new Error(`Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async testZoneInformation(tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      this.logger.info('🌐 TEST_ZONE_INFORMATION DEBUG', {
        hasTenantContext: !!tenantContext,
        tenantContextKeys: tenantContext ? Object.keys(tenantContext) : 'none',
        tenantId: tenantContext?.tenantId,
        hasCredentials: !!(tenantContext?.credentials),
        impersonationResourceId: tenantContext?.impersonationResourceId
      });

      const zoneInfo = await this.autotaskService.testZoneInformation(tenantContext);
      
      if (zoneInfo) {
        const message = tenantContext 
          ? `✅ Successfully discovered Autotask zone information for tenant: ${tenantContext.tenantId}${tenantContext.impersonationResourceId ? ` (impersonating resource ${tenantContext.impersonationResourceId})` : ''}\n\n` +
            `Zone URL: ${zoneInfo.url || 'N/A'}\n` +
            `Web URL: ${zoneInfo.webUrl || 'N/A'}\n` +
            `Full Zone Info: ${JSON.stringify(zoneInfo, null, 2)}`
          : `✅ Successfully discovered Autotask zone information\n\n` +
            `Zone URL: ${zoneInfo.url || 'N/A'}\n` +
            `Web URL: ${zoneInfo.webUrl || 'N/A'}\n` +
            `Full Zone Info: ${JSON.stringify(zoneInfo, null, 2)}`;

        return {
          content: [{
            type: 'text',
            text: message
          }],
          isError: false
        };
      } else {
        const message = tenantContext
          ? `❌ Failed to discover Autotask zone information for tenant: ${tenantContext.tenantId}`
          : '❌ Failed to discover Autotask zone information';

        return {
          content: [{
            type: 'text',
            text: message
          }],
          isError: true
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const message = tenantContext 
        ? `❌ Zone information test failed for tenant ${tenantContext.tenantId}: ${errorMessage}`
        : `❌ Zone information test failed: ${errorMessage}`;

      return {
        content: [{
          type: 'text',
          text: message
        }],
        isError: true
      };
    }
  }

  // ===================================
  // Phase 1: Individual Entity Getters
  // ===================================

  private async getCompany(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    return this.getEntity(
      args.id,
      'Company',
      (id, ctx) => this.autotaskService.getCompany(id, ctx),
      tenantContext
    );
  }

  private async getContact(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    return this.getEntity(
      args.id,
      'Contact',
      (id, ctx) => this.autotaskService.getContact(id, ctx),
      tenantContext
    );
  }

  private async getTicket(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { id, fullDetails = false } = args;
      
      if (!id || typeof id !== 'number') {
        throw new Error('Ticket ID is required and must be a number');
      }

      const ticket = await this.autotaskService.getTicket(id, fullDetails, tenantContext);
      
      if (!ticket) {
        return this.createNotFoundResponse('ticket', id);
      }

      return this.createDataResponse(ticket);
    } catch (error) {
      throw new Error(`Failed to get ticket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getTicketByNumber(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { ticketNumber, fullDetails = false } = args;
      
      if (!ticketNumber || typeof ticketNumber !== 'string') {
        throw new Error('Ticket number is required and must be a string (e.g., T20250914.0008)');
      }

      const ticket = await this.autotaskService.getTicketByNumber(ticketNumber, fullDetails, tenantContext);
      
      if (!ticket) {
        return this.createNotFoundResponse('ticket', ticketNumber);
      }

      return this.createDataResponse(ticket);
    } catch (error) {
      throw new Error(`Failed to get ticket by number: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getProject(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    return this.getEntity(
      args.id,
      'Project',
      (id, ctx) => this.autotaskService.getProject(id, ctx),
      tenantContext
    );
  }

  private async getResource(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    return this.getEntity(
      args.id,
      'Resource',
      (id, ctx) => this.autotaskService.getResource(id, ctx),
      tenantContext
    );
  }

  private async createProject(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { 
        companyID, 
        projectName, 
        description, 
        status, 
        projectType, 
        projectManagerResourceID, 
        startDateTime, 
        endDateTime, 
        estimatedHours 
      } = args;
      
      if (!companyID || !projectName) {
        throw new Error('Company ID and project name are required');
      }

      const projectData = {
        companyID,
        projectName,
        ...(description && { description }),
        ...(status && { status }),
        ...(projectType && { projectType }),
        ...(projectManagerResourceID && { projectManagerResourceID }),
        ...(startDateTime && { startDateTime }),
        ...(endDateTime && { endDateTime }),
        ...(estimatedHours && { estimatedHours })
      };

      const projectId = await this.autotaskService.createProject(projectData, tenantContext);
      
      return this.createCreationResponse('project', projectId);
    } catch (error) {
      throw new Error(`Failed to create project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateProject(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { 
        id, 
        projectName, 
        description, 
        status, 
        projectManagerResourceID, 
        startDateTime, 
        endDateTime, 
        estimatedHours 
      } = args;
      
      if (!id) {
        throw new Error('Project ID is required');
      }

      const updateData: any = {};
      
      if (projectName !== undefined) updateData.projectName = projectName;
      if (description !== undefined) updateData.description = description;
      if (status !== undefined) updateData.status = status;
      if (projectManagerResourceID !== undefined) updateData.projectManagerResourceID = projectManagerResourceID;
      if (startDateTime !== undefined) updateData.startDateTime = startDateTime;
      if (endDateTime !== undefined) updateData.endDateTime = endDateTime;
      if (estimatedHours !== undefined) updateData.estimatedHours = estimatedHours;

      if (Object.keys(updateData).length === 0) {
        throw new Error('At least one field to update must be provided');
      }

      await this.autotaskService.updateProject(id, updateData, tenantContext);
      
      return this.createUpdateResponse('project', id);
    } catch (error) {
      throw new Error(`Failed to update project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ===================================
  // Phase 1: Time Entry Management
  // ===================================

  private async searchTimeEntries(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { ticketID, taskID, resourceId, dateFrom, dateTo, pageSize } = args;
      
      // Build filter for time entries search
      const filter: any[] = [];
      
      if (ticketID) {
        filter.push({ field: 'ticketID', op: 'eq', value: ticketID });
      }
      
      if (taskID) {
        filter.push({ field: 'taskID', op: 'eq', value: taskID });
      }
      
      if (resourceId) {
        filter.push({ field: 'resourceID', op: 'eq', value: resourceId });
      }
      
      if (dateFrom) {
        filter.push({ field: 'dateWorked', op: 'gte', value: dateFrom });
      }
      
      if (dateTo) {
        filter.push({ field: 'dateWorked', op: 'lte', value: dateTo });
      }
      
      // If no specific filters, get recent entries
      if (filter.length === 0) {
        // Get entries from last 30 days by default
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        filter.push({ field: 'dateWorked', op: 'gte', value: thirtyDaysAgo.toISOString().split('T')[0] });
      }

      const queryOptions: any = {
        filter
      };
      
      // Explicitly handle pageSize to ensure it's passed through (including pageSize: 1)
      if (pageSize !== undefined) {
        queryOptions.pageSize = pageSize;
      }

      const timeEntries = await this.autotaskService.getTimeEntries(queryOptions, tenantContext);
      
      const content = [{
        type: 'text',
        text: JSON.stringify(timeEntries, null, 2)
      }];

      // Check if we're hitting the threshold limit and show guidance proactively
      const threshold = LARGE_RESPONSE_THRESHOLDS.timeentries;
      const isHittingLimit = pageSize !== undefined && pageSize >= threshold;
      const shouldShowGuidance = isHittingLimit || timeEntries.length >= threshold;

      let contentWithGuidance = content;
      if (shouldShowGuidance) {
        const guidanceMessage = isHittingLimit 
          ? `Requested ${pageSize} entries (limit: ${threshold}). For more focused results, try:\n` +
            `  • Use \`ticketID\` to search time entries for a specific ticket\n` +
            `  • Use \`taskID\` to search time entries for a specific task\n` + 
            `  • Use \`resourceId\` to find time entries by a specific person\n` +
            `  • Add date filters with \`dateFrom\` and \`dateTo\` (YYYY-MM-DD format)\n` +
            `  • Use smaller \`pageSize\` parameter (current: ${pageSize})`
          : this.generateSearchGuidance('timeentries', timeEntries.length, Math.round(JSON.stringify(content).length / 1024));

        contentWithGuidance = [
          ...content,
          {
            type: 'text',
            text: `\n\n🔍 **Search Guidance**: ${guidanceMessage}`
          }
        ];
      }
      
      return {
        content: contentWithGuidance,
        isError: false
      };
    } catch (error) {
      throw new Error(`Failed to search time entries: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getTimeEntry(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { id } = args;
      
      if (!id || typeof id !== 'number') {
        throw new Error('Time Entry ID is required and must be a number');
      }

      const timeEntry = await this.autotaskService.getTimeEntry(id, tenantContext);
      
      if (!timeEntry) {
        return this.createNotFoundResponse('time entry', id);
      }

      return this.createDataResponse(timeEntry);
    } catch (error) {
      throw new Error(`Failed to get time entry: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ===================================
  // Phase 1: Task Management
  // ===================================

  private async searchTasks(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { projectId, assignedResourceId, status, searchTerm, pageSize } = args;
      
      // Build filter for tasks search
      const filter: any[] = [];
      
      if (projectId) {
        filter.push({ field: 'projectID', op: 'eq', value: projectId });
      }
      
      if (assignedResourceId) {
        filter.push({ field: 'assignedResourceID', op: 'eq', value: assignedResourceId });
      }
      
      if (status !== undefined) {
        filter.push({ field: 'status', op: 'eq', value: status });
      }
      
      if (searchTerm) {
        filter.push({ field: 'title', op: 'contains', value: searchTerm });
      }
      
      // If no specific filters, get all active tasks
      if (filter.length === 0) {
        filter.push({ field: 'id', op: 'gte', value: 0 });
      }

      const queryOptions = {
        filter,
        ...(pageSize && { pageSize })
      };

      const tasks = await this.autotaskService.searchTasks(queryOptions, tenantContext);
      
      const content = [{
        type: 'text',
        text: JSON.stringify(tasks, null, 2)
      }];

      // Add guidance for large responses
      const contentWithGuidance = this.addLargeResponseGuidance(content, tasks.length, 'tasks');
      
      return {
        content: contentWithGuidance,
        isError: false
      };
    } catch (error) {
      throw new Error(`Failed to search tasks: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getTask(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { id } = args;
      
      if (!id || typeof id !== 'number') {
        throw new Error('Task ID is required and must be a number');
      }

      const task = await this.autotaskService.getTask(id, tenantContext);
      
      if (!task) {
        return this.createNotFoundResponse('task', id);
      }

      return this.createDataResponse(task);
    } catch (error) {
      throw new Error(`Failed to get task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createTask(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { 
        projectID, 
        title, 
        description, 
        assignedResourceID, 
        status, 
        startDateTime, 
        endDateTime, 
        estimatedHours, 
        priorityLabel 
      } = args;
      
      if (!projectID || !title) {
        throw new Error('Project ID and title are required');
      }

      const taskData = {
        projectID,
        title,
        ...(description && { description }),
        ...(assignedResourceID && { assignedResourceID }),
        ...(status && { status }),
        ...(startDateTime && { startDateTime }),
        ...(endDateTime && { endDateTime }),
        ...(estimatedHours && { estimatedHours }),
        ...(priorityLabel && { priorityLabel })
      };

      const taskID = await this.autotaskService.createTask(taskData, tenantContext);
      
      return this.createCreationResponse('task', taskID);
    } catch (error) {
      throw new Error(`Failed to create task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateTask(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { 
        id, 
        title, 
        description, 
        assignedResourceID, 
        status, 
        startDateTime, 
        endDateTime, 
        estimatedHours, 
        percentComplete 
      } = args;
      
      if (!id) {
        throw new Error('Task ID is required');
      }

      const updateData: any = {};
      
      if (title !== undefined) updateData.title = title;
      if (description !== undefined) updateData.description = description;
      if (assignedResourceID !== undefined) updateData.assignedResourceID = assignedResourceID;
      if (status !== undefined) updateData.status = status;
      if (startDateTime !== undefined) updateData.startDateTime = startDateTime;
      if (endDateTime !== undefined) updateData.endDateTime = endDateTime;
      if (estimatedHours !== undefined) updateData.estimatedHours = estimatedHours;
      if (percentComplete !== undefined) updateData.percentComplete = percentComplete;

      if (Object.keys(updateData).length === 0) {
        throw new Error('At least one field to update must be provided');
      }

      await this.autotaskService.updateTask(id, updateData, tenantContext);
      
      return this.createUpdateResponse('task', id);
    } catch (error) {
      throw new Error(`Failed to update task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ===================================
  // Phase 2: Notes Management
  // ===================================

  private async searchTicketNotes(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { ticketID, pageSize } = args;
      
      if (!ticketID || typeof ticketID !== 'number') {
        throw new Error('Ticket ID is required and must be a number');
      }

      const queryOptions = {
        ...(pageSize && { pageSize })
      };

      const notes = await this.autotaskService.searchTicketNotes(ticketID, queryOptions, tenantContext);
      
      return this.createDataResponse(notes);
    } catch (error) {
      throw new Error(`Failed to search ticket notes: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getTicketNote(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { ticketID, noteId } = args;
      
      if (!ticketID || typeof ticketID !== 'number') {
        throw new Error('Ticket ID is required and must be a number');
      }
      
      if (!noteId || typeof noteId !== 'number') {
        throw new Error('Note ID is required and must be a number');
      }

      const note = await this.autotaskService.getTicketNote(ticketID, noteId, tenantContext);
      
      if (!note) {
        return this.createNotFoundResponse('ticket note', { ticketID, noteId });
      }

      return this.createDataResponse(note);
    } catch (error) {
      throw new Error(`Failed to get ticket note: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createTicketNote(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { ticketID, title, description, noteType, publish } = args;
      
      if (!ticketID || typeof ticketID !== 'number') {
        throw new Error('Ticket ID is required and must be a number');
      }
      
      if (!description) {
        throw new Error('Description is required');
      }

      const noteData = {
        ...(title && { title }),
        description,
        ...(noteType && { noteType }),
        ...(publish && { publish })
      };

      const noteId = await this.autotaskService.createTicketNote(ticketID, noteData, tenantContext);
      
      return this.createCreationResponse('ticket note', noteId);
    } catch (error) {
      throw new Error(`Failed to create ticket note: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchProjectNotes(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { projectId, pageSize } = args;
      
      if (!projectId || typeof projectId !== 'number') {
        throw new Error('Project ID is required and must be a number');
      }

      const queryOptions = {
        ...(pageSize && { pageSize })
      };

      const notes = await this.autotaskService.searchProjectNotes(projectId, queryOptions, tenantContext);
      
      return this.createDataResponse(notes);
    } catch (error) {
      throw new Error(`Failed to search project notes: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getProjectNote(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { projectId, noteId } = args;
      
      if (!projectId || typeof projectId !== 'number') {
        throw new Error('Project ID is required and must be a number');
      }
      
      if (!noteId || typeof noteId !== 'number') {
        throw new Error('Note ID is required and must be a number');
      }

      const note = await this.autotaskService.getProjectNote(projectId, noteId, tenantContext);
      
      if (!note) {
        return this.createNotFoundResponse('project note', { projectId, noteId });
      }

      return this.createDataResponse(note);
    } catch (error) {
      throw new Error(`Failed to get project note: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createProjectNote(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { projectId, title, description, noteType, publish } = args;
      
      if (!projectId || typeof projectId !== 'number') {
        throw new Error('Project ID is required and must be a number');
      }
      
      if (!description) {
        throw new Error('Description is required');
      }

      const noteData = {
        ...(title && { title }),
        description,
        ...(noteType && { noteType }),
        ...(publish && { publish })
      };

      const noteId = await this.autotaskService.createProjectNote(projectId, noteData, tenantContext);
      
      return this.createCreationResponse('project note', noteId);
    } catch (error) {
      throw new Error(`Failed to create project note: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchCompanyNotes(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { companyId, pageSize } = args;
      
      if (!companyId || typeof companyId !== 'number') {
        throw new Error('Company ID is required and must be a number');
      }

      const queryOptions = {
        ...(pageSize && { pageSize })
      };

      const notes = await this.autotaskService.searchCompanyNotes(companyId, queryOptions, tenantContext);
      
      return this.createDataResponse(notes);
    } catch (error) {
      throw new Error(`Failed to search company notes: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getCompanyNote(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { companyId, noteId } = args;
      
      if (!companyId || typeof companyId !== 'number') {
        throw new Error('Company ID is required and must be a number');
      }
      
      if (!noteId || typeof noteId !== 'number') {
        throw new Error('Note ID is required and must be a number');
      }

      const note = await this.autotaskService.getCompanyNote(companyId, noteId, tenantContext);
      
      if (!note) {
        return this.createNotFoundResponse('company note', { companyId, noteId });
      }

      return this.createDataResponse(note);
    } catch (error) {
      throw new Error(`Failed to get company note: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createCompanyNote(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { companyId, title, description, noteType, publish } = args;
      
      if (!companyId || typeof companyId !== 'number') {
        throw new Error('Company ID is required and must be a number');
      }
      
      if (!description) {
        throw new Error('Description is required');
      }

      const noteData = {
        ...(title && { title }),
        description,
        ...(noteType && { noteType }),
        ...(publish && { publish })
      };

      const noteId = await this.autotaskService.createCompanyNote(companyId, noteData, tenantContext);
      
      return this.createCreationResponse('company note', noteId);
    } catch (error) {
      throw new Error(`Failed to create company note: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ===================================
  // Phase 2: Attachments Management
  // ===================================

  private async searchTicketAttachments(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { ticketID, pageSize } = args;
      
      if (!ticketID || typeof ticketID !== 'number') {
        throw new Error('Ticket ID is required and must be a number');
      }

      const queryOptions = {
        ...(pageSize && { pageSize })
      };

      const attachments = await this.autotaskService.searchTicketAttachments(ticketID, queryOptions, tenantContext);
      
      return this.createDataResponse(attachments);
    } catch (error) {
      throw new Error(`Failed to search ticket attachments: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getTicketAttachment(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { ticketID, attachmentId, includeData = false } = args;
      
      if (!ticketID || typeof ticketID !== 'number') {
        throw new Error('Ticket ID is required and must be a number');
      }
      
      if (!attachmentId || typeof attachmentId !== 'number') {
        throw new Error('Attachment ID is required and must be a number');
      }

      const attachment = await this.autotaskService.getTicketAttachment(ticketID, attachmentId, includeData, tenantContext);
      
      if (!attachment) {
        return this.createNotFoundResponse('ticket attachment', { ticketID, attachmentId });
      }

      return this.createDataResponse(attachment);
    } catch (error) {
      throw new Error(`Failed to get ticket attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ===================================
  // Phase 3: Financial Management
  // ===================================

  private async getContract(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { id } = args;
      
      if (!id || typeof id !== 'number') {
        throw new Error('Contract ID is required and must be a number');
      }

      const contract = await this.autotaskService.getContract(id, tenantContext);
      
      if (!contract) {
        return this.createNotFoundResponse('contract', id);
      }

      return this.createDataResponse(contract);
    } catch (error) {
      throw new Error(`Failed to get contract: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchContracts(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { companyId, status, contractType, searchTerm, pageSize } = args;
      
      // Build filter for contracts search
      const filter: any[] = [];
      
      if (companyId) {
        filter.push({ field: 'companyID', op: 'eq', value: companyId });
      }
      
      if (status !== undefined) {
        filter.push({ field: 'status', op: 'eq', value: status });
      }
      
      if (contractType !== undefined) {
        filter.push({ field: 'contractType', op: 'eq', value: contractType });
      }
      
      if (searchTerm) {
        filter.push({ field: 'contractName', op: 'contains', value: searchTerm });
      }
      
      // If no specific filters, get all contracts
      if (filter.length === 0) {
        filter.push({ field: 'id', op: 'gte', value: 0 });
      }

      const queryOptions = {
        filter,
        ...(pageSize && { pageSize })
      };

      const contracts = await this.autotaskService.searchContracts(queryOptions, tenantContext);
      
      return this.createDataResponse(contracts);
    } catch (error) {
      throw new Error(`Failed to search contracts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getInvoice(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { id } = args;
      
      if (!id || typeof id !== 'number') {
        throw new Error('Invoice ID is required and must be a number');
      }

      const invoice = await this.autotaskService.getInvoice(id, tenantContext);
      
      if (!invoice) {
        return this.createNotFoundResponse('invoice', id);
      }

      return this.createDataResponse(invoice);
    } catch (error) {
      throw new Error(`Failed to get invoice: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchInvoices(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { companyId, fromDate, toDate, pageSize } = args;
      // Build filter for invoices search
      const filter: any[] = [];
      
      if (companyId) {
        filter.push({ field: 'companyID', op: 'eq', value: companyId });
      }
      
      if (fromDate) {
        filter.push({ field: 'invoiceDateTime', op: 'gte', value: fromDate });
      }
      
      if (toDate) {
        filter.push({ field: 'invoiceDateTime', op: 'lte', value: toDate });
      }
       
      
      // If no specific filters, get recent invoices (last 30 days)
      if (filter.length === 0) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        filter.push({ field: 'invoiceDateTime', op: 'gte', value: thirtyDaysAgo.toISOString().split('T')[0] });
      }

      const queryOptions = {
        filter,
        ...(pageSize && { pageSize })
      };

      const invoices = await this.autotaskService.searchInvoices(queryOptions, tenantContext);
      
      return this.createDataResponse(invoices);
    } catch (error) {
      throw new Error(`Failed to search invoices: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getQuote(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { id } = args;
      
      if (!id || typeof id !== 'number') {
        throw new Error('Quote ID is required and must be a number');
      }

      const quote = await this.autotaskService.getQuote(id, tenantContext);
      
      if (!quote) {
        return this.createNotFoundResponse('quote', id);
      }

      return this.createDataResponse(quote);
    } catch (error) {
      throw new Error(`Failed to get quote: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchQuotes(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { companyId, contactId, opportunityId, searchTerm, pageSize } = args;
      
      // Build filter for quotes search
      const filter: any[] = [];
      
      if (companyId) {
        filter.push({ field: 'accountId', op: 'eq', value: companyId });
      }
      
      if (contactId) {
        filter.push({ field: 'contactId', op: 'eq', value: contactId });
      }
      
      if (opportunityId) {
        filter.push({ field: 'opportunityId', op: 'eq', value: opportunityId });
      }
      
      if (searchTerm) {
        filter.push({ field: 'description', op: 'contains', value: searchTerm });
      }
      
      // If no specific filters, get all quotes
      if (filter.length === 0) {
        filter.push({ field: 'id', op: 'gte', value: 0 });
      }

      const queryOptions = {
        filter,
        ...(pageSize && { pageSize })
      };

      const quotes = await this.autotaskService.searchQuotes(queryOptions, tenantContext);
      
      return this.createDataResponse(quotes);
    } catch (error) {
      throw new Error(`Failed to search quotes: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createQuote(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { 
        accountId, 
        contactId, 
        title, 
        description, 
        opportunityId, 
        proposedWorkDescription, 
        paymentTerms, 
        effectiveDate, 
        expirationDate 
      } = args;
      
      if (!accountId || !contactId || !title) {
        throw new Error('Account ID, contact ID, and title are required');
      }

      const quoteData = {
        accountId,
        contactId,
        title,
        ...(description && { description }),
        ...(opportunityId && { opportunityId }),
        ...(proposedWorkDescription && { proposedWorkDescription }),
        ...(paymentTerms && { paymentTerms }),
        ...(effectiveDate && { effectiveDate }),
        ...(expirationDate && { expirationDate })
      };

      const quoteId = await this.autotaskService.createQuote(quoteData, tenantContext);
      
      return this.createCreationResponse('quote', quoteId);
    } catch (error) {
      throw new Error(`Failed to create quote: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getExpenseReport(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { id } = args;
      
      if (!id || typeof id !== 'number') {
        throw new Error('Expense report ID is required and must be a number');
      }

      const expenseReport = await this.autotaskService.getExpenseReport(id, tenantContext);
      
      if (!expenseReport) {
        return this.createNotFoundResponse('expense report', id);
      }

      return this.createDataResponse(expenseReport);
    } catch (error) {
      throw new Error(`Failed to get expense report: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchExpenseReports(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { submitterId, status, fromDate, toDate, pageSize } = args;
      
      // Build filter for expense reports search
      const filter: any[] = [];
      
      if (submitterId) {
        filter.push({ field: 'resourceId', op: 'eq', value: submitterId });
      }
      
      if (status !== undefined) {
        filter.push({ field: 'status', op: 'eq', value: status });
      }
      
      if (fromDate) {
        filter.push({ field: 'submitDate', op: 'gte', value: fromDate });
      }
      
      if (toDate) {
        filter.push({ field: 'submitDate', op: 'lte', value: toDate });
      }
      
      // If no specific filters, get recent expense reports (last 30 days)
      if (filter.length === 0) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        filter.push({ field: 'submitDate', op: 'gte', value: thirtyDaysAgo.toISOString().split('T')[0] });
      }

      const queryOptions = {
        submitterId,
        status,
        ...(pageSize && { pageSize })
      };

      const expenseReports = await this.autotaskService.searchExpenseReports(queryOptions, tenantContext);
      
      return this.createDataResponse(expenseReports);
    } catch (error) {
      throw new Error(`Failed to search expense reports: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createExpenseReport(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { 
        resourceId, 
        name, 
        weekEnding, 
        status, 
        approverResourceId, 
        submitDate 
      } = args;
      
      if (!resourceId || !name || !weekEnding) {
        throw new Error('Resource ID, name, and week ending date are required');
      }

      const expenseReportData = {
        resourceId,
        name,
        weekEnding,
        ...(status && { status }),
        ...(approverResourceId && { approverResourceId }),
        ...(submitDate && { submitDate })
      };

      const expenseReportId = await this.autotaskService.createExpenseReport(expenseReportData, tenantContext);
      
      return this.createCreationResponse('expense report', expenseReportId);
    } catch (error) {
      throw new Error(`Failed to create expense report: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateExpenseReport(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { 
        id, 
        name, 
        status, 
        approverResourceId, 
        submitDate, 
        weekEnding 
      } = args;
      
      if (!id || typeof id !== 'number') {
        throw new Error('Expense report ID is required and must be a number');
      }

      const updateData: any = {};
      
      if (name !== undefined) updateData.name = name;
      if (status !== undefined) updateData.status = status;
      if (approverResourceId !== undefined) updateData.approverResourceId = approverResourceId;
      if (submitDate !== undefined) updateData.submitDate = submitDate;
      if (weekEnding !== undefined) updateData.weekEnding = weekEnding;

      if (Object.keys(updateData).length === 0) {
        throw new Error('At least one field to update must be provided');
      }

      await this.autotaskService.updateExpenseReport(id, updateData, tenantContext);
      
      return this.createUpdateResponse('expense report', id);
    } catch (error) {
      throw new Error(`Failed to update expense report: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ===================================
  // Configuration Items Management  
  // ===================================

  private async getConfigurationItem(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { id } = args;
      
      if (!id || typeof id !== 'number') {
        throw new Error('Configuration item ID is required and must be a number');
      }

      const configItem = await this.autotaskService.getConfigurationItem(id, tenantContext);
      
      if (!configItem) {
        return this.createNotFoundResponse('configuration item', id);
      }

      return this.createDataResponse(configItem);
    } catch (error) {
      throw new Error(`Failed to get configuration item: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchConfigurationItems(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { companyId, configurationItemType, serialNumber, referenceTitle, searchTerm, pageSize } = args;
      
      // Build filter for configuration items search
      const filter: any[] = [];
      
      if (companyId) {
        filter.push({ field: 'companyID', op: 'eq', value: companyId });
      }
      
      if (configurationItemType !== undefined) {
        filter.push({ field: 'configurationItemType', op: 'eq', value: configurationItemType });
      }
      
      if (serialNumber) {
        filter.push({ field: 'serialNumber', op: 'contains', value: serialNumber });
      }
      
      if (referenceTitle) {
        filter.push({ field: 'referenceTitle', op: 'contains', value: referenceTitle });
      }
      
      if (searchTerm) {
        filter.push({ field: 'referenceTitle', op: 'contains', value: searchTerm });
      }
      
      // If no specific filters, get all configuration items
      if (filter.length === 0) {
        filter.push({ field: 'id', op: 'gte', value: 0 });
      }

      const queryOptions = {
        filter,
        ...(pageSize && { pageSize })
      };

      const configItems = await this.autotaskService.searchConfigurationItems(queryOptions, tenantContext);
      
      return this.createDataResponse(configItems);
    } catch (error) {
      throw new Error(`Failed to search configuration items: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createConfigurationItem(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { 
        companyID, 
        configurationItemType, 
        referenceTitle, 
        serialNumber, 
        installedProductID, 
        contactID, 
        location, 
        notes 
      } = args;
      
      if (!companyID || !configurationItemType || !referenceTitle) {
        throw new Error('Company ID, configuration item type, and reference title are required');
      }

      const configItemData = {
        companyID,
        configurationItemType,
        referenceTitle,
        ...(serialNumber && { serialNumber }),
        ...(installedProductID && { installedProductID }),
        ...(contactID && { contactID }),
        ...(location && { location }),
        ...(notes && { notes })
      };

      const configItemId = await this.autotaskService.createConfigurationItem(configItemData, tenantContext);
      
      return this.createCreationResponse('configuration item', configItemId);
    } catch (error) {
      throw new Error(`Failed to create configuration item: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateConfigurationItem(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { 
        id, 
        referenceTitle, 
        serialNumber, 
        installedProductID, 
        contactID, 
        location, 
        notes 
      } = args;
      
      if (!id) {
        throw new Error('Configuration item ID is required');
      }

      const updateData: any = {};
      
      if (referenceTitle !== undefined) updateData.referenceTitle = referenceTitle;
      if (serialNumber !== undefined) updateData.serialNumber = serialNumber;
      if (installedProductID !== undefined) updateData.installedProductID = installedProductID;
      if (contactID !== undefined) updateData.contactID = contactID;
      if (location !== undefined) updateData.location = location;
      if (notes !== undefined) updateData.notes = notes;

      if (Object.keys(updateData).length === 0) {
        throw new Error('At least one field to update must be provided');
      }

      await this.autotaskService.updateConfigurationItem(id, updateData, tenantContext);
      
      return this.createUpdateResponse('configuration item', id);
    } catch (error) {
      throw new Error(`Failed to update configuration item: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ===================================
  // Pagination Helper Methods  
  // ===================================

  private async getCompaniesPage(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
             // This is essentially the same as searchCompanies but optimized for pagination
       const options: any = {
         page: args.page || 1,
         pageSize: Math.min(args.pageSize || 50, 2000) // Respect the new 2000 limit
       };
      
      if (args.searchTerm) {
        options.filter = [{
          field: 'companyName',
          op: 'contains',
          value: args.searchTerm
        }];
      }
      
      if (typeof args.isActive === 'boolean') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'isActive',
          op: 'eq',
          value: args.isActive
        });
      }

      const companies = await this.autotaskService.searchCompanies(options, tenantContext);
      
      // Enhanced results with mapped names
      const mappingService = await this.getMappingService();
      const enhancedCompanies = await Promise.all(
        companies.map(async (company: any) => {
          const enhanced: any = { ...company };
          
          // Add owner resource name if available
          if (company.ownerResourceID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.ownerResourceName = await mappingService.getResourceName(company.ownerResourceID);
            } catch (error) {
              this.logger.info(`Failed to map owner resource ID ${company.ownerResourceID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.ownerResourceName = `Unknown (${company.ownerResourceID})`;
            }
          }
          
          return enhanced;
        })
      );

      // Prepare pagination-aware response
      const currentPage = args.page || 1;
      const pageSize = args.pageSize || 50;
      const hasMore = enhancedCompanies.length === pageSize;
      
      let resultsText = `Companies (Page ${currentPage}, ${enhancedCompanies.length} results)`;
      
      if (hasMore) {
        resultsText += `\n📄 More results available - use get_companies_page with page=${currentPage + 1}`;
      }
      
      if (enhancedCompanies.length > 0) {
        resultsText += `:\n\n${enhancedCompanies.map(company => 
          `ID: ${company.id}\nName: ${company.companyName}\nType: ${company.companyType}\nActive: ${company.isActive}\nOwner: ${company._enhanced?.ownerResourceName || 'Unknown'}\n`
        ).join('\n')}`;
      } else {
        resultsText += '\n\nNo companies found on this page.';
        if (currentPage > 1) {
          resultsText += ` Try page=1 or adjust search criteria.`;
        }
      }

      return {
        content: [{
          type: 'text',
          text: resultsText
        }]
      };
    } catch (error) {
      throw new Error(`Failed to get companies page: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ===================================
  // Expense Items Management  
  // ===================================

  private async searchExpenseItems(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { expenseReportId, pageSize } = args;
      
      // ExpenseItems are child entities of ExpenseReports and require the parent ID
      if (!expenseReportId || typeof expenseReportId !== 'number') {
        throw new Error('Expense report ID is required for searching expense items (parent-child relationship)');
      }

      // Log tenant context usage like other search methods
      this.logger.info(`🏢 Searching expense items for expense report ${expenseReportId}`, {
        tenant: tenantContext,
        sessionId: tenantContext?.sessionId,
        expenseReportId,
        pageSize
      });

      // Build query options
      const queryOptions: any = {};
      if (pageSize) {
        queryOptions.pageSize = pageSize;
      }

      const expenseItems = await this.autotaskService.searchExpenseItems(expenseReportId, queryOptions, tenantContext);

      const resultsText = expenseItems.length > 0 
        ? `Found ${expenseItems.length} expense items in expense report ${expenseReportId}:\n\n${JSON.stringify(expenseItems, null, 2)}`
        : `No expense items found in expense report ${expenseReportId}`;

      return {
        content: [{
          type: 'text',
          text: resultsText
        }],
        isError: false
      };
    } catch (error) {
      throw new Error(`Failed to search expense items: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getExpenseItem(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { id, expenseReportId } = args;
      
      if (!id || typeof id !== 'number') {
        throw new Error('Expense item ID is required and must be a number');
      }

      // ExpenseItems are child entities requiring both expense report ID and item ID
      if (!expenseReportId || typeof expenseReportId !== 'number') {
        throw new Error('Expense report ID is required for accessing expense items (parent-child relationship)');
      }

      // Log tenant context usage like other get methods
      this.logger.info(`🏢 Getting expense item ${id} from expense report ${expenseReportId}`, {
        tenant: tenantContext,
        sessionId: tenantContext?.sessionId,
        expenseItemId: id,
        expenseReportId
      });

      const expenseItem = await this.autotaskService.getExpenseItem(expenseReportId, id, tenantContext);

      if (!expenseItem) {
        return this.createNotFoundResponse('expense item', { expenseReportId, id });
      }

      return this.createDataResponse(expenseItem);
    } catch (error) {
      throw new Error(`Failed to get expense item: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createExpenseItem(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { expenseReportID, ...itemData } = args;
      
      if (!expenseReportID || typeof expenseReportID !== 'number') {
        throw new Error('Expense report ID is required for creating expense items (parent-child relationship)');
      }

      // Log tenant context usage like other create methods
      this.logger.info(`🏢 Creating expense item in expense report ${expenseReportID}`, {
        tenant: tenantContext,
        sessionId: tenantContext?.sessionId,
        expenseReportId: expenseReportID,
        providedFields: Object.keys(args)
      });

      const expenseItemId = await this.autotaskService.createExpenseItem(expenseReportID, itemData, tenantContext);

      return this.createCreationResponse('expense item', expenseItemId);
    } catch (error) {
      throw new Error(`Failed to create expense item: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateExpenseItem(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const { id, expenseReportId, ...updateData } = args;
      
      if (!id || typeof id !== 'number') {
        throw new Error('Expense item ID is required');
      }

      if (!expenseReportId || typeof expenseReportId !== 'number') {
        throw new Error('Expense report ID is required for updating expense items (parent-child relationship)');
      }

      // Log tenant context usage like other update methods
      this.logger.info(`🏢 Updating expense item ${id}`, {
        tenant: tenantContext,
        sessionId: tenantContext?.sessionId,
        expenseItemId: id,
        expenseReportId: expenseReportId,
        updateFields: Object.keys(updateData)
      });

      if (Object.keys(updateData).length === 0) {
        throw new Error('At least one field to update must be provided');
      }

      await this.autotaskService.updateExpenseItem(expenseReportId, id, updateData, tenantContext);

      return this.createUpdateResponse('expense item', id);
    } catch (error) {
      throw new Error(`Failed to update expense item: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}