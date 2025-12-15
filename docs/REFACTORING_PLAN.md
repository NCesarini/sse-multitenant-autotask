# Autotask MCP Server - Comprehensive Refactoring Plan

## Executive Summary

This document outlines a comprehensive plan to refactor the Autotask MCP server to be more robust, reliable, and maintainable. The plan addresses:

1. **Library Migration**: From `autotask-node` to `@apigrate/autotask-restapi`
2. **Pagination Protocol Enforcement**: Rock-solid pagination handling with explicit protocols
3. **Architecture Improvements**: Cleaner separation of concerns and better error handling
4. **Multi-tenant SSE Support**: Enhanced real-time capabilities

---

## Current State Analysis

### Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Entry Points                              │
├─────────────────┬─────────────────┬─────────────────────────┤
│    index.ts     │  sse-server.ts  │     http-server.ts      │
│   (STDIO MCP)   │  (SSE + MCP)    │    (HTTP Bridge)        │
└────────┬────────┴────────┬────────┴────────────┬────────────┘
         │                 │                      │
         └────────────────┬┴──────────────────────┘
                          │
         ┌────────────────▼────────────────┐
         │    mcp/server.ts                 │
         │  (MCP Protocol Handler)          │
         └────────────────┬────────────────┘
                          │
         ┌────────────────▼────────────────┐
         │  handlers/enhanced.tool.handler  │
         │  (Tool Definitions & Execution)  │
         │  ~5,500 lines - TOO LARGE       │
         └────────────────┬────────────────┘
                          │
         ┌────────────────▼────────────────┐
         │  services/autotask.service.ts    │
         │  (Autotask API Wrapper)          │
         │  ~3,300 lines - TOO LARGE       │
         │  Uses: autotask-node             │
         └─────────────────────────────────┘
