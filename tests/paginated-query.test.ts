/**
 * PaginatedQueryEngine + CursorStore integration tests (mocked HTTP).
 */

import { PaginatedQueryEngine } from '../src/core/paginated-query';
import { CursorStore } from '../src/core/cursor-store';
import type { AutotaskCredentials } from '../src/types/mcp';
import type { TenantContext } from '../src/types/mcp';

const creds: AutotaskCredentials = {
  username: 'u',
  secret: 's',
  integrationCode: 'ic'
};

const tenant: TenantContext = {
  tenantId: 't1',
  credentials: creds,
  impersonationResourceId: 29683316,
  mode: 'write'
};

class MockProvider {
  public queryCalls: unknown[] = [];
  private page = 0;

  constructor(
    private readonly pages: Array<{ items: unknown[]; next: string | null }>
  ) {}

  getCredentialsForRequest(): AutotaskCredentials {
    return creds;
  }

  async getAutotaskRestClient(): Promise<unknown> {
    const self = this;
    return {
      Widgets: {
        query: async (body: unknown) => {
          self.queryCalls.push(body);
          const chunk = self.pages[self.page];
          if (!chunk) {
            return { items: [], pageDetails: { count: 0, requestCount: 0, prevPageUrl: null, nextPageUrl: null } };
          }
          self.page += 1;
          return {
            items: chunk.items,
            pageDetails: {
              count: 100,
              requestCount: chunk.items.length,
              prevPageUrl: null,
              nextPageUrl: chunk.next
            }
          };
        }
      }
    };
  }
}

describe('PaginatedQueryEngine', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('merges multiple pages via nextPageUrl', async () => {
    const provider = new MockProvider([
      { items: [{ id: 1 }], next: 'https://example.test/next1' },
      { items: [{ id: 2 }], next: null }
    ]);
    const store = new CursorStore({ maxCursors: 50, maxPerTenant: 10, ttlMs: 60_000, cleanupIntervalMs: 300_000 });
    const engine = new PaginatedQueryEngine(provider as any, store);

    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(url).toContain('next1');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify({ filter: [], pageSize: 10, MaxRecords: 10 }));
      expect((init?.headers as Record<string, string>).ImpersonationResourceId).toBeUndefined();
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [{ id: 2 }],
            pageDetails: {
              count: 100,
              requestCount: 1,
              prevPageUrl: null,
              nextPageUrl: null
            }
          })
      } as Response;
    }) as unknown as typeof fetch;

    const r = await engine.fetchAll(
      'Widgets',
      { filter: [], pageSize: 10, MaxRecords: 10 },
      tenant,
      undefined,
      undefined,
      { enrichment: 'none', responseKey: 'items' }
    );

    expect(r.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(r.status).toBe('COMPLETE');
    expect(r.pagesFetched).toBe(2);
    store.destroy();
  });

  it('issues cursor when maxPages budget hit', async () => {
    const provider = new MockProvider([
      { items: [{ id: 1 }], next: 'https://example.test/n1' },
      { items: [{ id: 2 }], next: 'https://example.test/n2' }
    ]);
    const store = new CursorStore({ maxCursors: 50, maxPerTenant: 10, ttlMs: 60_000, cleanupIntervalMs: 300_000 });
    const engine = new PaginatedQueryEngine(provider as any, store);

    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          items: [{ id: 99 }],
          pageDetails: {
            count: 999,
            requestCount: 1,
            prevPageUrl: null,
            nextPageUrl: 'https://example.test/more'
          }
        })
    })) as any;

    const prevPages = process.env.AT_MAX_PAGES_PER_QUERY;
    process.env.AT_MAX_PAGES_PER_QUERY = '1';
    try {
      const r = await engine.fetchAll(
        'Widgets',
        { filter: [], pageSize: 5, MaxRecords: 5 },
        tenant,
        undefined,
        undefined,
        { enrichment: 'companies', responseKey: 'companies' }
      );
      expect(r.status).toBe('INCOMPLETE');
      expect(r.cursor).toBeDefined();
      expect(r.truncationReason).toBe('budget-pages');
      expect(typeof r.cursor).toBe('string');
    } finally {
      if (prevPages === undefined) delete process.env.AT_MAX_PAGES_PER_QUERY;
      else process.env.AT_MAX_PAGES_PER_QUERY = prevPages;
    }
    store.destroy();
  });

  it('resumeFromCursor rejects wrong tenant', async () => {
    const provider = new MockProvider([{ items: [], next: null }]);
    const store = new CursorStore({ maxCursors: 50, maxPerTenant: 10, ttlMs: 60_000, cleanupIntervalMs: 300_000 });
    const engine = new PaginatedQueryEngine(provider as any, store);

    const token = store.put(tenant, 'Widgets', 'https://example.test/resume-here', {
      queryBody: { filter: [], pageSize: 10, MaxRecords: 10 },
      continuation: { enrichment: 'none', responseKey: 'items' }
    });

    const otherTenant: TenantContext = {
      tenantId: 't2',
      credentials: { ...creds, username: 'other' },
      mode: 'write'
    };

    await expect(engine.resumeFromCursor(token, otherTenant, undefined)).rejects.toThrow(/Invalid or expired/);
    store.destroy();
  });
});
