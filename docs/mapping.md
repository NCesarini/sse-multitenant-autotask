# ID-to-Name Mapping

The Autotask MCP server includes intelligent ID-to-name mapping functionality that automatically resolves company and resource IDs to human-readable names. This makes the API responses much more useful for AI assistants and human users.

## 🎯 Data Accuracy Guarantee

**CRITICAL**: All search tools now use **pagination by default** to ensure complete data accuracy. When you search for tickets, projects, or other entities, you get **ALL matching results**, not just the first page. This eliminates the undercounting issues that made previous versions unreliable for reporting and analytics.

- ✅ **Default behavior**: Complete pagination through all results
- ✅ **Optional limiting**: Only specify `pageSize` if you need to limit results  
- ✅ **Accurate reporting**: Perfect for pie charts, dashboards, and analytics

## Features

### Automatic Enhancement
When you use search tools like `search_tickets`, `search_projects`, or `get_ticket_details`, the response automatically includes an `_enhanced` field with resolved names:

```json
{
  "id": 12345,
  "title": "Sample Ticket",
  "companyID": 678,
  "assignedResourceID": 90,
  "_enhanced": {
    "companyName": "Acme Corporation", 
    "assignedResourceName": "John Smith"
  }
}
```

### Multi-Tenant Support

The mapping service now includes **per-tenant cache isolation** for multi-tenant deployments:

- **Complete tenant isolation**: Each tenant gets its own cache, preventing data leakage
- **Memory-bounded**: Maximum 50 tenant caches (configurable)
- **LRU eviction**: Oldest unused tenant caches are evicted when the limit is reached
- **Automatic cleanup**: Expired tenant caches are removed every 5 minutes
- **99% API call reduction**: Cached lookups avoid redundant API calls

```
┌─────────────────────────────────────────────────────────────┐
│                    Multi-Tenant Cache                       │
├─────────────────────────────────────────────────────────────┤
│  Tenant A Cache        │  Tenant B Cache        │  ...      │
│  ├── Companies Map     │  ├── Companies Map     │           │
│  ├── Resources Map     │  ├── Resources Map     │           │
│  └── Last Used: 10:30  │  └── Last Used: 10:25  │           │
└─────────────────────────────────────────────────────────────┘
```

### Intelligent Caching
- Company and resource names are cached for 30 minutes by default
- Cache is automatically refreshed when expired
- Supports bulk lookups for better performance
- Individual lookups for missing IDs
- Per-tenant isolation in multi-tenant mode

### Enhanced Search Tools

All search tools now automatically include `_enhanced` fields:

| Tool | Enhanced Fields |
|------|----------------|
| `search_tickets` | `companyName`, `assignedResourceName` |
| `search_projects` | `companyName` |
| `search_contacts` | `companyName` |
| `search_companies` | `ownerResourceName` |
| `search_tasks` | `assignedResourceName`, `creatorResourceName`, `completedByResourceName` |
| `search_time_entries` | `resourceName`, `billingApprovalResourceName` |
| `search_contracts` | `companyName` |
| `search_opportunities` | `companyName`, `ownerResourceName`, `creatorResourceName` |
| `search_invoices` | `companyName`, `creatorResourceName` |
| `search_quotes` | `companyName`, `creatorResourceName` |
| `search_expense_reports` | `submittedByResourceName`, `approvedByResourceName` |
| `search_expense_items` | `companyName` |
| `search_configuration_items` | `companyName` |

### Mapping Tools

#### `get_company_name`
Get a company name by ID:
```json
{
  "companyId": 678
}
```

Returns:
```json
{
  "id": 678,
  "name": "Acme Corporation",
  "found": true
}
```

#### `get_resource_name`
Get a resource (user) name by ID:
```json
{
  "resourceId": 90
}
```

Returns:
```json
{
  "id": 90,
  "name": "John Smith",
  "found": true
}
```

#### `get_mapping_cache_stats`
View cache statistics:
```json
{}
```

