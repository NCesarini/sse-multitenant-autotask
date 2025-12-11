// Autotask Entity Type Definitions
// Based on @apigrate/autotask-restapi library types

// ============================================
// Pagination Configuration - Single Source of Truth
// ============================================

/**
 * Centralized pagination configuration
 * All search methods MUST respect these limits
 */
export const PAGINATION_CONFIG = {
  /** Max items per page - request up to this many at once */
  MAX_PAGE_SIZE: 200,
  /** Default page size when not specified */
  DEFAULT_PAGE_SIZE: 100,
  /** Autotask API hard limit - cannot exceed this per API call */
  API_MAX: 500,
  /** Informational: max pages recommended per conversation turn */
  MAX_PAGES_PER_CALL: 5,
  /** Informational: max items per conversation turn (5 pages x 200) */
  MAX_ITEMS_PER_CALL: 1000
} as const;

// ============================================
// Pagination Types for "Showing X of Y" Pattern
// ============================================

/**
 * Pagination information included in all search responses
 * Enables AI agents to detect incomplete data and fetch remaining pages
 */
export interface PaginationInfo {
  /** Number of items in current response */
  showing: number;
  /** Total count of matching items (from Autotask count API or pageDetails) */
  total: number;
  /** Whether total is exact or estimated */
  totalKnown: boolean;
  /** Current page number (1-based) */
  currentPage: number;
  /** Number of items per page */
  pageSize: number;
  /** Whether more pages are available */
  hasMore: boolean;
  /** URL to fetch next page (if available) */
  nextPageUrl?: string;
  /** URL to fetch previous page (if available) */
  prevPageUrl?: string;
  /** Percentage of total data retrieved */
  percentComplete: number;
}

/**
 * Wrapper for paginated API responses
 * All search tools return this format for consistency
 */
export interface PaginatedResponse<T> {
  /** The actual data items */
  items: T[];
  /** Pagination metadata for AI agent decision making */
  pagination: PaginationInfo;
  /** 
   * Human-readable warning when data is incomplete
   * Format: "PAGINATION STATUS: Showing X of Y entries. WARNING: INCOMPLETE DATA."
   */
  _paginationStatus: string;
  /**
   * Procedural instruction for AI agent
   * Only present when hasMore is true
   */
  _nextAction?: string;
}

/**
 * Creates a formatted pagination status message with clear next steps
 */
export function formatPaginationStatus(pagination: PaginationInfo): string {
  if (!pagination.hasMore) {
    return `PAGINATION STATUS: Showing ${pagination.showing} of ${pagination.total} entries (COMPLETE - ALL DATA RETRIEVED)`;
  }
  
  const remaining = pagination.total - pagination.showing;
  const percentRetrieved = pagination.percentComplete.toFixed(1);
  const nextPage = pagination.currentPage + 1;
  const totalPagesNeeded = Math.ceil(pagination.total / pagination.pageSize);
  
  // Calculate what range the next page will return
  const nextPageStart = pagination.showing + 1;
  const nextPageEnd = Math.min(pagination.showing + pagination.pageSize, pagination.total);
  
  return `PAGINATION STATUS: Showing ${pagination.showing} of ${pagination.total} entries\n` +
    `DATA INCOMPLETE: ${percentRetrieved}% retrieved\n` +
    `REMAINING: ${remaining} more entries\n` +
    `NEXT STEP: Call same tool with page=${nextPage} to get items ${nextPageStart}-${nextPageEnd}\n` +
    `FULL RETRIEVAL: Will require ${totalPagesNeeded} total calls (pages 1-${totalPagesNeeded})`;
}

/**
 * Creates the next action instruction for incomplete data
 */
export function formatNextAction(pagination: PaginationInfo, toolName: string): string {
  if (!pagination.hasMore) {
    return '';
  }
  
  return `REQUIRED ACTION: Call ${toolName} with page=${pagination.currentPage + 1} to retrieve next batch`;
}

export interface AutotaskCompany {
  id?: number;
  companyName?: string;
  companyType?: number;
  phone?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryID?: number;
  isActive?: boolean;
  ownerResourceID?: number;
  createDate?: string;
  lastActivityDate?: string;
  lastTrackedModifiedDateTime?: string;
  [key: string]: any;
}

