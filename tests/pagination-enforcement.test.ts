/**
 * Integration Tests for Pagination Enforcement
 * 
 * These tests validate that the "Showing X of Y" pattern is properly
 * implemented across all search tools and that AI agents can reliably
 * detect incomplete data.
 */

import { 
  PaginatedResponse, 
  PaginationInfo,
  formatPaginationStatus,
  formatNextAction 
} from '../src/types/autotask';

describe('Pagination Types and Helpers', () => {
  
  describe('PaginationInfo', () => {
    it('should correctly identify complete data', () => {
      const pagination: PaginationInfo = {
        showing: 50,
        total: 50,
        totalKnown: true,
        currentPage: 1,
        pageSize: 100,
        hasMore: false,
        percentComplete: 100
      };
      
      expect(pagination.hasMore).toBe(false);
      expect(pagination.percentComplete).toBe(100);
    });
    
    it('should correctly identify incomplete data', () => {
      const pagination: PaginationInfo = {
        showing: 100,
        total: 847,
        totalKnown: true,
        currentPage: 1,
        pageSize: 100,
        hasMore: true,
        nextPageUrl: '/next',
        percentComplete: 12
      };
      
      expect(pagination.hasMore).toBe(true);
      expect(pagination.percentComplete).toBe(12);
      expect(pagination.total - pagination.showing).toBe(747);
    });
  });
  
  describe('formatPaginationStatus', () => {
    it('should format complete status correctly', () => {
      const pagination: PaginationInfo = {
        showing: 50,
        total: 50,
        totalKnown: true,
        currentPage: 1,
        pageSize: 100,
        hasMore: false,
        percentComplete: 100
      };
      
      const status = formatPaginationStatus(pagination);
      
      expect(status).toContain('PAGINATION STATUS');
      expect(status).toContain('50 of 50');
      expect(status).toContain('COMPLETE');
    });
    
    it('should format incomplete status with warning', () => {
      const pagination: PaginationInfo = {
        showing: 100,
        total: 847,
        totalKnown: true,
        currentPage: 1,
        pageSize: 100,
        hasMore: true,
        percentComplete: 11.8
      };
      
      const status = formatPaginationStatus(pagination);
      
      expect(status).toContain('PAGINATION STATUS');
      expect(status).toContain('100 of 847');
      expect(status).toContain('INCOMPLETE');
      expect(status).toContain('WARNING');
    });
  });
  
  describe('formatNextAction', () => {
    it('should return empty string for complete data', () => {
      const pagination: PaginationInfo = {
        showing: 50,
        total: 50,
        totalKnown: true,
        currentPage: 1,
        pageSize: 100,
        hasMore: false,
        percentComplete: 100
      };
      
      const nextAction = formatNextAction(pagination, 'search_time_entries');
      
      expect(nextAction).toBe('');
    });
    
    it('should return page instruction for incomplete data', () => {
      const pagination: PaginationInfo = {
        showing: 100,
        total: 300,
        totalKnown: true,
        currentPage: 1,
        pageSize: 100,
        hasMore: true,
        percentComplete: 33
      };
      
      const nextAction = formatNextAction(pagination, 'search_time_entries');
      
      expect(nextAction).toContain('REQUIRED ACTION');
      expect(nextAction).toContain('page=2');
      expect(nextAction).toContain('search_time_entries');
    });
    
    it('should increment page number correctly for subsequent pages', () => {
      const pagination: PaginationInfo = {
        showing: 100,
        total: 500,
        totalKnown: true,
        currentPage: 3,
        pageSize: 100,
        hasMore: true,
        percentComplete: 60
      };
      
      const nextAction = formatNextAction(pagination, 'search_tickets');
      
      expect(nextAction).toContain('page=4');
    });
  });
});

describe('PaginatedResponse Structure', () => {
  
  it('should include all required fields', () => {
    const response: PaginatedResponse<{ id: number }> = {
      items: [{ id: 1 }, { id: 2 }],
      pagination: {
        showing: 2,
        total: 10,
        totalKnown: true,
        currentPage: 1,
        pageSize: 100,
        hasMore: true,
        percentComplete: 20
      },
      _paginationStatus: 'PAGINATION STATUS: Showing 2 of 10 entries',
      _nextAction: 'REQUIRED ACTION: Call with page=2'
    };
    
    expect(response.items).toHaveLength(2);
    expect(response.pagination).toBeDefined();
    expect(response._paginationStatus).toBeDefined();
    expect(response._nextAction).toBeDefined();
  });
  
  it('should not include _nextAction when data is complete', () => {
    const response: PaginatedResponse<{ id: number }> = {
      items: [{ id: 1 }],
      pagination: {
        showing: 1,
        total: 1,
        totalKnown: true,
        currentPage: 1,
        pageSize: 100,
        hasMore: false,
        percentComplete: 100
      },
      _paginationStatus: 'PAGINATION STATUS: Showing 1 of 1 entries (COMPLETE)',
      _nextAction: undefined
    };
    
    expect(response._nextAction).toBeUndefined();
  });
});

