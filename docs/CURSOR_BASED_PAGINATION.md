# Cursor-based pagination (Autotask REST)

## Facts

- Autotask entity search uses **POST** `/{Entity}/query` and returns **`pageDetails.nextPageUrl`** for the next slice.
- Request body **`page` / page numbers are not honored** for continuing a query.
- The MCP server follows **`nextPageUrl`** **inside** `search_*` tools (via `PaginatedQueryEngine`) until complete or until a **budget** stops the iteration.

## What agents should do

1. Call `search_tickets` (or another search tool) with filters and optional `pageSize` / `maxItems`.
2. Read **`_paginationProtocol.status`**.
3. If **`COMPLETE`** → analyze the merged array in the response.
4. If **`INCOMPLETE`** → call **`continue_query`** with **`{ "cursor": "<from nextAction.callWith.cursor>" }`** (same `_tenant` if multi-tenant). Repeat until **`COMPLETE`**.
5. **Never** rely on `page: 2, 3, …` — tools return an error for `page > 1` pointing to this flow.

## `continue_query` tool

- **Input:** `{ cursor: string, maxItems?: number }` plus optional `_tenant`.
- **Output:** Same entity key as the original search (`tickets`, `companies`, …) and a fresh `_paginationProtocol`.

## Autotask response shape (reference)

```json
{
  "items": [],
  "pageDetails": {
    "count": 1234,
    "requestCount": 500,
    "prevPageUrl": null,
    "nextPageUrl": "https://webservices.../query/continue?..."
  }
}
```

The MCP server follows `nextPageUrl` with the same query method/body and API credential headers as the original query (`ApiIntegrationcode`, `UserName`, `Secret`). Because search tools start with POST `/{Entity}/query`, continuation requests also use POST.

## Related

- [PAGINATION_AND_LARGE_RESULTS.md](./PAGINATION_AND_LARGE_RESULTS.md) — protocol fields and env budgets  
- [MULTI_TENANT_USAGE.md](../MULTI_TENANT_USAGE.md) — cursor binding to tenant credentials  