export interface AutotaskContact {
  id?: number;
  companyID?: number;
  firstName?: string;
  lastName?: string;
  emailAddress?: string;
  phone?: string;
  title?: string;
  isActive?: number; // Note: autotask-node uses number, not boolean
  createDate?: string;
  lastModifiedDate?: string;
  [key: string]: any;
}

export interface AutotaskTicket {
  id?: number;
  ticketNumber?: string;
  companyID?: number;
  contactID?: number;
  assignedResourceID?: number;
  title?: string;
  description?: string;
  status?: number;
  priority?: number;
  ticketType?: number;
  issueType?: number;
  subIssueType?: number;
  createDate?: string;
  createdByContactID?: number;
  createdByResourceID?: number;
  dueDateTime?: string;
  completedDate?: string;
  lastActivityDate?: string;
  estimatedHours?: number;
  hoursToBeScheduled?: number;
  [key: string]: any;
}

export interface AutotaskResource {
  id?: number;
  firstName?: string;
  lastName?: string;
  userName?: string;
  email?: string;
  isActive?: boolean;
  title?: string;
  resourceType?: number;
  userType?: number;
  [key: string]: any;
}

export interface AutotaskProject {
  id?: number;
  companyID?: number;
  projectName?: string;
  projectNumber?: string;
  description?: string;
  status?: number;
  projectType?: number;
  department?: number;
  startDate?: string;
  endDate?: string;
  startDateTime?: string;
  endDateTime?: string;
  projectManagerResourceID?: number;
  estimatedHours?: number;
  actualHours?: number;
  laborEstimatedRevenue?: number;
  createDate?: string;
  completedDate?: string;
  contractID?: number;
  originalEstimatedRevenue?: number;
  [key: string]: any;
}

export interface AutotaskTimeEntry {
  id?: number;
  resourceID?: number;
  ticketID?: number;
  projectID?: number;
  taskID?: number;
  dateWorked?: string;
  startDateTime?: string;
  endDateTime?: string;
  hoursWorked?: number;
  hoursToBill?: number;
  offsetHours?: number;
  summaryNotes?: string;
  internalNotes?: string;
  billableToAccount?: boolean;
  isNonBillable?: boolean;
  createDate?: string;
  createdByResourceID?: number;
  lastModifiedDate?: string;
  lastModifiedByResourceID?: number;
  [key: string]: any;
}

// Additional interfaces that were missing
export interface AutotaskConfigurationItem {
  id?: number;
  companyID?: number;
  serialNumber?: string;
  configurationItemName?: string;
  configurationItemType?: number;
  configurationItemCategoryID?: number;
  isActive?: boolean;
  warrantyExpirationDate?: string;
  lastActivityDate?: string;
  [key: string]: any;
}

export interface AutotaskContract {
  id?: number;
  companyID?: number;
  contractName?: string;
  contractNumber?: string;
  startDate?: string;
  endDate?: string;
  status?: number;
  contactID?: number;
  [key: string]: any;
}

export interface AutotaskInvoice {
  id?: number;
  companyID?: number;
  invoiceNumber?: string;
  invoiceDate?: string;
  totalAmount?: number;
  paidAmount?: number;
  isVoided?: boolean;
  [key: string]: any;
}

export interface AutotaskTask {
  id?: number;
  projectID?: number;
  title?: string;
  description?: string;
  assignedResourceID?: number;
  status?: number;
  priority?: number;
  startDate?: string;
  endDate?: string;
  estimatedHours?: number;
  actualHours?: number;
  [key: string]: any;
}

export interface AutotaskTicketNote {
  id?: number;
  ticketID?: number;
  noteType?: number;
  title?: string;
  description?: string;
  createDate?: string;
  createdByResourceID?: number;
  isVisibleToClientPortal?: boolean;
  [key: string]: any;
}

export interface AutotaskProjectNote {
  id?: number;
  projectID?: number;
  noteType?: number;
  title?: string;
  description?: string;
  createDate?: string;
  createdByResourceID?: number;
  [key: string]: any;
}

export interface AutotaskCompanyNote {
  id?: number;
  companyID?: number;
  noteType?: number;
  title?: string;
  description?: string;
  createDate?: string;
  createdByResourceID?: number;
  [key: string]: any;
}

export interface AutotaskTicketAttachment {
  id?: number;
  ticketID?: number;
  fileName?: string;
  fileSize?: number;
  contentType?: string;
  data?: string; // Base64 encoded file data
  createDate?: string;
  createdByResourceID?: number;
  [key: string]: any;
}

