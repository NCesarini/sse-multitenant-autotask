/**
 * Pagination Enforcer
 * 
 * This module provides rock-solid pagination handling for Autotask API responses.
 * It ensures that AI agents ALWAYS know when data is incomplete and what to do about it.
 * 
 * Key principles:
 * 1. EVERY paginated response includes explicit status (COMPLETE/INCOMPLETE)
 * 2. INCOMPLETE status includes CLEAR instructions on what to do next
 * 3. AI agents MUST retrieve ALL pages before performing any analysis
 */

import { 
  PaginatedResult, 
  PaginationProtocol, 
  PaginationStatus,
  PageDetails 
} from '../adapters/autotask-adapter.interface.js';
import { McpToolResult } from '../types/mcp.js';
import type { TruncationReason } from './paginated-query.js';

// ============================================

export interface EnforceOptions<T> {
  items: T[];
  /** Total matching records from Autotask count / pageDetails.count */
  totalEstimate: number;
  entityName: string;
  status: 'COMPLETE' | 'INCOMPLETE';
  /** Present when status is INCOMPLETE — pass to continue_query */
  cursor?: string;
  truncationReason?: TruncationReason | null;
  pagesFetched?: number;
  sumField?: string;
  availableFilters?: string[];
  /** Warn when totalEstimate exceeds this (default 5000) */
  largeResultWarningThreshold?: number;
}

export interface EnforceResult<T> {
  items: T[];
  protocol: {
    status: 'COMPLETE' | 'INCOMPLETE';
    message: string;
    showing: string;
    totalItems: number;
    itemsInThisResponse: number;
    itemsAccumulated: number;
    pagesFetched?: number;
    truncationReason?: TruncationReason;
    nextAction?: {
      tool: 'continue_query';
      description: string;
      callWith: { cursor: string };
    };
    verificationSteps: string[];
    performanceWarning?: {
      severity: 'HIGH' | 'MEDIUM';
      message: string;
      recommendation: string;
      suggestedFilters?: string[];
    };
  };
}

// ============================================
// Pagination Enforcer Class
// ============================================

export class PaginationEnforcer {
  
  /**
   * Build pagination protocol for results after server-side cursor iteration
   * (PaginatedQueryEngine + Autotask nextPageUrl).
   */
  static enforce<T>(options: EnforceOptions<T>): EnforceResult<T> {
    const {
      items,
      totalEstimate,
      entityName,
      status,
      cursor,
      truncationReason,
      pagesFetched,
      sumField,
      availableFilters,
      largeResultWarningThreshold = 5000
    } = options;

    const isComplete = status === 'COMPLETE';
    const itemsAccumulated = items.length;
    const showing =
      totalEstimate > 0
        ? `Retrieved ${itemsAccumulated} row(s); Autotask reports ~${totalEstimate} total matches for this query`
        : `Retrieved ${itemsAccumulated} row(s)`;

    const verificationSteps = isComplete
      ? [
          '1. All data for this request has been retrieved (or capped by maxItems).',
          `2. Create verification table with ALL ${entityName} in this response`,
          sumField
            ? `3. Use math_calculator to sum ${sumField} values`
            : '3. Analyze the complete dataset in this response',
          'PROTOCOL COMPLETE'
        ]
      : [
          `1. INCOMPLETE: ${itemsAccumulated} ${entityName} in this response; more exist on Autotask.`,
          ...(truncationReason
            ? [`2. Truncation reason: ${truncationReason} (server budget: items/pages/time).`]
            : ['2. Additional pages were not merged into this response.']),
          '3. Call tool `continue_query` with argument { cursor: <value from nextAction.callWith.cursor> }',
          '4. Repeat until _paginationProtocol.status is COMPLETE',
          sumField
            ? `5. Only then: sum ${sumField} with math_calculator`
            : '5. Only then: analyze the full merged dataset',
          'DO NOT use page=N — Autotask uses cursor URLs only; use continue_query.'
        ];

    const protocol: EnforceResult<T>['protocol'] = {
      status,
      message: isComplete
        ? `Dataset complete for this tool call (${itemsAccumulated} ${entityName}). Safe to analyze.`
        : `INCOMPLETE: ${showing}. You MUST call continue_query with the cursor before any analysis that requires all rows.`,
      showing,
      totalItems: totalEstimate,
      itemsInThisResponse: itemsAccumulated,
      itemsAccumulated,
      ...(pagesFetched !== undefined ? { pagesFetched } : {}),
      ...(truncationReason !== undefined &&
      truncationReason !== null &&
      !isComplete
        ? { truncationReason }
        : {}),
      verificationSteps
    };

    if (!isComplete && cursor !== undefined && cursor.length > 0) {
      protocol.nextAction = {
        tool: 'continue_query',
        description: 'Resume Autotask pagination from the server-stored nextPageUrl.',
        callWith: { cursor }
      };
    }

    if (totalEstimate > largeResultWarningThreshold) {
      const isMassive = totalEstimate > 20_000;
      protocol.performanceWarning = {
        severity: isMassive ? 'HIGH' : 'MEDIUM',
        message: isMassive
          ? `VERY LARGE RESULT SET: ~${totalEstimate} ${entityName} match this filter`
          : `LARGE RESULT SET: ~${totalEstimate} ${entityName} match this filter`,
        recommendation: isMassive
          ? `STRONGLY RECOMMENDED: Narrow the query (dates, status, companyID, etc.) or use maxItems. Full retrieval may require many continue_query calls.`
          : `RECOMMENDED: Add filters to reduce matches below ${largeResultWarningThreshold} when possible.`,
        ...(availableFilters !== undefined &&
          availableFilters.length > 0 && {
            suggestedFilters: availableFilters
          })
      };
    }

    return { items, protocol };
  }

