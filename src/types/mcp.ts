// MCP Protocol Type Definitions
// Based on Model Context Protocol specification

export interface McpServerConfig {
  name: string;
  version: string;
  autotask?: {
    username?: string;
    integrationCode?: string;
    secret?: string;
    apiUrl?: string;
  };
  // New: Multi-tenant configuration
  multiTenant?: {
    enabled: boolean;
    defaultApiUrl?: string;
    clientPoolSize?: number;
    sessionTimeout?: number;
  };
}

// New: Per-request authentication
export interface AutotaskCredentials {
  username: string;
  secret: string;
  integrationCode: string;
  apiUrl?: string;
}

// New: Tenant context for requests
export interface TenantContext {
  tenantId: string;
  credentials: AutotaskCredentials;
  sessionId?: string;
  // User impersonation - which user this session acts as
  impersonationResourceId?: number;
  // Access mode - restricts what operations this tenant can perform
  mode?: 'read' | 'write';
}

// Enhanced tool call with tenant context
export interface McpToolCallWithTenant extends McpToolCall {
  tenantContext?: TenantContext;
}

// MCP Resource types
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// MCP Tool types
export interface McpTool {
  name: string;
  description: string;
  /**
   * Indicates the data access pattern of the tool:
   * - 'read': Read-only operations that don't modify data (e.g., search, get)
   * - 'write': Creates new records in Autotask (e.g., create operations)
   * - 'modify': Updates existing records or system state (e.g., update, cache operations)
   */
  operationType?: 'read' | 'write' | 'modify';
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface McpToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface McpToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: any;
  }>;
  isError?: boolean;
}

// Autotask-specific MCP Resource URIs
export const AUTOTASK_RESOURCE_URIS = {
  COMPANIES: 'autotask://companies',
  COMPANY: 'autotask://companies/{id}',
  TICKETS: 'autotask://tickets',
  TICKET: 'autotask://tickets/{id}',
  CONTACTS: 'autotask://contacts',
  CONTACT: 'autotask://contacts/{id}',
  COMPANY_CONTACTS: 'autotask://companies/{companyId}/contacts',
  COMPANY_TICKETS: 'autotask://companies/{companyId}/tickets',
} as const;

// Autotask-specific MCP Tool names
export const AUTOTASK_TOOLS = {
  // Company tools
  GET_COMPANY: 'autotask_get_company',
  SEARCH_COMPANIES: 'autotask_search_companies',
  CREATE_COMPANY: 'autotask_create_company',
  UPDATE_COMPANY: 'autotask_update_company',

  // Ticket tools
  GET_TICKET: 'autotask_get_ticket',
  SEARCH_TICKETS: 'autotask_search_tickets',
  CREATE_TICKET: 'autotask_create_ticket',
  UPDATE_TICKET: 'autotask_update_ticket',
  ADD_TICKET_NOTE: 'autotask_add_ticket_note',

  // Contact tools
  GET_CONTACT: 'autotask_get_contact',
  SEARCH_CONTACTS: 'autotask_search_contacts',
  CREATE_CONTACT: 'autotask_create_contact',
  UPDATE_CONTACT: 'autotask_update_contact',

  // Time entry tools
  CREATE_TIME_ENTRY: 'autotask_create_time_entry',
  GET_TIME_ENTRIES: 'autotask_get_time_entries',
} as const;

// Common parameter schemas for tools
export const COMMON_SCHEMAS = {
  ID_PARAMETER: {
    type: 'integer',
    description: 'The ID of the entity',
    minimum: 1
  },
  COMPANY_ID_PARAMETER: {
    type: 'integer',
    description: 'The company ID',
    minimum: 1
  },
  SEARCH_QUERY: {
    type: 'string',
    description: 'Search query string',
    minLength: 1
  },
  LIMIT_PARAMETER: {
    type: 'integer',
    description: 'Maximum number of results to return',
    minimum: 1,
    maximum: 500,
    default: 50
  }
} as const; 