```

### Current Library: `autotask-node`

**Pros:**
- TypeScript support
- Connection pooling & rate limiting built-in
- Entity-based API (client.tickets, client.accounts, etc.)

**Cons:**
- Many API calls bypass the library and use `client.axios.post()` directly
- Limited entity coverage (missing BillingCodes, Departments, etc.)
- Zone discovery issues requiring workarounds
- Not actively maintained (fewer updates)

### Current Library: `@apigrate/autotask-restapi`

**Pros:**
- Direct from the .cursorrules - well-documented API
- Native fetch (Node >= 18) - no external dependencies
- Complete entity support with parent-child relationships
- Auto zone discovery on first API call
- Query, count, get, create, update, replace, delete methods
- Active maintenance
- Better error handling with `AutotaskApiError`
- UDF querying support

**Cons:**
- Different API structure (need to migrate method calls)
- No built-in rate limiting (need to implement)

---

## Key Issues to Address

### 1. Pagination is NOT Enforced (Critical - Boss's Feedback)

**Current Problem:**
- John Bidwell reports pagination issues with time entries
- Results show "Showing X of Y" but AI doesn't retrieve remaining pages
- Analysis done on incomplete data leads to incorrect conclusions

**Current Approach (Flawed):**
```typescript
// Current code just returns whatever comes back
const timeEntries = await this.autotaskService.getTimeEntries(queryOptions, tenantContext);
return { content: [{ type: 'text', text: JSON.stringify(timeEntries) }] };
```

**Required Approach (Procedural Enforcement):**
```typescript
// New approach with explicit pagination protocol
{
  "pagination": {
    "page": 1,
    "totalPages": 5,
    "totalItems": 478,
    "itemsInThisPage": 100,
    "hasMorePages": true,
    "nextPageUrl": "/TimeEntries/query?page=2"
  },
  "data": [...],
  "⚠️ PAGINATION_PROTOCOL": {
    "status": "INCOMPLETE_DATA",
    "instruction": "You have retrieved 100 of 478 items. You MUST call this tool 4 more times with page=2,3,4,5 before any analysis.",
    "verification_required": true
  }
}
```

### 2. Large Response Limitations (To Remove)

**Current Code (lines 12-22 of enhanced.tool.handler.ts):**
```typescript
export const LARGE_RESPONSE_THRESHOLDS = {
  tickets: 100,        
  companies: 100,     
  // etc...
};
```

**Action:** Remove these artificial limits. Let the API return full results with proper pagination metadata.

### 3. Code Organization (Too Large Files)

- `enhanced.tool.handler.ts`: 5,563 lines
- `autotask.service.ts`: 3,345 lines

Both need to be split into smaller, focused modules.

---

## Proposed New Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Entry Points                              │
├─────────────────┬─────────────────┬─────────────────────────────┤
│    index.ts     │  sse-server.ts  │     http-server.ts          │
│   (STDIO MCP)   │  (SSE + MCP)    │    (HTTP Bridge)            │
└────────┬────────┴────────┬────────┴────────────┬────────────────┘
         │                 │                      │
         └────────────────┬┴──────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────┐
│               mcp/server.ts                        │
│          (MCP Protocol Handler)                    │
│   - Request routing                                │
│   - Tenant context extraction                      │
│   - Response formatting                            │
└─────────────────────────┬─────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────┐
│            handlers/ (Split by Domain)             │
├───────────────────────────────────────────────────┤
│  company.handler.ts    │  ticket.handler.ts       │
│  contact.handler.ts    │  project.handler.ts      │
│  time.handler.ts       │  task.handler.ts         │
│  financial.handler.ts  │  config.handler.ts       │
│  note.handler.ts       │  attachment.handler.ts   │
└─────────────────────────┬─────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────┐
│           core/pagination.ts                       │
│   - PaginationProtocol class                       │
│   - Auto-pagination detection                      │
│   - Explicit incomplete data warnings              │
│   - Verification checkpoints                       │
└─────────────────────────┬─────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────┐
│        services/ (Split by Entity Group)           │
├───────────────────────────────────────────────────┤
│  autotask-client.ts    │ Rate limiting, pooling   │
│  company.service.ts    │ Company operations       │
│  ticket.service.ts     │ Ticket operations        │
│  project.service.ts    │ Project operations       │
│  time.service.ts       │ Time entry operations    │
│  financial.service.ts  │ Contracts, invoices      │
└─────────────────────────┬─────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────┐
│         @apigrate/autotask-restapi                 │
│  (Direct API wrapper - well-documented)            │
└───────────────────────────────────────────────────┘
```

---

## Migration Plan: autotask-node → @apigrate/autotask-restapi

### Phase 1: Create Adapter Layer (Non-Breaking)

Create an abstraction layer that works with both libraries:

```typescript
// src/adapters/autotask-adapter.ts
export interface AutotaskAdapter {
  // Core operations
  query<T>(entity: string, filter: FilterExpression[]): Promise<PaginatedResult<T>>;
  get<T>(entity: string, id: number): Promise<T | null>;
  create<T>(entity: string, data: Partial<T>): Promise<{ itemId: number }>;
  update(entity: string, id: number, data: Record<string, any>): Promise<void>;
  delete(entity: string, id: number): Promise<void>;
  
  // Metadata
  count(entity: string, filter: FilterExpression[]): Promise<number>;
  fieldInfo(entity: string): Promise<FieldInfo[]>;
  
  // Connection
  testConnection(): Promise<boolean>;
}

// Pagination is EXPLICIT in the interface
export interface PaginatedResult<T> {
  items: T[];
  pageDetails: {
    count: number;
    requestCount: number;
    prevPageUrl: string | null;
    nextPageUrl: string | null;
    currentPage: number;
    totalPages: number;
  };
  // Explicit pagination protocol for AI consumption
  paginationProtocol: {
    status: 'COMPLETE' | 'INCOMPLETE';
    totalItems: number;
    retrievedItems: number;
    remainingPages: number[];
    instruction: string;
  };
}
```

### Phase 2: Implement Apigrate Adapter

