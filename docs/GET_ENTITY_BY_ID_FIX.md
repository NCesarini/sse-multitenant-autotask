# Get Entity By ID Bug Fix

## Issue Summary

The `get_entity` tool was failing to retrieve entities (e.g., companies) by ID due to incorrect parameter passing in the `getEntityById` method.

## Root Cause

The handler was passing parameters as an **object** instead of **separate arguments** to service methods.

### The Bug (Before)

```typescript
// Some entities support fullDetails parameter
const getOptions = fullDetails !== undefined ? { id, fullDetails } : id;
const result = await serviceMethod.call(this.autotaskService, getOptions, tenantContext);
```

**What was happening:**
1. If `fullDetails` was defined: Passed `{ id: 123, fullDetails: true }` as first argument
2. If `fullDetails` was undefined: Passed `123` (number) as first argument

**Why this broke:**
- Service methods expect: `methodName(id: number, tenantContext?: TenantContext)`
- Or for tickets: `getTicket(id: number, fullDetails: boolean, tenantContext?: TenantContext)`
- When an **object** is passed instead of a **number**, the database lookup fails

### Example Failure

```typescript
// User calls: get_entity with { entity: 'companies', id: 123, fullDetails: true }

// Handler incorrectly passed:
await getCompany({ id: 123, fullDetails: true }, tenantContext)
//                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                Object passed as ID - WRONG!

// Service method signature:
async getCompany(id: number, tenantContext?: TenantContext)
//               ^^^^^^^^^^
//               Expects a number!
```

## The Fix (After)

```typescript
// Only tickets support fullDetails parameter (as second argument)
const supportsFullDetails = ['getTicket', 'getTicketByNumber'].includes(methodName);

let result;
if (supportsFullDetails && fullDetails !== undefined) {
  // Pass id, fullDetails, tenantContext as separate parameters
  result = await serviceMethod.call(this.autotaskService, id, fullDetails, tenantContext);
} else {
  // Pass id, tenantContext as separate parameters
  result = await serviceMethod.call(this.autotaskService, id, tenantContext);
}
```

**What's correct now:**
1. Parameters are passed as **separate arguments**, not as an object
2. Only entities that support `fullDetails` receive it (`getTicket`, `getTicketByNumber`)
3. Other entities receive just `id` and `tenantContext`

## Service Method Signatures

### Methods that support `fullDetails`:
- `getTicket(id: number, fullDetails: boolean = false, tenantContext?: TenantContext)`
- `getTicketByNumber(ticketNumber: string, fullDetails: boolean = false, tenantContext?: TenantContext)`

### Methods that DON'T support `fullDetails`:
- `getCompany(id: number, tenantContext?: TenantContext)`
- `getContact(id: number, tenantContext?: TenantContext)`
- `getProject(id: number, tenantContext?: TenantContext)`
- `getResource(id: number, tenantContext?: TenantContext)`
- `getTask(id: number, tenantContext?: TenantContext)`
- `getContract(id: number, tenantContext?: TenantContext)`
- `getQuote(id: number, tenantContext?: TenantContext)`
- `getInvoice(id: number, tenantContext?: TenantContext)`
- `getTimeEntry(id: number, tenantContext?: TenantContext)`
- `getConfigurationItem(id: number, tenantContext?: TenantContext)`
- `getExpenseReport(id: number, tenantContext?: TenantContext)`

## Impact

### Before the Fix:
- ❌ `get_entity` would fail for ANY entity if `fullDetails` was provided
- ❌ Specifically affected: companies, contacts, projects, resources, etc.
- ❌ Error: Database lookup would fail because object passed instead of ID number

### After the Fix:
- ✅ `get_entity` correctly passes ID as a number for all entities
- ✅ Tickets receive `fullDetails` parameter when provided
- ✅ Other entities ignore `fullDetails` (as they don't support it)
- ✅ All entity lookups work correctly

## Testing

### Test Case 1: Get Company by ID
```json
{
  "tool": "get_entity",
  "arguments": {
    "entity": "companies",
    "id": 123
  }
}
```
**Expected:** Returns company with ID 123
**Status:** ✅ Now works

### Test Case 2: Get Company with fullDetails (not supported)
```json
{
  "tool": "get_entity",
  "arguments": {
    "entity": "companies",
    "id": 123,
    "fullDetails": true
  }
}
```
**Expected:** Returns company with ID 123 (ignores fullDetails)
**Status:** ✅ Now works (was broken before)

### Test Case 3: Get Ticket with fullDetails (supported)
```json
{
  "tool": "get_entity",
  "arguments": {
    "entity": "tickets",
    "id": 456,
    "fullDetails": true
  }
}
```
**Expected:** Returns ticket with ID 456 including full details
**Status:** ✅ Now works correctly

## Related Files

- **Fixed:** `/src/handlers/enhanced.tool.handler.ts` (lines 5505-5522)
- **Tool Definition:** `/src/handlers/enhanced.tool.handler.ts` (lines 2402-2421)
- **Service Methods:** `/src/services/autotask.service.ts`

## Key Takeaway

When calling methods dynamically with `.call()`, ensure parameters are passed as **separate arguments**, not as objects, unless the method signature explicitly expects an object parameter.

**Wrong:**
```typescript
serviceMethod.call(service, { param1, param2 }, context)
```

**Correct:**
```typescript
serviceMethod.call(service, param1, param2, context)
```