  /**
   * Build pagination protocol metadata from API response.
   * 
   * @param items Items returned in this response
   * @param pageDetails Raw page details from Autotask API
   * @param currentPage Current page number (1-indexed)
   * @param pageSize Items per page
   */
  static buildProtocol<T>(
    items: T[],
    pageDetails: PageDetails,
    currentPage: number = 1,
    pageSize: number = 500
  ): PaginationProtocol {
    const totalItems = pageDetails.count;
    const totalPages = Math.ceil(totalItems / pageSize);
    const isComplete = pageDetails.nextPageUrl === null || currentPage >= totalPages;
    
    const status: PaginationStatus = isComplete ? 'COMPLETE' : 'INCOMPLETE';
    
    const protocol: PaginationProtocol = {
      status,
      currentPage,
      totalPages,
      itemsInThisResponse: items.length,
      totalItems,
      instruction: this.buildInstruction(status, currentPage, totalPages, items.length, totalItems),
      verificationRequired: !isComplete
    };
    
    if (!isComplete) {
      const remainingPages = this.calculateRemainingPages(currentPage, totalPages);
      protocol.nextAction = {
        description: `Retrieve page ${currentPage + 1} of ${totalPages}`,
        page: currentPage + 1,
        remainingPages
      };
    }
    
    return protocol;
  }
  
  /**
   * Build human-readable instruction for AI agents.
   */
  private static buildInstruction(
    status: PaginationStatus,
    currentPage: number,
    totalPages: number,
    itemsRetrieved: number,
    totalItems: number
  ): string {
    if (status === 'COMPLETE') {
      return `DATA COMPLETE: All ${totalItems} items retrieved across ${currentPage} page(s). Safe to proceed with analysis.`;
    }
    
    const remaining = totalPages - currentPage;
    const cumulativeRetrieved = (currentPage - 1) * 500 + itemsRetrieved; // Approximate
    const percentComplete = Math.round((cumulativeRetrieved / totalItems) * 100);
    
    return `INCOMPLETE DATA - DO NOT ANALYZE YET

Progress: ${cumulativeRetrieved} of ${totalItems} items (${percentComplete}%)
Pages: ${currentPage} of ${totalPages} (${remaining} remaining)

REQUIRED STEPS:
1. Call this tool again with page=${currentPage + 1}
2. Repeat for each remaining page until status is COMPLETE
3. Collect all items from all pages
4. ONLY THEN perform any calculations or analysis

WARNING: Any analysis on incomplete data will produce INCORRECT results.
The current data represents only ${percentComplete}% of the total.`;
  }
  
  /**
   * Calculate remaining pages to fetch.
   */
  private static calculateRemainingPages(currentPage: number, totalPages: number): number[] {
    const remaining: number[] = [];
    for (let p = currentPage + 1; p <= totalPages; p++) {
      remaining.push(p);
    }
    return remaining;
  }
  
  /**
   * Wrap a query result into a PaginatedResult with full protocol.
   */
  static wrapResult<T>(
    items: T[],
    pageDetails: PageDetails,
    currentPage: number = 1,
    pageSize: number = 500
  ): PaginatedResult<T> {
    return {
      items,
      pageDetails,
      paginationProtocol: this.buildProtocol(items, pageDetails, currentPage, pageSize)
    };
  }
  
