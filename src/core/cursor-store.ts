/**
 * In-memory continuation cursor store for Autotask nextPageUrl pagination.
 * Tokens are opaque UUIDs bound to a tenant credential hash (same pattern as MappingService).
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import type { TenantContext } from '../types/mcp.js';

/** Passed through cursor so continue_query can shape the response and re-run enrichment */
export type SearchEnrichmentKind =
  | 'companies'
  | 'contacts'
  | 'tickets'
  | 'timeentries'
  | 'opportunities'
  | 'resources'
  | 'projects'
  | 'tasks'
  | 'contracts'
  | 'invoices'
  | 'quotes'
  | 'none';

export interface CursorContinuation {
  enrichment: SearchEnrichmentKind;
  /** Top-level JSON key e.g. "tickets", "companies" */
  responseKey: string;
}

export interface CursorPayload {
  tenantKey: string;
  entity: string;
  nextPageUrl: string;
  queryBody?: Record<string, unknown>;
  impersonationResourceId?: number;
  createdAt: number;
  lastUsed: number;
  continuation?: CursorContinuation;
}

function tenantKeyFromContext(tenantContext?: TenantContext): string {
  if (!tenantContext?.credentials) {
    return 'default';
  }
  const keyData = `${tenantContext.credentials.username}:${tenantContext.credentials.integrationCode}`;
  return Buffer.from(keyData).toString('base64').substring(0, 16);
}

export interface CursorStoreConfig {
  /** Max cursors globally (default 200) */
  maxCursors?: number;
  /** Max cursors per tenant key (default 20) */
  maxPerTenant?: number;
  /** Cursor TTL in ms (default 30 min) */
  ttlMs?: number;
  /** Cleanup interval ms (default 5 min) */
  cleanupIntervalMs?: number;
  logger?: Logger;
}

export class CursorStore {
  private readonly cursors = new Map<string, CursorPayload>();
  /** token -> tenantKey for per-tenant counts */
  private readonly tokenTenant = new Map<string, string>();
  private readonly maxCursors: number;
  private readonly maxPerTenant: number;
  private readonly ttlMs: number;
  private readonly logger: Logger | undefined;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: CursorStoreConfig = {}) {
    this.maxCursors = config.maxCursors ?? 200;
    this.maxPerTenant = config.maxPerTenant ?? 20;
    this.ttlMs = config.ttlMs ?? 30 * 60 * 1000;
    this.logger = config.logger;
    const interval = config.cleanupIntervalMs ?? 5 * 60 * 1000;
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), interval);
  }

  /** Stop background cleanup (tests / shutdown) */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Store next page URL; returns opaque token for continue_query.
   */
  put(
    tenantContext: TenantContext | undefined,
    entity: string,
    nextPageUrl: string,
    opts?: {
      queryBody?: Record<string, unknown>;
      impersonationResourceId?: number;
      continuation?: CursorContinuation;
    }
  ): string {
    const tenantKey = tenantKeyFromContext(tenantContext);
    this.enforcePerTenantLimit(tenantKey);
    this.enforceGlobalLimit();

    const token = randomUUID();
    const now = Date.now();
    const payload: CursorPayload = {
      tenantKey,
      entity,
      nextPageUrl,
      createdAt: now,
      lastUsed: now,
      ...(opts?.queryBody !== undefined ? { queryBody: opts.queryBody } : {}),
      ...(opts?.impersonationResourceId !== undefined ? { impersonationResourceId: opts.impersonationResourceId } : {}),
      ...(opts?.continuation !== undefined ? { continuation: opts.continuation } : {})
    };
    this.cursors.set(token, payload);
    this.tokenTenant.set(token, tenantKey);
    this.logger?.debug(`CursorStore: stored cursor for ${entity}`, { token: token.substring(0, 8) });
    return token;
  }

  /**
   * Resolve cursor if valid for this tenant; updates lastUsed.
   */
  get(token: string, tenantContext?: TenantContext): CursorPayload | null {
    const payload = this.cursors.get(token);
    if (!payload) {
      return null;
    }
    const now = Date.now();
    if (now - payload.createdAt > this.ttlMs) {
      this.delete(token);
      return null;
    }
    const expectedKey = tenantKeyFromContext(tenantContext);
    if (payload.tenantKey !== expectedKey) {
      this.logger?.warn('CursorStore: tenant mismatch for cursor', {
        token: token.substring(0, 8)
      });
      return null;
    }
    payload.lastUsed = now;
    return payload;
  }

  delete(token: string): void {
    this.cursors.delete(token);
    this.tokenTenant.delete(token);
  }

  /** @internal tests */
  size(): number {
    return this.cursors.size;
  }

  private countForTenant(tenantKey: string): number {
    let n = 0;
    for (const t of this.tokenTenant.values()) {
      if (t === tenantKey) n++;
    }
    return n;
  }

  private enforcePerTenantLimit(tenantKey: string): void {
    while (this.countForTenant(tenantKey) >= this.maxPerTenant) {
      const evicted = this.evictOldestForTenant(tenantKey);
      if (!evicted) break;
    }
  }

  private evictOldestForTenant(tenantKey: string): boolean {
    let oldestToken: string | null = null;
    let oldestCreated = Infinity;
    for (const [token, tk] of this.tokenTenant.entries()) {
      if (tk !== tenantKey) continue;
      const p = this.cursors.get(token);
      if (p && p.createdAt < oldestCreated) {
        oldestCreated = p.createdAt;
        oldestToken = token;
      }
    }
    if (oldestToken) {
      this.delete(oldestToken);
      this.logger?.debug('CursorStore: evicted oldest cursor for tenant (per-tenant limit)');
      return true;
    }
    return false;
  }

  private enforceGlobalLimit(): void {
    while (this.cursors.size >= this.maxCursors) {
      const evicted = this.evictOldestGlobally();
      if (!evicted) break;
    }
  }

  private evictOldestGlobally(): boolean {
    let oldestToken: string | null = null;
    let oldestCreated = Infinity;
    for (const [token, p] of this.cursors.entries()) {
      if (p.createdAt < oldestCreated) {
        oldestCreated = p.createdAt;
        oldestToken = token;
      }
    }
    if (oldestToken) {
      this.delete(oldestToken);
      this.logger?.debug('CursorStore: evicted oldest cursor (global limit)');
      return true;
    }
    return false;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    const toDelete: string[] = [];
    for (const [token, p] of this.cursors.entries()) {
      if (now - p.createdAt > this.ttlMs) {
        toDelete.push(token);
      }
    }
    for (const t of toDelete) {
      this.delete(t);
    }
    if (toDelete.length > 0) {
      this.logger?.info(`CursorStore: cleaned ${toDelete.length} expired cursors`);
    }
  }
}
