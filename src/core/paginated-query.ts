/**
 * Follows Autotask REST cursor pagination (nextPageUrl) server-side within configurable budgets.
 * First page uses @apigrate/autotask-restapi entity.query(); subsequent pages use POST nextPageUrl
 * with the same query body and auth headers as the connector.
 */

import crypto from 'node:crypto';
import https from 'node:https';
import type { TenantContext, AutotaskCredentials } from '../types/mcp.js';
import type { ApiCallTracker } from '../utils/api-call-tracker.js';
import type { Logger } from '../utils/logger.js';
import { RateLimiter, ConcurrencyLimiter } from './rate-limiter.js';
import { CursorStore, type CursorContinuation } from './cursor-store.js';

const httpsAgent = new https.Agent({
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
});

/** Avoid importing AutotaskService (circular). Implemented by AutotaskService. */
export interface PaginatedQueryClientProvider {
  getAutotaskRestClient(tenantContext?: TenantContext): Promise<unknown>;
  getCredentialsForRequest(tenantContext?: TenantContext): AutotaskCredentials;
}

export type TruncationReason = 'budget-items' | 'budget-pages' | 'budget-time';

export interface PaginatedFetchResult<T> {
  items: T[];
  status: 'COMPLETE' | 'INCOMPLETE';
  /** Total matching records from API pageDetails.count (last page seen) */
  totalEstimate: number;
  cursor?: string;
  truncationReason?: TruncationReason;
  pagesFetched: number;
  /** Echoed from cursor for continue_query enrichment */
  continuation?: CursorContinuation;
}

export interface PaginatedQueryBudget {
  maxItems: number;
  maxPages: number;
  maxWallClockMs: number;
}

function readIntEnv(name: string, defaultVal: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') {
    return defaultVal;
  }
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

function defaultBudget(): PaginatedQueryBudget {
  return {
    maxItems: readIntEnv('AT_MAX_ITEMS_PER_QUERY', 5000),
    maxPages: readIntEnv('AT_MAX_PAGES_PER_QUERY', 20),
    maxWallClockMs: readIntEnv('AT_MAX_QUERY_MS', 30_000)
  };
}

interface ApigrateQueryResponse {
  items?: unknown[];
  pageDetails?: {
    count: number;
    requestCount: number;
    prevPageUrl: string | null;
    nextPageUrl: string | null;
  };
}

async function autotaskHttpJson(
  url: string,
  method: 'GET' | 'POST',
  creds: AutotaskCredentials,
  body?: unknown,
  impersonationResourceId?: number
): Promise<ApigrateQueryResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'autotask-mcp/1.0 paginated-query',
    ApiIntegrationcode: creds.integrationCode,
    UserName: creds.username,
    Secret: creds.secret
  };
  if (impersonationResourceId !== undefined) {
    headers.ImpersonationResourceId = String(impersonationResourceId);
  }
  const init: RequestInit & { agent?: https.Agent } = {
    method,
    headers,
    agent: httpsAgent
  };
  if (method === 'POST' && body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Autotask pagination fetch: invalid JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const detail = typeof json === 'object' && json !== null ? JSON.stringify(json) : String(text);
    throw new Error(`Autotask pagination fetch failed HTTP ${res.status}: ${detail}`);
  }
  return json as ApigrateQueryResponse;
}

export class PaginatedQueryEngine {
  private readonly rateLimiter: RateLimiter;
  private readonly concurrencyLimiter: ConcurrencyLimiter;

  constructor(
    private readonly clientProvider: PaginatedQueryClientProvider,
    private readonly cursorStore: CursorStore,
    private readonly logger?: Logger
  ) {
    this.rateLimiter = RateLimiter.perSecond(readIntEnv('AT_PAGINATION_RPS', 5), logger);
    this.concurrencyLimiter = new ConcurrencyLimiter(readIntEnv('AT_PAGINATION_MAX_CONCURRENCY', 10));
  }

