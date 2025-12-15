# Contracts Search Debugging Guide

## Issue Summary

The `search_contracts` tool was returning empty arrays even when contracts exist in the Autotask instance.

## Root Causes Identified

### 1. **Property Name Mismatch (FIXED)**
The original `searchContracts` method was using PascalCase property names (`Filter`, `IncludeFields`, `MaxRecords`) instead of the camelCase format expected by the @apigrate/autotask-restapi library.

**Before:**
```typescript
const searchBody: any = {
  MaxRecords: 100,
  IncludeFields: [],
  Filter: []
};
searchBody.Filter = filterArray; // Wrong!
```

**After:**
```typescript
const searchBody: any = {};
searchBody.filter = filterArray; // Correct!
searchBody.pageSize = requestedPageSize;
searchBody.MaxRecords = requestedPageSize;
```

### 2. **Missing Filter Conversion Logic (FIXED)**
The method wasn't properly handling filter conversion from object format to array format, unlike other working methods (Companies, Projects, Invoices, etc.).

**Added:**
- Default filter fallback when no filter is provided
- Object-to-array filter conversion
- Consistent filter handling with other entity methods

### 3. **Potential Status Value Issue (NEEDS VERIFICATION)**
There's an inconsistency in the codebase regarding contract status values:
- Tool description says: `1=Inactive, 2=Active, 3=Complete`
- But code elsewhere checks `c.status === 1` for "activeContracts"

**This needs to be verified against actual Autotask API field information.**

## Changes Made

### File: `src/services/autotask.service.ts`

1. **Changed property names from PascalCase to camelCase:**
   - `Filter` → `filter`
   - `IncludeFields` → removed (not needed)
   - Added `pageSize` alongside `MaxRecords`

2. **Added proper filter handling:**
   - Default filter `{ op: 'gte', field: 'id', value: 0 }` when none provided
   - Object-to-array conversion for filters
   - Consistent with other entity methods

3. **Enhanced logging:**
   - Added `fullSearchBody` to debug logs to see exact request

## Testing the Fix

### Option 1: Run the Debug Script

We've created a comprehensive debug script to verify the fix:

```bash
cd /home/nicolas/dev/autotask-mcp
node scripts/test-contracts-debug.js
```

This script will:
1. Get field information for Contracts to see valid status values
2. Search for all contracts (no status filter)
3. Show actual status values in your Autotask instance
4. Test searching with status=2
5. Test searching with status=1

### Option 2: Rebuild and Test via MCP

```bash
# Rebuild the project
npm run build

# Restart your MCP server
# Then test via your MCP client (Claude Desktop, etc.)
```

## Expected Results

After the fix, the search should:
1. ✅ Accept filters in the correct format
2. ✅ Send properly formatted requests to the Autotask API  
3. ✅ Return contracts that match your filter criteria
4. ✅ Show detailed logging of the request body

## Verifying Contract Status Values

To verify which status value represents "Active" contracts in your Autotask instance:

1. Run the debug script (it will show field info and actual data)
2. Or check the Autotask API documentation for your version
3. Or query without a status filter and inspect the returned values

Common status values (may vary by instance):
- Status 1: May be "Inactive" or "Active" (needs verification)
- Status 2: May be "Active" or something else (needs verification)
- Status 3: Typically "Complete"

## Related Files

- `/src/services/autotask.service.ts` - Main service file (searchContracts method)
- `/src/handlers/enhanced.tool.handler.ts` - Tool definitions (line 1682 - status description)
- `/scripts/test-contracts-debug.js` - Debug script for testing

## Next Steps

1. Rebuild the TypeScript project
2. Run the debug script to verify actual status values
3. Update the tool description if status values are incorrect
4. Test the search_contracts tool via MCP

## Code Inconsistencies to Review

**Line 1682 in `enhanced.tool.handler.ts`:**
```typescript
description: 'Filter by contract status. Common values: 1=Inactive, 2=Active, 3=Complete'
```

**Line 5710 in `enhanced.tool.handler.ts`:**
```typescript
activeContracts: contracts.filter(c => c.status === 1).length,
```

These contradict each other - one needs to be updated after verifying the correct status values.

