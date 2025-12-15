# Example: Large Result Set Response

## What the Agent Sees When Making a Broad Search

### Scenario: Agent searches for all open tickets without filters

**Agent Request:**
```json
{
  "tool": "search_tickets",
  "arguments": {
    "status": 1
  }
}
```

**Server Response:**
```json
{
  "tickets": [
    { "id": 12345, "title": "Email server down", "status": 1, "priority": 1, "companyID": 567 },
    { "id": 12346, "title": "Password reset request", "status": 1, "priority": 3, "companyID": 890 },
    { "id": 12347, "title": "Laptop not booting", "status": 1, "priority": 2, "companyID": 234 },
    // ... 497 more tickets ...
  ],
  "_paginationProtocol": {
    "status": "INCOMPLETE",
    "message": "⚠️ INCOMPLETE: Showing 1-500 of 5847. You MUST retrieve remaining pages before any analysis.",
    "currentPage": 1,
    "totalPages": 12,
    "showing": "Showing 1-500 of 5847",
    "totalItems": 5847,
    "nextAction": {
      "description": "Retrieve page 2 of 12",
      "callWith": { "page": 2 },
      "remainingPages": [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    },
    "verificationSteps": [
      "1. ⚠️ Only showing 500 of 5847 tickets",
      "2. IMMEDIATELY retrieve page 2 with page=2",
      "3. DO NOT perform any analysis until status is COMPLETE",
      "4. Only after ALL pages: analyze the complete dataset",
      "❌ FAILURE TO RETRIEVE ALL PAGES = INCORRECT RESULTS"
    ],
    "performanceWarning": {
      "severity": "HIGH",
      "message": "🔴 VERY LARGE RESULT SET: 5847 tickets found (12 pages required)",
      "recommendation": "STRONGLY RECOMMENDED: This search is too broad and will require 12 API calls. This is inefficient and time-consuming. Please narrow your search using more specific filters to reduce the result set to < 500 items. Consider adding date ranges, status filters, or other criteria to focus on the specific tickets you need.",
      "suggestedFilters": [
        "searchTerm (ticket number or title)",
        "priority (1=Critical, 2=High, 3=Medium, 4=Low)",
        "companyID (filter by specific customer)",
        "assignedResourceID (filter by technician)",
        "createdDateFrom (filter by date range)"
      ]
    }
  }
}
```

## How the Agent Should Respond

### Option 1: Narrow the Search (RECOMMENDED) ✅

The agent sees the `performanceWarning` with severity `HIGH` and decides to narrow the search:

**Agent's Next Request:**
```json
{
  "tool": "search_tickets",
  "arguments": {
    "status": 1,
    "priority": 1,
    "createdDateFrom": "2024-12-01"
  }
}
```

**Server Response:**
```json
{
  "tickets": [
    { "id": 12345, "title": "Email server down", "status": 1, "priority": 1 },
    { "id": 12789, "title": "Network outage", "status": 1, "priority": 1 },
    // ... 21 more tickets ...
  ],
  "_paginationProtocol": {
    "status": "COMPLETE",
    "message": "✅ All 23 tickets retrieved. Safe to analyze.",
    "currentPage": 1,
    "totalPages": 1,
    "showing": "Showing 1-23 of 23",
    "totalItems": 23,
    "verificationSteps": [
      "1. ✅ All data retrieved",
      "2. Create verification table with ALL tickets",
      "3. Analyze the complete dataset",
      "✅ PROTOCOL COMPLETE"
    ]
  }
}
```

**Agent Response to User:**
```
I found 23 critical open tickets created since December 1st, 2024. 
All data has been retrieved and is ready for analysis.

[Proceeds with analysis...]
```

### Option 2: Fetch All Pages (When Truly Needed) ⚠️

If the agent truly needs all 5,847 tickets, it should fetch all pages systematically:

**Page 1:**
```json
{ "tool": "search_tickets", "arguments": { "status": 1, "page": 1 } }
→ Returns 500 tickets (1-500), status: INCOMPLETE, nextAction: page=2
```

