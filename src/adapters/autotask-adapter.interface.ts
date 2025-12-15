/**
 * Autotask Adapter Interface
 * 
 * This interface provides a unified abstraction for Autotask API operations,
 * allowing easy migration between different underlying libraries
 * (autotask-node → @apigrate/autotask-restapi).
 * 
 * Key features:
 * - Explicit pagination protocol in all query responses
 * - Rate limiting support
 * - Multi-tenant support via tenant context
 */

import { TenantContext } from '../types/mcp.js';

// ============================================
// Filter & Query Types
// ============================================

export type FilterOperator = 
  | 'eq'           // Equals
  | 'ne'           // Not equals
  | 'gt'           // Greater than
  | 'gte'          // Greater than or equal
  | 'lt'           // Less than
  | 'lte'          // Less than or equal
  | 'contains'     // Contains substring
  | 'beginsWith'   // Starts with
  | 'endsWith'     // Ends with
  | 'in'           // In list
  | 'notIn'        // Not in list
  | 'isNull'       // Is null
  | 'isNotNull';   // Is not null

export interface FilterExpression {
  field: string;
  op: FilterOperator;
  value: any;
  udf?: boolean;  // Is this a User Defined Field?
}

export interface QueryOptions {
  filter?: FilterExpression[];
  includeFields?: string[];
  sort?: {
    field: string;
    direction: 'asc' | 'desc';
  };
  page?: number;
  pageSize?: number;  // Max 500 per Autotask API limits
}

// ============================================
// Pagination Protocol Types
// ============================================

export type PaginationStatus = 'COMPLETE' | 'INCOMPLETE';

/**
 * Pagination protocol metadata - included in EVERY query response.
 * This enables AI agents to know exactly when they need to retrieve more data.
 */
export interface PaginationProtocol {
  /** Current status of data retrieval */
  status: PaginationStatus;
  
  /** Current page number (1-indexed) */
  currentPage: number;
  
  /** Total number of pages available */
  totalPages: number;
  
  /** Number of items in this response */
  itemsInThisResponse: number;
  
  /** Total items available across all pages */
  totalItems: number;
  
  /** 
   * Human-readable instruction for AI agents.
   * This tells the AI exactly what to do next.
   */
  instruction: string;
  
  /** If true, AI must verify all data retrieved before analysis */
  verificationRequired: boolean;
  
  /** Next action to take if data is incomplete */
  nextAction?: {
    description: string;
    page: number;
    remainingPages: number[];
  };
}

export interface PageDetails {
  count: number;          // Total items matching query
  requestCount: number;   // Items per page requested
  prevPageUrl: string | null;
  nextPageUrl: string | null;
}

/**
 * Paginated result - ALL query methods return this format.
 * The paginationProtocol field enables rock-solid pagination handling.
 */
export interface PaginatedResult<T> {
  /** The actual data items */
  items: T[];
  
  /** Raw page details from Autotask API */
  pageDetails: PageDetails;
  
  /** 
   * CRITICAL: Pagination protocol for AI agents.
   * This tells the AI exactly whether data is complete and what to do next.
   */
  paginationProtocol: PaginationProtocol;
}

// ============================================
// Entity Metadata Types
// ============================================

export interface FieldInfo {
  name: string;
  dataType: 'string' | 'integer' | 'double' | 'boolean' | 'datetime';
  length: number;
  isRequired: boolean;
  isReadOnly: boolean;
  isQueryable: boolean;
  isReference: boolean;
  referenceEntityType: string;
  isPickList: boolean;
  picklistValues: PicklistValue[] | null;
}

export interface PicklistValue {
  value: string;
  label: string;
  isDefaultValue: boolean;
  sortOrder: number;
  isActive: boolean;
}

export interface EntityInfo {
  name: string;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canQuery: boolean;
  hasUserDefinedFields: boolean;
}

// ============================================
// Result Types
// ============================================

export interface CreateResult {
  itemId: number;
}

export interface CountResult {
  queryCount: number;
}

export interface GetResult<T> {
  item: T | null;
}

// ============================================
// Main Adapter Interface
// ============================================

/**
 * Autotask API Adapter Interface
 * 
 * Implementations of this interface wrap the actual Autotask API library
 * and provide a consistent interface with explicit pagination handling.
 */
export interface AutotaskAdapter {
  // ============================================
  // Core CRUD Operations
  // ============================================
  
  /**
   * Query for entities matching filter criteria.
   * 
   * CRITICAL: Always check the returned paginationProtocol.status.
   * If status is 'INCOMPLETE', you MUST retrieve remaining pages
   * before performing any analysis on the data.
   */
  query<T>(
    entity: string, 
    options: QueryOptions,
    tenantContext?: TenantContext
  ): Promise<PaginatedResult<T>>;
  
  /**
   * Get a single entity by ID.
   * Returns { item: null } if not found (not an error).
   */
  get<T>(
    entity: string, 
    id: number,
    tenantContext?: TenantContext
  ): Promise<GetResult<T>>;
  
  /**
   * Get a child entity by parent ID and child ID.
   * Used for parent-child relationships like Tickets/Attachments.
   */
  getChild<T>(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    childId: number,
    tenantContext?: TenantContext
  ): Promise<GetResult<T>>;
  
  /**
   * Create a new entity.
   */
  create<T>(
    entity: string, 
    data: Partial<T>,
    tenantContext?: TenantContext
  ): Promise<CreateResult>;
  
