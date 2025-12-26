/**
 * Enhanced Autotask Tool Handler with ID-to-Name Mapping
 * Extends the base tool handler to include automatic mapping of company and resource IDs to names
 */

import { McpTool, McpToolResult } from '../types/mcp.js';
import { AutotaskService } from '../services/autotask.service.js';
import { Logger } from '../utils/logger.js';
import { MappingService } from '../utils/mapping.service.js';
import { AutotaskCredentials, TenantContext } from '../types/mcp.js'; 
import { PaginationEnforcer, buildPaginatedToolDescription } from '../core/pagination.js';
import { ApiCallTracker, ApiCallSummary } from '../utils/api-call-tracker.js'; 

export const LARGE_RESPONSE_THRESHOLDS = {
  tickets: 100,        
  companies: 100,     
  contacts: 100,     
  projects: 100,      
  resources: 100,     
  tasks: 100,          
  timeentries: 100,    
  default: 100,        
  responseSizeKB: 200  
};


/**
 * Tool name constants - centralized list of all available tools
 */
export const TOOL_NAMES = {
  // Company tools
  SEARCH_COMPANIES: 'search_companies',
  CREATE_COMPANY: 'create_company',
  UPDATE_COMPANY: 'update_company',
  
  // Contact tools
  SEARCH_CONTACTS: 'search_contacts',
  CREATE_CONTACT: 'create_contact',
  UPDATE_CONTACT: 'update_contact',
  
  // Ticket tools
  SEARCH_TICKETS: 'search_tickets',
  CREATE_TICKET: 'create_ticket',
  UPDATE_TICKET: 'update_ticket',
  GET_TICKET_BY_NUMBER: 'get_ticket_by_number',
  
  // Time Entry tools
  CREATE_TIME_ENTRY: 'create_time_entry',
  SEARCH_TIME_ENTRIES: 'search_time_entries',
  
  // Project tools
  SEARCH_PROJECTS: 'search_projects',
  CREATE_PROJECT: 'create_project',
  UPDATE_PROJECT: 'update_project',
  GET_PROJECT_DETAILS: 'get_project_details',
  
  // Resource tools
  SEARCH_RESOURCES: 'search_resources',
  
  // Task tools
  SEARCH_TASKS: 'search_tasks',
  CREATE_TASK: 'create_task',
  UPDATE_TASK: 'update_task',
  
  // Notes Management
  //SEARCH_TICKET_NOTES: 'search_ticket_notes',
  GET_TICKET_NOTE: 'get_ticket_note',
  CREATE_TICKET_NOTE: 'create_ticket_note',
  //SEARCH_PROJECT_NOTES: 'search_project_notes',
  GET_PROJECT_NOTE: 'get_project_note',
  CREATE_PROJECT_NOTE: 'create_project_note',
  //SEARCH_COMPANY_NOTES: 'search_company_notes',
  GET_COMPANY_NOTE: 'get_company_note',
  CREATE_COMPANY_NOTE: 'create_company_note',
  
  // Attachments Management
  //SEARCH_TICKET_ATTACHMENTS: 'search_ticket_attachments',
  GET_TICKET_ATTACHMENT: 'get_ticket_attachment',
  
  // Financial Management
  SEARCH_CONTRACTS: 'search_contracts',
  SEARCH_INVOICES: 'search_invoices',
  SEARCH_QUOTES: 'search_quotes',
  CREATE_QUOTE: 'create_quote',
  SEARCH_EXPENSE_REPORTS: 'search_expense_reports',
  CREATE_EXPENSE_REPORT: 'create_expense_report',
  UPDATE_EXPENSE_REPORT: 'update_expense_report',
  
  // Sales Management
  SEARCH_OPPORTUNITIES: 'search_opportunities',
  
  // Expense Items Management
  SEARCH_EXPENSE_ITEMS: 'search_expense_items',
  GET_EXPENSE_ITEM: 'get_expense_item',
  CREATE_EXPENSE_ITEM: 'create_expense_item',
  UPDATE_EXPENSE_ITEM: 'update_expense_item',
  
  // Configuration Items Management
  SEARCH_CONFIGURATION_ITEMS: 'search_configuration_items',
  CREATE_CONFIGURATION_ITEM: 'create_configuration_item',
  UPDATE_CONFIGURATION_ITEM: 'update_configuration_item',
  
  // Pagination Helper Tools
  GET_COMPANIES_PAGE: 'get_companies_page',
  
  // Generic Tools
  QUERY_ENTITY: 'query_entity',
  GET_ENTITY: 'get_entity',
  
  // Managed Services Tools
  GET_COMPANY_CATEGORIES: 'get_company_categories',
  FIND_CLIENTS_BY_CATEGORY: 'find_clients_by_category'
} as const;

/**
 * Read-only tools that don't modify data
 */
export const READ_ONLY_TOOLS = [
  TOOL_NAMES.SEARCH_COMPANIES,
  TOOL_NAMES.SEARCH_CONTACTS,
  TOOL_NAMES.SEARCH_TICKETS,
  TOOL_NAMES.SEARCH_PROJECTS,
  TOOL_NAMES.SEARCH_RESOURCES,
  TOOL_NAMES.SEARCH_TIME_ENTRIES,
  TOOL_NAMES.SEARCH_TASKS,
  TOOL_NAMES.GET_PROJECT_DETAILS,
  //TOOL_NAMES.GET_TICKET_NOTE,
  //TOOL_NAMES.GET_PROJECT_NOTE,
  //TOOL_NAMES.GET_COMPANY_NOTE,
  //TOOL_NAMES.SEARCH_TICKET_ATTACHMENTS,
  //TOOL_NAMES.GET_TICKET_ATTACHMENT,
  TOOL_NAMES.SEARCH_CONTRACTS,
  TOOL_NAMES.SEARCH_INVOICES,
  TOOL_NAMES.SEARCH_QUOTES,
  TOOL_NAMES.SEARCH_OPPORTUNITIES,
  //TOOL_NAMES.SEARCH_EXPENSE_REPORTS,
  //TOOL_NAMES.SEARCH_EXPENSE_ITEMS,
  //TOOL_NAMES.GET_EXPENSE_ITEM,
  //TOOL_NAMES.SEARCH_CONFIGURATION_ITEMS,
  TOOL_NAMES.QUERY_ENTITY,
  TOOL_NAMES.GET_ENTITY,
  TOOL_NAMES.GET_COMPANIES_PAGE,
  TOOL_NAMES.GET_TICKET_BY_NUMBER,
  TOOL_NAMES.GET_COMPANY_CATEGORIES,
  TOOL_NAMES.FIND_CLIENTS_BY_CATEGORY
] as const;

/**
 * Write tools that create new data
 */
export const WRITE_TOOLS = [
  TOOL_NAMES.CREATE_COMPANY,
  TOOL_NAMES.CREATE_CONTACT,
  TOOL_NAMES.CREATE_TICKET,
  TOOL_NAMES.CREATE_TIME_ENTRY,
  TOOL_NAMES.CREATE_TASK,
  TOOL_NAMES.CREATE_PROJECT,
  TOOL_NAMES.CREATE_TICKET_NOTE,
  TOOL_NAMES.CREATE_PROJECT_NOTE,
  TOOL_NAMES.CREATE_COMPANY_NOTE,
  TOOL_NAMES.CREATE_QUOTE,
  TOOL_NAMES.CREATE_EXPENSE_REPORT,
  TOOL_NAMES.CREATE_EXPENSE_ITEM,
  TOOL_NAMES.CREATE_CONFIGURATION_ITEM
] as const;

/**
 * Modify tools that update existing data
 */
