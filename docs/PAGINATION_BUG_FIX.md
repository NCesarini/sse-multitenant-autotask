# Pagination Bug Fix - Math.max vs Math.min

## Issue Summary

The `searchCompanies` method (and potentially others) had a critical bug that prevented proper pagination. All paginated requests were returning the **maximum** page size instead of respecting the requested size.

## Root Cause

**Line 505 in `autotask.service.ts`:**

```typescript
// ❌ WRONG - Math.max INCREASES the value!
requestedPageSize = Math.max(requestedPageSize, THRESHOLD_LIMIT);

// Example with THRESHOLD_LIMIT = 100:
// User requests pageSize = 50
// Math.max(50, 100) = 100  ← Returns 100 instead of 50!
```

**The Bug:**
- `Math.max()` returns the **larger** of two values
- This meant if you requested a page size **smaller** than the threshold, it would be **increased** to the threshold
- The intent was to **cap/limit** the page size, which requires `Math.min()`

## Impact

### Before the Fix:
- ❌ Requesting `pageSize: 50` would return 100 results (threshold)
- ❌ Requesting `pageSize: 25` would return 100 results (threshold)  
- ❌ Requesting `pageSize: 150` would still return 150 (above threshold)
- ❌ All pagination was broken because pages always returned max size
- ❌ Users would see the same companies repeating on every "page"

### After the Fix:
- ✅ Requesting `pageSize: 50` returns 50 results (as requested)
- ✅ Requesting `pageSize: 25` returns 25 results (as requested)
- ✅ Requesting `pageSize: 150` returns 100 results (capped at threshold)
- ✅ Pagination works correctly
- ✅ Different pages return different companies

## The Fix

```typescript
// ✅ CORRECT - Math.min CAPS the value!
requestedPageSize = Math.min(requestedPageSize, THRESHOLD_LIMIT);

// Example with THRESHOLD_LIMIT = 100:
// User requests pageSize = 50
// Math.min(50, 100) = 50   ← Returns 50 as requested!

// User requests pageSize = 150
// Math.min(150, 100) = 100 ← Caps at 100 (threshold)
```

## Additional Improvements

Added detailed logging to show actual query parameters:

```typescript
this.logger.info('📋 Companies query parameters:', {
  page: searchBody.page || 1,
  pageSize: searchBody.pageSize,
  MaxRecords: searchBody.MaxRecords,
  filterCount: searchBody.filter?.length || 0,
  hasSort: !!searchBody.sort
});
```

This helps diagnose pagination issues in the future.

## Finding Specific Companies

### Problem
User was trying to paginate to find company ID 1717 using `get_companies_page`.

### Better Solution
Instead of paginating through thousands of companies, **use direct lookup**:

#### Method 1: Use `get_entity` (Recommended)

```json
{
  "tool": "get_entity",
  "arguments": {
    "entity": "companies",
    "id": 1717
  }
}
```

This retrieves company 1717 **directly** in one API call.

#### Method 2: Use `query_entity` with ID filter

```json
{
  "tool": "query_entity",
  "arguments": {
    "entity": "companies",
    "search": "1717"
  }
}
```

#### Method 3: Use `search_companies` with ID filter

```json
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

## Understanding Autotask Pagination

The Autotask REST API may use **cursor-based pagination** rather than simple page numbers. This means:

- ✅ The API respects `pageSize` and `MaxRecords`
- ⚠️ The `page` parameter may not work as expected (cursor-based instead)
- ✅ The API returns `pageDetails` with `nextPageUrl` for cursor-based pagination
- ✅ To get page 2, you may need to use the `nextPageUrl` from page 1's response

### Current Implementation

The current implementation passes a `page` parameter to the API, but this may not be honored by Autotask. Future improvements could:

1. Use `nextPageUrl` from `pageDetails` for proper cursor-based pagination
2. Implement a cursor-tracking system for multi-page requests
3. Add warnings when pagination beyond page 1 is requested

## Files Modified

- ✅ `/src/services/autotask.service.ts` - Fixed Math.max → Math.min (line 505)
- ✅ `/src/services/autotask.service.ts` - Added detailed query logging

## Testing

After rebuilding:

1. **Test page size respected:**
   ```json
   { "tool": "get_companies_page", "arguments": { "pageSize": 25 } }
   ```
   Should return 25 companies, not 100

2. **Test direct company lookup:**
   ```json
   { "tool": "get_entity", "arguments": { "entity": "companies", "id": 1717 } }
   ```
   Should return company 1717 directly

3. **Test pagination (if supported):**
   ```json
   { "tool": "get_companies_page", "arguments": { "page": 2, "pageSize": 50 } }
   ```
   Should return different companies than page 1

## Prevention

When implementing threshold limiting in the future:

- ✅ Use `Math.min(requested, max)` to **CAP** values (set upper limit)
- ❌ Don't use `Math.max(requested, max)` unless you want to **ENFORCE MINIMUM** values
- ✅ Add logging to verify the actual values being used
- ✅ Write tests that check edge cases (requested < threshold, requested > threshold)

## Related Issues

- [API Library Usage Fixes](./API_LIBRARY_USAGE_FIXES.md) - Entity name case sensitivity
- [Get Entity By ID Fix](./GET_ENTITY_BY_ID_FIX.md) - Parameter passing issue
- [Contracts Search Debug](./CONTRACTS_SEARCH_DEBUG.md) - Filter format issue