  /**
   * Create a child entity under a parent.
   * Required for entities with parent-child relationships.
   */
  createChild<T>(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    data: Partial<T>,
    tenantContext?: TenantContext
  ): Promise<CreateResult>;
  
  /**
   * Update an entity (PATCH - only specified fields).
   */
  update(
    entity: string, 
    id: number, 
    data: Record<string, any>,
    tenantContext?: TenantContext
  ): Promise<void>;
  
  /**
   * Update a child entity.
   */
  updateChild(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    childId: number,
    data: Record<string, any>,
    tenantContext?: TenantContext
  ): Promise<void>;
  
  /**
   * Replace an entity (PUT - replaces entire entity).
   */
  replace<T>(
    entity: string, 
    id: number, 
    data: T,
    tenantContext?: TenantContext
  ): Promise<void>;
  
  /**
   * Delete an entity by ID.
   */
  delete(
    entity: string, 
    id: number,
    tenantContext?: TenantContext
  ): Promise<void>;
  
  // ============================================
  // Metadata Operations
  // ============================================
  
  /**
   * Count entities matching filter criteria.
   */
  count(
    entity: string, 
    filter: FilterExpression[],
    tenantContext?: TenantContext
  ): Promise<CountResult>;
  
  /**
   * Get field information for an entity.
   */
  fieldInfo(
    entity: string,
    tenantContext?: TenantContext
  ): Promise<FieldInfo[]>;
  
  /**
   * Get entity metadata.
   */
  entityInfo(
    entity: string,
    tenantContext?: TenantContext
  ): Promise<EntityInfo>;
  
  /**
   * Get UDF (User Defined Field) information for an entity.
   */
  udfInfo(
    entity: string,
    tenantContext?: TenantContext
  ): Promise<FieldInfo[]>;
  
  // ============================================
  // Connection & Health
  // ============================================
  
  /**
   * Test API connection.
   */
  testConnection(tenantContext?: TenantContext): Promise<boolean>;
  
  /**
   * Get zone information for the current credentials.
   */
  getZoneInfo(tenantContext?: TenantContext): Promise<{
    url: string;
    webUrl: string;
  }>;
}

// ============================================
// Entity Name Constants
// ============================================

/**
 * All supported Autotask entities.
 * These names match the @apigrate/autotask-restapi entity names.
 */
export const AUTOTASK_ENTITIES = {
  // Core entities
  Companies: 'Companies',
  Contacts: 'Contacts',
  Tickets: 'Tickets',
  Projects: 'Projects',
  Resources: 'Resources',
  Tasks: 'Tasks',
  
  // Time & Billing
  TimeEntries: 'TimeEntries',
  BillingCodes: 'BillingCodes',
  BillingItems: 'BillingItems',
  
  // Configuration
  ConfigurationItems: 'ConfigurationItems',
  ConfigurationItemCategories: 'ConfigurationItemCategories',
  ConfigurationItemTypes: 'ConfigurationItemTypes',
  
  // Contracts & Services
  Contracts: 'Contracts',
  ContractServices: 'ContractServices',
  ContractBlocks: 'ContractBlocks',
  Services: 'Services',
  ServiceBundles: 'ServiceBundles',
  
  // Financial
  Invoices: 'Invoices',
  Quotes: 'Quotes',
  Expenses: 'Expenses',
  ExpenseReports: 'ExpenseReports',
  
  // Notes (child entities)
  TicketNotes: 'TicketNotes',
  ProjectNotes: 'ProjectNotes',
  CompanyNotes: 'CompanyNotes',
  
  // Attachments (child entities)
  TicketAttachments: 'TicketAttachments',
  ProjectAttachments: 'ProjectAttachments',
  
  // Reference data
  Departments: 'Departments',
  TicketCategories: 'TicketCategories',
  TicketStatuses: 'TicketStatuses',
  TicketPriorities: 'TicketPriorities',
  
  // Other
  Opportunities: 'Opportunities',
  Products: 'Products'
} as const;

export type AutotaskEntityName = typeof AUTOTASK_ENTITIES[keyof typeof AUTOTASK_ENTITIES];

// ============================================
// Parent-Child Relationship Mapping
// ============================================

/**
 * Maps child entities to their parent entities.
 * Used for create/update/delete operations that require parent context.
 */
export const PARENT_CHILD_RELATIONSHIPS: Record<string, string> = {
  // Company children
  'CompanyNotes': 'Companies',
  'CompanyToDos': 'Companies',
  'CompanyAttachments': 'Companies',
  'CompanyContacts': 'Companies',
  'CompanyLocations': 'Companies',
  
  // Ticket children
  'TicketNotes': 'Tickets',
  'TicketAttachments': 'Tickets',
  'TicketChecklistItems': 'Tickets',
  'TicketSecondaryResources': 'Tickets',
  
  // Project children
  'Tasks': 'Projects',
  'ProjectNotes': 'Projects',
  'ProjectAttachments': 'Projects',
  'Phases': 'Projects',
  
  // Task children
  'TaskNotes': 'Tasks',
  'TaskAttachments': 'Tasks',
  
  // Contract children
  'ContractServices': 'Contracts',
  'ContractBlocks': 'Contracts',
  'ContractNotes': 'Contracts',
  
  // Expense children
  'ExpenseItems': 'Expenses',
  
  // Quote children
  'QuoteItems': 'Quotes',
  
  // Other
  'SubscriptionPeriods': 'Subscriptions',
  'Holidays': 'HolidaySets'
};