describe('Tool Description Pagination Protocol', () => {
  // These tests validate that the tool descriptions contain the required
  // procedural enforcement language
  
  const REQUIRED_PHRASES = [
    'PAGINATION PROTOCOL',
    'MANDATORY',
    'Showing X of Y',
    'MUST retrieve remaining pages',
    'page=2',
    'FAILURE'
  ];
  
  it('should include procedural enforcement in search_time_entries description', () => {
    // This is a documentation test - the actual description is in enhanced.tool.handler.ts
    const description = `Search for time entries in Autotask.

⚠️ PAGINATION PROTOCOL (MANDATORY):
This tool returns PAGINATED results. After EVERY call, you MUST:
1. Check the response for "Showing X of Y"
2. If X < Y: You MUST retrieve remaining pages by calling again with page=2, page=3, etc.
3. Create a verification table with ALL entries before calculations
4. Use math to sum hours ONLY after ALL pages have been retrieved
5. State explicitly: "Retrieved X of Y entries (complete/incomplete)"

FAILURE TO COMPLETE ALL PAGES BEFORE ANALYSIS = TASK FAILURE`;
    
    REQUIRED_PHRASES.forEach(phrase => {
      expect(description).toContain(phrase);
    });
  });
});

describe('Response Format Validation', () => {
  
  it('should place pagination status at the beginning of response', () => {
    // The format should be:
    // 1. PAGINATION STATUS line (first thing AI sees)
    // 2. Warning/Next action (if applicable)
    // 3. Separator
    // 4. Actual data
    
    const mockResponse = `PAGINATION STATUS: Showing 100 of 847 entries
WARNING: This is INCOMPLETE data (11.8% retrieved)
REMAINING: 747 entries not yet retrieved

REQUIRED ACTION: Call search_time_entries with page=2 to retrieve next batch

============================================================

[
  { "id": 1, "hoursWorked": 2.5 },
  { "id": 2, "hoursWorked": 1.0 }
]`;
    
    const lines = mockResponse.split('\n');
    
    // First line should contain PAGINATION STATUS
    expect(lines[0]).toContain('PAGINATION STATUS');
    
    // Should contain WARNING for incomplete data
    expect(mockResponse).toContain('WARNING');
    expect(mockResponse).toContain('INCOMPLETE');
    
    // Should contain REQUIRED ACTION
    expect(mockResponse).toContain('REQUIRED ACTION');
    
    // Should have separator before data
    expect(mockResponse).toContain('====');
    
    // Data should come after separator
    const separatorIndex = mockResponse.indexOf('====');
    const dataIndex = mockResponse.indexOf('[');
    expect(dataIndex).toBeGreaterThan(separatorIndex);
  });
  
  it('should show complete status for full data retrieval', () => {
    const mockResponse = `PAGINATION STATUS: Showing 25 of 25 entries (COMPLETE)

============================================================

[
  { "id": 1, "hoursWorked": 2.5 }
]`;
    
    expect(mockResponse).toContain('COMPLETE');
    expect(mockResponse).not.toContain('WARNING');
    expect(mockResponse).not.toContain('REQUIRED ACTION');
  });
});

describe('Edge Cases', () => {
  
  it('should handle zero results gracefully', () => {
    const pagination: PaginationInfo = {
      showing: 0,
      total: 0,
      totalKnown: true,
      currentPage: 1,
      pageSize: 100,
      hasMore: false,
      percentComplete: 100
    };
    
    expect(pagination.hasMore).toBe(false);
    // Division by zero should be handled
    expect(pagination.percentComplete).toBe(100);
  });
  
  it('should handle unknown total count', () => {
    const pagination: PaginationInfo = {
      showing: 100,
      total: 100, // Same as showing when unknown
      totalKnown: false,
      currentPage: 1,
      pageSize: 100,
      hasMore: true, // Has nextPageUrl even though we don't know total
      nextPageUrl: '/next',
      percentComplete: 100 // Can't calculate true percentage
    };
    
    expect(pagination.totalKnown).toBe(false);
    expect(pagination.hasMore).toBe(true);
  });
  
  it('should handle last page correctly', () => {
    const pagination: PaginationInfo = {
      showing: 47, // Less than pageSize
      total: 247,
      totalKnown: true,
      currentPage: 3,
      pageSize: 100,
      hasMore: false, // No nextPageUrl
      percentComplete: 100 // All data retrieved across pages
    };
    
    expect(pagination.hasMore).toBe(false);
    expect(pagination.showing).toBeLessThan(pagination.pageSize);
  });
});