**Page 2:**
```json
{ "tool": "search_tickets", "arguments": { "status": 1, "page": 2 } }
→ Returns 500 tickets (501-1000), status: INCOMPLETE, nextAction: page=3
```

**... continues through all pages ...**

**Page 12:**
```json
{ "tool": "search_tickets", "arguments": { "status": 1, "page": 12 } }
→ Returns 347 tickets (5501-5847), status: COMPLETE
```

**Agent verifies:**
```
Total collected: 500+500+500+500+500+500+500+500+500+500+500+347 = 5,847 ✓
Status: COMPLETE ✓
Safe to analyze.
```

## Medium Warning Example

For searches returning 500-2000 items, the warning is less severe:

**Server Response:**
```json
{
  "_paginationProtocol": {
    "status": "INCOMPLETE",
    "totalItems": 1247,
    "totalPages": 3,
    "performanceWarning": {
      "severity": "MEDIUM",
      "message": "⚠️ LARGE RESULT SET: 1247 tickets found (3 pages required)",
      "recommendation": "RECOMMENDED: Consider narrowing your search using more specific filters to improve performance. Retrieving all 3 pages will require 3 API calls. If you only need recent or specific tickets, add filters to reduce the result set.",
      "suggestedFilters": [
        "priority (1=Critical, 2=High, 3=Medium, 4=Low)",
        "companyID (filter by specific customer)",
        "createdDateFrom (filter by date range)"
      ]
    }
  }
}
```

In this case, the agent can choose:
- **Narrow the search** (still recommended)
- **Fetch all 3 pages** (reasonable if needed)

## No Warning Example

For small result sets, no warning appears:

**Server Response:**
```json
{
  "tickets": [
    { "id": 12345, "title": "Email issue", "status": 1 },
    { "id": 12346, "title": "Password reset", "status": 1 }
  ],
  "_paginationProtocol": {
    "status": "COMPLETE",
    "message": "✅ All 2 tickets retrieved. Safe to analyze.",
    "currentPage": 1,
    "totalPages": 1,
    "totalItems": 2
    // No performanceWarning field
  }
}
```

## Agent Decision Tree

```
┌─────────────────────────┐
│ Make Search Request     │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│ Check _paginationProtocol│
└──────────┬──────────────┘
           │
           ▼
    ┌──────────────┐
    │ Has Warning? │
    └──┬───────┬───┘
       │       │
      Yes     No
       │       │
       ▼       ▼
┌──────────┐  ┌──────────┐
│ Severity?│  │ Status?  │
└──┬────┬──┘  └──┬───┬───┘
   │    │        │   │
 HIGH MEDIUM  COMP INCOMP
   │    │        │   │
   ▼    ▼        ▼   ▼
┌──────┐ ┌─────┐ ┌────┐ ┌────────┐
│Narrow│ │ Choice│ │ Done│ │Continue│
│Search│ │       │ │     │ │Pages   │
└──────┘ └───────┘ └─────┘ └────────┘
  ✅      ⚠️/✅      ✅       ⚠️
```

## Benefits for AI Agents

1. **Clear Signals**: `status` field explicitly tells if data is complete
2. **Actionable Guidance**: `suggestedFilters` shows exactly how to narrow the search
3. **Severity Awareness**: Different warnings for different situations
4. **Prevention**: Can't accidentally analyze partial data
5. **Efficiency**: Encouraged to use filters for better performance
6. **Transparency**: Always knows progress and what remains

## Key Fields to Check

Always check these fields in order:

1. **`_paginationProtocol.status`**
   - `COMPLETE` = Safe to analyze
   - `INCOMPLETE` = Must continue fetching or narrow search

2. **`_paginationProtocol.performanceWarning`** (if present)
   - `severity: "HIGH"` = Strongly consider narrowing
   - `severity: "MEDIUM"` = Consider narrowing
   - `suggestedFilters` = Available options to narrow

3. **`_paginationProtocol.nextAction`** (if continuing)
   - `callWith` = Exact parameters for next call
   - `remainingPages` = Full list of pages needed

4. **`_paginationProtocol.totalItems`**
   - Total count for verification
   - Use to assess if narrowing is needed