Returns (single-tenant mode):
```json
{
  "companies": {
    "count": 150,
    "lastUpdated": "2024-01-15T10:30:00Z",
    "isValid": true
  },
  "resources": {
    "count": 45,
    "lastUpdated": "2024-01-15T10:30:00Z", 
    "isValid": true
  },
  "tenantId": "default",
  "lastUsed": "2024-01-15T10:30:00Z"
}
```

Returns (multi-tenant mode - global stats):
```json
{
  "tenantCount": 5,
  "maxTenants": 50,
  "tenants": [
    {
      "tenantId": "tenant-a",
      "companies": { "count": 100, "isValid": true },
      "resources": { "count": 25, "isValid": true },
      "lastUsed": "2024-01-15T10:30:00Z"
    }
  ]
}
```

#### `clear_mapping_cache`
Clear cached data:
```json
{
  "type": "all"  // or "companies" or "resources"
}
```

#### `preload_mapping_cache`
Preload cache for better performance:
```json
{}
```

## Enhanced Data Fields

The following ID fields are automatically enhanced when present:

### Company Fields
- `companyID` → `_enhanced.companyName`
- `accountID` → `_enhanced.companyName` (for opportunities, quotes)

### Resource Fields
- `assignedResourceID` → `_enhanced.assignedResourceName`
- `ownerResourceID` → `_enhanced.ownerResourceName`
- `projectManagerResourceID` → `_enhanced.projectManagerResourceName`
- `createdByResourceID` → `_enhanced.createdByResourceName`
- `creatorResourceID` → `_enhanced.creatorResourceName`
- `completedByResourceID` → `_enhanced.completedByResourceName`
- `lastModifiedByResourceID` → `_enhanced.lastModifiedByResourceName`
- `submittedByResourceID` → `_enhanced.submittedByResourceName`
- `approvedByResourceID` → `_enhanced.approvedByResourceName`
- `billingApprovalResourceID` → `_enhanced.billingApprovalResourceName`
- `resourceID` → `_enhanced.resourceName` (for time entries)

## Implementation Details

### MappingService Class
The core mapping functionality is implemented in `src/utils/mapping.service.ts`. It provides:

- **Per-tenant cache isolation**: Each tenant gets isolated cache storage
- **Memory management**: LRU eviction and automatic cleanup
- **Cached lookups**: Configurable 30-minute expiry
- **Graceful error handling**: Null returns on failures, no exceptions
- **Batch operations**: Efficient bulk lookups
- **Statistics**: Per-tenant and global cache stats

### EnhancedAutotaskToolHandler Class
Extends the base tool handler in `src/handlers/enhanced.tool.handler.ts` to:

- Automatically enhance search results with mapped names
- Add mapping-specific tools
- Maintain backward compatibility
- Handle mapping errors gracefully

### Cache Management
- Default cache expiry: 30 minutes
- Automatic refresh on cache miss
- Memory-bounded (max 50 tenants in multi-tenant mode)
- LRU eviction when tenant limit is reached
- Automatic cleanup every 5 minutes
- Memory-efficient Map-based storage

## Usage Examples

### Single-Tenant Mode
```javascript
import { MappingService } from './src/utils/mapping.service.js';

// Get singleton instance
const mappingService = await MappingService.getInstance(autotaskService, logger);

// Get company name (no tenant context = single-tenant mode)
const companyName = await mappingService.getCompanyName(123);
console.log(companyName); // "Acme Corporation"

// Get resource name  
const resourceName = await mappingService.getResourceName(456);
console.log(resourceName); // "John Smith"
```

### Multi-Tenant Mode
```javascript
// Create tenant context
const tenantContext = {
  tenantId: 'tenant-a',
  credentials: {
    username: 'api@company.com',
    secret: 'secret',
    integrationCode: 'CODE123'
  }
};

// Get company name for specific tenant
const companyName = await mappingService.getCompanyName(123, tenantContext);

// Get tenant-specific cache stats
const stats = mappingService.getCacheStats(tenantContext);
console.log(`Tenant ${stats.tenantId} has ${stats.companies.count} companies cached`);

// Get global stats (all tenants)
const globalStats = mappingService.getGlobalCacheStats();
console.log(`${globalStats.tenantCount} of ${globalStats.maxTenants} tenant caches in use`);
```