```typescript
// src/adapters/apigrate-adapter.ts
import { AutotaskRestApi } from '@apigrate/autotask-restapi';

export class ApigrateAdapter implements AutotaskAdapter {
  private api: AutotaskRestApi;
  
  constructor(username: string, secret: string, integrationCode: string) {
    this.api = new AutotaskRestApi(username, secret, integrationCode);
  }
  
  async query<T>(entity: string, filter: FilterExpression[]): Promise<PaginatedResult<T>> {
    const result = await this.api[entity].query({ filter });
    
    return {
      items: result.items,
      pageDetails: result.pageDetails,
      paginationProtocol: this.buildPaginationProtocol(result)
    };
  }
  
  private buildPaginationProtocol(result: any): PaginationProtocol {
    const totalItems = result.pageDetails.count;
    const retrievedItems = result.items.length;
    const hasMore = result.pageDetails.nextPageUrl !== null;
    
    return {
      status: hasMore ? 'INCOMPLETE' : 'COMPLETE',
      totalItems,
      retrievedItems,
      remainingPages: this.calculateRemainingPages(result),
      instruction: hasMore 
        ? `⚠️ CRITICAL: You have retrieved ${retrievedItems} of ${totalItems} items. ` +
          `You MUST retrieve remaining pages before ANY analysis. ` +
          `Failure to retrieve all pages will result in INCORRECT conclusions.`
        : `✅ All ${totalItems} items retrieved. Safe to proceed with analysis.`
    };
  }
}
```

### Phase 3: Entity Mapping

Map current autotask-node entities to @apigrate/autotask-restapi:

| autotask-node | @apigrate/autotask-restapi |
|---------------|---------------------------|
| `client.accounts` | `autotask.Companies` |
| `client.contacts` | `autotask.Contacts` |
| `client.tickets` | `autotask.Tickets` |
| `client.projects` | `autotask.Projects` |
| `client.resources` | `autotask.Resources` |
| `client.timeEntries` | `autotask.TimeEntries` |
| `client.configurationItems` | `autotask.ConfigurationItems` |
| `client.contracts` | `autotask.Contracts` |
| `client.invoices` | `autotask.Invoices` |
| `client.tasks` | `autotask.Tasks` (child of Projects) |
| `client.notes` | `autotask.TicketNotes`, `autotask.ProjectNotes`, etc. |
| `client.quotes` | `autotask.Quotes` |
| `client.expenses` | `autotask.Expenses` / `autotask.ExpenseReports` |
| N/A (not available) | `autotask.BillingCodes` ✅ |
| N/A (not available) | `autotask.Departments` ✅ |

---

## Pagination Protocol Implementation

### 1. Tool Descriptions with Procedural Enforcement

```typescript
// New tool description format
const SEARCH_TIME_ENTRIES_TOOL = {
  name: 'search_time_entries',
  description: `Search for time entries with filters.

⚠️ CRITICAL PAGINATION PROTOCOL ⚠️

This tool returns paginated results. After EVERY call, you MUST:

1. CHECK the response 'paginationProtocol.status' field
2. IF status is 'INCOMPLETE':
   a. Note the 'paginationProtocol.remainingPages' array
   b. IMMEDIATELY call this tool again for EACH remaining page
   c. DO NOT proceed to any analysis until ALL pages are retrieved
3. CREATE a verification checkpoint:
   - Count total items across all pages
   - Verify: totalRetrieved === paginationProtocol.totalItems
4. ONLY THEN proceed with analysis (sum hours, etc.)

FAILURE TO FOLLOW THIS PROTOCOL WILL RESULT IN INCORRECT DATA ANALYSIS.

Example workflow:
  Call 1: Returns 100 of 478 items, status: INCOMPLETE, remainingPages: [2,3,4,5]
  Call 2: page=2, Returns items 101-200
  Call 3: page=3, Returns items 201-300
  Call 4: page=4, Returns items 301-400
  Call 5: page=5, Returns items 401-478
  Verify: 100+100+100+100+78 = 478 ✓
  NOW safe to sum hours.`,
  inputSchema: {
    type: 'object',
    properties: {
      ticketID: { type: 'number', description: 'Filter by ticket ID' },
      resourceID: { type: 'number', description: 'Filter by resource ID' },
      dateFrom: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      dateTo: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      page: { type: 'number', description: 'Page number (1-indexed)' },
      pageSize: { type: 'number', description: 'Items per page (max 500)' }
    }
  }
};
```