  /**
   * Run entity query and follow nextPageUrl until complete or budget exhausted.
   * @param entity - REST entity name e.g. "Tickets", "Companies"
   * @param queryBody - JSON body for POST /{entity}/query
   * @param userMaxItems - optional hard cap on merged items (tool arg maxItems)
   * @param continuation - stored on cursor for continue_query shaping/enrichment
   */
  async fetchAll<T>(
    entity: string,
    queryBody: Record<string, unknown>,
    tenantContext: TenantContext | undefined,
    tracker: ApiCallTracker | undefined,
    userMaxItems?: number,
    continuation?: CursorContinuation
  ): Promise<PaginatedFetchResult<T>> {
    const budget = defaultBudget();
    if (userMaxItems !== undefined && Number.isFinite(userMaxItems) && userMaxItems > 0) {
      budget.maxItems = Math.min(budget.maxItems, userMaxItems);
    }
    const creds = this.clientProvider.getCredentialsForRequest(tenantContext);
    const started = Date.now();

    return this.concurrencyLimiter.execute(async () => {
      const client = (await this.clientProvider.getAutotaskRestClient(tenantContext)) as Record<
        string,
        { query?: (b: unknown) => Promise<ApigrateQueryResponse> }
      >;
      const entityApi = client[entity];
      if (!entityApi?.query) {
        throw new Error(`PaginatedQueryEngine: entity ${entity} has no query()`);
      }

      await this.rateLimiter.waitForSlot();
      const t0 = Date.now();
      let response = await entityApi.query(queryBody);
      let duration = Date.now() - t0;
      tracker?.recordApiCall(entity, 'query', duration, { page: 1, paginated: true });

      const items: T[] = [...((response.items ?? []) as T[])];
      let pageDetails = response.pageDetails;
      let totalEstimate = pageDetails?.count ?? items.length;
      let nextUrl = pageDetails?.nextPageUrl ?? null;
      let pagesFetched = 1;

      const hitTime = (): boolean => Date.now() - started >= budget.maxWallClockMs;
      const hitItems = (): boolean => items.length >= budget.maxItems;
      const hitPages = (): boolean => pagesFetched >= budget.maxPages;

      while (nextUrl) {
        if (hitTime()) {
          return this.truncate(
            entity,
            items,
            totalEstimate,
            pagesFetched,
            nextUrl,
            queryBody,
            tenantContext,
            undefined,
            'budget-time',
            continuation
          );
        }
        if (hitItems()) {
          return this.truncate(
            entity,
            items,
            totalEstimate,
            pagesFetched,
            nextUrl,
            queryBody,
            tenantContext,
            undefined,
            'budget-items',
            continuation
          );
        }
        if (hitPages()) {
          return this.truncate(
            entity,
            items,
            totalEstimate,
            pagesFetched,
            nextUrl,
            queryBody,
            tenantContext,
            undefined,
            'budget-pages',
            continuation
          );
        }

        await this.rateLimiter.waitForSlot();
        const t1 = Date.now();
        response = await autotaskHttpJson(nextUrl, 'POST', creds, queryBody);
        duration = Date.now() - t1;
        tracker?.recordApiCall(entity, 'query-nextPage', duration, { page: pagesFetched + 1, paginated: true });

        const pageItems = (response.items ?? []) as T[];
        items.push(...pageItems);
        pageDetails = response.pageDetails;
        if (pageDetails?.count !== undefined) {
          totalEstimate = pageDetails.count;
        }
        nextUrl = pageDetails?.nextPageUrl ?? null;
        pagesFetched += 1;
      }

      return {
        items,
        status: 'COMPLETE',
        totalEstimate,
        pagesFetched,
        ...(continuation !== undefined ? { continuation } : {})
      };
    });
  }