export const MODIFY_TOOLS = [
  TOOL_NAMES.UPDATE_COMPANY,
  TOOL_NAMES.UPDATE_CONTACT,
  TOOL_NAMES.UPDATE_TICKET,
  TOOL_NAMES.UPDATE_TASK,
  TOOL_NAMES.UPDATE_PROJECT,
  TOOL_NAMES.UPDATE_EXPENSE_REPORT,
  TOOL_NAMES.UPDATE_EXPENSE_ITEM,
  TOOL_NAMES.UPDATE_CONFIGURATION_ITEM
] as const;

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

  /**
   * Get all available tool names
   * @returns Array of all tool names that are exposed
   */
  public static getAllToolNames(): string[] {
    return Object.values(TOOL_NAMES);
  }

  /**
   * Check if a tool name is valid
   * @param toolName Tool name to check
   * @returns True if the tool is exposed, false otherwise
   */
  public static isValidToolName(toolName: string): boolean {
    return Object.values(TOOL_NAMES).includes(toolName as any);
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
   * Pre-fetch and cache unique IDs to avoid cache stampede.
   * This must be called BEFORE parallel enhancement loops to ensure
   * all IDs are cached, preventing N parallel API calls for the same ID.
   * 
   * @param items - Array of items to extract IDs from
   * @param companyFields - Field names containing company IDs
   * @param resourceFields - Field names containing resource IDs
   * @param tenantContext - Tenant context for multi-tenant mode
   */
  private async prefetchMappingIds(
    items: any[],
    companyFields: string[],
    resourceFields: string[],
    tenantContext?: TenantContext
  ): Promise<void> {
    const mappingService = await this.getMappingService();
    
    // Collect unique company IDs
    const companyIds = new Set<number>();
    for (const item of items) {
      for (const field of companyFields) {
        if (item[field] && typeof item[field] === 'number') {
          companyIds.add(item[field]);
        }
      }
    }
    
    // Collect unique resource IDs
    const resourceIds = new Set<number>();
    for (const item of items) {
      for (const field of resourceFields) {
        if (item[field] && typeof item[field] === 'number') {
          resourceIds.add(item[field]);
        }
      }
    }
    
    // Pre-fetch unique IDs (this populates the cache BEFORE the parallel loop)
    // Fetch sequentially to avoid rate limiting - cache will make subsequent lookups instant
    if (companyIds.size > 0) {
      this.logger.debug(`Pre-fetching ${companyIds.size} unique company IDs for enhancement`);
      for (const id of companyIds) {
        await mappingService.getCompanyName(id, tenantContext);
      }
    }
    
    if (resourceIds.size > 0) {
      this.logger.debug(`Pre-fetching ${resourceIds.size} unique resource IDs for enhancement`);
      for (const id of resourceIds) {
        await mappingService.getResourceName(id, tenantContext);
      }
    }
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
          text: `\n\nSearch Guidance: ${guidanceMessage}`
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
     

    // Check if tenant credentials are provided in the arguments
    if (args._tenant || args.tenant || args.credentials) {
      const tenantData = args._tenant || args.tenant || args.credentials;
       
      
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
  private getToolOperationType(toolName: string): 'read' | 'write' | 'modify'| 'hidden'  {
    if (READ_ONLY_TOOLS.includes(toolName as any)) {
      return 'read';
    } else if (WRITE_TOOLS.includes(toolName as any)) {
      return 'write';
    } else if (MODIFY_TOOLS.includes(toolName as any)) {
      return 'modify';
    }
    
    // Default to read for unknown tools (shouldn't happen with proper validation) 
    return 'hidden';
  }

  async listTools(tenantContext?: TenantContext): Promise<McpTool[]> {
    const allTools = [
      // Company tools
      EnhancedAutotaskToolHandler.createTool(
        'search_companies',
        buildPaginatedToolDescription(
        'Search for companies (customers, prospects, vendors) in Autotask with advanced filtering and enhanced name resolution. Companies are the core business entities in Autotask - they represent customers who receive services, prospects for sales, vendors who provide services, or partners. Returns comprehensive company records including ID, name, type, owner assignment, contact information, and address details. Use this to find specific companies for ticket creation, contact management, project assignment, or reporting. Essential for customer relationship management and business operations. Enhanced with automatic owner resource name mapping for better readability.',
          'companies'
        ),
        'read',
        {
          searchTerm: {
            type: 'string',
            description: 'Search term to filter companies by name using partial matching (case-insensitive). Searches the companyName field. Use for finding companies when you know part of their name. Examples: "Microsoft" finds "Microsoft Corporation", "Acme" finds "Acme Industries LLC". Essential for user-friendly company lookup when exact names are unknown. Combine with other filters to narrow results further.'
          },
          companyType: {
            type: 'number',
            description: 'Filter by company type classification. Values: 1=Customer (active service recipient), 2=Lead (potential customer, early sales stage), 3=Prospect (qualified potential customer), 4=Dead (disqualified prospect), 5=Suspect (unqualified potential), 6=Vendor (service/product provider). Essential for segmenting companies by business relationship. Example: companyType=1 finds all customers, companyType=6 finds all vendors.'
          },
          ownerResourceID: {
            type: 'number',
            description: 'Filter by owner resource ID - refers to Resources entity (account manager/sales rep). Find all companies managed by a specific person. Essential for territory management, account manager dashboards, workload distribution. Example: ownerResourceID=123 shows all companies owned by employee #123.'
          },
          isActive: {
            type: 'boolean',
            description: 'Filter by active status to control which companies appear in results. TRUE returns only active companies (current customers/prospects), FALSE returns only inactive companies (former customers, closed prospects). Active companies can have tickets, projects, and contracts assigned. Inactive companies are typically kept for historical records. Most operational searches should use TRUE. Use FALSE for cleanup or historical analysis.'
          },
          city: {
            type: 'string',
            description: 'Filter by city name (partial match supported). Use for geographical filtering, territory management, or regional reporting. Example: city="New York" finds all companies in New York City. Combine with state/country for more precise location filtering.'
          },
          state: {
            type: 'string',
            description: 'Filter by state/province (partial match supported). Use for regional filtering or territory-based searches. Example: state="CA" finds all California companies. Important for regional sales, service territories, and compliance reporting.'
          },
          country: {
            type: 'string',
            description: 'Filter by country name or code (partial match supported). Use for international operations, multi-country reporting, or region-specific analysis. Example: country="United States" or country="US". Essential for global operations.'
          },
          pageSize: {
            type: 'number',
            description: 'LIMIT results returned (default: 100, max: 500). This does NOT support pagination to specific pages - Autotask uses cursor-based pagination. To find specific companies: 1) Use get_entity with company ID for direct lookup, 2) Use searchTerm to filter by name, 3) Add filters (ownerResourceID, companyType, isActive, etc.) to narrow results. DO NOT request large pageSizes - instead use specific filters to reduce the dataset.',
            minimum: 1,
            maximum: 500,
            default: 100
          }
        }
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_company',
        'Create a new company record in Autotask system. Companies represent business entities that can be customers (service recipients), prospects (potential customers), vendors (service providers), or partners. Creating a company establishes the foundation for all business relationships including contacts, tickets, projects, contracts, and billing. Returns the newly created company ID for immediate use in other operations. Essential for onboarding new customers, registering prospects, or adding vendor relationships.',
        'write',
        {
          companyName: {
            type: 'string',
            description: 'Official company name (REQUIRED). This becomes the primary identifier for the business entity. Should be the legal business name or commonly recognized name. Examples: "Microsoft Corporation", "Acme Industries LLC", "John Doe Consulting". Used in reports, tickets, invoices, and all customer communications. Choose carefully as this impacts all future references.'
          },
          companyType: {
            type: 'number',
            description: 'Company type classification (REQUIRED) - determines how the company is treated in the system. Values: 1=Customer (active service recipient, can have tickets/projects), 2=Lead (potential customer, early sales stage), 3=Prospect (qualified potential customer, active sales process), 4=Dead (disqualified prospect, historical record), 5=Suspect (unqualified potential customer), 6=Vendor (service/product provider to your organization). Choose based on business relationship and sales stage.'
          },
          phone: {
            type: 'string',
            description: 'Primary business phone number. Format can be flexible but consider standardization for consistency. Used for customer communications, emergency contacts, and business correspondence. Include country code for international companies. Example: "+1-555-123-4567" or "(555) 123-4567".'
          },
          fax: {
            type: 'string',
            description: 'Business fax number (if still used). Optional field as fax usage has declined. Include if company specifically requires fax communications or for compliance reasons. Use same formatting standards as phone numbers.'
          },
          address1: {
            type: 'string',
            description: 'Primary street address line 1. Street number and name, suite/building information. Used for service delivery, billing, legal correspondence, and on-site support. Example: "123 Main Street, Suite 456". Essential for companies requiring physical service delivery.'
          },
          address2: {
            type: 'string',
            description: 'Additional address information (optional). Secondary address details like apartment numbers, floor information, building names, or special delivery instructions. Example: "Building C, Floor 3", "Attention: IT Department".'
          },
          city: {
            type: 'string',
            description: 'City or municipality name. Used for geographical organization, service territory assignment, and logistics planning. Impacts time zone considerations and local service provider assignments.'
          },
          state: {
            type: 'string',
            description: 'State, province, or regional designation. Important for tax calculations, service territories, and legal jurisdiction. Use standard abbreviations for consistency (e.g., "CA" for California, "ON" for Ontario).'
          },
          postalCode: {
            type: 'string',
            description: 'Postal code, ZIP code, or equivalent regional identifier. Critical for service routing, shipping, and geographical reporting. Impacts local service provider assignments and delivery logistics.'
          },
          country: {
            type: 'string',
            description: 'Country name or code. Essential for international operations, currency considerations, time zone management, and compliance requirements. Use standard country codes (ISO) for consistency.'
          },
          ownerResourceID: {
            type: 'number',
            description: 'Resource ID of the employee/user who owns/manages this company relationship - refers to Resources entity. The owner is responsible for the business relationship, typically an account manager, sales rep, or customer success manager. This person receives notifications and is the primary contact for company-related activities. Choose based on territory, expertise, or existing relationships.'
          }
        },
        ['companyName', 'companyType']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_company',
        'Update an existing company in Autotask. Requires company ID from Companies entity.',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Company ID to update - refers to Companies entity'
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
            description: 'Owner resource ID - refers to Resources entity (employee/user who owns this company)'
          }
        },
        ['id']
      ),

      // Contact tools
                  EnhancedAutotaskToolHandler.createTool(
              'search_contacts',
              buildPaginatedToolDescription(
              'Search for individual contacts (people) within companies in Autotask with comprehensive filtering. Contacts represent real people who work for or are associated with companies - they are the human touchpoints for business relationships. Returns detailed contact records including personal information, role details, communication preferences, and their company associations. Use this to find specific people for ticket assignment, communication, project coordination, or relationship management. Essential for customer service, support escalation, and business communications. Enhanced with automatic company name mapping for better context.',
                'contacts'
              ),
              'read',
              {
                searchTerm: {
                  type: 'string',
                  description: 'Search term to filter contacts by name or email using partial matching (case-insensitive). Searches across firstName, lastName, and emailAddress fields simultaneously. Examples: "john" finds "John Smith" and "Johnny Doe", "smith@" finds all Smith email addresses. Essential for finding contacts when you know part of their name or email. More flexible than individual field searches.'
                },
                companyId: {
                  type: 'number',
                  description: 'Filter by specific company ID - refers to Companies entity. Use to find all contacts within a particular company/organization. Essential for: company directory listings, team communications, project staffing, or when you need to contact someone at a specific customer site. Combine with searchTerm to find specific people within large organizations. Example: companyId=123 returns all contacts at Acme Industries.'
                },
                isActive: {
                  type: 'boolean',
                  description: 'Filter by active status to control contact availability. TRUE returns only active contacts (current employees, available for communication), FALSE returns inactive contacts (former employees, disabled accounts). Active contacts can receive tickets, notifications, and communications. Inactive contacts are kept for historical records. Most operational searches should use TRUE unless doing cleanup or historical analysis.'
                },
                page: {
                  type: 'number',
                  description: 'Page number (1-indexed) for pagination. CRITICAL: Check _paginationProtocol.status in the response. If status is INCOMPLETE, you MUST call again with the next page number. Continue until status is COMPLETE before performing any analysis.',
                  minimum: 1,
                  default: 1
                },
                pageSize: {
                  type: 'number',
                  description: 'Number of contact records per page (max 500). Default 500 for comprehensive results. Use with page parameter for pagination.',
                  minimum: 1,
                  maximum: 500,
                  default: 500
                }
              }
            ),
      EnhancedAutotaskToolHandler.createTool(
        'create_contact',
        'Create a new contact (person) record associated with a company in Autotask. Contacts represent individual people who work for or are associated with companies - they are the human interfaces for business relationships. Creating contacts enables ticket assignment, communication tracking, project coordination, and relationship management. Returns the newly created contact ID for immediate use in tickets, projects, and communications. Essential for establishing proper communication channels and accountability in customer relationships.',
        'write',
        {
          companyID: {
            type: 'number',
            description: 'Company ID that this contact belongs to (REQUIRED) - refers to Companies entity. Every contact must be associated with a company, even for individual consultants (create a company first). This establishes the business relationship context and determines access permissions, billing relationships, and organizational hierarchy. The company must already exist in the system before creating contacts.'
          },
          firstName: {
            type: 'string',
            description: 'Contact\'s first name (REQUIRED). Personal identifier used in communications, greetings, and personal recognition. Examples: "John", "Mary", "Dr. Robert". Used in email salutations, phone greetings, and all personal communications. Important for building professional relationships and personal recognition.'
          },
          lastName: {
            type: 'string',
            description: 'Contact\'s last name (REQUIRED). Family name or surname used for formal identification and sorting. Examples: "Smith", "Johnson", "Van Der Berg". Combined with firstName for full identification. Used in formal communications, directory listings, and official correspondence. Essential for professional identification.'
          },
          emailAddress: {
            type: 'string',
            description: 'Primary email address for business communications. Used for ticket notifications, project updates, system alerts, and general business correspondence. Should be the person\'s preferred business email. Critical for automated communications and ticket routing. Validate format to ensure deliverability. Example: "john.smith@company.com".'
          },
          phone: {
            type: 'string',
            description: 'Primary business or mobile phone number. Used for urgent communications, escalations, and direct contact when email is insufficient. Include country code for international contacts. Consider time zones for contact preferences. Format flexibly but consistently. Examples: "+1-555-123-4567", "(555) 123-4567".'
          },
          title: {
            type: 'string',
            description: 'Professional job title or role within the organization. Helps identify decision-making authority, technical expertise, and appropriate communication level. Examples: "IT Manager", "CEO", "Senior Developer", "Procurement Specialist". Important for escalation paths and role-appropriate communications.'
          }
        },
        ['companyID', 'firstName', 'lastName']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_contact',
        'Update an existing contact in Autotask. Requires contact ID from Contacts entity.',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Contact ID to update - refers to Contacts entity'
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
              buildPaginatedToolDescription(
              'Search for support tickets (service requests, incidents, problems) in Autotask with comprehensive filtering capabilities. Tickets represent customer service requests, technical issues, incidents, or any work that needs to be tracked and resolved. Returns detailed ticket records including status, priority, assignment, descriptions, and associated relationships (company, contact, project, contract). Use this for service desk operations, workload management, reporting, escalation tracking, and customer service analysis. Essential for support operations, SLA monitoring, and customer satisfaction management. Enhanced with automatic name mapping for better readability.',
                'tickets'
              ),
              'read',
              {
                searchTerm: {
                  type: 'string',
                  description: 'Search term to filter tickets by ticket number (exact: T20250914.0008) or title content (partial matching). Ticket numbers are unique identifiers assigned automatically. Title searches look within ticket descriptions and subjects. Examples: "T20250914.0008" finds exact ticket, "email" finds all tickets with email-related issues, "server down" finds server outage tickets. Essential for finding specific tickets or issues by topic.'
                },
                status: {
                  type: 'number',
                  description: 'Filter by ticket status ID to focus on tickets in specific workflow stages. Values: 1=New (just created, not assigned), 2=In Progress (actively being worked), 3=Customer Reply Needed (waiting for customer response), 4=Waiting Customer (customer action required), 5=Complete (resolved and closed), 8=On Hold (temporarily suspended), 9=Escalate (needs management attention), 29=Waiting Materials (pending parts/resources). Critical for workload management and SLA tracking.'
                },
                priority: {
                  type: 'number',
                  description: 'Filter by ticket priority level indicating urgency and business impact. Values: 1=Critical (system down, business stopped, immediate attention required), 2=High (significant impact, work hampered), 3=Medium (standard priority, normal workflow), 4=Low (minor issue, convenience item). Priority affects SLA timelines, escalation procedures, and resource allocation. Essential for finding urgent tickets or filtering by severity.'
                },
                companyID: {
                  type: 'number',
                  description: 'Filter by specific company ID - refers to Companies entity. Shows only tickets submitted by or for a particular customer/company. Essential for: customer-specific support dashboards, account management, billing analysis, company-focused reporting. Use when you need to see all support activity for a specific customer or when troubleshooting company-wide issues.'
                },
                projectID: {
                  type: 'number',
                  description: 'Filter by specific project ID - refers to Projects entity. Shows tickets that are part of or related to a specific project. Project tickets often represent implementation issues, change requests, or project-specific support. Use for: project management, implementation tracking, project-related issue monitoring. Helps separate project work from general support.'
                },
                contractID: {
                  type: 'number',
                  description: 'Filter by specific contract ID - refers to Contracts entity. Shows tickets covered under a particular service contract or support agreement. Critical for: contract compliance monitoring, billable vs. non-billable work separation, SLA enforcement, contract utilization analysis. Use when tracking contract performance or billing accuracy.'
                },
                assignedResourceID: {
                  type: 'number',
                  description: 'Filter by specific assigned resource ID - refers to Resources entity (technician/employee assigned to ticket). Shows tickets assigned to a particular team member. Essential for: individual workload monitoring, performance tracking, capacity planning, escalation management. Use for technician-specific dashboards or workload balancing. Combine with status filters for detailed workload analysis.'
                },
                unassigned: {
                  type: 'boolean',
                  description: 'Filter for unassigned tickets requiring attention. TRUE returns only tickets with no assigned technician (need assignment), FALSE returns only assigned tickets. Unassigned tickets represent work that needs to be distributed to team members. Critical for: work distribution, ensuring no tickets are overlooked, queue management, workload balancing. Use TRUE to find tickets needing assignment.'
                },
                createdDateFrom: {
                  type: 'string',
                  description: 'Filter tickets created on or after this date (YYYY-MM-DD format). Use for time-bounded reporting like "tickets created this month" or trend analysis. Example: "2024-01-01" finds tickets created since January 1st. Combine with createdDateTo for specific date ranges. Essential for historical analysis and reporting periods.'
                },
                createdDateTo: {
                  type: 'string',
                  description: 'Filter tickets created on or before this date (YYYY-MM-DD format). Works with createdDateFrom to create date ranges. Example: "2024-01-31" finds tickets up to end of January. Use for periodic reports, billing cycles, or historical analysis. Inclusive - tickets created ON this date are included.'
                },
                completedDateFrom: {
                  type: 'string',
                  description: 'Filter tickets completed (closed) on or after this date (YYYY-MM-DD format). Use for reporting on resolved tickets, calculating resolution metrics, or analyzing completed work. Example: "2024-01-01" finds tickets completed since January 1st. Combine with completedDateTo for specific completion date ranges. Essential for performance analysis, billing periods, and SLA compliance reporting.'
                },
                completedDateTo: {
                  type: 'string',
                  description: 'Filter tickets completed (closed) on or before this date (YYYY-MM-DD format). Works with completedDateFrom to create completion date ranges. Example: "2024-01-31" finds tickets completed by end of January. Use for periodic completion reports, analyzing past performance, or billing cycle analysis. Inclusive - tickets completed ON this date are included.'
                },
                lastActivityDateFrom: {
                  type: 'string',
                  description: 'Filter tickets with last activity (update, note, status change) on or after this date (YYYY-MM-DD format). Use to find recently active tickets, identify stale tickets, or track ticket aging. Example: "2024-01-01" finds tickets with activity since January 1st. Helpful for finding tickets that need attention or haven\'t been updated recently.'
                },
                lastActivityDateTo: {
                  type: 'string',
                  description: 'Filter tickets with last activity on or before this date (YYYY-MM-DD format). Use to find tickets that haven\'t been updated recently (potentially stale), or for historical activity analysis. Example: "2024-01-01" finds tickets with no activity after January 1st. Combine with lastActivityDateFrom to find tickets inactive during specific periods.'
                },
                page: {
                  type: 'number',
                  description: 'Page number (1-indexed) for pagination. CRITICAL: Check _paginationProtocol.status in the response. If status is INCOMPLETE, you MUST call again with the next page number. Continue until status is COMPLETE before performing any analysis.',
                  minimum: 1,
                  default: 1
                },
                pageSize: {
                  type: 'number',
                  description: 'Number of ticket records per page (max 500). Default 500 for comprehensive results. Use with page parameter for pagination.',
                  minimum: 1,
                  maximum: 500,
                  default: 500
                }
              }
            ),
      EnhancedAutotaskToolHandler.createTool(
        'create_ticket',
        'Create a new support ticket (service request, incident, problem) in Autotask system. Tickets are the primary mechanism for tracking customer service requests, technical issues, incidents, or any work requiring resolution. Creating a ticket initiates the service delivery process and establishes accountability, tracking, and communication channels. Returns the newly created ticket ID for immediate reference and follow-up operations. Essential for formalizing customer requests, ensuring proper service delivery, and maintaining service level agreements.',
        'write',
        {
          companyID: {
            type: 'number',
            description: 'Company ID that this ticket belongs to (REQUIRED) - refers to Companies entity. Every ticket must be associated with a company to establish the customer relationship, billing context, and service agreements. This determines which contracts apply, SLA requirements, and support entitlements. The company must exist in the system before creating tickets.'
          },
          title: {
            type: 'string',
            description: 'Concise ticket title/subject (REQUIRED). This is the primary identifier users see in lists and reports. Should be descriptive enough to understand the issue at a glance. Examples: "Email server down", "Password reset for John Smith", "New laptop setup request". Keep concise but informative - used in dashboards, reports, and communications. Avoid vague titles like "Issue" or "Problem".'
          },
          description: {
            type: 'string',
            description: 'Detailed description of the issue, request, or work needed. Provide comprehensive information including: symptoms, error messages, steps to reproduce, business impact, user details, and any troubleshooting already attempted. This becomes the primary reference for technicians. Good descriptions speed resolution and reduce back-and-forth communication. Include relevant context and background information.'
          },
          priority: {
            type: 'number',
            description: 'Priority level indicating urgency and business impact. Values: 1=Critical (system down, business stopped, immediate attention), 2=High (significant impact, work hampered), 3=Medium (standard priority, normal workflow), 4=Low (minor issue, convenience item). Priority affects SLA timelines, escalation procedures, and resource allocation. Choose based on business impact, not personal preference.'
          },
          status: {
            type: 'number',
            description: 'Initial status for ticket workflow. Common values: 1=New (default for new tickets, awaiting assignment), 2=In Progress (actively being worked), 5=Complete (only if creating resolved tickets retroactively). Usually leave as default (New) unless creating historical tickets or specific workflow requirements. Status drives automated processes and notifications.'
          },
          assignedResourceID: {
            type: 'number',
            description: 'Resource ID of technician/employee to assign this ticket - refers to Resources entity. Assigns immediate ownership and responsibility. Use when you know the appropriate technician (skills, territory, availability). Leave empty for queue-based assignment through normal workflow. Assignment triggers notifications and adds to technician workload. Consider skills, availability, and workload balance.'
          },
          contactID: {
            type: 'number',
            description: 'Contact ID of the primary person for this ticket - refers to Contacts entity. This person receives notifications, communications, and updates about ticket progress. Should be the person reporting the issue or the primary stakeholder. Critical for proper communication flow and customer service. The contact must belong to the specified company.'
          }
        },
        ['companyID', 'title']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_ticket',
        'Update an existing ticket in Autotask. Requires ticket ID from Tickets entity.',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Ticket ID to update - refers to Tickets entity'
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
            description: 'Priority level. Common values: 1=Critical, 2=High, 3=Medium, 4=Low'
          },
          status: {
            type: 'number',
            description: 'Status ID. Common values: 1=New, 2=In Progress, 3=Customer Reply Needed, 4=Waiting Customer, 5=Complete'
          },
          assignedResourceID: {
            type: 'number',
            description: 'Assigned resource ID - refers to Resources entity (technician/employee assigned to ticket)'
          },
          resolution: {
            type: 'string',
            description: 'Ticket resolution description'
          }
        },
        ['id']
      ),

      // Time Entry tools
      EnhancedAutotaskToolHandler.createTool(
        'create_time_entry',
        'Log time against a ticket or project in Autotask. Returns the new time entry ID.',
        'write',
        {
          ticketID: {
            type: 'number',
            description: 'Ticket ID (if logging time against a ticket) - refers to Tickets entity. Use either ticketID or projectID, not both.'
          },
          projectID: {
            type: 'number',
            description: 'Project ID (if logging time against a project) - refers to Projects entity. Use either ticketID or projectID, not both.'
          },
          resourceID: {
            type: 'number',
            description: 'Resource ID (person logging time) - refers to Resources entity (employee/technician)'
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
            description: 'Hours worked (decimal format, e.g., 1.5 for 1 hour 30 minutes)'
          },
          summaryNotes: {
            type: 'string',
            description: 'Summary of work performed'
          },
          internalNotes: {
            type: 'string',
            description: 'Internal notes (not visible to client)'
          }
        },
        ['resourceID', 'dateWorked', 'hoursWorked']
      ),

      // Project tools
                  EnhancedAutotaskToolHandler.createTool(
              'search_projects',
              buildPaginatedToolDescription(
              'Search for projects in Autotask with advanced filtering. Returns project records with company and project manager information.',
                'projects'
              ),
              'read',
              {
                searchTerm: {
                  type: 'string',
                  description: 'Search term to filter projects by name (partial match supported). Searches the projectName field. Example: "Migration" finds "Server Migration", "Email Migration Project", etc.'
                },
                companyId: {
                  type: 'number',
                  description: 'Filter by company ID - refers to Companies entity. Find all projects for a specific customer/company. Essential for account management and customer-specific project tracking.'
                },
                status: {
                  type: 'number',
                  description: 'Filter by project status. Values: 1=New, 2=In Progress, 3=Complete, 4=Canceled, 5=On Hold. Use to focus on active projects (status=2) or review completed work (status=3). Critical for project portfolio management and resource planning.'
                },
                projectType: {
                  type: 'number',
                  description: 'Filter by project type (billing model). Values: 1=Fixed Price (set budget, fixed deliverables), 2=Time and Materials (hourly billing, flexible scope), 3=Retainer (pre-paid hours, ongoing support), 4=Internal (company projects, no billing). Essential for financial reporting, billing analysis, and project categorization. Example: projectType=2 finds all T&M projects.'
                },
                projectManagerResourceID: {
                  type: 'number',
                  description: 'Filter by project manager resource ID - refers to Resources entity (employee managing the project). Find all projects managed by a specific PM. Essential for: PM workload analysis, portfolio management by PM, capacity planning, performance tracking. Example: projectManagerResourceID=123 shows all projects managed by employee #123.'
                },
                page: {
                  type: 'number',
                  description: 'Page number (1-indexed) for pagination. CRITICAL: Check _paginationProtocol.status in the response. If status is INCOMPLETE, you MUST call again with the next page number.',
                  minimum: 1,
                  default: 1
                },
                pageSize: {
                  type: 'number',
                  description: 'Number of results per page (max 500). Default 500 for comprehensive results.',
                  minimum: 1,
                  maximum: 500,
                  default: 500
                }
              }
            ),

      // Resource tools
                  EnhancedAutotaskToolHandler.createTool(
              'search_resources',
              buildPaginatedToolDescription(
              'Search for resources (employees) in Autotask. Returns employee/user records.',
                'resources'
              ),
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
                  description: 'Filter by active status (true for active employees, false for inactive)'
                },
                page: {
                  type: 'number',
                  description: 'Page number (1-indexed) for pagination. CRITICAL: Check _paginationProtocol.status in the response. If status is INCOMPLETE, you MUST call again with the next page number.',
                  minimum: 1,
                  default: 1
                },
                pageSize: {
                  type: 'number',
                  description: 'Number of results per page (max 500). Default 500 for comprehensive results.',
                  minimum: 1,
                  maximum: 500,
                  default: 500
                }
              }
            ),

      // Individual Entity Getters
      EnhancedAutotaskToolHandler.createTool(
        'get_ticket_by_number',
        'Get a specific ticket by ticket number (e.g., T20250914.0008) with full details from Tickets entity. Use get_entity for retrieving by ID.',
        'read',
        {
          ticketNumber: {
            type: 'string',
            description: 'Ticket number to retrieve (e.g., T20250914.0008) - refers to ticketNumber field in Tickets entity'
          },
          fullDetails: {
            type: 'boolean',
            description: 'Whether to include full details (default: false for optimized response)'
          }
        },
        ['ticketNumber']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_project',
        'Create a new project in Autotask. Returns the new project ID.',
        'write',
        {
          companyID: {
            type: 'number',
            description: 'Company ID for the project (required) - refers to Companies entity'
          },
          projectName: {
            type: 'string',
            description: 'Project name (required)'
          },
          description: {
            type: 'string',
            description: 'Project description'
          },
          status: {
            type: 'number',
            description: 'Project status ID. Common values: 1=New, 2=In Progress, 3=Complete, 4=Canceled, 5=On Hold'
          },
          projectType: {
            type: 'number',
            description: 'Project type ID. Common values: 1=Fixed Price, 2=Time and Materials, 3=Retainer, 4=Internal'
          },
          projectManagerResourceID: {
            type: 'number',
            description: 'Project manager resource ID - refers to Resources entity (employee managing this project)'
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
        'Update an existing project in Autotask. Requires project ID from Projects entity.',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Project ID to update - refers to Projects entity'
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
            description: 'Project status ID. Common values: 1=New, 2=In Progress, 3=Complete, 4=Canceled, 5=On Hold'
          },
          projectManagerResourceID: {
            type: 'number',
            description: 'Project manager resource ID - refers to Resources entity (employee managing this project)'
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
        buildPaginatedToolDescription(
        'Search for time entries in Autotask with comprehensive filtering options. To find time entries for a project, get tasks or tickets first. Time entries represent work logged by employees/technicians against tickets, tasks, or projects. Returns detailed time entry records including duration, billing information, work descriptions, and associated entity relationships (ticket/task/project/resource). Use this to find logged work hours, track employee productivity, analyze project time allocation, generate billing reports, or audit time tracking. Default behavior returns last 30 days of entries if no filters specified.',
          'time entries'
        ),
        'read',
        {
          ticketID: {
            type: 'number',
            description: 'Filter by specific ticket ID - refers to Tickets entity. Use when you want time entries logged against a particular support ticket or service request. Example: Find all hours worked on ticket #12345 to understand total effort spent resolving that issue. Combines well with resourceId to see who worked on the ticket and dateFrom/dateTo to see work over time periods.'
          },
          taskID: {
            type: 'number',
            description: 'Filter by specific task ID - refers to Tasks entity (project tasks). Use when you want time entries for a particular project task or deliverable. Example: Find hours logged against "Database Migration" task to track progress and resource allocation. Tasks are typically part of projects, so this gives more granular tracking than projectId alone. Often used with projectId context.'
          },
          resourceID: {
            type: 'number',
            description: 'Filter by specific resource ID - refers to Resources entity (employee/technician/consultant). Use to find all time entries logged by a particular person. Essential for: employee productivity reports, timesheet verification, billable hours tracking per person, workload analysis. Example: Get all time entries for John Doe (resourceId: 123) to generate his monthly timesheet or analyze his work distribution across projects.'
          },
          dateFrom: {
            type: 'string',
            description: 'Start date filter (YYYY-MM-DD format). Filters time entries by the dateWorked field - the actual date work was performed, not when it was logged. Use to create time-bounded reports like "March 2024 timesheet" or "last quarter billing". Essential for payroll periods, billing cycles, project phase analysis. Example: "2024-03-01" to start from March 1st. Commonly paired with dateTo for ranges.'
          },
          dateTo: {
            type: 'string',
            description: 'End date filter (YYYY-MM-DD format). Works with dateFrom to create date ranges. Without dateFrom, gets all entries up to this date. Essential for: monthly/quarterly reports, billing cutoffs, project phase completions. Example: "2024-03-31" to end at March 31st. Use inclusive date logic (entries ON the dateTo are included).'
          },
          page: {
            type: 'number',
            description: 'Page number (1-indexed) for pagination. CRITICAL: Check _paginationProtocol.status in the response. If status is INCOMPLETE, you MUST call again with the next page number. Continue until status is COMPLETE before performing any analysis.',
            minimum: 1,
            default: 1
          },
          pageSize: {
            type: 'number',
            description: 'Number of results per page (max 500). Default 500 for comprehensive results. Time entry searches can return large datasets. Use with page parameter for pagination.',
            minimum: 1,
            maximum: 500,
            default: 500
          }
        }
      ),

      // Task Management
      EnhancedAutotaskToolHandler.createTool(
        'search_tasks',
        buildPaginatedToolDescription(
        'Search for tasks in Autotask with comprehensive filtering. Returns task records with project, resource, and priority information. Essential for task management, deadline tracking, and workload planning.',
          'tasks'
        ),
        'read',
        {
          projectId: {
            type: 'number',
            description: 'Filter by project ID - refers to Projects entity. Find all tasks within a specific project. Essential for project-specific task tracking and project management dashboards.'
          },
          assignedResourceId: {
            type: 'number',
            description: 'Filter by assigned resource ID - refers to Resources entity (employee assigned to task). Find all tasks assigned to a specific person. Essential for individual workload management, capacity planning, and performance tracking.'
          },
          status: {
            type: 'number',
            description: 'Filter by task status. Values: 1=New (not started), 2=In Progress (actively worked), 3=Complete (finished), 4=Canceled, 5=On Hold. Use to focus on active tasks or review completed work. Critical for task management and progress tracking.'
          },
          priorityLabel: {
            type: 'string',
            description: 'Filter by task priority level. Values: "Critical" (urgent, immediate attention), "High" (important, near-term deadline), "Normal" (standard priority), "Low" (can be delayed). Essential for prioritizing work, finding urgent tasks, or balancing workloads. Example: priorityLabel="Critical" finds all critical-priority tasks.'
          },
          searchTerm: {
            type: 'string',
            description: 'Search term to filter tasks by title (partial match supported). Example: "Setup" finds "Email Setup", "Server Setup Task", etc. Use for finding tasks by keywords or topic.'
          },
          dueDateFrom: {
            type: 'string',
            description: 'Filter tasks with due date on or after this date (YYYY-MM-DD format). Use to find upcoming deadlines or overdue tasks. Example: dueDateFrom=today finds tasks due today or later. Essential for deadline tracking and schedule management. Combine with dueDateTo for date ranges.'
          },
          dueDateTo: {
            type: 'string',
            description: 'Filter tasks with due date on or before this date (YYYY-MM-DD format). Works with dueDateFrom to create date ranges. Example: dueDateTo=today finds overdue tasks and tasks due today. Critical for finding missed deadlines or near-term deliverables. Inclusive - tasks due ON this date are included.'
          },
          createdDateFrom: {
            type: 'string',
            description: 'Filter tasks created on or after this date (YYYY-MM-DD format). Use for time-bounded task analysis or tracking task creation trends. Example: "2024-01-01" finds tasks created since January 1st. Useful for project phase analysis or historical reporting.'
          },
          createdDateTo: {
            type: 'string',
            description: 'Filter tasks created on or before this date (YYYY-MM-DD format). Works with createdDateFrom for date ranges. Use for periodic reports or historical analysis. Example: "2024-01-31" finds tasks created through end of January.'
          },
          page: {
            type: 'number',
            description: 'Page number (1-indexed) for pagination. CRITICAL: Check _paginationProtocol.status in the response. If status is INCOMPLETE, you MUST call again with the next page number.',
            minimum: 1,
            default: 1
          },
          pageSize: {
            type: 'number',
            description: 'Number of results per page (max 500). Default 500 for comprehensive results.',
            minimum: 1,
            maximum: 500
          }
        }
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_task',
        'Create a new task in Autotask. Returns the new task ID.',
        'write',
        {
          projectID: {
            type: 'number',
            description: 'Project ID for the task (required) - refers to Projects entity'
          },
          title: {
            type: 'string',
            description: 'Task title (required)'
          },
          description: {
            type: 'string',
            description: 'Task description'
          },
          assignedResourceID: {
            type: 'number',
            description: 'Assigned resource ID - refers to Resources entity (employee assigned to task)'
          },
          status: {
            type: 'number',
            description: 'Task status ID. Common values: 1=New, 2=In Progress, 3=Complete, 4=Canceled, 5=On Hold'
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
            description: 'Priority label. Common values: "Critical", "High", "Normal", "Low"'
          }
        },
        ['projectID', 'title']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_task',
        'Update an existing task in Autotask. Requires task ID from Tasks entity.',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Task ID to update - refers to Tasks entity'
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
            description: 'Assigned resource ID - refers to Resources entity (employee assigned to task)'
          },
          status: {
            type: 'number',
            description: 'Task status ID. Common values: 1=New, 2=In Progress, 3=Complete, 4=Canceled, 5=On Hold'
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
        'Search for notes on a specific ticket. Returns note records from TicketNotes entity.',
        'read',
        {
          ticketID: {
            type: 'number',
            description: 'Ticket ID to search notes for (required) - refers to Tickets entity'
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
        'Get a specific ticket note by ticket ID and note ID from TicketNotes entity.',
        'read',
        {
          ticketID: {
            type: 'number',
            description: 'Ticket ID - refers to Tickets entity'
          },
          noteId: {
            type: 'number',
            description: 'Note ID - refers to TicketNotes entity'
          }
        },
        ['ticketID', 'noteId']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_ticket_note',
        'Create a new note on a ticket. Returns the new note ID.',
        'write',
        {
          ticketID: {
            type: 'number',
            description: 'Ticket ID to add note to (required) - refers to Tickets entity'
          },
          title: {
            type: 'string',
            description: 'Note title'
          },
          description: {
            type: 'string',
            description: 'Note content/description (required)'
          },
          noteType: {
            type: 'number',
            description: 'Note type ID. Common values: 1=General, 2=Summary, 3=Resolution, 4=Time Entry'
          },
          publish: {
            type: 'number',
            description: 'Publish setting. Values: 1=Internal Only, 2=All Autotask Users, 3=Client Portal'
          }
        },
        ['ticketID', 'description']
      ),

      EnhancedAutotaskToolHandler.createTool(
        'search_project_notes',
        'Search for notes on a specific project. Returns note records from ProjectNotes entity.',
        'read',
        {
          projectId: {
            type: 'number',
            description: 'Project ID to search notes for (required) - refers to Projects entity'
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
        'Get a specific project note by project ID and note ID from ProjectNotes entity.',
        'read',
        {
          projectId: {
            type: 'number',
            description: 'Project ID - refers to Projects entity'
          },
          noteId: {
            type: 'number',
            description: 'Note ID - refers to ProjectNotes entity'
          }
        },
        ['projectId', 'noteId']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_project_note',
        'Create a new note on a project. Returns the new note ID.',
        'write',
        {
          projectId: {
            type: 'number',
            description: 'Project ID to add note to (required) - refers to Projects entity'
          },
          title: {
            type: 'string',
            description: 'Note title'
          },
          description: {
            type: 'string',
            description: 'Note content/description (required)'
          },
          noteType: {
            type: 'number',
            description: 'Note type ID. Common values: 1=General, 2=Summary, 3=Resolution, 4=Time Entry'
          },
          publish: {
            type: 'number',
            description: 'Publish setting. Values: 1=Internal Only, 2=All Autotask Users, 3=Client Portal'
          }
        },
        ['projectId', 'description']
      ),

      EnhancedAutotaskToolHandler.createTool(
        'search_company_notes',
        'Search for notes on a specific company. Returns note records from CompanyNotes entity.',
        'read',
        {
          companyId: {
            type: 'number',
            description: 'Company ID to search notes for (required) - refers to Companies entity'
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
        'Get a specific company note by company ID and note ID from CompanyNotes entity.',
        'read',
        {
          companyId: {
            type: 'number',
            description: 'Company ID - refers to Companies entity'
          },
          noteId: {
            type: 'number',
            description: 'Note ID - refers to CompanyNotes entity'
          }
        },
        ['companyId', 'noteId']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_company_note',
        'Create a new note on a company. Returns the new note ID.',
        'write',
        {
          companyId: {
            type: 'number',
            description: 'Company ID to add note to (required) - refers to Companies entity'
          },
          title: {
            type: 'string',
            description: 'Note title'
          },
          description: {
            type: 'string',
            description: 'Note content/description (required)'
          },
          noteType: {
            type: 'number',
            description: 'Note type ID. Common values: 1=General, 2=Summary, 3=Resolution, 4=Time Entry'
          },
          publish: {
            type: 'number',
            description: 'Publish setting. Values: 1=Internal Only, 2=All Autotask Users, 3=Client Portal'
          }
        },
        ['companyId', 'description']
      ),

      // Attachments Management  
      EnhancedAutotaskToolHandler.createTool(
        'search_ticket_attachments',
        'Search for attachments on a specific ticket. Returns attachment records from TicketAttachments entity.',
        'read',
        {
          ticketID: {
            type: 'number',
            description: 'Ticket ID to search attachments for (required) - refers to Tickets entity'
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
        'Get a specific ticket attachment by ticket ID and attachment ID from TicketAttachments entity.',
        'read',
        {
          ticketID: {
            type: 'number',
            description: 'Ticket ID - refers to Tickets entity'
          },
          attachmentId: {
            type: 'number',
            description: 'Attachment ID - refers to TicketAttachments entity'
          },
          includeData: {
            type: 'boolean',
            description: 'Whether to include base64-encoded file data (default: false for metadata only). Warning: including data may result in very large responses.'
          }
        },
        ['ticketID', 'attachmentId']
      ),

      // Financial Management
      EnhancedAutotaskToolHandler.createTool(
        'search_contracts',
        'Search for contracts in Autotask with filters. Returns contract records with company information.',
        'read',
        {
          companyId: {
            type: 'number',
            description: 'Filter by company ID - refers to Companies entity'
          },
          status: {
            type: 'number',
            description: 'Filter by contract status. Common values: 1=Inactive, 2=Active, 3=Complete'
          },
          contractType: {
            type: 'number',
            description: 'Filter by contract type. Common values: 1=Service, 2=Maintenance, 3=Block Hours, 4=Retainer, 5=Incident Response'
          },
          searchTerm: {
            type: 'string',
            description: 'Search term to filter contracts by name (partial match supported)'
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
        'search_invoices',
        'Search for invoices in Autotask with filters. Returns invoice records with company information.',
        'read',
        {
          companyId: {
            type: 'number',
            description: 'Filter by company ID - refers to Companies entity'
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
            description: 'Filter by invoice status. Common values: 1=Draft, 2=Sent, 3=Paid, 4=Void'
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
        'search_quotes',
        'Search for quotes in Autotask with filters. Returns quote records with company and contact information.',
        'read',
        {
          companyId: {
            type: 'number',
            description: 'Filter by company ID - refers to Companies entity'
          },
          contactId: {
            type: 'number',
            description: 'Filter by contact ID - refers to Contacts entity'
          },
          opportunityId: {
            type: 'number',
            description: 'Filter by opportunity ID - refers to Opportunities entity'
          },
          searchTerm: {
            type: 'string',
            description: 'Search term to filter quotes by description (partial match supported)'
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
        'Create a new quote in Autotask. Returns the new quote ID.',
        'write',
        {
          accountId: {
            type: 'number',
            description: 'Company/Account ID for the quote (required) - refers to Companies entity'
          },
          contactId: {
            type: 'number',
            description: 'Contact ID (required) - refers to Contacts entity'
          },
          opportunityId: {
            type: 'number',
            description: 'Opportunity ID (if related to an opportunity) - refers to Opportunities entity'
          },
          title: {
            type: 'string',
            description: 'Quote title (required)'
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
            description: 'Payment terms ID. Common values: 1=Net 10, 2=Net 15, 3=Net 30, 4=Net 45, 5=Net 60, 6=Due on Receipt'
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

      // Sales Management Tools
      EnhancedAutotaskToolHandler.createTool(
        'search_opportunities',
        buildPaginatedToolDescription(
          'Search for sales opportunities in Autotask with advanced filtering. Opportunities represent potential sales, deals in the pipeline, or business development initiatives. Returns comprehensive opportunity records including title, status, stage, amount, probability, owner, and associated company/contact information. Use this for sales pipeline management, forecasting, deal tracking, and revenue analysis. Essential for sales operations, business development, and revenue planning.',
          'opportunities'
        ),
        'read',
        {
          searchTerm: {
            type: 'string',
            description: 'Search term to filter opportunities by title (partial match supported). Searches the title field. Example: "Migration" finds "Server Migration Deal", "Cloud Migration Opportunity", etc. Use for finding opportunities when you know part of the deal name.'
          },
          companyId: {
            type: 'number',
            description: 'Filter by company ID - refers to Companies entity. Find all sales opportunities for a specific customer or prospect. Essential for account-level sales tracking and customer relationship management.'
          },
          status: {
            type: 'number',
            description: 'Filter by opportunity status. Common values: 0=Inactive, 1=Open (active pursuit), 2=Won (successfully closed), 3=Lost (unsuccessful). Use to focus on active deals (status=1) or analyze win/loss rates. Critical for pipeline management and sales forecasting.'
          },
          stage: {
            type: 'string',
            description: 'Filter by sales stage (pipeline stage name). Examples: "Qualification", "Proposal", "Negotiation", "Closed Won", "Closed Lost". Use to analyze opportunities at specific points in the sales cycle. Essential for pipeline velocity and stage-specific conversion analysis.'
          },
          ownerResourceID: {
            type: 'number',
            description: 'Filter by opportunity owner resource ID - refers to Resources entity (sales rep/account exec managing the opportunity). Find all opportunities owned by a specific salesperson. Essential for: sales rep performance tracking, quota management, territory analysis, individual pipeline reviews.'
          },
          leadReferralSourceID: {
            type: 'number',
            description: 'Filter by lead source ID - tracks where the opportunity originated. Common sources: referrals, marketing campaigns, partnerships, cold outreach. Essential for marketing ROI analysis and lead source effectiveness tracking.'
          },
          minAmount: {
            type: 'number',
            description: 'Filter opportunities with amount greater than or equal to this value. Use for focusing on large deals or enterprise opportunities. Example: minAmount=50000 finds opportunities worth $50k or more. Essential for strategic deal tracking.'
          },
          maxAmount: {
            type: 'number',
            description: 'Filter opportunities with amount less than or equal to this value. Use for segmenting deals by size or focusing on specific deal tiers. Combine with minAmount for precise deal value ranges.'
          },
          createdDateFrom: {
            type: 'string',
            description: 'Filter opportunities created on or after this date (YYYY-MM-DD format). Use for time-bounded analysis like "opportunities created this quarter". Essential for trending and period-over-period comparisons.'
          },
          createdDateTo: {
            type: 'string',
            description: 'Filter opportunities created on or before this date (YYYY-MM-DD format). Combine with createdDateFrom for specific date ranges. Useful for quarterly reviews and historical analysis.'
          },
          projectedCloseDate: {
            type: 'string',
            description: 'Filter by projected close date (YYYY-MM-DD format). Find opportunities expected to close by a specific date. Critical for sales forecasting, quota planning, and revenue projections.'
          },
          page: {
            type: 'number',
            description: 'Page number (1-indexed) for pagination. CRITICAL: Check _paginationProtocol.status in the response. If status is INCOMPLETE, you MUST call again with the next page number. Continue until status is COMPLETE before performing any analysis.',
            minimum: 1,
            default: 1
          },
          pageSize: {
            type: 'number',
            description: 'Number of opportunity records per page (max 500). Default 500 for comprehensive results. Use with page parameter for pagination.',
            minimum: 1,
            maximum: 500,
            default: 500
          }
        }
      ),

      EnhancedAutotaskToolHandler.createTool(
        'search_expense_reports',
        'Search for expense reports in Autotask with filters. Returns expense report records with submitter information.',
        'read',
        {
          submitterId: {
            type: 'number',
            description: 'Filter by submitter resource ID - refers to Resources entity (employee who submitted the expense report)'
          },
          status: {
            type: 'number',
            description: 'Filter by expense report status. Common values: 1=New, 2=Submitted, 3=Approved, 4=Rejected, 5=Paid'
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
        'Create a new expense report in Autotask. Returns the new expense report ID.',
        'write',
        {
          resourceId: {
            type: 'number',
            description: 'Resource ID (submitter of the expense report) (required) - refers to Resources entity (employee)'
          },
          name: {
            type: 'string',
            description: 'Expense report name/title (required)'
          },
          weekEnding: {
            type: 'string',
            description: 'Week ending date (YYYY-MM-DD format) (required)'
          },
          status: {
            type: 'number',
            description: 'Initial status of the expense report. Common values: 1=New, 2=Submitted, 3=Approved, 4=Rejected, 5=Paid'
          },
          approverResourceId: {
            type: 'number',
            description: 'Approver resource ID - refers to Resources entity (employee who will approve this expense report)'
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
        'Update an existing expense report in Autotask. Requires expense report ID from ExpenseReports entity.',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Expense report ID to update - refers to ExpenseReports entity'
          },
          name: {
            type: 'string',
            description: 'Expense report name/title'
          },
          status: {
            type: 'number',
            description: 'Expense report status. Common values: 1=New, 2=Submitted, 3=Approved, 4=Rejected, 5=Paid'
          },
          approverResourceId: {
            type: 'number',
            description: 'Approver resource ID - refers to Resources entity (employee who will approve this expense report)'
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
        'Search for expense items in a specific expense report (parent-child relationship). Returns expense item records from ExpenseItems entity.',
        'read',
        {
          expenseReportId: {
            type: 'number',
            description: 'Expense report ID (required - parent entity) - refers to ExpenseReports entity'
          },
          companyId: {
            type: 'number',
            description: 'Filter by company ID - refers to Companies entity'
          },
          projectId: {
            type: 'number',
            description: 'Filter by project ID - refers to Projects entity'
          },
          taskID: {
            type: 'number',
            description: 'Filter by task ID - refers to Tasks entity'
          },
          ticketID: {
            type: 'number',
            description: 'Filter by ticket ID - refers to Tickets entity'
          },
          expenseCategory: {
            type: 'number',
            description: 'Filter by expense category. Common values: 1=Meals, 2=Lodging, 3=Transportation, 4=Entertainment, 5=Other'
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
        'Get a specific expense item by ID from an expense report (parent-child relationship). Returns expense item details from ExpenseItems entity.',
        'read',
        {
          id: {
            type: 'number',
            description: 'Expense item ID to retrieve - refers to ExpenseItems entity'
          },
          expenseReportId: {
            type: 'number',
            description: 'Expense report ID (required - parent entity) - refers to ExpenseReports entity'
          }
        },
        ['id', 'expenseReportId']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'create_expense_item',
        'Create a new expense item in Autotask. Returns the new expense item ID.',
        'write',
        {
          expenseReportID: {
            type: 'number',
            description: 'Expense report ID (required) - refers to ExpenseReports entity'
          },
          companyID: {
            type: 'number',
            description: 'Company ID (required) - refers to Companies entity'
          },
          description: {
            type: 'string',
            description: 'Expense description (required)'
          },
          expenseCategory: {
            type: 'number',
            description: 'Expense category ID (required). Common values: 1=Meals, 2=Lodging, 3=Transportation, 4=Entertainment, 5=Other'
          },
          expenseDate: {
            type: 'string',
            description: 'Expense date (YYYY-MM-DD format) (required)'
          },
          expenseCurrencyExpenseAmount: {
            type: 'number',
            description: 'Amount in expense currency (decimal format, e.g., 25.50)'
          },
          expenseCurrencyID: {
            type: 'number',
            description: 'Expense currency ID. Common values: 1=USD, 2=EUR, 3=GBP, 4=CAD'
          },
          projectID: {
            type: 'number',
            description: 'Project ID (if billable to project) - refers to Projects entity'
          },
          taskID: {
            type: 'number',
            description: 'Task ID (if billable to task) - refers to Tasks entity'
          },
          ticketID: {
            type: 'number',
            description: 'Ticket ID (if billable to ticket) - refers to Tickets entity'
          },
          isBillableToCompany: {
            type: 'boolean',
            description: 'Whether expense is billable to company (true/false)'
          },
          isReimbursable: {
            type: 'boolean',
            description: 'Whether expense is reimbursable (true/false)'
          },
          haveReceipt: {
            type: 'boolean',
            description: 'Whether receipt is available (true/false)'
          },
          paymentType: {
            type: 'number',
            description: 'Payment type ID. Common values: 1=Cash, 2=Check, 3=Credit Card, 4=Company Card'
          },
          workType: {
            type: 'number',
            description: 'Work type ID - refers to WorkTypes entity'
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
            description: 'GL code (general ledger code)'
          }
        },
        ['expenseReportID', 'companyID', 'description', 'expenseCategory', 'expenseDate']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'update_expense_item',
        'Update an existing expense item in an expense report (parent-child relationship). Requires expense item ID from ExpenseItems entity.',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Expense item ID to update - refers to ExpenseItems entity'
          },
          expenseReportId: {
            type: 'number',
            description: 'Expense report ID (recommended - parent entity) - refers to ExpenseReports entity'
          },
          description: {
            type: 'string',
            description: 'Expense description'
          },
          expenseCategory: {
            type: 'number',
            description: 'Expense category ID. Common values: 1=Meals, 2=Lodging, 3=Transportation, 4=Entertainment, 5=Other'
          },
          expenseDate: {
            type: 'string',
            description: 'Expense date (YYYY-MM-DD format)'
          },
          expenseCurrencyExpenseAmount: {
            type: 'number',
            description: 'Amount in expense currency (decimal format, e.g., 25.50)'
          },
          projectID: {
            type: 'number',
            description: 'Project ID (if billable to project) - refers to Projects entity'
          },
          taskID: {
            type: 'number',
            description: 'Task ID (if billable to task) - refers to Tasks entity'
          },
          ticketID: {
            type: 'number',
            description: 'Ticket ID (if billable to ticket) - refers to Tickets entity'
          },
          isBillableToCompany: {
            type: 'boolean',
            description: 'Whether expense is billable to company (true/false)'
          },
          isReimbursable: {
            type: 'boolean',
            description: 'Whether expense is reimbursable (true/false)'
          },
          haveReceipt: {
            type: 'boolean',
            description: 'Whether receipt is available (true/false)'
          },
          paymentType: {
            type: 'number',
            description: 'Payment type ID. Common values: 1=Cash, 2=Check, 3=Credit Card, 4=Company Card'
          },
          workType: {
            type: 'number',
            description: 'Work type ID - refers to WorkTypes entity'
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
            description: 'GL code (general ledger code)'
          }
        },
        ['id']
      ),

      // Configuration Items Management
      EnhancedAutotaskToolHandler.createTool(
        'search_configuration_items',
        'Search for configuration items in Autotask with filters. Returns configuration item records with company information.',
        'read',
        {
          companyId: {
            type: 'number',
            description: 'Filter by company ID - refers to Companies entity'
          },
          configurationItemType: {
            type: 'number',
            description: 'Filter by configuration item type. Common values: 1=Desktop, 2=Laptop, 3=Server, 4=Printer, 5=Network Device, 6=Software'
          },
          serialNumber: {
            type: 'string',
            description: 'Filter by serial number (partial match supported)'
          },
          referenceTitle: {
            type: 'string',
            description: 'Filter by reference title (partial match supported)'
          },
          searchTerm: {
            type: 'string',
            description: 'Search term to filter configuration items (partial match supported)'
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
        'Create a new configuration item in Autotask. Returns the new configuration item ID.',
        'write',
        {
          companyID: {
            type: 'number',
            description: 'Company ID for the configuration item (required) - refers to Companies entity'
          },
          configurationItemType: {
            type: 'number',
            description: 'Configuration item type ID (required). Common values: 1=Desktop, 2=Laptop, 3=Server, 4=Printer, 5=Network Device, 6=Software'
          },
          referenceTitle: {
            type: 'string',
            description: 'Reference title/name (required)'
          },
          serialNumber: {
            type: 'string',
            description: 'Serial number'
          },
          installedProductID: {
            type: 'number',
            description: 'Installed product ID - refers to Products entity'
          },
          contactID: {
            type: 'number',
            description: 'Contact ID - refers to Contacts entity (person responsible for this item)'
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
        'Update an existing configuration item in Autotask. Requires configuration item ID from ConfigurationItems entity.',
        'modify',
        {
          id: {
            type: 'number',
            description: 'Configuration item ID to update - refers to ConfigurationItems entity'
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
            description: 'Installed product ID - refers to Products entity'
          },
          contactID: {
            type: 'number',
            description: 'Contact ID - refers to Contacts entity (person responsible for this item)'
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
        'Get company name by ID from Companies entity.',
        'read',
        {
          id: {
            type: 'number',
            description: 'Company ID - refers to Companies entity'
          }
        },
        ['id']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_resource_name',
        'Get resource name by ID from Resources entity.',
        'read',
        {
          id: {
            type: 'number',
            description: 'Resource ID - refers to Resources entity (employee/user)'
          }
        },
        ['id']
      ),

      // Pagination helper tools
      EnhancedAutotaskToolHandler.createTool(
        'get_companies_page',
        'WARNING: Autotask API does NOT support jumping to specific pages - it uses cursor-based pagination. DO NOT try to paginate through many pages. Instead: 1) Use get_entity to retrieve a specific company by ID, 2) Use search_companies with specific filters (name, id, owner, etc.) to narrow results, 3) If you need to browse many companies, use searchTerm or isActive filters to reduce the dataset. This tool returns the FIRST page only - there is no reliable way to get subsequent pages. Pagination is STRONGLY DISCOURAGED - always prefer filtering to reduce results.',
        'read',
        {
          pageSize: {
            type: 'number',
            description: 'Number of companies to return (default: 50, max: 100 recommended). DO NOT use large page sizes - instead use filters to narrow results. If you need a specific company, use get_entity with the company ID.',
            minimum: 1,
            maximum: 100,
            default: 50
          },
          searchTerm: {
            type: 'string',
            description: 'RECOMMENDED: Filter companies by name (partial match). Example: "Microsoft" will find "Microsoft Corporation". Use this instead of pagination.'
          },
          isActive: {
            type: 'boolean',
            description: 'RECOMMENDED: Filter by active status (true for active companies, false for inactive). Use this instead of pagination.'
          }
        }
      ),



      // Generic GET Query Tool (URL parameter-based search)
      EnhancedAutotaskToolHandler.createTool(
        'query_entity',
        'Query any Autotask entity using simple text-based search (alternative to advanced POST-based search_* tools). Uses GET /V1.0/{Entity}/query endpoint with search parameter for quick lookups across entity text fields. This is simpler than the POST-based search tools but less flexible - use this for basic text searches, use search_* tools for advanced filtering with multiple criteria.',
        'read',
        {
          entity: {
            type: 'string',
            description: 'Entity type to query (required). Must be one of: companies, contacts, tickets, projects, resources, tasks, contracts, quotes, invoices, timeentries, configurationitems, expensereports'
          },
          search: {
            type: 'string',
            description: 'Search string to query the entity (required). Searches across relevant text fields like names, titles, descriptions, numbers, etc. Examples: "Microsoft", "john@email.com", "T20240001", "login issue"'
          },
          pageSize: {
            type: 'number',
            description: 'Number of results to return (default: 500, max: 500)'
          }
        },
        ['entity', 'search']
      ),
      EnhancedAutotaskToolHandler.createTool(
        'get_entity',
        'Get a specific entity by ID with full details. Works for any major Autotask entity type. This is a read-only operation that retrieves a single record.',
        'read',
        {
          entity: {
            type: 'string',
            description: 'Entity type to retrieve (required). Must be one of: companies, contacts, tickets, projects, resources, tasks, contracts, quotes, invoices, timeentries, configurationitems, expensereports'
          },
          id: {
            type: 'number',
            description: 'Entity ID to retrieve (required)'
          },
          fullDetails: {
            type: 'boolean',
            description: 'Whether to include full details (optional, only applicable to some entities like tickets for optimized responses)'
          }
        },
        ['entity', 'id']
      ), 
      EnhancedAutotaskToolHandler.createTool(
        'get_project_details',
        'Get comprehensive project details including tasks and time entries in a single optimized call. This tool efficiently fetches project information along with its associated tasks and time entries, minimizing data transfer by returning only essential fields. Perfect for project status reports, resource planning, and project analysis without multiple API calls. Returns project info, task summaries, and time entry summaries with minimal data overhead.',
        'read',
        {
          projectId: {
            type: 'number',
            description: 'Project ID to retrieve details for (REQUIRED) - refers to Projects entity. Use this to get comprehensive project information including all associated tasks and time entries in one efficient call.'
          },
          searchTerm: {
            type: 'string',
            description: 'Search term to find project by name (alternative to projectId). Searches projectName field using partial matching. Use when you know part of the project name but not the exact ID. Examples: "Website Redesign" finds "Website Redesign Phase 1".'
          },
          includeTasks: {
            type: 'boolean',
            description: 'Whether to include project tasks in the response (default: true). Set to false to exclude task data and reduce response size if only project info is needed.',
            default: true
          },
          includeTimeEntries: {
            type: 'boolean',
            description: 'Whether to include time entries in the response (default: true). Set to false to exclude time entry data and reduce response size if only project and task info is needed.',
            default: true
          },
          taskPageSize: {
            type: 'number',
            description: 'Number of tasks to return (default: 25, max: 100). Controls task data volume. Use smaller values for quick overviews, larger values for comprehensive task lists.',
            minimum: 1,
            maximum: 100,
            default: 25
          },
          timeEntryPageSize: {
            type: 'number',
            description: 'Number of time entries to return (default: 25, max: 100). Controls time entry data volume. Use smaller values for recent activity overviews, larger values for comprehensive time tracking analysis.',
            minimum: 1,
            maximum: 100,
            default: 25
          },
          timeEntryDateFrom: {
            type: 'string',
            description: 'Start date for time entries filter (YYYY-MM-DD format). Use to limit time entries to specific date ranges. Example: "2024-01-01" gets entries from January 1st onwards. Helps focus on recent or specific period activity.'
          },
          timeEntryDateTo: {
            type: 'string',
            description: 'End date for time entries filter (YYYY-MM-DD format). Use with timeEntryDateFrom to create date ranges. Example: "2024-12-31" gets entries up to December 31st. Helps focus on specific periods or recent activity.'
          }
        },
        []
      ),

      // Managed Services Tools - Using CompanyCategories entity
      EnhancedAutotaskToolHandler.createTool(
        'get_company_categories',
        'Get all available company categories from Autotask. This tool queries the CompanyCategories entity to show you the actual classification values available in your Autotask instance. Perfect for discovering what company categories/classifications exist before filtering clients. Returns category ID, name, nickname, and status information.',
        'read',
        {
          includeInactive: {
            type: 'boolean',
            description: 'Whether to include inactive categories (default: false). Set to true to see all categories including inactive ones.',
            default: false
          }
        },
        []
      ),

      EnhancedAutotaskToolHandler.createTool(
        'find_clients_by_category',
        'Find clients by company category with their related contracts. Uses the actual CompanyCategories from Autotask instead of guessing field types. Perfect for managed services teams to find clients in specific categories like "MCS" or other managed services categories. Returns comprehensive client information including contact details and associated contract analysis.',
        'read',
        {
          categoryName: {
            type: 'string',
            description: 'Company category name or nickname to search for (REQUIRED). Examples: "MCS", "Managed Services", "Standard Client". The tool will automatically find the matching category ID from CompanyCategories.'
          },
          categoryId: {
            type: 'number',
            description: 'Company category ID to filter by (alternative to categoryName). Use get_company_categories first to find the correct category ID for your managed services clients.'
          },
          includeContracts: {
            type: 'boolean',
            description: 'Whether to include contract information for each client (default: true). Set to false to get only client information without contract details for faster response.',
            default: true
          },
          pageSize: {
            type: 'number',
            description: 'Number of clients to return (default: 25, max: 50). Controls response size and analysis scope.',
            minimum: 1,
            maximum: 50,
            default: 25
          }
        },
        []
      ),

    ];

    // Extract mode from tenant context
    const mode = tenantContext?.mode || 'read'; // Default to read mode if no tenant context
    
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
    
    // For write mode, return all tools
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
    
    // Create API call tracker for this tool execution
    const tracker = new ApiCallTracker(name, toolCallId, this.logger);
    
    try {
      // Validate tool name
      if (!EnhancedAutotaskToolHandler.isValidToolName(name)) {
        this.logger.error(`❌ Invalid tool name: ${name}`, {
          toolCallId,
          availableTools: EnhancedAutotaskToolHandler.getAllToolNames()
        });
        
        return {
          content: [{
            type: 'text',
            text: `Error: Unknown tool '${name}'. This tool is not exposed in the current configuration.`
          }],
          isError: true
        };
      }

      this.logger.info(`🛠️ Tool call started: ${name}`, {
        toolCallId,
        toolName: name,
        argsProvided: Object.keys(args || {}),
        argCount: Object.keys(args || {}).length,
        timestamp: new Date().toISOString()
      }); 

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
          result = await this.searchCompanies(args, tenantContext, tracker);
          break;
        
        case 'create_company':
          this.logger.info(`➕ Executing create_company`, { toolCallId });
          result = await this.createCompany(args, tenantContext, tracker);
          break;

        case 'update_company':
          this.logger.info(`✏️ Executing update_company`, { toolCallId });
          result = await this.updateCompany(args, tenantContext, tracker);
          break;

        // Contact tools
        case 'search_contacts':
          this.logger.info(`📊 Executing search_contacts`, { toolCallId });
          result = await this.searchContacts(args, tenantContext, tracker);
          break;

        case 'create_contact':
          this.logger.info(`➕ Executing create_contact`, { toolCallId });
          result = await this.createContact(args, tenantContext, tracker);
          break;

        case 'update_contact':
          this.logger.info(`✏️ Executing update_contact`, { toolCallId });
          result = await this.updateContact(args, tenantContext, tracker);
          break;

        // Ticket tools
        case 'search_tickets':
          this.logger.info(`📊 Executing search_tickets`, { toolCallId });
          result = await this.searchTickets(args, tenantContext, tracker);
          break;

        case 'create_ticket':
          this.logger.info(`➕ Executing create_ticket`, { toolCallId });
          result = await this.createTicket(args, tenantContext, tracker);
          break;

        case 'update_ticket':
          this.logger.info(`✏️ Executing update_ticket`, { toolCallId });
          result = await this.updateTicket(args, tenantContext, tracker);
          break;

        // Time Entry tools
        case 'create_time_entry':
          this.logger.info(`⏰ Executing create_time_entry`, { toolCallId });
          result = await this.createTimeEntry(args, tenantContext, tracker);
          break;

        // Project tools
        case 'search_projects':
          this.logger.info(`📊 Executing search_projects`, { toolCallId });
          result = await this.searchProjects(args, tenantContext, tracker);
          break;

        // Resource tools
        case 'search_resources':
          this.logger.info(`📊 Executing search_resources`, { toolCallId });
          result = await this.searchResources(args, tenantContext, tracker);
          break;
        // Get ticket by number (special case - not by ID)
        case 'get_ticket_by_number':
          this.logger.info(`🎫 Executing get_ticket_by_number`, { toolCallId });
          result = await this.getTicketByNumber(args, tenantContext, tracker);
          break;

        case 'create_project':
          this.logger.info(`➕ Executing create_project`, { toolCallId });
          result = await this.createProject(args, tenantContext, tracker);
          break;

        case 'update_project':
          this.logger.info(`✏️ Executing update_project`, { toolCallId });
          result = await this.updateProject(args, tenantContext, tracker);
          break;

        case 'get_project_details':
          this.logger.info(`📋 Executing get_project_details`, { toolCallId });
          result = await this.getProjectDetails(args, tenantContext, tracker);
          break;

        // Time Entry Management
        case 'search_time_entries':
          this.logger.info(`⏰ Executing search_time_entries`, { toolCallId });
          result = await this.searchTimeEntries(args, tenantContext, tracker);
          break;

        // Task Management
        case 'search_tasks':
          this.logger.info(`📝 Executing search_tasks`, { toolCallId });
          result = await this.searchTasks(args, tenantContext, tracker);
          break;

        case 'create_task':
          this.logger.info(`➕ Executing create_task`, { toolCallId });
          result = await this.createTask(args, tenantContext, tracker);
          break;

        case 'update_task':
          this.logger.info(`✏️ Executing update_task`, { toolCallId });
          result = await this.updateTask(args, tenantContext, tracker);
          break;

        // Notes Management
        case 'search_ticket_notes':
          this.logger.info(`📝 Executing search_ticket_notes`, { toolCallId });
          result = await this.searchTicketNotes(args, tenantContext, tracker);
          break;

        case 'get_ticket_note':
          this.logger.info(`📝 Executing get_ticket_note`, { toolCallId });
          result = await this.getTicketNote(args, tenantContext, tracker);
          break;

        case 'create_ticket_note':
          this.logger.info(`➕ Executing create_ticket_note`, { toolCallId });
          result = await this.createTicketNote(args, tenantContext, tracker);
          break;

        case 'search_project_notes':
          this.logger.info(`📝 Executing search_project_notes`, { toolCallId });
          result = await this.searchProjectNotes(args, tenantContext, tracker);
          break;

        case 'get_project_note':
          this.logger.info(`📝 Executing get_project_note`, { toolCallId });
          result = await this.getProjectNote(args, tenantContext, tracker);
          break;

        case 'create_project_note':
          this.logger.info(`➕ Executing create_project_note`, { toolCallId });
          result = await this.createProjectNote(args, tenantContext, tracker);
          break;

        case 'search_company_notes':
          this.logger.info(`📝 Executing search_company_notes`, { toolCallId });
          result = await this.searchCompanyNotes(args, tenantContext, tracker);
          break;

        case 'get_company_note':
          this.logger.info(`📝 Executing get_company_note`, { toolCallId });
          result = await this.getCompanyNote(args, tenantContext, tracker);
          break;

        case 'create_company_note':
          this.logger.info(`➕ Executing create_company_note`, { toolCallId });
          result = await this.createCompanyNote(args, tenantContext, tracker);
          break;

        case 'search_ticket_attachments':
          this.logger.info(`📎 Executing search_ticket_attachments`, { toolCallId });
          result = await this.searchTicketAttachments(args, tenantContext, tracker);
          break;

        case 'get_ticket_attachment':
          this.logger.info(`📎 Executing get_ticket_attachment`, { toolCallId });
          result = await this.getTicketAttachment(args, tenantContext, tracker);
          break;

        // Financial Management
        case 'search_contracts':
          this.logger.info(`📄 Executing search_contracts`, { toolCallId });
          result = await this.searchContracts(args, tenantContext, tracker);
          break;

        case 'search_invoices':
          this.logger.info(`🧾 Executing search_invoices`, { toolCallId });
          result = await this.searchInvoices(args, tenantContext, tracker);
          break;

        case 'search_quotes':
          this.logger.info(`💰 Executing search_quotes`, { toolCallId });
          result = await this.searchQuotes(args, tenantContext, tracker);
          break;

        case 'create_quote':
          this.logger.info(`➕ Executing create_quote`, { toolCallId });
          result = await this.createQuote(args, tenantContext, tracker);
          break;

        case 'search_opportunities':
          this.logger.info(`💼 Executing search_opportunities`, { toolCallId });
          result = await this.searchOpportunities(args, tenantContext, tracker);
          break;

        case 'search_expense_reports':
          this.logger.info(`💳 Executing search_expense_reports`, { toolCallId });
          result = await this.searchExpenseReports(args, tenantContext, tracker);
          break;

        case 'create_expense_report':
          this.logger.info(`➕ Executing create_expense_report`, { toolCallId });
          result = await this.createExpenseReport(args, tenantContext, tracker);
          break;

        case 'update_expense_report':
          this.logger.info(`✏️ Executing update_expense_report`, { toolCallId });
          result = await this.updateExpenseReport(args, tenantContext, tracker);
          break;

        // Expense Items Management
        case 'search_expense_items':
          this.logger.info(`💳 Executing search_expense_items`, { toolCallId });
          result = await this.searchExpenseItems(args, tenantContext, tracker);
          break;

        case 'get_expense_item':
          this.logger.info(`💳 Executing get_expense_item`, { toolCallId });
          result = await this.getExpenseItem(args, tenantContext, tracker);
          break;

        case 'create_expense_item':
          this.logger.info(`➕ Executing create_expense_item`, { toolCallId });
          result = await this.createExpenseItem(args, tenantContext, tracker);
          break;

        case 'update_expense_item':
          this.logger.info(`✏️ Executing update_expense_item`, { toolCallId });
          result = await this.updateExpenseItem(args, tenantContext, tracker);
          break;

        // Configuration Items Management
        case 'search_configuration_items':
          this.logger.info(`🖥️ Executing search_configuration_items`, { toolCallId });
          result = await this.searchConfigurationItems(args, tenantContext, tracker);
          break;

        case 'create_configuration_item':
          this.logger.info(`➕ Executing create_configuration_item`, { toolCallId });
          result = await this.createConfigurationItem(args, tenantContext, tracker);
          break;

        case 'update_configuration_item':
          this.logger.info(`✏️ Executing update_configuration_item`, { toolCallId });
          result = await this.updateConfigurationItem(args, tenantContext, tracker);
          break;

        // Pagination Helper Tools
        case 'get_companies_page':
          this.logger.info(`📄 Executing get_companies_page`, { toolCallId });
          result = await this.getCompaniesPage(args, tenantContext, tracker);
          break;

        case 'query_entity':
          this.logger.info(`🔍 Executing query_entity`, { toolCallId });
          result = await this.queryEntity(args, tenantContext, tracker);
          break;

        case 'get_entity':
          this.logger.info(`🏢 Executing get_entity`, { toolCallId });
          result = await this.getEntityById(args, tenantContext, tracker);
          break;

        // Managed Services Tools
        case 'get_company_categories':
          this.logger.info(`📋 Executing get_company_categories`, { toolCallId });
          result = await this.getCompanyCategories(args, tenantContext, tracker);
          break;

        case 'find_clients_by_category':
          this.logger.info(`🏢 Executing find_clients_by_category`, { toolCallId });
          result = await this.findClientsByCategory(args, tenantContext, tracker);
          break;

        default:
          // This should never happen due to validation above, but keep as failsafe
          this.logger.error(`❌ Unhandled tool in switch statement: ${name}`, { 
            toolCallId, 
            toolName: name,
            isValidTool: EnhancedAutotaskToolHandler.isValidToolName(name)
          });
          throw new Error(`Tool '${name}' is defined but not implemented in callTool switch statement`);
      }

      const executionTime = Date.now() - startTime;
      const contentLength = result.content && result.content.length > 0 && result.content[0] && result.content[0].type === 'text' 
        ? (result.content[0] as any).text.length 
        : 0;
      
      // Log API call summary
      tracker.logSummary();
      
      // Inject API call summary into the result
      const apiCallSummary = tracker.getSummary();
      result = this.injectApiCallSummary(result, apiCallSummary);
        
      this.logger.info(`✅ Tool call completed successfully: ${name}`, {
        toolCallId,
        toolName: name,
        executionTimeMs: executionTime,
        resultType: result.isError ? 'error' : 'success',
        contentLength,
        apiCalls: apiCallSummary.apiCalls,
        cacheHits: apiCallSummary.cacheHits
      });

      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      // Log API call summary even on error
      tracker.logSummary();
      
      this.logger.error(`❌ Tool call failed: ${name}`, {
        toolCallId,
        toolName: name,
        executionTimeMs: executionTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        apiCalls: tracker.getSummary().apiCalls,
        cacheHits: tracker.getSummary().cacheHits
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
  
  /**
   * Inject API call summary into tool result
   * Modifies the JSON response to include _apiCalls metadata
   */
  private injectApiCallSummary(result: McpToolResult, summary: ApiCallSummary): McpToolResult {
    // If there are no calls tracked, skip injection
    if (summary.totalCalls === 0) {
      return result;
    }
    
    // Try to inject into the first text content that looks like JSON
    if (result.content && result.content.length > 0) {
      const firstContent = result.content[0];
      if (firstContent.type === 'text' && firstContent.text) {
        try {
          // Try to parse as JSON
          const jsonData = JSON.parse(firstContent.text);
          
          // Add the _apiCalls summary
          jsonData._apiCalls = {
            totalCalls: summary.totalCalls,
            apiCalls: summary.apiCalls,
            cacheHits: summary.cacheHits,
            totalDurationMs: summary.totalDurationMs,
            calls: summary.calls.map(call => ({
              entity: call.entity,
              operation: call.operation,
              source: call.source,
              ...(call.durationMs !== undefined && { durationMs: call.durationMs })
            }))
          };
          
          // Replace the content with updated JSON
          return {
            ...result,
            content: [{
              type: 'text',
              text: JSON.stringify(jsonData, null, 2)
            }]
          };
        } catch {
          // Not valid JSON, skip injection
          this.logger.debug('Could not inject API call summary - response is not JSON');
        }
      }
    }
    
    return result;
  }

  private async searchCompanies(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const { page = 1, pageSize = 500 } = args;
      const options: any = {};
      
      // Build filter array
      const filters: any[] = [];
      
      if (args.searchTerm) {
        filters.push({
          field: 'companyName',
          op: 'contains',
          value: args.searchTerm
        });
      }
      
      if (typeof args.companyType === 'number') {
        filters.push({
          field: 'companyType',
          op: 'eq',
          value: args.companyType
        });
      }
      
      if (typeof args.ownerResourceID === 'number') {
        filters.push({
          field: 'ownerResourceID',
          op: 'eq',
          value: args.ownerResourceID
        });
      }
      
      if (typeof args.isActive === 'boolean') {
        filters.push({
          field: 'isActive',
          op: 'eq',
          value: args.isActive
        });
      }
      
      if (args.city) {
        filters.push({
          field: 'city',
          op: 'contains',
          value: args.city
        });
      }
      
      if (args.state) {
        filters.push({
          field: 'state',
          op: 'contains',
          value: args.state
        });
      }
      
      if (args.country) {
        filters.push({
          field: 'country',
          op: 'contains',
          value: args.country
        });
      }
      
      if (filters.length > 0) {
        options.filter = filters;
      }
      
      options.pageSize = Math.min(pageSize, 500);

      const companies = await this.autotaskService.searchCompanies(options, tenantContext, tracker);
      
      // Get total count for pagination
      let totalCount = companies.length;
      try {
        const countResult = await this.autotaskService.countCompanies(options, tenantContext, tracker);
        totalCount = countResult ?? companies.length;
      } catch (countError) {
        this.logger.warn('Could not get total count for companies, using returned count');
      }

      // Determine which filters are available but not used (for performance suggestions)
      const unusedFilters: string[] = [];
      if (!args.searchTerm) unusedFilters.push('searchTerm (company name)');
      if (args.companyType === undefined) unusedFilters.push('companyType (1=Customer, 3=Prospect, etc)');
      if (!args.ownerResourceID) unusedFilters.push('ownerResourceID (filter by account manager)');
      if (args.isActive === undefined) unusedFilters.push('isActive (true for active companies only)');
      if (!args.city) unusedFilters.push('city (geographical filter)');
      if (!args.state) unusedFilters.push('state (geographical filter)');

      // Apply pagination protocol
      const paginationResult = PaginationEnforcer.enforce({
        items: companies,
        totalCount,
        currentPage: page,
        pageSize: Math.min(pageSize, 500),
        entityName: 'companies',
        availableFilters: unusedFilters,
        largeResultThreshold: 500
      });

      // Build response with pagination protocol
      const response = {
        companies: paginationResult.items,
        _paginationProtocol: paginationResult.protocol
      };

      const content = [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }];

      return {
        content,
        isError: false
      };
    } catch (error) {
      throw new Error(`Failed to search companies: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createCompany(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const companyData = { ...args };
      
      const companyId = await this.autotaskService.createCompany(companyData, tenantContext, tracker);
      
      return this.createCreationResponse('company', companyId);
    } catch (error) {
      throw new Error(`Failed to create company: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateCompany(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
    return this.updateEntity(
      args,
      'Company',
      'id',
      (id, data, ctx) => this.autotaskService.updateCompany(id, data, ctx),
      tenantContext
    );
  }

  private async searchContacts(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const { page = 1, pageSize = 500 } = args;
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
      
      options.pageSize = Math.min(pageSize, 500);

      const contacts = await this.autotaskService.searchContacts(options, tenantContext, tracker);
      this.logger.info(`🏢 Found ${contacts.length} contacts`, {
        tenant: tenantContext,
        sessionId: tenantContext?.sessionId
      });
      
      // Get total count for pagination
      let totalCount = contacts.length;
      try {
        const countResult = await this.autotaskService.countContacts(options, tenantContext, tracker);
        totalCount = countResult ?? contacts.length;
      } catch (countError) {
        this.logger.warn('Could not get total count for contacts, using returned count');
      }
      
      // Pre-fetch unique IDs to avoid cache stampede
      await this.prefetchMappingIds(
        contacts,
        ['companyID'],
        [],
        tenantContext
      );
      
      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedContacts = await Promise.all(
        contacts.map(async (contact: any) => {
          const enhanced: any = { ...contact };
          
          // Add company name if available (from cache)
          if (contact.companyID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = await mappingService.getCompanyName(contact.companyID, tenantContext);
            } catch (error) {
              this.logger.info(`Failed to map company ID ${contact.companyID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = `Unknown (${contact.companyID})`;
            }
          }
          
          return enhanced;
        })
      );

      // Apply pagination protocol
      const paginationResult = PaginationEnforcer.enforce({
        items: enhancedContacts,
        totalCount,
        currentPage: page,
        pageSize: Math.min(pageSize, 500),
        entityName: 'contacts'
      });

      // Build response with pagination protocol
      const response = {
        contacts: paginationResult.items,
        _paginationProtocol: paginationResult.protocol
      };

      const content = [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }];

      return {
        content,
        isError: false
      };
    } catch (error) {
      throw new Error(`Failed to search contacts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createContact(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const contactData = { ...args };
      
      const contactId = await this.autotaskService.createContact(contactData, tenantContext, tracker);
      
      return this.createCreationResponse('contact', contactId);
    } catch (error) {
      throw new Error(`Failed to create contact: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateContact(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
    return this.updateEntity(
      args,
      'Contact',
      'id',
      (id, data, ctx) => this.autotaskService.updateContact(id, data, ctx),
      tenantContext
    );
  }

  private async searchTickets(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const { page = 1, pageSize = 500 } = args;
      const options: any = {};
      
      // Use the proper searchTerm parameter instead of custom filter
      if (args.searchTerm) {
        options.searchTerm = args.searchTerm;
      }
      
      if (typeof args.status === 'number') {
        options.status = args.status;
      }
      
      if (typeof args.priority === 'number') {
        options.priority = args.priority;
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
      
      if (args.createdDateFrom) {
        options.createdDateFrom = args.createdDateFrom;
      }
      
      if (args.createdDateTo) {
        options.createdDateTo = args.createdDateTo;
      }
      
      options.pageSize = Math.min(pageSize, 500);

      let tickets = await this.autotaskService.searchTickets(options, tenantContext, tracker);
      
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
        
        try {
          tickets = await this.autotaskService.searchTickets(fallbackOptions, tenantContext, tracker);
          if (tickets.length > 0) {
            this.logger.info(`Fallback search found ${tickets.length} tickets`);
          }
        } catch (error) {
          this.logger.warn(`Fallback search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
      
      // Get total count for pagination
      let totalCount = tickets.length;
      try {
        const countResult = await this.autotaskService.countTickets(options, tenantContext, tracker);
        totalCount = countResult ?? tickets.length;
      } catch (countError) {
        this.logger.warn('Could not get total count for tickets, using returned count');
      }
      
      // Determine which filters are available but not used (for performance suggestions)
      const unusedFilters: string[] = [];
      if (!args.searchTerm) unusedFilters.push('searchTerm (ticket number or title)');
      if (args.status === undefined) unusedFilters.push('status (1=New, 2=In Progress, 5=Complete, etc)');
      if (args.priority === undefined) unusedFilters.push('priority (1=Critical, 2=High, 3=Medium, 4=Low)');
      if (!args.companyID) unusedFilters.push('companyID (filter by specific customer)');
      if (!args.assignedResourceID) unusedFilters.push('assignedResourceID (filter by technician)');
      if (!args.createdDateFrom) unusedFilters.push('createdDateFrom (filter by date range)');
      
      // Pre-fetch unique IDs to avoid cache stampede
      await this.prefetchMappingIds(
        tickets,
        ['companyID'],
        ['assignedResourceID'],
        tenantContext
      );
      
      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedTickets = await Promise.all(
        tickets.map(async (ticket: any) => {
          const enhanced: any = { ...ticket };
          
          // Add company name if available (from cache)
          if (ticket.companyID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = await mappingService.getCompanyName(ticket.companyID, tenantContext);
            } catch (error) {
              this.logger.info(`Failed to map company ID ${ticket.companyID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = `Unknown (${ticket.companyID})`;
            }
          }

          // Add assigned resource name if available (from cache)
          if (ticket.assignedResourceID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.assignedResourceName = await mappingService.getResourceName(ticket.assignedResourceID, tenantContext);
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

      // Apply pagination protocol
      const paginationResult = PaginationEnforcer.enforce({
        items: enhancedTickets,
        totalCount,
        currentPage: page,
        pageSize: Math.min(pageSize, 500),
        entityName: 'tickets',
        availableFilters: unusedFilters,
        largeResultThreshold: 500
      });

      // Build response with pagination protocol
      const response = {
        tickets: paginationResult.items,
        _paginationProtocol: paginationResult.protocol
      };

      const content = [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }];

      return {
        content,
        isError: false
      };
    } catch (error) {
      throw new Error(`Failed to search tickets: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createTicket(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const ticketData = { ...args };
      
      const ticketID = await this.autotaskService.createTicket(ticketData, tenantContext, tracker);
      
      return this.createCreationResponse('ticket', ticketID);
    } catch (error) {
      throw new Error(`Failed to create ticket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateTicket(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const ticketData = { ...args };
      const ticketID = ticketData.id;
      delete ticketData.id; // Remove ID from data for update

      await this.autotaskService.updateTicket(ticketID, ticketData, tenantContext, tracker);

      return this.createUpdateResponse('ticket', ticketID);
    } catch (error) {
      throw new Error(`Failed to update ticket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createTimeEntry(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const timeEntryData = { ...args };
      
      const timeEntryId = await this.autotaskService.createTimeEntry(timeEntryData, tenantContext, tracker);
      
      return this.createCreationResponse('time entry', timeEntryId);
    } catch (error) {
      throw new Error(`Failed to create time entry: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchProjects(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const options: any = {};
      
      // Build filter array
      const filters: any[] = [];
      
      if (args.searchTerm) {
        filters.push({
          field: 'projectName',
          op: 'contains',
          value: args.searchTerm
        });
      }
      
      if (typeof args.companyId === 'number') {
        filters.push({
          field: 'companyID',
          op: 'eq',
          value: args.companyId
        });
      }
      
      if (typeof args.status === 'number') {
        filters.push({
          field: 'status',
          op: 'eq',
          value: args.status
        });
      }
      
      if (typeof args.projectType === 'number') {
        filters.push({
          field: 'projectType',
          op: 'eq',
          value: args.projectType
        });
      }
      
      if (typeof args.projectManagerResourceID === 'number') {
        filters.push({
          field: 'projectManagerResourceID',
          op: 'eq',
          value: args.projectManagerResourceID
        });
      }
      
      if (filters.length > 0) {
        options.filter = filters;
      }
      
      if (args.pageSize) {
        options.pageSize = args.pageSize;
      }

      const projects = await this.autotaskService.searchProjects(options, tenantContext, tracker);
      
      // Pre-fetch unique IDs to avoid cache stampede
      await this.prefetchMappingIds(
        projects,
        ['companyID'],
        [],
        tenantContext
      );
      
      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedProjects = await Promise.all(
        projects.map(async (project: any) => {
          const enhanced: any = { ...project };
          
          // Add company name if available (from cache)
          if (project.companyID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = await mappingService.getCompanyName(project.companyID, tenantContext);
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

  private async searchResources(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
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

      const resources = await this.autotaskService.searchResources(options, tenantContext, tracker);
      
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

  // ===================================
  // Phase 1: Individual Entity Getters
  // ===================================

  private async getTicketByNumber(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const { ticketNumber, fullDetails = false } = args;
      
      if (!ticketNumber || typeof ticketNumber !== 'string') {
        throw new Error('Ticket number is required and must be a string (e.g., T20250914.0008)');
      }

      const ticket = await this.autotaskService.getTicketByNumber(ticketNumber, fullDetails, tenantContext, tracker);
      
      if (!ticket) {
        return this.createNotFoundResponse('ticket', ticketNumber);
      }

      return this.createDataResponse(ticket);
    } catch (error) {
      throw new Error(`Failed to get ticket by number: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createProject(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
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

      const projectId = await this.autotaskService.createProject(projectData, tenantContext, tracker);
      
      return this.createCreationResponse('project', projectId);
    } catch (error) {
      throw new Error(`Failed to create project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateProject(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
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

      await this.autotaskService.updateProject(id, updateData, tenantContext, tracker);
      
      return this.createUpdateResponse('project', id);
    } catch (error) {
      throw new Error(`Failed to update project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getProjectDetails(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const { 
        projectId, 
        searchTerm,  
        taskPageSize = 25,
        timeEntryPageSize = 25,
        timeEntryDateFrom,
        timeEntryDateTo
      } = args;
      
      this.logger.info(`Getting project details for project ${projectId}`, { projectId: projectId });
      let project: any = null;
      
      // Get project by ID or search term
      if (projectId) {
        project = await this.autotaskService.getProject(projectId, tenantContext, tracker);
        if (!project) {
          return this.createNotFoundResponse('project', projectId);
        }
      } else if (searchTerm) {
        // Search for project by name
        const projects = await this.autotaskService.searchProjects({
          filter: [{
            field: 'projectName',
            op: 'contains',
            value: searchTerm
          }],
          pageSize: 1
        }, tenantContext);
        
        if (projects.length === 0) {
          return this.createNotFoundResponse('project', searchTerm);
        }
        
        project = projects[0];
      } else {
        throw new Error('Either projectId or searchTerm must be provided');
      }

      this.logger.info(`Project details: ${JSON.stringify(project)}`);
      
      // Handle the case where project data is wrapped in an 'item' object
      const projectData = project.item || project;
      
      const result: any = {
        project: {
          id: projectData.id,
          projectName: projectData.projectName,
          description: projectData.description,
          status: projectData.status,
          projectType: projectData.projectType,
          projectManagerResourceID: projectData.projectManagerResourceID,
          companyID: projectData.companyID,
          startDateTime: projectData.startDateTime,
          endDateTime: projectData.endDateTime,
          estimatedHours: projectData.estimatedTime,
          actualHours: projectData.actualHours,
          createDateTime: projectData.createDateTime,
          lastActivityDateTime: projectData.lastActivityDateTime,
          projectNumber: projectData.projectNumber,
          completedPercentage: projectData.completedPercentage,
          contractID: projectData.contractID,
          department: projectData.department,
          projectLeadResourceID: projectData.projectLeadResourceID,
          userDefinedFields: projectData.userDefinedFields
        }
      };

      // Get company name if available
      if (projectData.companyID) {
        try {
          const mappingService = await this.getMappingService();
          result.project.companyName = await mappingService.getCompanyName(projectData.companyID, tenantContext);
        } catch (error) {
          this.logger.info(`Failed to map company ID ${projectData.companyID}:`, error);
          result.project.companyName = `Unknown (${projectData.companyID})`;
        }
      }
 
        try {
          this.logger.info(`Fetching tasks for project ${projectData.id}`, { projectId: projectData.id });
          
          const tasks = await this.autotaskService.searchTasks({
            filter: [{
              field: 'projectID',
              op: 'eq',
              value: projectData.id
            }],
            pageSize: Math.max(taskPageSize, 130)
          }, tenantContext);

          this.logger.info(`Found ${tasks.length} tasks for project ${projectData.id}`);

          // Get resource information for tasks
          const uniqueTaskResourceIds = [...new Set(tasks.map((task: any) => task.assignedResourceID).filter(id => id))];
          const taskResourceMap = new Map();
          
          if (uniqueTaskResourceIds.length > 0) {
            this.logger.info(`Fetching resource information for ${uniqueTaskResourceIds.length} unique task resources ${JSON.stringify(uniqueTaskResourceIds)}`);
            
            for (const resourceId of uniqueTaskResourceIds) {
              try {
                const resource = await this.autotaskService.getResource(resourceId, tenantContext, tracker);
                if (resource) {
                  taskResourceMap.set(resourceId, {
                    id: resource.id,
                    firstName: resource.firstName,
                    lastName: resource.lastName,
                    userName: resource.userName,
                    email: resource.email,
                    title: resource.title,
                    department: resource.department
                  });
                }
              } catch (error) {
                this.logger.warn(`Failed to fetch task resource ${resourceId}:`, error);
                taskResourceMap.set(resourceId, {
                  id: resourceId,
                  firstName: 'Unknown',
                  lastName: `Resource ${resourceId}`,
                  userName: `resource_${resourceId}`,
                  email: null,
                  title: null,
                  department: null
                });
              }
            }
          }
          result.tasks = tasks.map((task: any) => {
            const resourceInfo = taskResourceMap.get(task.assignedResourceID);
            return {
              id: task.id,
              title: task.title,
              description: task.description,
              status: task.status,
              priorityLabel: task.priorityLabel,
              assignedResourceID: task.assignedResourceID,
              assignedResource: resourceInfo ? {
                id: resourceInfo.id,
                name: `${resourceInfo.firstName} ${resourceInfo.lastName}`.trim(),
                userName: resourceInfo.userName,
                email: resourceInfo.email,
                title: resourceInfo.title,
                department: resourceInfo.department
              } : task.assignedResourceID ? {
                id: task.assignedResourceID,
                name: `Unknown Resource ${task.assignedResourceID}`,
                userName: `resource_${task.assignedResourceID}`,
                email: null,
                title: null,
                department: null
              } : null,
              startDateTime: task.startDateTime,
              endDateTime: task.endDateTime,
              estimatedHours: task.estimatedHours,
              actualHours: task.actualHours,
              createDateTime: task.createDateTime,
              lastActivityDateTime: task.lastActivityDateTime
            };
          });

          result.tasksSummary = {
            total: tasks.length,
            completed: tasks.filter((t: any) => t.status === 5).length, // Assuming 5 is completed status
            inProgress: tasks.filter((t: any) => t.status === 2).length, // Assuming 2 is in progress
            notStarted: tasks.filter((t: any) => t.status === 1).length, // Assuming 1 is not started
            uniqueResources: uniqueTaskResourceIds.length,
            resourceBreakdown: Array.from(taskResourceMap.entries()).map(([resourceId, resourceInfo]) => ({
              resourceId,
              resourceName: `${resourceInfo.firstName} ${resourceInfo.lastName}`.trim(),
              taskCount: tasks.filter(t => t.assignedResourceID === resourceId).length,
              completedTasks: tasks.filter(t => t.assignedResourceID === resourceId && t.status === 5).length,
              inProgressTasks: tasks.filter(t => t.assignedResourceID === resourceId && t.status === 2).length,
              notStartedTasks: tasks.filter(t => t.assignedResourceID === resourceId && t.status === 1).length
            })).sort((a, b) => b.taskCount - a.taskCount) // Sort by task count descending
          };
        } catch (error) {
          this.logger.warn(`Failed to fetch tasks for project ${projectData.id}:`, error);
          result.tasks = [];
          result.tasksSummary = { total: 0, completed: 0, inProgress: 0, notStarted: 0 };
        } 

       try {
         this.logger.info(`Fetching time entries for project ${projectData.id}`, { projectId: projectData.id });
        
        // For time entries, we need to get them by task IDs since time entries are associated with tasks, not directly with projects
        let timeEntries: any[] = [];
        
        if (result.tasks && result.tasks.length > 0) {
          this.logger.info(`Getting time entries for ${result.tasks.length} tasks`);
          // Get time entries for all tasks in the project
          const taskIds = result.tasks.map((task: any) => task.id);
          
          for (const taskId of taskIds) {
            try {
              const taskTimeEntries = await this.autotaskService.getTimeEntries({
                filter: [{
                  field: 'taskID',
                  op: 'eq',
                  value: taskId
                }],
                pageSize: Math.min(timeEntryPageSize, 100)
              }, tenantContext);
              
              this.logger.info(`Found ${taskTimeEntries.length} time entries for task ${taskId}`);
              timeEntries = timeEntries.concat(taskTimeEntries);
            } catch (error) {
              this.logger.warn(`Failed to fetch time entries for task ${taskId}:`, error);
            }
          }
        } else {
          this.logger.info(`No tasks found, trying direct projectID filter for time entries`);
           // If no tasks, try to get time entries directly by projectID (if the field exists)
           const timeEntryFilter: any[] = [{
             field: 'projectID',
             op: 'eq',
             value: projectData.id
           }];

          // Add date filters if provided
          if (timeEntryDateFrom) {
            timeEntryFilter.push({
              field: 'dateWorked',
              op: 'gte',
              value: timeEntryDateFrom
            });
          }
          if (timeEntryDateTo) {
            timeEntryFilter.push({
              field: 'dateWorked',
              op: 'lte',
              value: timeEntryDateTo
            });
          }

          timeEntries = await this.autotaskService.getTimeEntries({
            filter: timeEntryFilter,
            pageSize: Math.min(timeEntryPageSize, 100)
          }, tenantContext);
          
          this.logger.info(`Found ${timeEntries.length} time entries with direct projectID filter`);
        }

        result.timeEntries = timeEntries.map((entry: any) => ({
          id: entry.id,
          resourceID: entry.resourceID,
          ticketID: entry.ticketID,
          taskID: entry.taskID,
          projectID: entry.projectID,
          dateWorked: entry.dateWorked,
          hoursWorked: entry.hoursWorked,
          hoursToBill: entry.hoursToBill,
          description: entry.description,
          createDateTime: entry.createDateTime,
          lastModifiedDateTime: entry.lastModifiedDateTime
        }));

        // Get resource information for time entries
        const uniqueResourceIds = [...new Set(timeEntries.map((entry: any) => entry.resourceID).filter(id => id))];
        const resourceMap = new Map();
        
        if (uniqueResourceIds.length > 0) {
          this.logger.info(`Fetching resource information for ${uniqueResourceIds.length} unique resources`);
          
          for (const resourceId of uniqueResourceIds) {
            try {
              const resource = await this.autotaskService.getResource(resourceId, tenantContext);
              if (resource) {
                resourceMap.set(resourceId, {
                  id: resource.id,
                  firstName: resource.firstName,
                  lastName: resource.lastName,
                  userName: resource.userName,
                  email: resource.email,
                  title: resource.title,
                  department: resource.department
                });
              }
            } catch (error) {
              this.logger.warn(`Failed to fetch resource ${resourceId}:`, error);
              resourceMap.set(resourceId, {
                id: resourceId,
                firstName: 'Unknown',
                lastName: `Resource ${resourceId}`,
                userName: `resource_${resourceId}`,
                email: null,
                title: null,
                department: null
              });
            }
          }
        }

        // Add resource information to time entries
        result.timeEntries = result.timeEntries.map((entry: any) => {
          const resourceInfo = resourceMap.get(entry.resourceID);
          return {
            ...entry,
            resource: resourceInfo ? {
              id: resourceInfo.id,
              name: `${resourceInfo.firstName} ${resourceInfo.lastName}`.trim(),
              userName: resourceInfo.userName,
              email: resourceInfo.email,
              title: resourceInfo.title,
              department: resourceInfo.department
            } : {
              id: entry.resourceID,
              name: `Unknown Resource ${entry.resourceID}`,
              userName: `resource_${entry.resourceID}`,
              email: null,
              title: null,
              department: null
            }
          };
        });

        // Calculate time summary with resource breakdown
        const totalHours = timeEntries.reduce((sum: number, entry: any) => sum + (entry.hoursWorked || 0), 0);
        const totalBillableHours = timeEntries.reduce((sum: number, entry: any) => sum + (entry.hoursToBill || 0), 0);
        
        // Calculate hours by resource
        const resourceHours = new Map();
        timeEntries.forEach((entry: any) => {
          const resourceId = entry.resourceID;
          const hours = entry.hoursWorked || 0;
          const billableHours = entry.hoursToBill || 0;
          
          if (!resourceHours.has(resourceId)) {
            resourceHours.set(resourceId, { totalHours: 0, billableHours: 0, entries: 0 });
          }
          
          const current = resourceHours.get(resourceId);
          current.totalHours += hours;
          current.billableHours += billableHours;
          current.entries += 1;
        });

        // Convert resource hours to array with names
        const resourceBreakdown = Array.from(resourceHours.entries()).map(([resourceId, data]) => {
          const resourceInfo = resourceMap.get(resourceId);
          return {
            resourceId,
            resourceName: resourceInfo ? `${resourceInfo.firstName} ${resourceInfo.lastName}`.trim() : `Unknown Resource ${resourceId}`,
            totalHours: data.totalHours,
            billableHours: data.billableHours,
            entries: data.entries,
            averageHoursPerEntry: data.entries > 0 ? data.totalHours / data.entries : 0
          };
        }).sort((a, b) => b.totalHours - a.totalHours); // Sort by total hours descending
        
        result.timeSummary = {
          totalEntries: timeEntries.length,
          totalHoursWorked: totalHours,
          totalBillableHours: totalBillableHours,
          averageHoursPerEntry: timeEntries.length > 0 ? totalHours / timeEntries.length : 0,
          uniqueResources: uniqueResourceIds.length,
          resourceBreakdown: resourceBreakdown
        };
       } catch (error) {
         this.logger.warn(`Failed to fetch time entries for project ${projectData.id}:`, error);
         result.timeEntries = [];
         result.timeSummary = { totalEntries: 0, totalHoursWorked: 0, totalBillableHours: 0, averageHoursPerEntry: 0 };
       }

      const content = [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }];

      return {
        content,
        isError: false
      };
    } catch (error) {
      throw new Error(`Failed to get project details: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ===================================
  // Phase 1: Time Entry Management
  // ===================================

  private async searchTimeEntries(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const { ticketID, taskID, resourceID, resourceId, dateFrom, dateTo, page = 1, pageSize = 500 } = args;
      
      // Build filter for time entries search
      const filter: any[] = [];
      
      if (ticketID) {
        filter.push({ field: 'ticketID', op: 'eq', value: ticketID });
      }
      
      if (taskID) {
        filter.push({ field: 'taskID', op: 'eq', value: taskID });
      }
      
      if (resourceID || resourceId) {
        filter.push({ field: 'resourceID', op: 'eq', value: resourceID || resourceId });
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
        filter,
        pageSize: Math.min(pageSize, 500)
      };

      const timeEntries = await this.autotaskService.getTimeEntries(queryOptions, tenantContext, tracker);
      
      // Pre-fetch unique IDs to avoid cache stampede (N parallel API calls for same ID)
      await this.prefetchMappingIds(
        timeEntries,
        [], // No company fields in time entries
        ['resourceID', 'billingApprovalResourceID'],
        tenantContext
      );
      
      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedTimeEntries = await Promise.all(
        timeEntries.map(async (entry: any) => {
          const enhanced: any = { ...entry };
          enhanced._enhanced = {};
          
          // Add resource name if available (from cache)
          if (entry.resourceID) {
            try {
              const resourceName = await mappingService.getResourceName(entry.resourceID, tenantContext);
              enhanced._enhanced.resourceName = resourceName ?? `Unknown (${entry.resourceID})`;
            } catch (error) {
              this.logger.debug(`Failed to map resource ID ${entry.resourceID}:`, error);
              enhanced._enhanced.resourceName = `Unknown (${entry.resourceID})`;
            }
          }
          
          // Add billing approval resource name if available (from cache)
          if (entry.billingApprovalResourceID) {
            try {
              const resourceName = await mappingService.getResourceName(entry.billingApprovalResourceID, tenantContext);
              enhanced._enhanced.billingApprovalResourceName = resourceName ?? `Unknown (${entry.billingApprovalResourceID})`;
            } catch (error) {
              this.logger.debug(`Failed to map billing approval resource ID ${entry.billingApprovalResourceID}:`, error);
              enhanced._enhanced.billingApprovalResourceName = `Unknown (${entry.billingApprovalResourceID})`;
            }
          }
          
          return enhanced;
        })
      );
      
      // Get total count for pagination
      let totalCount = enhancedTimeEntries.length;
      try {
        const countResult = await this.autotaskService.countTimeEntries({ filter }, tenantContext, tracker);
        totalCount = countResult ?? enhancedTimeEntries.length;
      } catch (countError) {
        this.logger.warn('Could not get total count for time entries, using returned count');
      }

      // Apply pagination protocol
      const paginationResult = PaginationEnforcer.enforce({
        items: enhancedTimeEntries,
        totalCount,
        currentPage: page,
        pageSize: Math.min(pageSize, 500),
        entityName: 'time entries',
        sumField: 'hoursWorked'
      });

      // Build response with pagination protocol
      const response = {
        timeEntries: paginationResult.items,
        _paginationProtocol: paginationResult.protocol
      };
      
      const content = [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }];
      
      return {
        content,
        isError: false
      };
    } catch (error) {
      throw new Error(`Failed to search time entries: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ===================================
  // Phase 1: Task Management
  // ===================================

  private async searchTasks(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const { projectId, assignedResourceId, status, priorityLabel, searchTerm, dueDateFrom, dueDateTo, createdDateFrom, createdDateTo, pageSize } = args;
      
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
      
      if (priorityLabel) {
        filter.push({ field: 'priorityLabel', op: 'eq', value: priorityLabel });
      }
      
      if (searchTerm) {
        filter.push({ field: 'title', op: 'contains', value: searchTerm });
      }
      
      if (dueDateFrom) {
        filter.push({ field: 'endDateTime', op: 'gte', value: dueDateFrom });
      }
      
      if (dueDateTo) {
        filter.push({ field: 'endDateTime', op: 'lte', value: dueDateTo });
      }
      
      if (createdDateFrom) {
        filter.push({ field: 'createDateTime', op: 'gte', value: createdDateFrom });
      }
      
      if (createdDateTo) {
        filter.push({ field: 'createDateTime', op: 'lte', value: createdDateTo });
      }
      
      // If no specific filters, get all active tasks
      if (filter.length === 0) {
        filter.push({ field: 'id', op: 'gte', value: 0 });
      }

      const queryOptions = {
        filter,
        ...(pageSize && { pageSize })
      };

      const tasks = await this.autotaskService.searchTasks(queryOptions, tenantContext, tracker);
      
      // Pre-fetch unique IDs to avoid cache stampede
      await this.prefetchMappingIds(
        tasks,
        [], // No company fields in tasks
        ['assignedResourceID', 'creatorResourceID', 'completedByResourceID'],
        tenantContext
      );
      
      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedTasks = await Promise.all(
        tasks.map(async (task: any) => {
          const enhanced: any = { ...task };
          enhanced._enhanced = {};
          
          // Add assigned resource name if available (from cache)
          if (task.assignedResourceID) {
            try {
              const resourceName = await mappingService.getResourceName(task.assignedResourceID, tenantContext);
              enhanced._enhanced.assignedResourceName = resourceName ?? `Unknown (${task.assignedResourceID})`;
            } catch (error) {
              this.logger.debug(`Failed to map assigned resource ID ${task.assignedResourceID}:`, error);
              enhanced._enhanced.assignedResourceName = `Unknown (${task.assignedResourceID})`;
            }
          }
          
          // Add creator resource name if available (from cache)
          if (task.creatorResourceID) {
            try {
              const resourceName = await mappingService.getResourceName(task.creatorResourceID, tenantContext);
              enhanced._enhanced.creatorResourceName = resourceName ?? `Unknown (${task.creatorResourceID})`;
            } catch (error) {
              this.logger.debug(`Failed to map creator resource ID ${task.creatorResourceID}:`, error);
              enhanced._enhanced.creatorResourceName = `Unknown (${task.creatorResourceID})`;
            }
          }
          
          // Add completed by resource name if available (from cache)
          if (task.completedByResourceID) {
            try {
              const resourceName = await mappingService.getResourceName(task.completedByResourceID, tenantContext);
              enhanced._enhanced.completedByResourceName = resourceName ?? `Unknown (${task.completedByResourceID})`;
            } catch (error) {
              this.logger.debug(`Failed to map completed by resource ID ${task.completedByResourceID}:`, error);
              enhanced._enhanced.completedByResourceName = `Unknown (${task.completedByResourceID})`;
            }
          }
          
          return enhanced;
        })
      );
      
      const content = [{
        type: 'text',
        text: JSON.stringify(enhancedTasks, null, 2)
      }];

      // Add guidance for large responses
      const contentWithGuidance = this.addLargeResponseGuidance(content, enhancedTasks.length, 'tasks');
      
      return {
        content: contentWithGuidance,
        isError: false
      };
    } catch (error) {
      throw new Error(`Failed to search tasks: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createTask(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
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

      const taskID = await this.autotaskService.createTask(taskData, tenantContext, tracker);
      
      return this.createCreationResponse('task', taskID);
    } catch (error) {
      throw new Error(`Failed to create task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateTask(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
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

      await this.autotaskService.updateTask(id, updateData, tenantContext, tracker);
      
      return this.createUpdateResponse('task', id);
    } catch (error) {
      throw new Error(`Failed to update task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ===================================
  // Phase 2: Notes Management
  // ===================================

  private async searchTicketNotes(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async getTicketNote(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async createTicketNote(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async searchProjectNotes(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async getProjectNote(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async createProjectNote(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async searchCompanyNotes(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async getCompanyNote(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async createCompanyNote(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async searchTicketAttachments(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async getTicketAttachment(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async searchContracts(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
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

      const contracts = await this.autotaskService.searchContracts(queryOptions, tenantContext, tracker);
      
      // Pre-fetch unique IDs to avoid cache stampede
      await this.prefetchMappingIds(
        contracts,
        ['companyID'],
        [],
        tenantContext
      );
      
      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedContracts = await Promise.all(
        contracts.map(async (contract: any) => {
          const enhanced: any = { ...contract };
          enhanced._enhanced = {};
          
          // Add company name if available (from cache)
          if (contract.companyID) {
            try {
              const companyName = await mappingService.getCompanyName(contract.companyID, tenantContext);
              enhanced._enhanced.companyName = companyName ?? `Unknown (${contract.companyID})`;
            } catch (error) {
              this.logger.debug(`Failed to map company ID ${contract.companyID}:`, error);
              enhanced._enhanced.companyName = `Unknown (${contract.companyID})`;
            }
          }
          
          // Add billing contact name if available (contact ID would require separate lookup)
          if (contract.billToCompanyContactID) {
            enhanced._enhanced.billToContactId = contract.billToCompanyContactID;
          }
          
          return enhanced;
        })
      );
      
      return this.createDataResponse(enhancedContracts);
    } catch (error) {
      throw new Error(`Failed to search contracts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchInvoices(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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
      
      // Pre-fetch unique IDs to avoid cache stampede
      await this.prefetchMappingIds(
        invoices,
        ['companyID'],
        ['creatorResourceID'],
        tenantContext
      );
      
      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedInvoices = await Promise.all(
        invoices.map(async (invoice: any) => {
          const enhanced: any = { ...invoice };
          enhanced._enhanced = {};
          
          // Add company name if available (from cache)
          if (invoice.companyID) {
            try {
              const companyName = await mappingService.getCompanyName(invoice.companyID, tenantContext);
              enhanced._enhanced.companyName = companyName ?? `Unknown (${invoice.companyID})`;
            } catch (error) {
              this.logger.debug(`Failed to map company ID ${invoice.companyID}:`, error);
              enhanced._enhanced.companyName = `Unknown (${invoice.companyID})`;
            }
          }
          
          // Add creator resource name if available (from cache)
          if (invoice.creatorResourceID) {
            try {
              const resourceName = await mappingService.getResourceName(invoice.creatorResourceID, tenantContext);
              enhanced._enhanced.creatorResourceName = resourceName ?? `Unknown (${invoice.creatorResourceID})`;
            } catch (error) {
              this.logger.debug(`Failed to map creator resource ID ${invoice.creatorResourceID}:`, error);
              enhanced._enhanced.creatorResourceName = `Unknown (${invoice.creatorResourceID})`;
            }
          }
          
          return enhanced;
        })
      );
      
      return this.createDataResponse(enhancedInvoices);
    } catch (error) {
      throw new Error(`Failed to search invoices: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchQuotes(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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
      
      // Pre-fetch unique IDs to avoid cache stampede
      await this.prefetchMappingIds(
        quotes,
        ['accountId'],
        ['creatorResourceID'],
        tenantContext
      );
      
      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedQuotes = await Promise.all(
        quotes.map(async (quote: any) => {
          const enhanced: any = { ...quote };
          enhanced._enhanced = {};
          
          // Add company name if available (quotes use accountId, from cache)
          if (quote.accountId) {
            try {
              const companyName = await mappingService.getCompanyName(quote.accountId, tenantContext);
              enhanced._enhanced.companyName = companyName ?? `Unknown (${quote.accountId})`;
            } catch (error) {
              this.logger.debug(`Failed to map account ID ${quote.accountId}:`, error);
              enhanced._enhanced.companyName = `Unknown (${quote.accountId})`;
            }
          }
          
          // Add creator resource name if available (from cache)
          if (quote.creatorResourceID) {
            try {
              const resourceName = await mappingService.getResourceName(quote.creatorResourceID, tenantContext);
              enhanced._enhanced.creatorResourceName = resourceName ?? `Unknown (${quote.creatorResourceID})`;
            } catch (error) {
              this.logger.debug(`Failed to map creator resource ID ${quote.creatorResourceID}:`, error);
              enhanced._enhanced.creatorResourceName = `Unknown (${quote.creatorResourceID})`;
            }
          }
          
          return enhanced;
        })
      );
      
      return this.createDataResponse(enhancedQuotes);
    } catch (error) {
      throw new Error(`Failed to search quotes: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createQuote(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async searchOpportunities(args: Record<string, any>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const { page = 1, pageSize = 500 } = args;
      const options: any = {};
      
      // Build filter array
      const filters: any[] = [];
      
      if (args.searchTerm) {
        filters.push({
          field: 'title',
          op: 'contains',
          value: args.searchTerm
        });
      }
      
      if (typeof args.companyId === 'number') {
        filters.push({
          field: 'accountID',
          op: 'eq',
          value: args.companyId
        });
      }
      
      if (typeof args.status === 'number') {
        filters.push({
          field: 'status',
          op: 'eq',
          value: args.status
        });
      }
      
      if (args.stage) {
        filters.push({
          field: 'stage',
          op: 'eq',
          value: args.stage
        });
      }
      
      if (typeof args.ownerResourceID === 'number') {
        filters.push({
          field: 'ownerResourceID',
          op: 'eq',
          value: args.ownerResourceID
        });
      }
      
      if (typeof args.leadReferralSourceID === 'number') {
        filters.push({
          field: 'leadReferralSourceID',
          op: 'eq',
          value: args.leadReferralSourceID
        });
      }
      
      if (typeof args.minAmount === 'number') {
        filters.push({
          field: 'amount',
          op: 'gte',
          value: args.minAmount
        });
      }
      
      if (typeof args.maxAmount === 'number') {
        filters.push({
          field: 'amount',
          op: 'lte',
          value: args.maxAmount
        });
      }
      
      if (args.createdDateFrom) {
        filters.push({
          field: 'createDate',
          op: 'gte',
          value: args.createdDateFrom
        });
      }
      
      if (args.createdDateTo) {
        filters.push({
          field: 'createDate',
          op: 'lte',
          value: args.createdDateTo
        });
      }
      
      if (args.projectedCloseDate) {
        filters.push({
          field: 'projectedCloseDate',
          op: 'eq',
          value: args.projectedCloseDate
        });
      }
      
      if (filters.length > 0) {
        options.filter = filters;
      }
      
      options.pageSize = Math.min(pageSize, 500);

      const opportunities = await this.autotaskService.searchOpportunities(options, tenantContext, tracker);
      
      // Pre-fetch unique IDs to avoid cache stampede
      await this.prefetchMappingIds(
        opportunities,
        ['accountID'],
        ['ownerResourceID', 'creatorResourceID'],
        tenantContext
      );
      
      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedOpportunities = await Promise.all(
        opportunities.map(async (opportunity: any) => {
          const enhanced: any = { ...opportunity };
          enhanced._enhanced = {};
          
          // Add company name if available (opportunities use accountID, from cache)
          if (opportunity.accountID) {
            try {
              const companyName = await mappingService.getCompanyName(opportunity.accountID, tenantContext);
              enhanced._enhanced.companyName = companyName ?? `Unknown (${opportunity.accountID})`;
            } catch (error) {
              this.logger.debug(`Failed to map account ID ${opportunity.accountID}:`, error);
              enhanced._enhanced.companyName = `Unknown (${opportunity.accountID})`;
            }
          }
          
          // Add owner resource name if available (from cache)
          if (opportunity.ownerResourceID) {
            try {
              const resourceName = await mappingService.getResourceName(opportunity.ownerResourceID, tenantContext);
              enhanced._enhanced.ownerResourceName = resourceName ?? `Unknown (${opportunity.ownerResourceID})`;
            } catch (error) {
              this.logger.debug(`Failed to map owner resource ID ${opportunity.ownerResourceID}:`, error);
              enhanced._enhanced.ownerResourceName = `Unknown (${opportunity.ownerResourceID})`;
            }
          }
          
          // Add creator resource name if available (from cache)
          if (opportunity.creatorResourceID) {
            try {
              const resourceName = await mappingService.getResourceName(opportunity.creatorResourceID, tenantContext);
              enhanced._enhanced.creatorResourceName = resourceName ?? `Unknown (${opportunity.creatorResourceID})`;
            } catch (error) {
              this.logger.debug(`Failed to map creator resource ID ${opportunity.creatorResourceID}:`, error);
              enhanced._enhanced.creatorResourceName = `Unknown (${opportunity.creatorResourceID})`;
            }
          }
          
          return enhanced;
        })
      );
      
      // Get total count for pagination
      let totalCount = enhancedOpportunities.length;
      try {
        const countResult = await this.autotaskService.countOpportunities(options, tenantContext, tracker);
        totalCount = countResult ?? enhancedOpportunities.length;
      } catch (countError) {
        this.logger.warn('Could not get total count for opportunities, using returned count');
      }

      // Determine which filters are available but not used (for performance suggestions)
      const unusedFilters: string[] = [];
      if (!args.searchTerm) unusedFilters.push('searchTerm (opportunity title)');
      if (args.status === undefined) unusedFilters.push('status (0=Inactive, 1=Open, 2=Won, 3=Lost)');
      if (!args.stage) unusedFilters.push('stage (pipeline stage)');
      if (!args.companyId) unusedFilters.push('companyId (filter by customer)');
      if (!args.ownerResourceID) unusedFilters.push('ownerResourceID (filter by sales rep)');
      if (!args.minAmount && !args.maxAmount) unusedFilters.push('minAmount/maxAmount (filter by deal value)');
      if (!args.createdDateFrom) unusedFilters.push('createdDateFrom (filter by date range)');
      if (!args.projectedCloseDate) unusedFilters.push('projectedCloseDate (filter by close date)');

      // Apply pagination protocol
      const paginationResult = PaginationEnforcer.enforce({
        items: enhancedOpportunities,
        totalCount,
        currentPage: page,
        pageSize: Math.min(pageSize, 500),
        entityName: 'opportunities',
        availableFilters: unusedFilters,
        largeResultThreshold: 500
      });

      // Build response with pagination protocol
      const response = {
        opportunities: paginationResult.items,
        _paginationProtocol: paginationResult.protocol
      };

      const content = [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }];

      return {
        content,
        isError: false
      };
    } catch (error) {
      throw new Error(`Failed to search opportunities: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchExpenseReports(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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
      
      // Pre-fetch unique IDs to avoid cache stampede
      await this.prefetchMappingIds(
        expenseReports,
        [],
        ['submittedByResourceID', 'resourceId', 'approvedByResourceID'],
        tenantContext
      );
      
      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedExpenseReports = await Promise.all(
        expenseReports.map(async (report: any) => {
          const enhanced: any = { ...report };
          enhanced._enhanced = {};
          
          // Add submitter resource name if available (from cache)
          if (report.submittedByResourceID || report.resourceId) {
            const resourceId = report.submittedByResourceID || report.resourceId;
            try {
              const resourceName = await mappingService.getResourceName(resourceId, tenantContext);
              enhanced._enhanced.submittedByResourceName = resourceName ?? `Unknown (${resourceId})`;
            } catch (error) {
              this.logger.debug(`Failed to map submitter resource ID ${resourceId}:`, error);
              enhanced._enhanced.submittedByResourceName = `Unknown (${resourceId})`;
            }
          }
          
          // Add approver resource name if available (from cache)
          if (report.approvedByResourceID) {
            try {
              const resourceName = await mappingService.getResourceName(report.approvedByResourceID, tenantContext);
              enhanced._enhanced.approvedByResourceName = resourceName ?? `Unknown (${report.approvedByResourceID})`;
            } catch (error) {
              this.logger.debug(`Failed to map approver resource ID ${report.approvedByResourceID}:`, error);
              enhanced._enhanced.approvedByResourceName = `Unknown (${report.approvedByResourceID})`;
            }
          }
          
          return enhanced;
        })
      );
      
      return this.createDataResponse(enhancedExpenseReports);
    } catch (error) {
      throw new Error(`Failed to search expense reports: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createExpenseReport(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async updateExpenseReport(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async searchConfigurationItems(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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
      
      // Pre-fetch unique IDs to avoid cache stampede
      await this.prefetchMappingIds(
        configItems,
        ['companyID'],
        [],
        tenantContext
      );
      
      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedConfigItems = await Promise.all(
        configItems.map(async (item: any) => {
          const enhanced: any = { ...item };
          enhanced._enhanced = {};
          
          // Add company name if available (from cache)
          if (item.companyID) {
            try {
              const companyName = await mappingService.getCompanyName(item.companyID, tenantContext);
              enhanced._enhanced.companyName = companyName ?? `Unknown (${item.companyID})`;
            } catch (error) {
              this.logger.debug(`Failed to map company ID ${item.companyID}:`, error);
              enhanced._enhanced.companyName = `Unknown (${item.companyID})`;
            }
          }
          
          return enhanced;
        })
      );
      
      return this.createDataResponse(enhancedConfigItems);
    } catch (error) {
      throw new Error(`Failed to search configuration items: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createConfigurationItem(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async updateConfigurationItem(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async getCompaniesPage(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      // ⚠️ IMPORTANT: Autotask API uses cursor-based pagination with nextPageUrl/prevPageUrl
      // It does NOT support jumping to specific pages - only sequential traversal via URLs
      // This method only returns the FIRST page of results
      
      // Explicitly reject if page parameter is provided (it doesn't work)
      if (args.page && args.page !== 1) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `ERROR: Cannot jump to page ${args.page}\n\n` +
                  `Autotask API uses CURSOR-BASED pagination (nextPageUrl/prevPageUrl), NOT page numbers.\n` +
                  `You cannot directly access page 2, 3, etc.\n\n` +
                  `CORRECT APPROACHES:\n` +
                  `1. Use get_entity with entity="companies" and id=<company_id> to get a specific company directly\n` +
                  `2. Use search_companies with filter=[{field:"id",op:"eq",value:<id>}] to find by ID\n` +
                  `3. Use searchTerm parameter to filter by company name (e.g., searchTerm="Microsoft")\n` +
                  `4. Use isActive=true to filter active companies only\n` +
                  `5. Use search_companies with owner, type, or location filters\n\n` +
                  `DO NOT try to paginate through all companies - use filters to reduce the dataset instead.`
          }]
        };
      }
      
      const options: any = {
        pageSize: Math.min(args.pageSize || 50, 100) // Cap at 100 for performance
      };
      
      // Warn if filters are not being used
      const hasFilters = args.searchTerm || typeof args.isActive === 'boolean';
      if (!hasFilters) {
        this.logger.warn('⚠️ get_companies_page called without filters - returns arbitrary first page. Recommend using searchTerm or isActive filter, or use get_entity for specific company lookup.');
      }
      
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
      
      // Pre-fetch unique IDs to avoid cache stampede
      await this.prefetchMappingIds(
        companies,
        [],
        ['ownerResourceID'],
        tenantContext
      );
      
      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedCompanies = await Promise.all(
        companies.map(async (company: any) => {
          const enhanced: any = { ...company };
          
          // Add owner resource name if available (from cache)
          if (company.ownerResourceID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.ownerResourceName = await mappingService.getResourceName(company.ownerResourceID, tenantContext);
            } catch (error) {
              this.logger.info(`Failed to map owner resource ID ${company.ownerResourceID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.ownerResourceName = `Unknown (${company.ownerResourceID})`;
            }
          }
          
          return enhanced;
        })
      );

      // Prepare response with filter guidance
      const pageSize = args.pageSize || 50;
      const mayHaveMore = enhancedCompanies.length === pageSize;
      
      let resultsText = `Found ${enhancedCompanies.length} companies`;
      
      if (args.searchTerm) {
        resultsText += ` matching "${args.searchTerm}"`;
      }
      if (typeof args.isActive === 'boolean') {
        resultsText += ` (${args.isActive ? 'active' : 'inactive'} only)`;
      }
      
      if (mayHaveMore) {
        resultsText += `\n\nWARNING: Results may be incomplete (showing first ${enhancedCompanies.length} only).`;
        resultsText += `\nTO FIND A SPECIFIC COMPANY:`;
        resultsText += `\n  - Use get_entity with entity="companies" and id=<company_id> for direct lookup`;
        resultsText += `\n  - Add searchTerm parameter to filter by name`;
        resultsText += `\n  - Add isActive=true/false to filter by status`;
        resultsText += `\n  - Use search_companies with specific filters (companyName, ownerResourceID, etc.)`;
        resultsText += `\n\nWARNING: DO NOT attempt pagination - Autotask API uses cursor-based pagination which is not supported by this tool.`;
      }
      
      if (enhancedCompanies.length > 0) {
        resultsText += `\n\nCompanies:\n\n${enhancedCompanies.map(company => 
          `ID: ${company.id}\nName: ${company.companyName}\nType: ${company.companyType}\nActive: ${company.isActive}\nOwner: ${company._enhanced?.ownerResourceName || 'Unknown'}\n`
        ).join('\n')}`;
      } else {
        resultsText += '\n\nNo companies found with current filters.';
        if (hasFilters) {
          resultsText += ` Try different search criteria or removing filters.`;
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

  private async searchExpenseItems(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

      // Pre-fetch unique IDs to avoid cache stampede
      await this.prefetchMappingIds(
        expenseItems,
        ['companyID'],
        [],
        tenantContext
      );

      // Enhanced results with mapped names (cache is now populated)
      const mappingService = await this.getMappingService();
      const enhancedExpenseItems = await Promise.all(
        expenseItems.map(async (item: any) => {
          const enhanced: any = { ...item };
          enhanced._enhanced = {};
          
          // Add company name if available (from cache)
          if (item.companyID) {
            try {
              const companyName = await mappingService.getCompanyName(item.companyID, tenantContext);
              enhanced._enhanced.companyName = companyName ?? `Unknown (${item.companyID})`;
            } catch (error) {
              this.logger.debug(`Failed to map company ID ${item.companyID}:`, error);
              enhanced._enhanced.companyName = `Unknown (${item.companyID})`;
            }
          }
          
          return enhanced;
        })
      );

      const resultsText = enhancedExpenseItems.length > 0 
        ? `Found ${enhancedExpenseItems.length} expense items in expense report ${expenseReportId}:\n\n${JSON.stringify(enhancedExpenseItems, null, 2)}`
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

  private async getExpenseItem(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async createExpenseItem(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async updateExpenseItem(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
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

  private async queryEntity(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const { entity, search, pageSize } = args;
      
      if (!entity || !search) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Both entity and search parameters are required' }]
        };
      }

      // Map entity name to service method
      const entityMethodMap: Record<string, string> = {
        'companies': 'queryCompanies',
        'contacts': 'queryContacts',
        'tickets': 'queryTickets',
        'projects': 'queryProjects',
        'resources': 'queryResources',
        'tasks': 'queryTasks',
        'contracts': 'queryContracts',
        'quotes': 'queryQuotes',
        'invoices': 'queryInvoices',
        'timeentries': 'queryTimeEntries',
        'configurationitems': 'queryConfigurationItems',
        'expensereports': 'queryExpenseReports'
      };

      const methodName = entityMethodMap[entity.toLowerCase()];
      if (!methodName) {
        return {
          isError: true,
          content: [{ 
            type: 'text', 
            text: `Invalid entity type: ${entity}. Must be one of: ${Object.keys(entityMethodMap).join(', ')}` 
          }]
        };
      }

      // Call the appropriate service method
      const serviceMethod = (this.autotaskService as any)[methodName];
      if (typeof serviceMethod !== 'function') {
        return {
          isError: true,
          content: [{ type: 'text', text: `Service method ${methodName} not implemented` }]
        };
      }

      const queryOptions = { search, pageSize };
      const results = await serviceMethod.call(this.autotaskService, queryOptions, tenantContext);
      
      return this.createDataResponse(results);
    } catch (error: any) {
      return { 
        isError: true, 
        content: [{ type: 'text', text: `Failed to query ${args.entity}: ${error.message}` }] 
      };
    }
  }

  private async getEntityById(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const { entity, id, fullDetails } = args;
      
      if (!entity || !id) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Both entity and id parameters are required' }]
        };
      }

      // Map entity name to get method
      const entityMethodMap: Record<string, string> = {
        'companies': 'getCompany',
        'contacts': 'getContact',
        'tickets': 'getTicket',
        'projects': 'getProject',
        'resources': 'getResource',
        'tasks': 'getTask',
        'contracts': 'getContract',
        'quotes': 'getQuote',
        'invoices': 'getInvoice',
        'timeentries': 'getTimeEntry',
        'configurationitems': 'getConfigurationItem',
        'expensereports': 'getExpenseReport'
      };

      const methodName = entityMethodMap[entity.toLowerCase()];
      if (!methodName) {
        return {
          isError: true,
          content: [{ 
            type: 'text', 
            text: `Invalid entity type: ${entity}. Must be one of: ${Object.keys(entityMethodMap).join(', ')}` 
          }]
        };
      }

      // Call the appropriate service method
      const serviceMethod = (this.autotaskService as any)[methodName];
      if (typeof serviceMethod !== 'function') {
        return {
          isError: true,
          content: [{ type: 'text', text: `Service method ${methodName} not implemented` }]
        };
      }

      // Only tickets support fullDetails parameter (as second argument)
      const supportsFullDetails = ['getTicket', 'getTicketByNumber'].includes(methodName);
      
      let result;
      if (supportsFullDetails && fullDetails !== undefined) {
        // Pass id, fullDetails, tenantContext as separate parameters
        result = await serviceMethod.call(this.autotaskService, id, fullDetails, tenantContext);
      } else {
        // Pass id, tenantContext as separate parameters
        result = await serviceMethod.call(this.autotaskService, id, tenantContext);
      }
      
      if (!result) {
        return this.createNotFoundResponse(entity, id);
      }
      
      return this.createDataResponse(result);
    } catch (error: any) {
      return { 
        isError: true, 
        content: [{ type: 'text', text: `Failed to get ${args.entity}: ${error.message}` }] 
      };
    }
  }

  /**
   * Get company categories from Autotask CompanyCategories entity
   * This shows the actual classification values available in the system
   */
  private async getCompanyCategories(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const { includeInactive = false } = args;
      
      this.logger.info('📋 Getting company categories', {
        includeInactive,
        tenantId: tenantContext?.tenantId
      });

      const categories = await this.autotaskService.getCompanyCategories(includeInactive, tenantContext);

      const categoryInfo = {
        summary: {
          totalCategories: categories.length,
          activeCategories: categories.filter(c => c.isActive).length,
          inactiveCategories: categories.filter(c => !c.isActive).length,
          includeInactive: includeInactive
        },
        categories: categories.map(category => ({
          id: category.id,
          name: category.name,
          nickname: category.nickname,
          isActive: category.isActive,
          isApiOnly: category.isApiOnly,
          isGlobalDefault: category.isGlobalDefault,
          displayColorRGB: category.displayColorRGB
        }))
      };

      const guidance = `\n\n📋 **Company Categories Summary**: Found ${categories.length} categories. ` +
        `Use the category ID (not name) when filtering companies by category. ` +
        `Look for categories that match your managed services classification (e.g., "MCS", "Managed Services", etc.).`;

      return {
        isError: false,
        content: [{
          type: 'text',
          text: `# Company Categories${guidance}\n\n` + JSON.stringify(categoryInfo, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to get company categories: ${error.message}` }]
      };
    }
  }

  /**
   * Find clients by company category ID with their related contracts
   * Uses the actual CompanyCategories from Autotask instead of guessing field types
   * Now supports both categoryName (string) and categoryId (number) for better usability
   */
  private async findClientsByCategory(args: Record<string, any>, tenantContext?: TenantContext, _tracker?: ApiCallTracker): Promise<McpToolResult> {
    try {
      const { categoryName, categoryId, includeContracts = true, pageSize = 25 } = args;
      
      if (!categoryName && !categoryId) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Either categoryName or categoryId parameter is required. Use categoryName for easier searching (e.g., "MCS", "Managed Services").' }]
        };
      }

      this.logger.info('🏢 Finding clients by category', {
        categoryName,
        categoryId,
        includeContracts,
        pageSize,
        tenantId: tenantContext?.tenantId
      });

      let finalCategoryId = categoryId;
      let matchedCategory: any = null;

      // If categoryName is provided, find the matching category ID
      if (categoryName && !categoryId) {
        this.logger.info(`🔍 Looking up category ID for category name: "${categoryName}"`);
        
        const categories = await this.autotaskService.getCompanyCategories(false, tenantContext);
        
        // Try to find a matching category by name or nickname (case-insensitive)
        const searchTerm = categoryName.toLowerCase();
        matchedCategory = categories.find(cat => 
          cat.name?.toLowerCase().includes(searchTerm) || 
          cat.nickname?.toLowerCase().includes(searchTerm) ||
          searchTerm.includes(cat.name?.toLowerCase() || '') ||
          searchTerm.includes(cat.nickname?.toLowerCase() || '')
        );

        if (!matchedCategory) {
          // Show available categories to help the user
          const availableCategories = categories.map(cat => ({
            id: cat.id,
            name: cat.name,
            nickname: cat.nickname
          }));

          return {
            isError: true,
            content: [{
              type: 'text',
              text: `Category "${categoryName}" not found. Available categories:\n\n` + 
                    JSON.stringify(availableCategories, null, 2) + 
                    `\n\nTry using one of these category names or nicknames.`
            }]
          };
        }

        finalCategoryId = matchedCategory.id;
        this.logger.info(`✅ Found matching category: "${matchedCategory.name}" (ID: ${finalCategoryId})`);
      }

      // Search for companies with the specified category ID
      const companies = await this.autotaskService.searchCompanies({
        filter: [{
          field: 'companyCategoryID',
          op: 'eq',
          value: finalCategoryId
        }],
        pageSize: Math.min(pageSize, 50)
      }, tenantContext);

      const clientAnalysis: {
        summary: {
          totalClients: number;
          categoryId: number;
          categoryName?: string;
          searchCriteria: string;
          includeContracts: boolean;
        };
        clients: any[];
      } = {
        summary: {
          totalClients: companies.length,
          categoryId: finalCategoryId,
          categoryName: matchedCategory?.name || categoryName,
          searchCriteria: `Company Category ID = ${finalCategoryId}`,
          includeContracts: includeContracts
        },
        clients: []
      };

      // Enhance each client with contract information if requested
      for (const company of companies) {
        const clientData: any = {
          id: company.id,
          companyName: company.companyName,
          companyCategoryID: company.companyCategoryID,
          companyType: company.companyType,
          phone: company.phone,
          email: company.emailAddress,
          address1: company.address1,
          city: company.city,
          state: company.state,
          zipCode: company.zipCode,
          ownerResourceID: company.ownerResourceID,
          createDate: company.createDate,
          lastActivityDate: company.lastActivityDate
        };

        // Add contract information if requested
        if (includeContracts) {
          try {
            const contracts = await this.autotaskService.searchContracts({
              filter: [{
                field: 'companyID',
                op: 'eq',
                value: company.id
              }],
              pageSize: 10 // Limit contracts per client
            }, tenantContext);

            clientData.contracts = {
              count: contracts.length,
              activeContracts: contracts.filter(c => c.status === 1).length,
              contractTypes: this.groupByField(contracts, 'contractType'),
              totalContractValue: this.calculateTotalValue(contracts),
              contracts: contracts.map(contract => ({
                id: contract.id,
                contractName: contract.contractName,
                contractType: contract.contractType,
                status: contract.status,
                startDate: contract.startDate,
                endDate: contract.endDate,
                contractValue: contract.contractValue,
                isRecurring: contract.isRecurring
              }))
            };
          } catch (contractError) {
            this.logger.warn(`Failed to get contracts for company ${company.id}:`, contractError);
            clientData.contracts = { error: 'Unable to retrieve contract information' };
          }
        }

        clientAnalysis.clients.push(clientData);
      }

      const categoryInfo = matchedCategory ? 
        `"${matchedCategory.name}" (ID: ${finalCategoryId})` : 
        `ID: ${finalCategoryId}`;

      const guidance = `\n\n📊 **Client Analysis Summary**: Found ${companies.length} clients in category ${categoryInfo}. ` +
        `For managed services teams, focus on clients with active contracts and recurring billing. ` +
        `Use get_company_categories to see all available category names and IDs.`;

      return {
        isError: false,
        content: [{
          type: 'text',
          text: `# Client Category Analysis${guidance}\n\n` + JSON.stringify(clientAnalysis, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to find clients by category: ${error.message}` }]
      };
    }
  }

  /**
   * Helper method to group data by a specific field
   */
  private groupByField(data: any[], field: string): Record<string, number> {
    const groups: Record<string, number> = {};
    data.forEach(item => {
      const value = item[field] || 'Unknown';
      groups[value] = (groups[value] || 0) + 1;
    });
    return groups;
  }

  /**
   * Helper method to calculate total contract value
   */
  private calculateTotalValue(contracts: any[]): number {
    return contracts.reduce((sum, contract) => sum + (contract.contractValue || 0), 0);
  }
}