### 2. Response Format with Explicit Protocol

```typescript
interface PaginatedToolResponse {
  // Standard content
  content: Array<{
    type: 'text';
    text: string;
  }>;
  
  // Pagination protocol metadata (ALWAYS included)
  metadata: {
    paginationProtocol: {
      status: 'COMPLETE' | 'INCOMPLETE';
      currentPage: number;
      totalPages: number;
      itemsInThisResponse: number;
      totalItems: number;
      
      // Explicit instructions for AI
      instruction: string;
      verificationRequired: boolean;
      
      // If INCOMPLETE, what to do next
      nextAction?: {
        tool: string;
        parameters: Record<string, any>;
        reason: string;
      };
    };
  };
}
```

### 3. Pagination Wrapper Function

```typescript
// src/core/pagination.ts
export class PaginationEnforcer {
  
  static wrapResponse<T>(
    items: T[],
    pageDetails: PageDetails,
    toolName: string,
    originalParams: Record<string, any>
  ): PaginatedToolResponse {
    
    const totalItems = pageDetails.count;
    const currentPage = originalParams.page || 1;
    const pageSize = originalParams.pageSize || 500;
    const totalPages = Math.ceil(totalItems / pageSize);
    const isComplete = currentPage >= totalPages;
    
    const protocol: PaginationProtocol = {
      status: isComplete ? 'COMPLETE' : 'INCOMPLETE',
      currentPage,
      totalPages,
      itemsInThisResponse: items.length,
      totalItems,
      instruction: this.buildInstruction(isComplete, currentPage, totalPages, items.length, totalItems),
      verificationRequired: !isComplete
    };
    
    if (!isComplete) {
      protocol.nextAction = {
        tool: toolName,
        parameters: { ...originalParams, page: currentPage + 1 },
        reason: `Retrieve page ${currentPage + 1} of ${totalPages} to get complete data`
      };
    }
    
    // Build response text with embedded protocol
    const responseText = {
      data: items,
      pagination: {
        showing: `${items.length} items (page ${currentPage} of ${totalPages})`,
        total: totalItems
      },
      '⚠️_PAGINATION_STATUS': protocol.status,
      '📋_PROTOCOL': protocol.instruction
    };
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responseText, null, 2)
      }],
      metadata: { paginationProtocol: protocol }
    };
  }
  
  private static buildInstruction(
    isComplete: boolean,
    currentPage: number,
    totalPages: number,
    itemsRetrieved: number,
    totalItems: number
  ): string {
    if (isComplete) {
      return `✅ DATA COMPLETE: All ${totalItems} items retrieved. Safe to proceed with analysis.`;
    }
    
    const remaining = totalPages - currentPage;
    const remainingItems = totalItems - itemsRetrieved;
    
    return `⛔ INCOMPLETE DATA - DO NOT ANALYZE YET

Retrieved: ${itemsRetrieved} of ${totalItems} items (${Math.round(itemsRetrieved/totalItems*100)}%)
Remaining: ${remainingItems} items across ${remaining} more page(s)

REQUIRED STEPS:
1. Call this tool again with page=${currentPage + 1}
2. Repeat until status is COMPLETE
3. Only then perform any calculations or analysis

WARNING: Any analysis on incomplete data will be WRONG.`;
  }
}
```

---

## Multi-Tenant SSE Architecture Enhancement

### Current SSE Flow

```
Client → GET /sse → SSE Transport → MCP Server → Tool Handler → Autotask
                 ↓
Client ← SSE Events ← Response
```

### Enhanced SSE Flow with Better Tenant Isolation