  /**
   * Resume from a continuation cursor (POST stored nextPageUrl with original query body).
   */
  async resumeFromCursor<T>(
    token: string,
    tenantContext: TenantContext | undefined,
    tracker: ApiCallTracker | undefined,
    userMaxItems?: number
  ): Promise<PaginatedFetchResult<T>> {
    const payload = this.cursorStore.get(token, tenantContext);
    if (!payload) {
      throw new Error(
        'Invalid or expired pagination cursor. Re-run the original search tool to obtain a fresh result set.'
      );
    }
    const continuationMeta = payload.continuation;
    this.cursorStore.delete(token);

    const budget = defaultBudget();
    if (userMaxItems !== undefined && Number.isFinite(userMaxItems) && userMaxItems > 0) {
      budget.maxItems = Math.min(budget.maxItems, userMaxItems);
    }
    const creds = this.clientProvider.getCredentialsForRequest(tenantContext);
    const started = Date.now();
    const entity = payload.entity;
    const queryBody = payload.queryBody;
    if (!queryBody) {
      throw new Error(
        'Pagination cursor is missing the original query body. Re-run the original search tool to obtain a fresh result set.'
      );
    }

    return this.concurrencyLimiter.execute(async () => {
      const items: T[] = [];
      let nextUrl: string | null = payload.nextPageUrl;
      let pagesFetched = 0;
      let totalEstimate = 0;

      while (nextUrl) {
        if (Date.now() - started >= budget.maxWallClockMs) {
          return this.truncate(
            entity,
            items,
            totalEstimate,
            pagesFetched,
            nextUrl,
            queryBody,
            tenantContext,
            undefined,
            'budget-time',
            continuationMeta
          );
        }
        if (items.length >= budget.maxItems) {
          return this.truncate(
            entity,
            items,
            totalEstimate,
            pagesFetched,
            nextUrl,
            queryBody,
            tenantContext,
            undefined,
            'budget-items',
            continuationMeta
          );
        }
        if (pagesFetched >= budget.maxPages) {
          return this.truncate(
            entity,
            items,
            totalEstimate,
            pagesFetched,
            nextUrl,
            queryBody,
            tenantContext,
            undefined,
            'budget-pages',
            continuationMeta
          );
        }

        await this.rateLimiter.waitForSlot();
        const t0 = Date.now();
        const response = await autotaskHttpJson(nextUrl, 'POST', creds, queryBody);
        const duration = Date.now() - t0;
        tracker?.recordApiCall(entity, 'query-nextPage', duration, { page: pagesFetched + 1, resume: true });

        const pageItems = (response.items ?? []) as T[];
        items.push(...pageItems);
        const pd = response.pageDetails;
        if (pd?.count !== undefined) {
          totalEstimate = pd.count;
        }
        nextUrl = pd?.nextPageUrl ?? null;
        pagesFetched += 1;
      }

      return {
        items,
        status: 'COMPLETE',
        totalEstimate: totalEstimate || items.length,
        pagesFetched,
        ...(continuationMeta !== undefined ? { continuation: continuationMeta } : {})
      };
    });
  }

  private truncate<T>(
    entity: string,
    items: T[],
    totalEstimate: number,
    pagesFetched: number,
    nextUrl: string,
    queryBody: Record<string, unknown>,
    tenantContext: TenantContext | undefined,
    impersonationResourceId: number | undefined,
    reason: TruncationReason,
    continuation?: CursorContinuation
  ): PaginatedFetchResult<T> {
    const cursor = this.cursorStore.put(tenantContext, entity, nextUrl, {
      queryBody,
      ...(impersonationResourceId !== undefined ? { impersonationResourceId } : {}),
      ...(continuation !== undefined ? { continuation } : {})
    });
    if (this.logger) {
      this.logger.info('PaginatedQueryEngine: truncated by budget', {
        entity,
        reason,
        itemsReturned: items.length,
        pagesFetched
      });
    }
    return {
      items,
      status: 'INCOMPLETE',
      totalEstimate: totalEstimate || items.length,
      cursor,
      truncationReason: reason,
      pagesFetched,
      ...(continuation !== undefined ? { continuation } : {})
    };
  }
}