export interface AutotaskExpenseReport {
  id?: number;
  name?: string;
  submittedByResourceID?: number;
  submitDate?: string;
  approvedDate?: string;
  status?: number;
  totalAmount?: number;
  [key: string]: any;
}

export interface AutotaskExpenseItem {
  id?: number;
  expenseReportID?: number;
  expenseDate?: string;
  description?: string;
  amount?: number;
  billableToAccount?: boolean;
  [key: string]: any;
}

export interface AutotaskQuote {
  id?: number;
  companyID?: number;
  contactID?: number;
  quoteNumber?: string;
  quoteDate?: string;
  title?: string;
  description?: string;
  totalAmount?: number;
  status?: number;
  [key: string]: any;
}

export interface AutotaskBillingCode {
  id?: number;
  name?: string;
  description?: string;
  isActive?: boolean;
  hourlyRate?: number;
  [key: string]: any;
}

export interface AutotaskDepartment {
  id?: number;
  name?: string;
  description?: string;
  isActive?: boolean;
  [key: string]: any;
}

export interface AutotaskUserDefinedField {
  name: string;
  value: string;
}

// ============================================
// API Response wrapper types
// Based on @apigrate/autotask-restapi format
// ============================================

/**
 * Raw API response from Autotask REST API
 * This is what the @apigrate library returns
 */
export interface AutotaskApiResponse<T> {
  items: T[];
  pageDetails?: AutotaskPageDetails;
}

/**
 * Page details returned by Autotask API
 * Critical for implementing "Showing X of Y" pattern
 */
export interface AutotaskPageDetails {
  /** Number of items in current page */
  count: number;
  /** Number of items requested (pageSize) */
  requestCount: number;
  /** URL to previous page (null if first page) */
  prevPageUrl: string | null;
  /** URL to next page (null if last page) */
  nextPageUrl: string | null;
}

/**
 * Response from count API endpoint
 */
export interface AutotaskCountResponse {
  queryCount: number;
}

export interface AutotaskApiSingleResponse<T> {
  item: T;
  itemId?: number;
}

/**
 * Filter operators supported by Autotask REST API
 */
export type AutotaskFilterOperator = 
  | 'eq'          // equals
  | 'noteq'       // not equals
  | 'gt'          // greater than
  | 'gte'         // greater than or equal
  | 'lt'          // less than
  | 'lte'         // less than or equal
  | 'beginsWith'  // string starts with
  | 'endsWith'    // string ends with
  | 'contains'    // string contains
  | 'exist'       // field has value
  | 'notExist'    // field is null
  | 'in'          // value in list
  | 'notIn';      // value not in list

/**
 * Single filter condition for Autotask queries
 */
export interface AutotaskFilterCondition {
  field: string;
  op: AutotaskFilterOperator;
  value: any;
  /** Set to true for user-defined fields */
  udf?: boolean;
}

/**
 * Query options matching @apigrate/autotask-restapi format
 */
export interface AutotaskQueryOptions {
  filter?: AutotaskFilterCondition[] | Record<string, any>;
  sort?: string;
  page?: number;
  pageSize?: number;
  includeFields?: string[];
}

// Extended query options for more advanced queries
export interface AutotaskQueryOptionsExtended extends AutotaskQueryOptions {
  includeFields?: string[];
  excludeFields?: string[];
  expand?: string[];
  submitterId?: number;
  companyId?: number;
  contactId?: number;
  opportunityId?: number;
  searchTerm?: string;
  status?: number;
  priority?: number;
  assignedResourceID?: number;
  unassigned?: boolean;
  projectId?: number;
  contractId?: number;
  createdDateFrom?: string;
  createdDateTo?: string;
  // Note: Pagination is now enabled by default. Only specify pageSize to limit results.
}

// Status enums (commonly used values)
export enum TicketStatus {
  New = 1,
  InProgress = 5,
  Complete = 5,
  WaitingCustomer = 7,
  WaitingVendor = 8,
  Escalated = 9
}

export enum TicketPriority {
  Low = 1,
  Medium = 2,
  High = 3,
  Critical = 4,
  Urgent = 5
}

export enum CompanyType {
  Customer = 1,
  Lead = 2,
  Prospect = 3,
  DeadLead = 4,
  Vendor = 5,
  Partner = 6
} 