```typescript
// src/sse/tenant-session.ts
export class TenantSession {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly credentials: AutotaskCredentials;
  readonly createdAt: Date;
  
  private autotaskClient: AutotaskAdapter;
  private lastActivity: Date;
  
  constructor(tenantContext: TenantContext) {
    this.sessionId = crypto.randomUUID();
    this.tenantId = tenantContext.tenantId;
    this.credentials = tenantContext.credentials;
    this.createdAt = new Date();
    this.lastActivity = new Date();
    
    // Each tenant gets their own client instance
    this.autotaskClient = new ApigrateAdapter(
      tenantContext.credentials.username,
      tenantContext.credentials.secret,
      tenantContext.credentials.integrationCode
    );
  }
  
  getClient(): AutotaskAdapter {
    this.lastActivity = new Date();
    return this.autotaskClient;
  }
  
  isExpired(timeoutMs: number): boolean {
    return Date.now() - this.lastActivity.getTime() > timeoutMs;
  }
}

// src/sse/session-manager.ts
export class SessionManager {
  private sessions: Map<string, TenantSession> = new Map();
  private readonly maxSessions: number;
  private readonly sessionTimeout: number;
  
  getOrCreateSession(tenantContext: TenantContext): TenantSession {
    const cacheKey = this.getCacheKey(tenantContext);
    
    let session = this.sessions.get(cacheKey);
    if (session && !session.isExpired(this.sessionTimeout)) {
      return session;
    }
    
    // Cleanup expired sessions
    this.cleanupExpiredSessions();
    
    // Create new session
    session = new TenantSession(tenantContext);
    this.sessions.set(cacheKey, session);
    
    return session;
  }
  
  private cleanupExpiredSessions(): void {
    for (const [key, session] of this.sessions) {
      if (session.isExpired(this.sessionTimeout)) {
        this.sessions.delete(key);
      }
    }
    
    // Enforce max sessions limit (remove oldest)
    while (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.findOldestSession();
      if (oldestKey) this.sessions.delete(oldestKey);
    }
  }
}
```

---

## Rate Limiting Implementation

Since `@apigrate/autotask-restapi` doesn't include rate limiting, we need to implement it:

```typescript
// src/core/rate-limiter.ts
export class RateLimiter {
  private requests: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;
  
  constructor(requestsPerSecond: number = 5) {
    this.maxRequests = requestsPerSecond;
    this.windowMs = 1000;
  }
  
  async waitForSlot(): Promise<void> {
    const now = Date.now();
    
    // Remove old requests
    this.requests = this.requests.filter(time => now - time < this.windowMs);
    
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.windowMs - (now - oldestRequest);
      
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return this.waitForSlot();
      }
    }
    
    this.requests.push(now);
  }
}

// Usage in adapter
export class ApigrateAdapter implements AutotaskAdapter {
  private rateLimiter = new RateLimiter(5); // 5 requests per second
  
  async query<T>(entity: string, filter: FilterExpression[]): Promise<PaginatedResult<T>> {
    await this.rateLimiter.waitForSlot();
    return this.api[entity].query({ filter });
  }
}
```

---

## Implementation Phases

### Phase 1: Foundation (Week 1-2)
- [ ] Create adapter interface
- [ ] Implement ApigrateAdapter
- [ ] Add rate limiting
- [ ] Create pagination enforcer

### Phase 2: Service Migration (Week 2-3)
- [ ] Split autotask.service.ts into domain services
- [ ] Update each service to use adapter interface
- [ ] Add comprehensive logging

### Phase 3: Handler Refactoring (Week 3-4)
- [ ] Split enhanced.tool.handler.ts by domain
- [ ] Update tool descriptions with pagination protocol
- [ ] Implement pagination enforcement in all search tools

### Phase 4: Remove Limitations (Week 4)
- [ ] Remove LARGE_RESPONSE_THRESHOLDS
- [ ] Remove artificial pageSize caps
- [ ] Let Autotask API pagination work naturally

### Phase 5: Testing & Validation (Week 5)
- [ ] Write integration tests for pagination
- [ ] Test multi-tenant scenarios
- [ ] Validate all entity operations
- [ ] Performance testing

### Phase 6: SSE Enhancement (Week 5-6)
- [ ] Implement TenantSession
- [ ] Implement SessionManager
- [ ] Add real-time progress updates for large queries

---

## File Structure After Refactoring