  /**
   * Format paginated result for MCP tool response.
   * 
   * This creates a response that:
   * 1. Contains the data
   * 2. Contains pagination metadata
   * 3. Contains CLEAR instructions for AI agents
   */
  static formatForMcpResponse<T>(
    result: PaginatedResult<T>,
    toolName: string,
    originalParams: Record<string, any>
  ): McpToolResult {
    const { items, paginationProtocol } = result;
    
    // Build the response object with embedded pagination info
    const responseData = {
      // Core data
      data: items,
      
      // Pagination summary (human-readable)
      pagination: {
        showing: `${items.length} items (page ${paginationProtocol.currentPage} of ${paginationProtocol.totalPages})`,
        total: paginationProtocol.totalItems,
        status: paginationProtocol.status
      },
      
      // Explicit protocol status (for AI parsing)
      '_PAGINATION_STATUS': paginationProtocol.status,
      
      // Full protocol details
      _paginationProtocol: {
        status: paginationProtocol.status,
        currentPage: paginationProtocol.currentPage,
        totalPages: paginationProtocol.totalPages,
        itemsInThisResponse: paginationProtocol.itemsInThisResponse,
        totalItems: paginationProtocol.totalItems,
        verificationRequired: paginationProtocol.verificationRequired,
        ...(paginationProtocol.nextAction && {
          nextAction: {
            tool: toolName,
            parameters: { ...originalParams, page: paginationProtocol.nextAction.page },
            remainingPages: paginationProtocol.nextAction.remainingPages
          }
        })
      }
    };
    
    // Build content array
    const content: Array<{ type: string; text: string }> = [
      {
        type: 'text',
        text: JSON.stringify(responseData, null, 2)
      }
    ];
    
    // Add prominent warning for incomplete data
    if (paginationProtocol.status === 'INCOMPLETE') {
      content.push({
        type: 'text',
        text: `\n\n${'='.repeat(60)}\n${paginationProtocol.instruction}\n${'='.repeat(60)}`
      });
    }
    
    return {
      content,
      isError: false
    };
  }
  
  /**
   * Create a simple complete response (for single-item gets).
   */
  static formatSingleItemResponse<T>(
    item: T | null,
    entityName: string,
    id: number | string
  ): McpToolResult {
    if (item === null) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            found: false,
            message: `${entityName} with ID ${id} not found`
          }, null, 2)
        }],
        isError: false
      };
    }
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          found: true,
          data: item,
          _paginationProtocol: {
            status: 'COMPLETE',
            instruction: 'Single item retrieved. Safe to proceed.'
          }
        }, null, 2)
      }],
      isError: false
    };
  }
}

// ============================================
// Tool Description Builder
// ============================================

/**
 * Build a tool description with embedded pagination protocol instructions.
 */
export function buildPaginatedToolDescription(
  baseDescription: string,
  entityType: string
): string {
  return `${baseDescription}

CRITICAL PAGINATION PROTOCOL (Autotask REST uses nextPageUrl cursors — not page numbers)

This tool may return many rows in one call (server follows nextPageUrl up to a safety budget). After EVERY call, you MUST:

1. CHECK '_paginationProtocol.status'
2. IF status is 'INCOMPLETE':
   a. Read '_paginationProtocol.nextAction.callWith.cursor'
   b. Call the tool 'continue_query' with arguments: { "cursor": "<that value>" }
   c. Merge items from each response until status is 'COMPLETE'
   d. DO NOT analyze totals across the full Autotask universe until COMPLETE
3. NEVER pass page=2, page=3, etc. — the API ignores page numbers for queries
4. OPTIONAL: pass 'maxItems' on the search tool to cap how many rows this server will merge per call

FAILURE TO FOLLOW THIS PROTOCOL WILL RESULT IN INCORRECT DATA ANALYSIS.

Example workflow for ${entityType}:
  Call 1: search_* returns 5000 rows, status INCOMPLETE, nextAction.callWith.cursor = "abc-..."
  Call 2: continue_query({ cursor: "abc-..." }) returns 3000 more rows, status COMPLETE
  Verify: merged row counts match expectations; NOW safe to analyze.`;
}

// ============================================
// Pagination Verification Helper
// ============================================

/**
 * Verify that all pages have been retrieved.
 * Use this when collecting results across multiple calls.
 */
export class PaginationVerifier {
  private pages: Map<number, number> = new Map(); // page -> item count
  private totalItems: number = 0;
  
  /**
   * Record a page retrieval.
   */
  recordPage(pageNumber: number, itemCount: number, totalItemsFromApi: number): void {
    this.pages.set(pageNumber, itemCount);
    this.totalItems = totalItemsFromApi;
  }
  
  /**
   * Check if all data has been retrieved.
   */
  isComplete(): boolean {
    const retrievedCount = Array.from(this.pages.values()).reduce((sum, count) => sum + count, 0);
    return retrievedCount >= this.totalItems;
  }
  
  /**
   * Get verification summary.
   */
  getSummary(): {
    isComplete: boolean;
    pagesRetrieved: number;
    itemsRetrieved: number;
    totalExpected: number;
    missingItems: number;
  } {
    const itemsRetrieved = Array.from(this.pages.values()).reduce((sum, count) => sum + count, 0);
    
    return {
      isComplete: this.isComplete(),
      pagesRetrieved: this.pages.size,
      itemsRetrieved,
      totalExpected: this.totalItems,
      missingItems: Math.max(0, this.totalItems - itemsRetrieved)
    };
  }
}