### Batch Operations
```javascript
// Get multiple company names (efficiently batched)
const companyIds = [123, 456, 789];
const companyNames = await mappingService.getCompanyNames(companyIds, tenantContext);

companyNames.forEach((name, index) => {
  console.log(`${companyIds[index]}: ${name ?? 'Unknown'}`);
});
```

### Cache Management
```javascript
// Preload cache for a tenant (improves first-request performance)
await mappingService.preloadTenantCache(tenantContext);

// Check tenant cache statistics
const stats = mappingService.getCacheStats(tenantContext);
console.log(`Companies cached: ${stats.companies.count}`);

// Clear specific tenant's cache
mappingService.clearTenantCache(tenantContext);

// Clear all caches (all tenants)
mappingService.clearCache();

// Graceful shutdown (stops cleanup interval)
mappingService.shutdown();
```

### Using Enhanced Handler
```javascript
import { EnhancedAutotaskToolHandler } from './src/handlers/enhanced.tool.handler.js';

const handler = new EnhancedAutotaskToolHandler(autotaskService, logger);

// Search tickets with automatic enhancement
const result = await handler.callTool('search_tickets', { pageSize: 10 });
const tickets = JSON.parse(result.content[0].text);

tickets.forEach(ticket => {
  console.log(`Ticket: ${ticket.title}`);
  if (ticket._enhanced?.companyName) {
    console.log(`  Company: ${ticket._enhanced.companyName}`);
  }
  if (ticket._enhanced?.assignedResourceName) {
    console.log(`  Assigned to: ${ticket._enhanced.assignedResourceName}`);
  }
});
```

## Error Handling

The mapping service handles errors gracefully:

- Network errors return `null` (displayed as "Unknown (ID)" in enhanced responses)
- Invalid IDs are handled without throwing exceptions
- Cache errors don't prevent basic functionality
- Mapping failures don't break the main API response

## Performance Considerations

### Single-Tenant Mode
- Cache reduces API calls by up to 95% for repeated lookups
- Bulk operations minimize network round trips
- Async/parallel processing for multiple mappings
- Configurable cache expiry for data freshness balance

### Multi-Tenant Mode
- **99% API call reduction** after first cache population
- Each tenant's first request triggers cache build (~2 API calls)
- Subsequent requests use cached data (sub-millisecond)
- Memory usage: ~50KB per tenant cache
- Maximum memory: 50 tenants × 50KB = 2.5MB total

### API Call Comparison

| Scenario | Without Cache | With Cache | Savings |
|----------|--------------|------------|---------|
| List 100 tickets | 200 calls | 2 initial + 0 cached | 99% |
| List 50 tasks | 100 calls | 2 initial + 0 cached | 98% |
| Daily operations | 10,000+ calls | ~100 refreshes | 99% |

## Configuration

The mapping service accepts these constructor parameters (through getInstance):

```javascript
// Instance is created via getInstance
const mappingService = await MappingService.getInstance(
  autotaskService,    // Required: AutotaskService instance
  logger              // Required: Logger instance  
);

// Cache expiry is 30 minutes by default
// Max tenants is 50 by default
```

## Testing

Run the mapping tests:

```bash
# Run all tests
npm test

# Run multi-tenant specific tests
npm test -- tests/mapping-multitenant.test.ts

# Run legacy mapping tests
npm run test:mapping
# or
node scripts/test-mapping.js
```

The test suites validate:
- Tenant cache isolation (no data leakage)
- Memory management (LRU eviction)
- Cache key generation
- Backward compatibility (single-tenant mode)
- Batch operations
- Error handling
- Shutdown cleanup
