# Cursor-Based Pagination in Autotask API

## Executive Summary

The Autotask REST API uses **CURSOR-BASED PAGINATION**, not simple page numbers. This means you **cannot jump to page 2, 3, etc. directly**. Instead, you must follow `nextPageUrl` links sequentially.

## What This Means

### ❌ What DOESN'T Work
```json
// This does NOT work - page numbers are ignored
{
  "tool": "search_companies",
  "arguments": {
    "page": 35,  // ← IGNORED! API always returns page 1
    "pageSize": 50
  }
}
```

### ✅ What DOES Work
```json
// Option 1: Direct lookup by ID (BEST)
{
  "tool": "get_entity",
  "arguments": {
    "entity": "companies",
    "id": 1717  // Direct access to company 1717
  }
}

// Option 2: Filter by name
{
  "tool": "search_companies",
  "arguments": {
    "searchTerm": "Microsoft",
    "pageSize": 50
  }
}

// Option 3: Filter by ID
{
  "tool": "search_companies",
  "arguments": {
    "filter": [
      {
        "field": "id",
        "op": "eq",
        "value": 1717
      }
    ]
  }
}
```

## How Autotask API Pagination Works

### Response Structure

```json
{
  "items": [
    // ... array of results ...
  ],
  "pageDetails": {
    "count": 50,              // Items in this response
    "requestCount": 50,       // Items requested
    "prevPageUrl": null,      // URL for previous page (or null)
    "nextPageUrl": "https://..." // URL for next page (or null)
  }
}
```

### Sequential Navigation Required

```
Page 1 → Get nextPageUrl → Use URL for Page 2 → Get nextPageUrl → Use URL for Page 3
```

You **must** follow this chain - you cannot skip ahead.

## Changes Made

### 1. Updated `get_companies_page` Tool

**Before:**
- Accepted `page` parameter
- Suggested pagination through pages
- Didn't warn about limitations

**After:**
```typescript
// Tool now:
- Removed page parameter from schema
- Rejects requests with page > 1
- Shows error message explaining cursor-based pagination
- Guides users to better approaches (filters, direct lookup)
```

**Error Response:**
```
❌ ERROR: Cannot jump to page 35

Autotask API uses CURSOR-BASED pagination (nextPageUrl/prevPageUrl), NOT page numbers.
You cannot directly access page 2, 3, etc.

✅ CORRECT APPROACHES:
1. Use get_entity with entity="companies" and id=<company_id> to get a specific company directly
2. Use search_companies with filter=[{field:"id",op:"eq",value:<id>}] to find by ID
3. Use searchTerm parameter to filter by company name (e.g., searchTerm="Microsoft")
4. Use isActive=true to filter active companies only
5. Use search_companies with owner, type, or location filters

❌ DO NOT try to paginate through all companies - use filters to reduce the dataset instead.
```

### 2. Updated `search_companies` Tool

**Changes:**
- Removed `page` parameter from tool schema
- Updated `pageSize` description to discourage pagination
- Emphasizes using filters instead

**New Description:**
```
⚠️ LIMIT results returned (default: 100, max: 500). This does NOT support pagination to 
specific pages - Autotask uses cursor-based pagination. To find specific companies: 
1) Use get_entity with company ID for direct lookup, 2) Use searchTerm to filter by name, 
3) Add filters (ownerResourceID, companyType, isActive, etc.) to narrow results. 
DO NOT request large pageSizes - instead use specific filters to reduce the dataset.
```

### 3. Service Layer Warning

Added warning in `autotask.service.ts`:

```typescript
if (options.page && options.page > 1) {
  this.logger.warn(`⚠️ Page parameter (${options.page}) may not work - Autotask uses cursor-based pagination. Results may be incorrect.`);
}
```

## Best Practices for Finding Data

### For Specific Entities (Recommended)

```json
// Best: Direct lookup by ID
{
  "tool": "get_entity",
  "arguments": {
    "entity": "companies",
    "id": 1717
  }
}
```

### For Text-Based Search

```json
// Search by name
{
  "tool": "search_companies",
  "arguments": {
    "searchTerm": "Acme",
    "isActive": true,
    "pageSize": 50
  }
}
```

### For Filtered Lists

```json
// Filter by owner
{
  "tool": "search_companies",
  "arguments": {
    "ownerResourceID": 29683995,
    "companyType": 1,  // Customers only
    "isActive": true,
    "pageSize": 100
  }
}
```

### For ID-Based Lookup

```json
// Find by ID using filter
{
  "tool": "search_companies",
  "arguments": {
    "filter": [
      {
        "field": "id",
        "op": "eq",
        "value": 1717
      }
    ]
  }
}
```

## Why Pagination is Discouraged

1. **Not Supported**: API doesn't honor page numbers - always returns page 1
2. **Inefficient**: Would require following nextPageUrl chains
3. **Slow**: Multiple sequential API calls required
4. **Unnecessary**: Filters eliminate need for pagination
5. **Error-Prone**: Easy to get incomplete or duplicate data

## Implementation Strategy

### Tools Updated

1. ✅ `get_companies_page` - Rejects page > 1, guides to filters
2. ✅ `search_companies` - Removed page param, emphasizes filters
3. ✅ Service layer - Logs warnings for page > 1

### Future Improvements

If cursor-based pagination is truly needed:

1. Implement `nextPageUrl` tracking system
2. Create continuation token mechanism
3. Add cursor storage per session
4. Provide explicit "get next page" tool
5. Warn about sequential-only access

However, **filtering should always be preferred** over pagination.

## Agent Guidance

### If Agent Asks for Page 2+

❌ **Agent Request:**
> "Get page 35 of companies to find company 1717"

✅ **Correct Response:**
> "I cannot jump to page 35 - Autotask doesn't support that. Instead, let me:
> 1. Get company 1717 directly using get_entity, OR
> 2. Search for company ID 1717 using a filter"

### If Agent Wants to Browse All

❌ **Agent Request:**
> "Show me all 5000 companies"

✅ **Correct Response:**
> "I cannot paginate through 5000 companies. Can you:
> 1. Tell me which specific company you need (I'll look it up by ID or name)
> 2. Provide filter criteria (active status, owner, type, location, etc.)
> 3. Tell me what you're trying to accomplish (I may have a better approach)"

## Related Documentation

- [Pagination Bug Fix](./PAGINATION_BUG_FIX.md) - Math.max vs Math.min bug
- [API Library Usage](./API_LIBRARY_USAGE_FIXES.md) - Entity name fixes
- [Autotask REST API Docs](https://ww3.autotask.net/help/DeveloperHelp/Content/APIs/REST/REST_API_Home.htm)

## Testing After Rebuild

```bash
# 1. This should work (direct lookup)
{
  "tool": "get_entity",
  "arguments": {
    "entity": "companies",
    "id": 1717
  }
}

# 2. This should be rejected with helpful error
{
  "tool": "get_companies_page",
  "arguments": {
    "page": 35,
    "pageSize": 50
  }
}
# Expected: Error message explaining cursor-based pagination

# 3. This should work (filtered search)
{
  "tool": "search_companies",
  "arguments": {
    "searchTerm": "Acme",
    "isActive": true
  }
}
```
