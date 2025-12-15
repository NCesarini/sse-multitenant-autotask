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

// ============================================
// Types for Simple Enforce Interface
// ============================================

export interface EnforceOptions<T> {
  items: T[];
  totalCount: number;
  currentPage: number;
  pageSize: number;
  entityName: string;
  sumField?: string;  // Field to sum for verification (e.g., 'hoursWorked')
  availableFilters?: string[];  // Suggest filters when result set is too large
  largeResultThreshold?: number;  // Threshold to consider results "too large" (default: 500)
}

export interface EnforceResult<T> {
  items: T[];
  protocol: {
    status: 'COMPLETE' | 'INCOMPLETE';
    message: string;
    currentPage: number;
    totalPages: number;
    showing: string;
    totalItems: number;
    nextAction?: {
      description: string;
      callWith: { page: number };
      remainingPages: number[];
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
   * Simple enforce method for direct use in handlers.
   * 
   * @param options Configuration for pagination enforcement
   * @returns Result with items and pagination protocol
   */
  static enforce<T>(options: EnforceOptions<T>): EnforceResult<T> {
    const { 
      items, 
      totalCount, 
      currentPage, 
      pageSize, 
      entityName, 
      sumField,
      availableFilters,
      largeResultThreshold = 500
    } = options;
    
    const totalPages = Math.ceil(totalCount / pageSize);
    const isComplete = currentPage >= totalPages || items.length < pageSize;
    const status: 'COMPLETE' | 'INCOMPLETE' = isComplete ? 'COMPLETE' : 'INCOMPLETE';
    
    // Calculate running total
    const startItem = (currentPage - 1) * pageSize + 1;
    const endItem = startItem + items.length - 1;
    const showing = `Showing ${startItem}-${endItem} of ${totalCount}`;
    
    // Detect if result set is too large (only on first page)
    const isTooLarge = currentPage === 1 && totalCount > largeResultThreshold;
    const isMassive = currentPage === 1 && totalCount > 2000;
    
    // Build verification steps based on whether data is complete
    const verificationSteps = isComplete
      ? [
          '1. All data retrieved',
          `2. Create verification table with ALL ${entityName}`,
          sumField 
            ? `3. Use math_calculator to sum ${sumField} values` 
            : '3. Analyze the complete dataset',
          'PROTOCOL COMPLETE'
        ]
      : [
          `1. WARNING: Only showing ${items.length} of ${totalCount} ${entityName}`,
          `2. IMMEDIATELY retrieve page ${currentPage + 1} with page=${currentPage + 1}`,
          '3. DO NOT perform any analysis until status is COMPLETE',
          sumField 
            ? `4. Only after ALL pages: sum ${sumField} with math_calculator`
            : '4. Only after ALL pages: analyze the complete dataset',
          'FAILURE TO RETRIEVE ALL PAGES = INCORRECT RESULTS'
        ];
    
    const protocol: EnforceResult<T>['protocol'] = {
      status,
      message: isComplete 
        ? `All ${totalCount} ${entityName} retrieved. Safe to analyze.`
        : `INCOMPLETE: ${showing}. You MUST retrieve remaining pages before any analysis.`,
      currentPage,
      totalPages,
      showing,
      totalItems: totalCount,
      verificationSteps
    };
    
    // Add performance warning for large result sets
    if (isTooLarge) {
      const pagesNeeded = totalPages;
      const apiCallsRequired = pagesNeeded;
      
      protocol.performanceWarning = {
        severity: isMassive ? 'HIGH' : 'MEDIUM',
        message: isMassive
          ? `VERY LARGE RESULT SET: ${totalCount} ${entityName} found (${pagesNeeded} pages required)`
          : `LARGE RESULT SET: ${totalCount} ${entityName} found (${pagesNeeded} pages required)`,
        recommendation: isMassive
          ? `STRONGLY RECOMMENDED: This search is too broad and will require ${apiCallsRequired} API calls. ` +
            `This is inefficient and time-consuming. Please narrow your search using more specific filters to reduce the result set to < 500 items. ` +
            `Consider adding date ranges, status filters, or other criteria to focus on the specific ${entityName} you need.`
          : `RECOMMENDED: Consider narrowing your search using more specific filters to improve performance. ` +
            `Retrieving all ${pagesNeeded} pages will require ${apiCallsRequired} API calls. ` +
            `If you only need recent or specific ${entityName}, add filters to reduce the result set.`,
        ...(availableFilters && availableFilters.length > 0 && {
          suggestedFilters: availableFilters
        })
      };
    }
    
    if (!isComplete) {
      const remainingPages: number[] = [];
      for (let p = currentPage + 1; p <= totalPages; p++) {
        remainingPages.push(p);
      }
      
      protocol.nextAction = {
        description: `Retrieve page ${currentPage + 1} of ${totalPages}`,
        callWith: { page: currentPage + 1 },
        remainingPages
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

CRITICAL PAGINATION PROTOCOL

This tool returns paginated results. After EVERY call, you MUST:

1. CHECK the response '_paginationProtocol.status' field
2. IF status is 'INCOMPLETE':
   a. Note the '_paginationProtocol.nextAction.remainingPages' array
   b. IMMEDIATELY call this tool again with page parameter set to the next page
   c. Repeat for ALL remaining pages
   d. DO NOT proceed to any analysis until ALL pages are retrieved
3. CREATE a verification checkpoint:
   - Sum itemsInThisResponse across ALL calls
   - Verify: sum === totalItems from first response
4. ONLY THEN proceed with analysis

FAILURE TO FOLLOW THIS PROTOCOL WILL RESULT IN INCORRECT DATA ANALYSIS.

Example workflow for ${entityType}:
  Call 1: Returns 500 of 1,247 items, status: INCOMPLETE, remainingPages: [2,3]
  Call 2: page=2, Returns 500 items, status: INCOMPLETE, remainingPages: [3]
  Call 3: page=3, Returns 247 items, status: COMPLETE
  Verify: 500+500+247 = 1,247 - VERIFIED
  NOW safe to analyze.`;
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
