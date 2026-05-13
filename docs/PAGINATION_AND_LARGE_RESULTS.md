# Pagination and large result sets

## Summary

Search tools (`search_companies`, `search_contacts`, `search_tickets`, `search_time_entries`, `search_opportunities`, …) **merge multiple Autotask `/query` pages server-side** by following `pageDetails.nextPageUrl` until:

- Autotask returns no further page, or  
- A **budget** is hit (items, pages, or wall-clock time — see env vars below).

If a budget stops iteration early, the response is **`INCOMPLETE`** and includes an opaque **`cursor`**. The agent must call the **`continue_query`** tool with that `cursor` (and the same tenant credentials) until **`_paginationProtocol.status`** is **`COMPLETE`**.

**Numeric `page` arguments are not supported** by Autotask REST for these queries; passing `page > 1` returns an error explaining the `continue_query` flow.

## `_paginationProtocol` shape (cursor flow)

```json
{
  "tickets": [ /* ... merged rows for this chunk ... */ ],
  "_paginationProtocol": {
    "status": "COMPLETE",
    "message": "Dataset complete for this tool call (123 tickets). Safe to analyze.",
    "showing": "Retrieved 123 row(s); Autotask reports ~500 total matches for this query",
    "totalItems": 500,
    "itemsInThisResponse": 123,
    "itemsAccumulated": 123,
    "pagesFetched": 1,
    "verificationSteps": [ "1. All data for this request has been retrieved (or capped by maxItems).", "..." ]
  }
}
```

When truncated by budget:

```json
{
  "_paginationProtocol": {
    "status": "INCOMPLETE",
    "truncationReason": "budget-pages",
    "nextAction": {
      "tool": "continue_query",
      "description": "Resume Autotask pagination from the server-stored nextPageUrl.",
      "callWith": { "cursor": "<uuid>" }
    }
  }
}
```

## Tool arguments

| Argument    | Meaning |
|------------|---------|
| `pageSize` | Rows per **single** Autotask POST/GET page (default 500, max 500). Does **not** cap total merged rows. |
| `maxItems` | Optional hard cap on **merged** rows for **this** tool call (also applies to each `continue_query` chunk if you pass it). |
| `cursor`   | Only for `continue_query` — taken from `nextAction.callWith.cursor`. |

## Environment (budgets)

| Variable | Default | Role |
|----------|---------|------|
| `AT_MAX_ITEMS_PER_QUERY` | 5000 | Max merged items per `fetchAll` / resume chunk |
| `AT_MAX_PAGES_PER_QUERY` | 20 | Max Autotask pages per chunk |
| `AT_MAX_QUERY_MS` | 30000 | Max wall time per chunk (ms) |
| `AT_PAGINATION_RPS` | 5 | Rate limit for pagination GETs |
| `AT_PAGINATION_MAX_CONCURRENCY` | 10 | Concurrency limiter |

## Large-result warning

If Autotask reports **`totalEstimate` > 5000** matches, `_paginationProtocol.performanceWarning` may be set (MEDIUM/HIGH) suggesting narrower filters or `maxItems`.

## Horizontal scaling note

Continuation cursors are stored **in-memory** on the MCP process. Multiple instances without sticky sessions need a shared store (e.g. Redis) — not implemented in this repo.