```
src/
├── adapters/
│   ├── autotask-adapter.ts      # Interface definition
│   ├── apigrate-adapter.ts      # @apigrate implementation
│   └── index.ts
├── core/
│   ├── pagination.ts            # PaginationEnforcer
│   ├── rate-limiter.ts          # Rate limiting
│   ├── error-handler.ts         # Centralized error handling
│   └── logger.ts                # Enhanced logging
├── handlers/
│   ├── base.handler.ts          # Common handler logic
│   ├── company.handler.ts       # Company operations
│   ├── contact.handler.ts       # Contact operations
│   ├── ticket.handler.ts        # Ticket operations
│   ├── project.handler.ts       # Project operations
│   ├── task.handler.ts          # Task operations
│   ├── time.handler.ts          # Time entry operations
│   ├── financial.handler.ts     # Contracts, invoices, quotes
│   ├── config.handler.ts        # Configuration items
│   ├── note.handler.ts          # Notes (ticket, project, company)
│   ├── attachment.handler.ts    # Attachments
│   └── index.ts                 # Tool registry
├── services/
│   ├── autotask-client.ts       # Client factory & pooling
│   └── mapping.service.ts       # ID to name mapping
├── mcp/
│   └── server.ts                # MCP protocol handler
├── sse/
│   ├── server.ts                # SSE server
│   ├── session-manager.ts       # Tenant sessions
│   └── transport.ts             # SSE transport wrapper
├── http/
│   ├── server.ts                # HTTP server
│   └── mcp-bridge.ts            # HTTP to MCP bridge
├── types/
│   ├── autotask.ts              # Autotask entity types
│   ├── mcp.ts                   # MCP types
│   └── pagination.ts            # Pagination types
└── index.ts                     # Entry point
```

---

## Breaking Changes to Address

### Tool Response Format

**Before:**
```json
{
  "content": [{ "type": "text", "text": "[...array of items...]" }]
}
```

**After:**
```json
{
  "content": [{ 
    "type": "text", 
    "text": "{\"data\": [...], \"pagination\": {...}, \"⚠️_PAGINATION_STATUS\": \"INCOMPLETE\"}" 
  }]
}
```

### Tool Parameters

Add `page` parameter to all search tools:

```typescript
{
  page: { 
    type: 'number', 
    description: 'Page number (1-indexed). Check paginationProtocol in response for total pages.' 
  }
}
```

---

## Success Criteria

1. **Pagination Protocol**: Every search tool returns explicit pagination status
2. **Complete Data**: AI can retrieve ALL data by following the protocol
3. **No Artificial Limits**: Removed LARGE_RESPONSE_THRESHOLDS
4. **Clean Architecture**: No file over 500 lines
5. **Full Entity Support**: BillingCodes, Departments, and all entities working
6. **Multi-tenant Robust**: Proper tenant isolation and session management
7. **Rate Limited**: Respects Autotask API limits
8. **Error Handling**: Clear, actionable error messages

---

## Appendix: Entity Coverage Comparison

### Entities Requiring Parent-Child Handling

| Entity | Parent | Current Support | After Migration |
|--------|--------|-----------------|-----------------|
| Tasks | Projects | ✅ | ✅ |
| TicketNotes | Tickets | ✅ | ✅ |
| ProjectNotes | Projects | ✅ | ✅ |
| CompanyNotes | Companies | ✅ | ✅ |
| TicketAttachments | Tickets | ✅ | ✅ |
| ExpenseItems | ExpenseReports | ✅ | ✅ |
| ContractServices | Contracts | ❌ | ✅ |
| ContractBlocks | Contracts | ❌ | ✅ |
| QuoteItems | Quotes | ❌ | ✅ |

---

## Next Steps

1. **Review this plan** with stakeholders
2. **Approve phases** and timeline
3. **Begin Phase 1** with adapter layer creation
4. **Test in parallel** while maintaining current functionality
5. **Gradual rollout** with feature flags if needed

---

*Document Created: December 12, 2025*
*Author: AI Assistant*
*Status: Draft - Pending Review*


