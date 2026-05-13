// Autotask Service Layer
// Wraps the @apigrate/autotask-restapi client with our specific types and error handling

import { AutotaskRestApi } from '@apigrate/autotask-restapi';
import { 
  AutotaskCompany, 
  AutotaskContact, 
  AutotaskTicket, 
  AutotaskTimeEntry,
  AutotaskProject,
  AutotaskResource,
  AutotaskConfigurationItem,
  AutotaskContract,
  AutotaskInvoice,
  AutotaskTask,
  AutotaskQueryOptions,
  AutotaskTicketNote,
  AutotaskProjectNote,
  AutotaskCompanyNote,
  AutotaskTicketAttachment,
  AutotaskExpenseReport,
  AutotaskExpenseItem,
  AutotaskQuote,
  AutotaskBillingCode,
  AutotaskDepartment,
  AutotaskQueryOptionsExtended
} from '../types/autotask';
import { McpServerConfig, AutotaskCredentials, TenantContext } from '../types/mcp';
import { Logger } from '../utils/logger';
import { ApiCallTracker } from '../utils/api-call-tracker'; 
import { CursorStore, type CursorContinuation } from '../core/cursor-store.js';
import {
  PaginatedQueryEngine,
  type PaginatedQueryClientProvider,
  type PaginatedFetchResult
} from '../core/paginated-query.js';


/** Default rows per Autotask /query POST (max 500). Pagination merges multiple pages server-side. */
export const DEFAULT_ENTITY_PAGE_SIZE = 500;

/** @deprecated Use DEFAULT_ENTITY_PAGE_SIZE and env AT_MAX_*; kept for backward-compatible static threshold updates */
export const LARGE_RESPONSE_THRESHOLDS = {
  tickets: DEFAULT_ENTITY_PAGE_SIZE,
  companies: DEFAULT_ENTITY_PAGE_SIZE,
  contacts: DEFAULT_ENTITY_PAGE_SIZE,
  projects: DEFAULT_ENTITY_PAGE_SIZE,
  resources: DEFAULT_ENTITY_PAGE_SIZE,
  tasks: DEFAULT_ENTITY_PAGE_SIZE,
  timeentries: DEFAULT_ENTITY_PAGE_SIZE,
  contracts: DEFAULT_ENTITY_PAGE_SIZE,
  default: DEFAULT_ENTITY_PAGE_SIZE,
  responseSizeKB: 200
};


// Type alias for the API client (library doesn't export types)
type AutotaskClient = InstanceType<typeof AutotaskRestApi>;

// Client pool management for multi-tenant support
interface ClientPoolEntry {
  client: AutotaskClient;
  tenantId: string;
  lastUsed: Date;
  credentials: AutotaskCredentials;
}

export class AutotaskService implements PaginatedQueryClientProvider {
  private client: AutotaskClient | null = null;
  private logger: Logger;
  private config: McpServerConfig;
  private initializationPromise: Promise<void> | null = null;
  
  // New: Multi-tenant support
  private isMultiTenant: boolean;
  private clientPool: Map<string, ClientPoolEntry> = new Map();
  private readonly poolSize: number;
  private readonly sessionTimeout: number;

  private readonly cursorStore: CursorStore;
  private readonly paginatedQuery: PaginatedQueryEngine;

  constructor(config: McpServerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.isMultiTenant = config.multiTenant?.enabled ?? false;
    this.poolSize = config.multiTenant?.clientPoolSize ?? 50;
    this.sessionTimeout = config.multiTenant?.sessionTimeout ?? 30 * 60 * 1000; // 30 minutes

    if (!this.isMultiTenant) {
      // Single-tenant mode: initialize immediately if credentials available
      if (config.autotask?.username && config.autotask?.secret && config.autotask?.integrationCode) {
        this.logger.info('Single-tenant mode: credentials provided, will initialize on first use');
      }
    } else {
      this.logger.info('Multi-tenant mode enabled', { 
        poolSize: this.poolSize, 
        sessionTimeout: this.sessionTimeout 
      });
      // Start cleanup interval for expired clients
      this.startClientCleanup();
    }

    this.cursorStore = new CursorStore({ logger: this.logger });
    this.paginatedQuery = new PaginatedQueryEngine(this, this.cursorStore, this.logger);
  }

  /** Shrink ticket objects for list/search MCP responses. */
  shrinkTicketForList(ticket: AutotaskTicket): AutotaskTicket {
    return this.optimizeTicketDataAggressive(ticket);
  }

  /** Shrink project objects for list/search MCP responses. */
  shrinkProjectForList(project: AutotaskProject): AutotaskProject {
    return this.optimizeProjectData(project);
  }

  /** Shrink task objects for list/search MCP responses. */
  shrinkTaskForList(task: AutotaskTask): AutotaskTask {
    return this.optimizeTaskData(task);
  }

  /** Low-level paginated POST+nextPageUrl (MCP tools use this for cursor metadata). */
  fetchPaginatedEntity<T>(
    entity: string,
    queryBody: Record<string, unknown>,
    tenantContext?: TenantContext,
    tracker?: ApiCallTracker,
    maxItems?: number,
    continuation?: CursorContinuation
  ): Promise<PaginatedFetchResult<T>> {
    return this.paginatedQuery.fetchAll<T>(
      entity,
      queryBody,
      tenantContext,
      tracker,
      maxItems,
      continuation
    );
  }

  /** Resume MCP cursor pagination (see tool `continue_query`). */
  resumePaginatedFetch<T>(
    cursor: string,
    tenantContext?: TenantContext,
    tracker?: ApiCallTracker,
    maxItems?: number
  ): Promise<PaginatedFetchResult<T>> {
    return this.paginatedQuery.resumeFromCursor<T>(cursor, tenantContext, tracker, maxItems);
  }

  /**
   * Get or create Autotask client for tenant
   */
  private async getClientForTenant(tenantContext?: TenantContext): Promise<AutotaskClient> {
    if (!this.isMultiTenant) {
      // Single-tenant mode: use default client
      this.logger.info('🏠 Using single-tenant mode - getting default client');
      return this.ensureClient();
    }

    this.logger.info('🏢 Multi-tenant mode enabled - processing tenant context', {
      hasTenantContext: !!tenantContext,
      tenantId: tenantContext?.tenantId,
      hasCredentials: !!tenantContext?.credentials,
      sessionId: tenantContext?.sessionId
    });

    if (!tenantContext?.credentials) {
      this.logger.error('❌ Multi-tenant mode requires tenant credentials but none provided');
      throw new Error('Multi-tenant mode requires tenant credentials');
    }

    const tenantId = tenantContext.tenantId;
    const cacheKey = this.getTenantCacheKey(tenantContext.credentials);

    this.logger.info('🔍 Checking client pool for tenant', {
      tenantId,
      cacheKey: cacheKey.substring(0, 8) + '...',
      poolSize: this.clientPool.size,
      poolKeys: Array.from(this.clientPool.keys()).map(k => k.substring(0, 8) + '...')
    });

    // Check if we have a cached client for this tenant
    const poolEntry = this.clientPool.get(cacheKey);
    if (poolEntry && this.isClientValid(poolEntry)) {
      poolEntry.lastUsed = new Date();
      this.logger.info(`♻️ Using cached client for tenant: ${tenantId}`, {
        tenantId,
        cacheKey: cacheKey.substring(0, 8) + '...',
        clientAge: Date.now() - poolEntry.lastUsed.getTime(),
        poolSize: this.clientPool.size
      });
      return poolEntry.client;
    }

    if (poolEntry && !this.isClientValid(poolEntry)) {
      this.logger.info('⏰ Cached client expired for tenant, removing from pool', {
        tenantId,
        cacheKey: cacheKey.substring(0, 8) + '...',
        lastUsed: poolEntry.lastUsed
      });
      this.clientPool.delete(cacheKey);
    }

    // Create new client for tenant
    this.logger.info(`🆕 Creating new Autotask client for tenant: ${tenantId}`, {
      tenantId,
      username: tenantContext.credentials.username ? `${tenantContext.credentials.username.substring(0, 3)}***` : undefined,
      hasApiUrl: !!tenantContext.credentials.apiUrl,
      apiUrl: tenantContext.credentials.apiUrl,
      poolSizeBefore: this.clientPool.size
    });
    
    const client = await this.createTenantClient(tenantContext.credentials, tenantContext.impersonationResourceId);

    // Store in pool (with size limit)
    this.managePoolSize();
    this.clientPool.set(cacheKey, {
      client,
      tenantId,
      lastUsed: new Date(),
      credentials: tenantContext.credentials
    });

    this.logger.info(`✅ Client created and cached for tenant: ${tenantId}`, {
      tenantId,
      cacheKey: cacheKey.substring(0, 8) + '...',
      poolSizeAfter: this.clientPool.size
    });

    return client;
  }

  /**
   * Public accessor for REST client (zone discovery on first use).
   * Used by PaginatedQueryEngine for POST query + shared session.
   */
  getAutotaskRestClient(tenantContext?: TenantContext): Promise<unknown> {
    return this.getClientForTenant(tenantContext);
  }

  /**
   * Credentials for the current request (multi-tenant body or single-tenant config).
   */
  getCredentialsForRequest(tenantContext?: TenantContext): AutotaskCredentials {
    if (tenantContext?.credentials) {
      return tenantContext.credentials;
    }
    const c = this.config.autotask;
    if (!c?.username || !c?.secret || !c?.integrationCode) {
      throw new Error('No Autotask credentials: provide _tenant in multi-tenant mode or set AUTOTASK_* env vars.');
    }
    return {
      username: c.username,
      secret: c.secret,
      integrationCode: c.integrationCode,
      ...(c.apiUrl !== undefined ? { apiUrl: c.apiUrl } : {})
    };
  }

  /**
   * Create cache key for tenant credentials
   */
  private getTenantCacheKey(credentials: AutotaskCredentials): string {
    // Create a hash-like key from credentials (excluding sensitive data from logs)
    const keyData = `${credentials.username}:${credentials.integrationCode}:${credentials.apiUrl || 'auto'}`;
    return Buffer.from(keyData).toString('base64').substring(0, 16);
  }

  /**
   * Check if cached client is still valid
   */
  private isClientValid(poolEntry: ClientPoolEntry): boolean {
    const now = new Date();
    const timeSinceLastUsed = now.getTime() - poolEntry.lastUsed.getTime();
    return timeSinceLastUsed < this.sessionTimeout;
  }

  /**
   * Manage client pool size
   */
  private managePoolSize(): void {
    if (this.clientPool.size >= this.poolSize) {
      // Remove oldest client
      let oldestKey = '';
      let oldestTime = new Date();

      for (const [key, entry] of this.clientPool.entries()) {
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        this.logger.info(`Removing oldest client from pool: ${oldestKey}`);
        this.clientPool.delete(oldestKey);
      }
    }
  }

  /**
   * Start periodic cleanup of expired clients
   */
  private startClientCleanup(): void {
    setInterval(() => {
      const now = new Date();
      const expiredKeys: string[] = [];

      for (const [key, entry] of this.clientPool.entries()) {
        const timeSinceLastUsed = now.getTime() - entry.lastUsed.getTime();
        if (timeSinceLastUsed > this.sessionTimeout) {
          expiredKeys.push(key);
        }
      }

      expiredKeys.forEach(key => {
        this.logger.info(`Removing expired client from pool: ${key}`);
        this.clientPool.delete(key);
      });

      if (expiredKeys.length > 0) {
        this.logger.info(`Cleaned up ${expiredKeys.length} expired clients from pool`);
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  /**
   * Create Autotask client for specific tenant
   */
  private async createTenantClient(credentials: AutotaskCredentials, impersonationResourceId?: number): Promise<AutotaskClient> {
    try {
      const { username, secret, integrationCode, apiUrl } = credentials;
      
      this.logger.info('Creating Autotask client for tenant...', { 
        impersonationResourceId: impersonationResourceId ? `[Resource ID: ${impersonationResourceId}]` : undefined,
        credentials: {
          username,
          secret: secret ? `${secret.substring(0, 3)}***${secret.substring(secret.length - 3)}` : undefined,
          integrationCode,
          apiUrl: apiUrl || 'auto-discovery'
        }
      });

      if (!username || !secret || !integrationCode) {
        throw new Error('Missing required Autotask credentials: username, secret, and integrationCode are required');
      }

      this.logger.info('Creating Autotask client for tenant...', { 
        impersonationResourceId: impersonationResourceId ? `[Resource ID: ${impersonationResourceId}]` : undefined 
      });
      
      const authConfig: any = {
        username,
        secret,
        integrationCode
      };
      
      // API URL resolution logic with detailed logging
      if (apiUrl) {
        authConfig.apiUrl = apiUrl;
        this.logger.info(`Using explicit API URL: ${apiUrl}`, { 
          source: 'tenant-credentials',
          apiUrl 
        });
      } else if (this.config.multiTenant?.defaultApiUrl) {
        authConfig.apiUrl = this.config.multiTenant.defaultApiUrl;
        this.logger.info(`Using default API URL: ${this.config.multiTenant.defaultApiUrl}`, { 
          source: 'multi-tenant-config',
          apiUrl: this.config.multiTenant.defaultApiUrl 
        });
      } else {
        this.logger.info('Using @apigrate/autotask-restapi auto-discovery for API URL', { 
          source: 'auto-discovery',
          note: 'Library will discover zone automatically on first API call'
        });
      }

      // Add impersonation header if provided
      if (impersonationResourceId) {
        authConfig.headers = {
          'ImpersonationResourceId': impersonationResourceId.toString()
        };
        this.logger.info(`Added impersonation header for resource ID: ${impersonationResourceId}`, {
          impersonationResourceId,
          tenantUsername: username ? `${username.substring(0, 3)}***` : undefined
        });
      }

      this.logger.info('🚀 Creating Autotask client with configuration:', {
        username: username ? `${username.substring(0, 8)}***` : undefined,
        hasSecret: !!secret,
        secretLength: secret?.length || 0,
        integrationCode,
        integrationCodeLength: integrationCode?.length || 0,
        apiUrl: authConfig.apiUrl || 'auto-discovery',
        hasImpersonation: !!impersonationResourceId,
        fullAuthConfig: {
          ...authConfig,
          secret: secret ? `${secret.substring(0, 3)}***${secret.substring(secret.length - 3)}` : undefined
        }
      });

      this.logger.info('⏳ Creating AutotaskRestApi client - zone will be auto-discovered on first call...');
      
      // @apigrate/autotask-restapi uses a simple constructor
      // Zone discovery happens automatically on first API call
      const client = new AutotaskRestApi(username, secret, integrationCode);
      
      this.logger.info('✅ AutotaskRestApi client created successfully', {
        username: username ? `${username.substring(0, 8)}***` : undefined,
        note: 'Zone will be auto-discovered on first API call'
      });
      
      return client;
    } catch (error) {
      this.logger.error('❌ Failed to create tenant Autotask client:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        username: credentials.username ? `${credentials.username.substring(0, 8)}***` : undefined,
        hasSecret: !!credentials.secret,
        integrationCode: credentials.integrationCode,
        apiUrl: credentials.apiUrl || 'auto-discovery'
      });
      throw error;
    }
  }

  /**
   * Initialize the Autotask client with credentials (single-tenant mode)
   */
  async initialize(): Promise<void> {
    try {
      const { username, secret, integrationCode } = this.config.autotask || {};
      
      if (!username || !secret || !integrationCode) {
        throw new Error('Missing required Autotask credentials: username, secret, and integrationCode are required');
      }

      this.logger.info('Initializing AutotaskRestApi client...');
      
      // @apigrate/autotask-restapi uses a simple constructor
      // Zone discovery happens automatically on first API call
      this.client = new AutotaskRestApi(username, secret, integrationCode);

      this.logger.info('AutotaskRestApi client initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize AutotaskRestApi client:', error);
      throw error;
    }
  }

  /**
   * Ensure client is initialized (with lazy initialization) - single-tenant mode
   */
  private async ensureClient(): Promise<AutotaskClient> {
    if (!this.client) {
      await this.ensureInitialized();
    }
    return this.client!;
  }

  /**
   * Ensure the client is initialized, handling concurrent calls
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initializationPromise) {
      // Already initializing, wait for it to complete
      await this.initializationPromise;
      return;
    }

    if (this.client) {
      // Already initialized
      return;
    }

    // Start initialization
    this.initializationPromise = this.initialize();
    await this.initializationPromise;
  }

  // Company operations (updated to support multi-tenant)
  async getCompany(id: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskCompany | null> {
    const startTime = Date.now();
    
    this.logger.info('🏢 Getting company by ID', {
      companyId: id,
      hasTenantContext: !!tenantContext,
      tenantId: tenantContext?.tenantId,
      operation: 'getCompany'
    });

    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting company with ID: ${id}`, { tenant: tenantContext?.tenantId });
      const result = await client.Companies.get(id);
      
      const executionTime = Date.now() - startTime;
      
      // Record API call
      tracker?.recordApiCall('Companies', 'get', executionTime, { id });
      
      this.logger.info('✅ Company retrieved successfully', {
        companyId: id,
        found: !!result?.item,
        tenantId: tenantContext?.tenantId,
        executionTimeMs: executionTime
      });
      
      // @apigrate library returns { item: companyData } or { item: null } if not found
      return result?.item as AutotaskCompany || null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Companies', 'get', executionTime, { id, error: true });
      this.logger.error(`❌ Failed to get company ${id}:`, {
        companyId: id,
        tenantId: tenantContext?.tenantId,
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTimeMs: executionTime
      });
      throw error;
    }
  }

  /**
   * JSON body for POST /Companies/query (shared by searchCompanies and MCP handler).
   */
  buildCompaniesQueryPayload(options: AutotaskQueryOptions = {}): Record<string, unknown> {
    const searchBody: Record<string, unknown> = {};

    if (
      !options.filter ||
      (Array.isArray(options.filter) && options.filter.length === 0) ||
      (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)
    ) {
      searchBody.filter = [{ op: 'gte', field: 'id', value: 0 }];
    } else if (!Array.isArray(options.filter)) {
      const filterArray: unknown[] = [];
      for (const [field, value] of Object.entries(options.filter)) {
        filterArray.push({ op: 'eq', field, value });
      }
      searchBody.filter = filterArray;
    } else {
      searchBody.filter = options.filter;
    }

    if (options.sort) {
      searchBody.sort = options.sort;
    }

    const requestedPageSize = Math.min(options.pageSize ?? DEFAULT_ENTITY_PAGE_SIZE, 500);
    searchBody.pageSize = requestedPageSize;
    searchBody.MaxRecords = requestedPageSize;
    return searchBody;
  }

  async searchCompanies(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskCompany[]> {
    const startTime = Date.now();
    this.logger.info('🔍 Searching companies', {
      hasTenantContext: !!tenantContext,
      tenantId: tenantContext?.tenantId,
      impersonationResourceId: tenantContext?.impersonationResourceId?.toString(),
      hasFilter: !!(
        options.filter &&
        (Array.isArray(options.filter) ? options.filter.length > 0 : Object.keys(options.filter).length > 0)
      ),
      filterCount: options.filter
        ? Array.isArray(options.filter)
          ? options.filter.length
          : Object.keys(options.filter).length
        : 0,
      operation: 'searchCompanies'
    });

    try {
      this.logger.info('Searching companies with options:', options);

      if (options.page && options.page > 1) {
        this.logger.warn(
          `⚠️ searchCompanies: page=${options.page} is ignored by Autotask REST; use MCP continue_query with a cursor instead.`
        );
      }

      const searchBody = this.buildCompaniesQueryPayload(options);
      const result = await this.paginatedQuery.fetchAll<AutotaskCompany>(
        'Companies',
        searchBody,
        tenantContext,
        tracker,
        options.maxItems,
        { enrichment: 'companies', responseKey: 'companies' }
      );

      const executionTime = Date.now() - startTime;
      this.logger.info(`✅ Retrieved ${result.items.length} companies (paginated)`, {
        tenantId: tenantContext?.tenantId,
        resultCount: result.items.length,
        status: result.status,
        pagesFetched: result.pagesFetched,
        executionTimeMs: executionTime
      });

      return result.items;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Companies', 'query', executionTime, { error: true });
      this.logger.error('❌ Failed to search companies:', {
        tenantId: tenantContext?.tenantId,
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTimeMs: executionTime,
        options
      });
      throw error;
    }
  }

  /**
   * Count companies matching filter criteria.
   * Used for pagination to determine total number of pages.
   */
  async countCompanies(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Counting companies with options:', options);

      const filter = this.buildCompaniesQueryPayload(options).filter as unknown[];

      const response = await client.Companies.count({ filter });
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Companies', 'count', executionTime, { filterCount: filter.length });

      const count = response.queryCount ?? 0;
      this.logger.info(`Companies count: ${count}`);
      return count;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Companies', 'count', executionTime, { error: true });
      this.logger.error('Failed to count companies:', error);
      throw error;
    }
  }

  async createCompany(company: Partial<AutotaskCompany>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('🏢 Creating company', {
        tenantId: tenantContext?.tenantId,
        impersonationResourceId: tenantContext?.impersonationResourceId,
        operation: 'createCompany'
      });

      // Log detailed API parameters (excluding sensitive data)
      this.logger.info('📋 API Parameters for createCompany', {
        tenantId: tenantContext?.tenantId,
        impersonationResourceId: tenantContext?.impersonationResourceId,
        companyData: {
          companyName: company.companyName,
          companyType: company.companyType,
          hasOwnerResourceID: !!company.ownerResourceID,
          hasPhone: !!company.phone,
          hasAddress: !!(company.address1 || company.address2),
          fieldCount: Object.keys(company).length
        },
        apiEndpoint: 'client.Companies.create'
      });

      const result = await client.Companies.create(company as any);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Companies', 'create', executionTime, { companyName: company.companyName });
      
      // @apigrate library returns { itemId: number }
      const companyId = result?.itemId;
      this.logger.info(`Company created with ID: ${companyId}`);
      return companyId;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Companies', 'create', executionTime, { error: true });
      this.logger.error('Failed to create company:', error);
      throw error;
    }
  }

  async updateCompany(id: number, updates: Partial<AutotaskCompany>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<void> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating company ${id}:`, updates);
      await client.Companies.update({ id, ...updates } as any);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Companies', 'update', executionTime, { id });
      this.logger.info(`Company ${id} updated successfully`);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Companies', 'update', executionTime, { id, error: true });
      this.logger.error(`Failed to update company ${id}:`, error);
      throw error;
    }
  }

  // Contact operations
  async getContact(id: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskContact | null> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting contact with ID: ${id}`);
      const result = await client.Contacts.get(id);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contacts', 'get', executionTime, { id });
      // @apigrate library returns { item: contactData } or null
      return result?.item as AutotaskContact || null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contacts', 'get', executionTime, { id, error: true });
      this.logger.error(`Failed to get contact ${id}:`, error);
      throw error;
    }
  }

  /**
   * JSON body for POST /Contacts/query.
   */
  buildContactsQueryPayload(options: AutotaskQueryOptions = {}): Record<string, unknown> {
    let filter: unknown[];
    if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0)) {
      filter = [{ op: 'gte', field: 'id', value: 0 }];
    } else if (Array.isArray(options.filter)) {
      filter = options.filter;
    } else {
      filter = [{ op: 'gte', field: 'id', value: 0 }];
    }
    const pageSize = Math.min(options.pageSize ?? DEFAULT_ENTITY_PAGE_SIZE, 500);
    const body: Record<string, unknown> = {
      filter,
      pageSize,
      MaxRecords: pageSize
    };
    if (options.sort) {
      body.sort = options.sort;
    }
    return body;
  }

  async searchContacts(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskContact[]> {
    const startTime = Date.now();

    try {
      this.logger.info('Searching contacts with options:', options);

      const searchBody = this.buildContactsQueryPayload(options);
      const result = await this.paginatedQuery.fetchAll<AutotaskContact>(
        'Contacts',
        searchBody,
        tenantContext,
        tracker,
        options.maxItems,
        { enrichment: 'contacts', responseKey: 'contacts' }
      );

      const executionTime = Date.now() - startTime;
      this.logger.info(`Retrieved ${result.items.length} contacts (paginated)`, {
        executionTimeMs: executionTime,
        status: result.status,
        pagesFetched: result.pagesFetched
      });
      return result.items;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contacts', 'query', executionTime, { error: true });
      this.logger.error('Failed to search contacts:', error);
      throw error;
    }
  }

  /**
   * Count contacts matching filter criteria.
   * Used for pagination to determine total number of pages.
   */
  async countContacts(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Counting contacts with options:', options);

      const filter = this.buildContactsQueryPayload(options).filter as unknown[];

      const response = await client.Contacts.count({ filter });
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contacts', 'count', executionTime, { filterCount: filter.length });
      
      const count = response.queryCount ?? 0;
      this.logger.info(`Contacts count: ${count}`);
      return count;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contacts', 'count', executionTime, { error: true });
      this.logger.error('Failed to count contacts:', error);
      throw error;
    }
  }

  async createContact(contact: Partial<AutotaskContact>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating contact:', contact);
      const result = await client.contacts.create(contact as any);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contacts', 'create', executionTime);
      const contactId = (result.data as any)?.id;
      this.logger.info(`Contact created with ID: ${contactId}`);
      return contactId;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contacts', 'create', executionTime, { error: true });
      this.logger.error('Failed to create contact:', error);
      throw error;
    }
  }

  async updateContact(id: number, updates: Partial<AutotaskContact>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<void> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating contact ${id}:`, updates);
      await client.contacts.update(id, updates as any);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contacts', 'update', executionTime, { id });
      this.logger.info(`Contact ${id} updated successfully`);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contacts', 'update', executionTime, { id, error: true });
      this.logger.error(`Failed to update contact ${id}:`, error);
      throw error;
    }
  }

  // Ticket operations
  async getTicket(id: number, fullDetails: boolean = false, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskTicket | null> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting ticket with ID: ${id}, fullDetails: ${fullDetails}`);
      
      const result = await client.Tickets.get(id);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tickets', 'get', executionTime, { id });
      // @apigrate library returns { item: ticketData } or null
      const ticket = result?.item as AutotaskTicket;
      
      if (!ticket) {
        return null;
      }
      
      // Apply optimization unless full details requested
      return fullDetails ? ticket : this.optimizeTicketData(ticket);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tickets', 'get', executionTime, { id, error: true });
      this.logger.error(`Failed to get ticket ${id}:`, error);
      throw error;
    }
  }

  async getTicketByNumber(ticketNumber: string, fullDetails: boolean = false, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskTicket | null> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting ticket with number: ${ticketNumber}, fullDetails: ${fullDetails}`);
      
      // Search for ticket by exact ticket number match
      const searchBody = {
        filter: [
          {
            op: 'eq',
            field: 'ticketNumber',
            value: ticketNumber
          }
        ],
        pageSize: 1 // We only expect one result
      };

      this.logger.info('Querying Tickets via native library method:', searchBody);
      
      const response = await client.Tickets.query(searchBody);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tickets', 'query', executionTime, { ticketNumber });
      
      const tickets = (response.items || []) as AutotaskTicket[];
      
      if (tickets.length === 0) {
        this.logger.info(`Ticket with number ${ticketNumber} not found`);
        return null;
      }
      
      const ticket = tickets[0];
      this.logger.info(`Found ticket with number ${ticketNumber}, ID: ${ticket.id}`);
      
      // Apply optimization unless full details requested
      return fullDetails ? ticket : this.optimizeTicketData(ticket);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tickets', 'query', executionTime, { ticketNumber, error: true });
      this.logger.error(`Failed to get ticket by number ${ticketNumber}:`, error);
      throw error;
    }
  }



  /**
   * JSON body for POST /Tickets/query (shared by searchTickets, countTickets, MCP handler).
   */
  buildTicketsQueryPayload(options: AutotaskQueryOptionsExtended = {}): Record<string, unknown> {
    const filters: unknown[] = [];

    if (options.searchTerm) {
      const searchTerm = options.searchTerm;
      const looksLikeTicketNumber = /^T\d+\.\d+$/.test(searchTerm);
      if (looksLikeTicketNumber) {
        filters.push({ op: 'eq', field: 'ticketNumber', value: searchTerm });
      } else {
        filters.push({ op: 'contains', field: 'title', value: searchTerm });
      }
    }

    if (options.status !== undefined) {
      filters.push({ op: 'eq', field: 'status', value: options.status });
    } else {
      filters.push({ op: 'ne', field: 'status', value: 5 });
    }

    if (options.unassigned === true) {
      filters.push({ op: 'eq', field: 'assignedResourceID', value: null });
    } else if (options.assignedResourceID !== undefined) {
      filters.push({ op: 'eq', field: 'assignedResourceID', value: options.assignedResourceID });
    }

    if (options.priority !== undefined) {
      filters.push({ op: 'eq', field: 'priority', value: options.priority });
    }

    if (options.companyId !== undefined) {
      filters.push({ op: 'eq', field: 'companyID', value: options.companyId });
    }

    if (options.projectId !== undefined) {
      filters.push({ op: 'eq', field: 'projectID', value: options.projectId });
    }

    if (options.contractId !== undefined) {
      filters.push({ op: 'eq', field: 'contractID', value: options.contractId });
    }

    if (options.createdDateFrom) {
      filters.push({ op: 'gte', field: 'createDate', value: options.createdDateFrom });
    }
    if (options.createdDateTo) {
      filters.push({ op: 'lte', field: 'createDate', value: options.createdDateTo });
    }
    if (options.completedDateFrom) {
      filters.push({ op: 'gte', field: 'completedDate', value: options.completedDateFrom });
    }
    if (options.completedDateTo) {
      filters.push({ op: 'lte', field: 'completedDate', value: options.completedDateTo });
    }
    if (options.lastActivityDateFrom) {
      filters.push({ op: 'gte', field: 'lastActivityDate', value: options.lastActivityDateFrom });
    }
    if (options.lastActivityDateTo) {
      filters.push({ op: 'lte', field: 'lastActivityDate', value: options.lastActivityDateTo });
    }

    if (Array.isArray(options.filter)) {
      for (const clause of options.filter) {
        filters.push(clause);
      }
    }

    const requestedPageSize = Math.min(options.pageSize ?? DEFAULT_ENTITY_PAGE_SIZE, 500);
    return {
      filter: filters,
      pageSize: requestedPageSize,
      MaxRecords: requestedPageSize
    };
  }

  async searchTickets(options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskTicket[]> {
    const startTime = Date.now();

    try {
      this.logger.info('🎫 Searching tickets', {
        tenantId: tenantContext?.tenantId,
        impersonationResourceId: tenantContext?.impersonationResourceId,
        hasSearchTerm: !!options.searchTerm,
        hasStatusFilter: options.status !== undefined,
        pageSize: options.pageSize,
        operation: 'searchTickets'
      });

      const queryBody = this.buildTicketsQueryPayload(options);
      const result = await this.paginatedQuery.fetchAll<AutotaskTicket>(
        'Tickets',
        queryBody,
        tenantContext,
        tracker,
        options.maxItems,
        { enrichment: 'tickets', responseKey: 'tickets' }
      );

      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tickets', 'query', executionTime, {
        filterCount: (queryBody.filter as unknown[]).length,
        resultCount: result.items.length,
        paginated: true
      });

      this.logger.info('📊 API Result for searchTickets (paginated)', {
        tenantId: tenantContext?.tenantId,
        resultCount: result.items.length,
        status: result.status,
        pagesFetched: result.pagesFetched,
        executionTimeMs: executionTime
      });

      return result.items.map((ticket) => this.optimizeTicketDataAggressive(ticket));
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tickets', 'query', executionTime, { error: true });
      this.logger.error('Failed to search tickets:', error);
      throw error;
    }
  }

  /**
   * Count tickets matching filter criteria.
   * Used for pagination to determine total number of pages.
   */
  async countTickets(options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Counting tickets with options:', options);

      const filter = this.buildTicketsQueryPayload(options).filter as unknown[];

      const startTime = Date.now();
      const response = await client.Tickets.count({ filter });
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tickets', 'count', executionTime, { filterCount: filter.length });
      
      const count = response.queryCount ?? 0;
      this.logger.info(`Tickets count: ${count}`);
      return count;
    } catch (error) {
      this.logger.error('Failed to count tickets:', error);
      throw error;
    }
  }

  /**
   * Aggressively optimize ticket data by keeping only essential fields
   * Since the API returns all 76 fields (~2KB per ticket), we need to be very selective
   */
  private optimizeTicketDataAggressive(ticket: AutotaskTicket): AutotaskTicket {
    // Keep only the most essential fields to minimize response size
    const optimized: AutotaskTicket = {};
    
    if (ticket.id !== undefined) optimized.id = ticket.id;
    if (ticket.ticketNumber !== undefined) optimized.ticketNumber = ticket.ticketNumber;
    if (ticket.title !== undefined) optimized.title = ticket.title;
    
    // Handle description with truncation
    if (ticket.description !== undefined && ticket.description !== null) {
      optimized.description = ticket.description.length > 200
        ? ticket.description.substring(0, 200) + '... [truncated - use get_ticket_details for full text]'
        : ticket.description;
    }
    
    if (ticket.status !== undefined) optimized.status = ticket.status;
    if (ticket.priority !== undefined) optimized.priority = ticket.priority;
    if (ticket.companyID !== undefined) optimized.companyID = ticket.companyID;
    if (ticket.contactID !== undefined) optimized.contactID = ticket.contactID;
    if (ticket.assignedResourceID !== undefined) optimized.assignedResourceID = ticket.assignedResourceID;
    if (ticket.createDate !== undefined) optimized.createDate = ticket.createDate;
    if (ticket.lastActivityDate !== undefined) optimized.lastActivityDate = ticket.lastActivityDate;
    if (ticket.dueDateTime !== undefined) optimized.dueDateTime = ticket.dueDateTime;
    if (ticket.completedDate !== undefined) optimized.completedDate = ticket.completedDate;
    if (ticket.estimatedHours !== undefined) optimized.estimatedHours = ticket.estimatedHours;
    if (ticket.ticketType !== undefined) optimized.ticketType = ticket.ticketType;
    if (ticket.source !== undefined) optimized.source = ticket.source;
    if (ticket.issueType !== undefined) optimized.issueType = ticket.issueType;
    if (ticket.subIssueType !== undefined) optimized.subIssueType = ticket.subIssueType;
    
    // Handle resolution with truncation
    if (ticket.resolution !== undefined && ticket.resolution !== null) {
      optimized.resolution = ticket.resolution.length > 100
        ? ticket.resolution.substring(0, 100) + '... [truncated - use get_ticket_details for full text]'
        : ticket.resolution;
    }
    
    return optimized;
  }

  /**
   * Optimize ticket data by truncating large text fields and removing unnecessary data
   * This is the less aggressive version used by getTicket
   */
  private optimizeTicketData(ticket: AutotaskTicket): AutotaskTicket {
    const maxDescriptionLength = 500;
    const maxNotesLength = 300;

    return {
      ...ticket,
      // Truncate description if too long
      description: ticket.description && ticket.description.length > maxDescriptionLength
        ? ticket.description.substring(0, maxDescriptionLength) + '... [truncated]'
        : ticket.description,
      
      // Remove or truncate potentially large fields
      resolution: ticket.resolution && ticket.resolution.length > maxNotesLength
        ? ticket.resolution.substring(0, maxNotesLength) + '... [truncated]'
        : ticket.resolution,
        
      // Remove arrays that might contain large amounts of data
      userDefinedFields: [],
      
      // Keep only essential custom fields, truncate if present
      ...(ticket.purchaseOrderNumber && { 
        purchaseOrderNumber: ticket.purchaseOrderNumber.length > 50 
          ? ticket.purchaseOrderNumber.substring(0, 50) + '...' 
          : ticket.purchaseOrderNumber 
      })
    };
  }

  async createTicket(ticket: Partial<AutotaskTicket>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating ticket:', ticket);
      const result = await client.tickets.create(ticket as any);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tickets', 'create', executionTime);
      const ticketId = (result.data as any)?.id;
      this.logger.info(`Ticket created with ID: ${ticketId}`);
      return ticketId;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tickets', 'create', executionTime, { error: true });
      this.logger.error('Failed to create ticket:', error);
      throw error;
    }
  }

  async updateTicket(id: number, updates: Partial<AutotaskTicket>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<void> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating ticket ${id}:`, updates);
      await client.tickets.update(id, updates as any);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tickets', 'update', executionTime, { id });
      this.logger.info(`Ticket ${id} updated successfully`);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tickets', 'update', executionTime, { id, error: true });
      this.logger.error(`Failed to update ticket ${id}:`, error);
      throw error;
    }
  }

  // Time entry operations
  async createTimeEntry(timeEntry: Partial<AutotaskTimeEntry>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating time entry:', timeEntry);
      const result = await client.TimeEntries.create(timeEntry as any);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('TimeEntries', 'create', executionTime);
      // @apigrate library returns { itemId: id }
      const timeEntryId = result?.itemId;
      this.logger.info(`Time entry created with ID: ${timeEntryId}`);
      return timeEntryId;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('TimeEntries', 'create', executionTime, { error: true });
      this.logger.error('Failed to create time entry:', error);
      throw error;
    }
  }

  /**
   * JSON body for POST /TimeEntries/query (shared by getTimeEntries, countTimeEntries).
   */
  buildTimeEntriesQueryPayload(options: AutotaskQueryOptions = {}): Record<string, unknown> {
    let filter: unknown[];
    if (
      !options.filter ||
      (Array.isArray(options.filter) && options.filter.length === 0) ||
      (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)
    ) {
      filter = [{ op: 'gte', field: 'id', value: 0 }];
    } else if (!Array.isArray(options.filter)) {
      filter = [];
      for (const [field, value] of Object.entries(options.filter)) {
        filter.push({ op: 'eq', field, value });
      }
    } else {
      filter = options.filter as unknown[];
    }

    const pageSize = Math.min(options.pageSize ?? DEFAULT_ENTITY_PAGE_SIZE, 500);
    const body: Record<string, unknown> = {
      filter,
      pageSize,
      MaxRecords: pageSize
    };
    if (options.sort) {
      body.sort = options.sort;
    }
    return body;
  }

  async getTimeEntries(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskTimeEntry[]> {
    const startTime = Date.now();

    try {
      this.logger.info('Getting time entries with options:', options);

      const searchBody = this.buildTimeEntriesQueryPayload(options);
      const result = await this.paginatedQuery.fetchAll<AutotaskTimeEntry>(
        'TimeEntries',
        searchBody,
        tenantContext,
        tracker,
        options.maxItems,
        { enrichment: 'timeentries', responseKey: 'timeEntries' }
      );

      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('TimeEntries', 'query', executionTime, {
        resultCount: result.items.length,
        paginated: true,
        status: result.status
      });

      this.logger.info(`Retrieved ${result.items.length} time entries (paginated)`);
      return result.items;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('TimeEntries', 'query', executionTime, { error: true });
      this.logger.error('Failed to get time entries:', error);
      throw error;
    }
  }

  /**
   * Count time entries matching filter criteria.
   * Used for pagination to determine total number of pages.
   */
  async countTimeEntries(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Counting time entries with options:', options);

      const filter = this.buildTimeEntriesQueryPayload(options).filter as unknown[];

      const response = await client.TimeEntries.count({ filter });
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('TimeEntries', 'count', executionTime);

      const count = response.queryCount ?? 0;
      this.logger.info(`Time entries count: ${count}`);
      return count;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('TimeEntries', 'count', executionTime, { error: true });
      this.logger.error('Failed to count time entries:', error);
      throw error;
    }
  }

  async getTimeEntry(id: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskTimeEntry | null> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting time entry with ID: ${id}`);
      
      const searchBody = {
        filter: [
          { field: 'id', op: 'eq', value: id }
        ]
      };

      this.logger.info('Making direct API call to TimeEntries/query for single time entry:', searchBody);

      // Use native library method
      const response = await client.TimeEntries.query(searchBody);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('TimeEntries', 'query', executionTime, { id });
      
      // Extract time entry from response
      // @apigrate library returns items directly (not in response.data)
      const timeEntry: AutotaskTimeEntry | null = response.items?.[0] ?? null;
      
      if (timeEntry) {
        this.logger.info(`Retrieved time entry ${id}`);
        return timeEntry;
      }
      
      this.logger.info(`Time entry ${id} not found`);
      return null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('TimeEntries', 'query', executionTime, { id, error: true });
      this.logger.error(`Failed to get time entry ${id}:`, error);
      throw error;
    }
  }

  // Project operations
  async getProject(id: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskProject | null> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting project with ID: ${id}`);
      const result = await client.Projects.get(id);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Projects', 'get', executionTime, { id });
      
      // @apigrate library returns { item: projectData } or null
      const projectData = result?.item;
      return projectData as unknown as AutotaskProject || null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Projects', 'get', executionTime, { id, error: true });
      this.logger.error(`Failed to get project ${id}:`, error);
      throw error;
    }
  }

  /**
   * JSON body for POST /Projects/query (shared by searchProjects, countProjects).
   */
  buildProjectsQueryPayload(options: AutotaskQueryOptions = {}): Record<string, unknown> {
    let filter: unknown[];
    if (
      !options.filter ||
      (Array.isArray(options.filter) && options.filter.length === 0) ||
      (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)
    ) {
      filter = [{ op: 'gte', field: 'id', value: 0 }];
    } else if (!Array.isArray(options.filter)) {
      filter = [];
      for (const [field, value] of Object.entries(options.filter)) {
        filter.push({ op: 'eq', field, value });
      }
    } else {
      filter = options.filter as unknown[];
    }

    const raw = options.pageSize ?? DEFAULT_ENTITY_PAGE_SIZE;
    const pageSize = Math.max(1, Math.min(raw > 0 ? raw : DEFAULT_ENTITY_PAGE_SIZE, 500));
    const body: Record<string, unknown> = {
      filter,
      pageSize,
      MaxRecords: pageSize
    };
    if (options.sort) {
      body.sort = options.sort;
    }
    return body;
  }

  async searchProjects(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskProject[]> {
    const startTime = Date.now();

    try {
      this.logger.info('Searching projects with options:', options);

      if (options.page && options.page > 1) {
        this.logger.warn(
          `⚠️ searchProjects: page=${options.page} is ignored by Autotask REST; use MCP continue_query with a cursor instead.`
        );
      }

      const searchBody = this.buildProjectsQueryPayload(options);
      const result = await this.paginatedQuery.fetchAll<AutotaskProject>(
        'Projects',
        searchBody,
        tenantContext,
        tracker,
        options.maxItems,
        { enrichment: 'projects', responseKey: 'projects' }
      );

      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Projects', 'query', executionTime, {
        resultCount: result.items.length,
        paginated: true,
        status: result.status,
        pagesFetched: result.pagesFetched
      });

      this.logger.info(`Retrieved ${result.items.length} projects (paginated)`, {
        status: result.status,
        pagesFetched: result.pagesFetched,
        executionTimeMs: executionTime
      });

      return result.items.map((project) => this.optimizeProjectData(project));
    } catch (error: unknown) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Projects', 'query', executionTime, { error: true });
      const err = error as { response?: { status?: number } };
      if (err.response && err.response.status === 405) {
        this.logger.warn(
          'Projects endpoint may not support listing via API (405 Method Not Allowed). This is common with some Autotask configurations.'
        );
        return [];
      }
      this.logger.error('Failed to search projects:', error);
      throw error;
    }
  }

  /**
   * Optimize project data by truncating large text fields
   */
  private optimizeProjectData(project: AutotaskProject): AutotaskProject {
    const maxDescriptionLength = 500;

    const optimizedDescription = project.description 
      ? (project.description.length > maxDescriptionLength
          ? project.description.substring(0, maxDescriptionLength) + '... [truncated]'
          : project.description)
      : '';

    return {
      ...project,
      description: optimizedDescription,
      // Remove potentially large arrays
      userDefinedFields: []
    };
  }

  /**
   * Count projects matching filter criteria.
   * Used for pagination to determine total number of pages.
   */
  async countProjects(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Counting projects with options:', options);

      const filter = this.buildProjectsQueryPayload(options).filter as unknown[];

      const response = await client.Projects.count({ filter });
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Projects', 'count', executionTime);
      
      const count = response.queryCount ?? 0;
      this.logger.info(`Projects count: ${count}`);
      return count;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Projects', 'count', executionTime, { error: true });
      this.logger.error('Failed to count projects:', error);
      throw error;
    }
  }

  async createProject(project: Partial<AutotaskProject>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating project:', project);
      const result = await client.projects.create(project as any);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Projects', 'create', executionTime);
      const projectId = (result.data as any)?.id;
      this.logger.info(`Project created with ID: ${projectId}`);
      return projectId;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Projects', 'create', executionTime, { error: true });
      this.logger.error('Failed to create project:', error);
      throw error;
    }
  }

  async updateProject(id: number, updates: Partial<AutotaskProject>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<void> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating project ${id}:`, updates);
      await client.projects.update(id, updates as any);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Projects', 'update', executionTime, { id });
      this.logger.info(`Project ${id} updated successfully`);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Projects', 'update', executionTime, { id, error: true });
      this.logger.error(`Failed to update project ${id}:`, error);
      throw error;
    }
  }

  // Resource operations
  async getResource(id: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskResource | null> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting resource with ID: ${id}`);
      const result = await client.Resources.get(id);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Resources', 'get', executionTime, { id });
      
      // @apigrate library returns { item: resourceData } or null
      return result?.item as AutotaskResource || null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Resources', 'get', executionTime, { id, error: true });
      this.logger.error(`Failed to get resource ${id}:`, error);
      throw error;
    }
  }

  /**
   * JSON body for POST /Resources/query (shared by searchResources, countResources).
   */
  buildResourcesQueryPayload(options: AutotaskQueryOptions = {}): Record<string, unknown> {
    let filter: unknown[];
    if (
      !options.filter ||
      (Array.isArray(options.filter) && options.filter.length === 0) ||
      (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)
    ) {
      filter = [{ op: 'gte', field: 'id', value: 0 }];
    } else if (!Array.isArray(options.filter)) {
      filter = [];
      for (const [field, value] of Object.entries(options.filter)) {
        filter.push({ op: 'eq', field, value });
      }
    } else {
      filter = options.filter as unknown[];
    }

    const raw = options.pageSize ?? DEFAULT_ENTITY_PAGE_SIZE;
    const pageSize = Math.max(1, Math.min(raw > 0 ? raw : DEFAULT_ENTITY_PAGE_SIZE, 500));
    const body: Record<string, unknown> = {
      filter,
      pageSize,
      MaxRecords: pageSize
    };
    if (options.sort) {
      body.sort = options.sort;
    }
    return body;
  }

  async searchResources(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskResource[]> {
    const startTime = Date.now();

    try {
      this.logger.info('Searching resources with options:', options);

      if (options.page && options.page > 1) {
        this.logger.warn(
          `⚠️ searchResources: page=${options.page} is ignored by Autotask REST; use MCP continue_query with a cursor instead.`
        );
      }

      const searchBody = this.buildResourcesQueryPayload(options);
      const result = await this.paginatedQuery.fetchAll<AutotaskResource>(
        'Resources',
        searchBody,
        tenantContext,
        tracker,
        options.maxItems,
        { enrichment: 'resources', responseKey: 'resources' }
      );

      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Resources', 'query', executionTime, {
        resultCount: result.items.length,
        paginated: true,
        status: result.status,
        pagesFetched: result.pagesFetched
      });

      this.logger.info(`Retrieved ${result.items.length} resources (paginated)`, {
        status: result.status,
        pagesFetched: result.pagesFetched,
        executionTimeMs: executionTime
      });
      return result.items;
    } catch (error: unknown) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Resources', 'query', executionTime, { error: true });
      const err = error as { response?: { status?: number } };
      if (err.response && err.response.status === 405) {
        this.logger.warn(
          'Resources endpoint may not support listing via API (405 Method Not Allowed). This is common with some Autotask configurations.'
        );
        return [];
      }
      this.logger.error('Failed to search resources:', error);
      throw error;
    }
  }

  /**
   * Count resources matching filter criteria.
   * Used for pagination to determine total number of pages.
   */
  async countResources(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Counting resources with options:', options);

      const filter = this.buildResourcesQueryPayload(options).filter as unknown[];

      const response = await client.Resources.count({ filter });
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Resources', 'count', executionTime);
      
      const count = response.queryCount ?? 0;
      this.logger.info(`Resources count: ${count}`);
      return count;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Resources', 'count', executionTime, { error: true });
      this.logger.error('Failed to count resources:', error);
      throw error;
    }
  }

  // Opportunity operations (available via @apigrate/autotask-restapi)
  // async getOpportunity(id: number): Promise<AutotaskOpportunity | null> {
  //   const client = await this.ensureClient();
  //   
  //   try {
  //     this.logger.info(`Getting opportunity with ID: ${id}`);
  //     const result = await client.opportunities.get(id);
  //     return result.data as AutotaskOpportunity || null;
  //   } catch (error) {
  //     this.logger.error(`Failed to get opportunity ${id}:`, error);
  //     throw error;
  //   }
  // }

  // async searchOpportunities(options: AutotaskQueryOptions = {}): Promise<AutotaskOpportunity[]> {
  //   const client = await this.ensureClient();
  //   
  //   try {
  //     this.logger.info('Searching opportunities with options:', options);
  //     const result = await client.opportunities.list(options as any);
  //     return (result.data as AutotaskOpportunity[]) || [];
  //   } catch (error) {
  //     this.logger.error('Failed to search opportunities:', error);
  //     throw error;
  //   }
  // }

  // async createOpportunity(opportunity: Partial<AutotaskOpportunity>): Promise<number> {
  //   const client = await this.ensureClient();
  //   
  //   try {
  //     this.logger.info('Creating opportunity:', opportunity);
  //     const result = await client.opportunities.create(opportunity as any);
  //     const opportunityId = (result.data as any)?.id;
  //     this.logger.info(`Opportunity created with ID: ${opportunityId}`);
  //     return opportunityId;
  //   } catch (error) {
  //     this.logger.error('Failed to create opportunity:', error);
  //     throw error;
  //   }
  // }

  // async updateOpportunity(id: number, updates: Partial<AutotaskOpportunity>): Promise<void> {
  //   const client = await this.ensureClient();
  //   
  //   try {
  //     this.logger.info(`Updating opportunity ${id}:`, updates);
  //     await client.opportunities.update(id, updates as any);
  //     this.logger.info(`Opportunity ${id} updated successfully`);
  //   } catch (error) {
  //     this.logger.error(`Failed to update opportunity ${id}:`, error);
  //     throw error;
  //   }
  // }

  // Configuration Item operations
  async getConfigurationItem(id: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskConfigurationItem | null> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting configuration item with ID: ${id}`);
      const result = await client.ConfigurationItems.get(id);
      
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('ConfigurationItems', 'get', executionTime, { id });
      
      // @apigrate library returns { item: configItemData } or null
      return result?.item as AutotaskConfigurationItem || null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('ConfigurationItems', 'get', executionTime, { id, error: true });
      this.logger.error(`Failed to get configuration item ${id}:`, error);
      throw error;
    }
  }

  async searchConfigurationItems(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskConfigurationItem[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching configuration items with options:', options);
      const searchBody: any = {
        filter: options.filter || [{ op: 'gte', field: 'id', value: 0 }]
      };
      if (options.pageSize) searchBody.pageSize = options.pageSize;
      const result = await client.ConfigurationItems.query(searchBody);
      return result.items || [];
    } catch (error) {
      this.logger.error('Failed to search configuration items:', error);
      throw error;
    }
  }

  async createConfigurationItem(configItem: Partial<AutotaskConfigurationItem>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating configuration item:', configItem);
      const result = await client.ConfigurationItems.create(configItem as any);
      // @apigrate library returns { itemId: id }
      const configItemId = result?.itemId;
      this.logger.info(`Configuration item created with ID: ${configItemId}`);
      return configItemId;
    } catch (error) {
      this.logger.error('Failed to create configuration item:', error);
      throw error;
    }
  }

  async updateConfigurationItem(id: number, updates: Partial<AutotaskConfigurationItem>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating configuration item ${id}:`, updates);
      // Add id to updates object for patch operation
      const updateData = { ...updates, id };
      await client.ConfigurationItems.update(updateData as any);
      this.logger.info(`Configuration item ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update configuration item ${id}:`, error);
      throw error;
    }
  }

  // Product operations (available via @apigrate/autotask-restapi)
  // async getProduct(id: number): Promise<AutotaskProduct | null> {
  //   const client = await this.ensureClient();
  //   
  //   try {
  //     this.logger.info(`Getting product with ID: ${id}`);
  //     const result = await client.products.get(id);
  //     return result.data as AutotaskProduct || null;
  //   } catch (error) {
  //     this.logger.error(`Failed to get product ${id}:`, error);
  //     throw error;
  //   }
  // }

  // async searchProducts(options: AutotaskQueryOptions = {}): Promise<AutotaskProduct[]> {
  //   const client = await this.ensureClient();
  //   
  //   try {
  //     this.logger.info('Searching products with options:', options);
  //     const result = await client.products.list(options as any);
  //     return (result.data as AutotaskProduct[]) || [];
  //   } catch (error) {
  //     this.logger.error('Failed to search products:', error);
  //     throw error;
  //   }
  // }

  // Contract operations (read-only for now as they're complex)
  async getContract(id: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskContract | null> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting contract with ID: ${id}`);
      const result = await client.Contracts.get(id);
      
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contracts', 'get', executionTime, { id });
      
      // @apigrate library returns { item: contractData } or null
      return result?.item as AutotaskContract || null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contracts', 'get', executionTime, { id, error: true });
      this.logger.error(`Failed to get contract ${id}:`, error);
      throw error;
    }
  }

  /**
   * JSON body for POST /Contracts/query (shared by searchContracts).
   */
  buildContractsQueryPayload(options: AutotaskQueryOptions = {}): Record<string, unknown> {
    let filter: unknown[];
    if (
      !options.filter ||
      (Array.isArray(options.filter) && options.filter.length === 0) ||
      (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)
    ) {
      filter = [{ op: 'gte', field: 'id', value: 0 }];
    } else if (!Array.isArray(options.filter)) {
      filter = [];
      for (const [field, value] of Object.entries(options.filter)) {
        filter.push({ op: 'eq', field, value });
      }
    } else {
      filter = options.filter as unknown[];
    }

    const raw = options.pageSize ?? DEFAULT_ENTITY_PAGE_SIZE;
    const pageSize = Math.max(1, Math.min(raw > 0 ? raw : DEFAULT_ENTITY_PAGE_SIZE, 500));
    const body: Record<string, unknown> = {
      filter,
      pageSize,
      MaxRecords: pageSize
    };
    if (options.sort) {
      body.sort = options.sort;
    }
    return body;
  }

  async searchContracts(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskContract[]> {
    const startTime = Date.now();

    try {
      this.logger.info('Searching contracts with options:', options);

      if (options.page && options.page > 1) {
        this.logger.warn(
          `⚠️ searchContracts: page=${options.page} is ignored by Autotask REST; use MCP continue_query with a cursor instead.`
        );
      }

      const searchBody = this.buildContractsQueryPayload(options);
      const result = await this.paginatedQuery.fetchAll<AutotaskContract>(
        'Contracts',
        searchBody,
        tenantContext,
        tracker,
        options.maxItems,
        { enrichment: 'contracts', responseKey: 'contracts' }
      );

      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contracts', 'query', executionTime, {
        resultCount: result.items.length,
        paginated: true,
        status: result.status,
        pagesFetched: result.pagesFetched
      });

      this.logger.info(`Retrieved ${result.items.length} contracts (paginated)`, {
        status: result.status,
        pagesFetched: result.pagesFetched
      });

      return result.items;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Contracts', 'query', executionTime, { error: true });
      this.logger.error('Failed to search contracts:', error);
      throw error;
    }
  }

  // Invoice operations (read-only)
  async getInvoice(id: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskInvoice | null> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting invoice with ID: ${id}`);
      const result = await client.Invoices.get(id);
      
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Invoices', 'get', executionTime, { id });
      
      // @apigrate library returns { item: invoiceData } or null
      return result?.item as AutotaskInvoice || null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Invoices', 'get', executionTime, { id, error: true });
      this.logger.error(`Failed to get invoice ${id}:`, error);
      throw error;
    }
  }

  /**
   * JSON body for POST /Invoices/query (shared by searchInvoices).
   */
  buildInvoicesQueryPayload(options: AutotaskQueryOptions = {}): Record<string, unknown> {
    let filter: unknown[];
    if (
      !options.filter ||
      (Array.isArray(options.filter) && options.filter.length === 0) ||
      (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)
    ) {
      filter = [{ op: 'gte', field: 'id', value: 0 }];
    } else if (!Array.isArray(options.filter)) {
      filter = [];
      for (const [field, value] of Object.entries(options.filter)) {
        filter.push({ op: 'eq', field, value });
      }
    } else {
      filter = options.filter as unknown[];
    }

    const raw = options.pageSize ?? DEFAULT_ENTITY_PAGE_SIZE;
    const pageSize = Math.max(1, Math.min(raw > 0 ? raw : DEFAULT_ENTITY_PAGE_SIZE, 500));
    const body: Record<string, unknown> = {
      filter,
      pageSize,
      MaxRecords: pageSize
    };
    if (options.sort) {
      body.sort = options.sort;
    }
    return body;
  }

  async searchInvoices(
    options: AutotaskQueryOptions = {},
    tenantContext?: TenantContext,
    tracker?: ApiCallTracker
  ): Promise<AutotaskInvoice[]> {
    const startTime = Date.now();

    try {
      this.logger.info('Searching invoices with options:', options);

      if (options.page && options.page > 1) {
        this.logger.warn(
          `⚠️ searchInvoices: page=${options.page} is ignored by Autotask REST; use MCP continue_query with a cursor instead.`
        );
      }

      const searchBody = this.buildInvoicesQueryPayload(options);
      const result = await this.paginatedQuery.fetchAll<AutotaskInvoice>(
        'Invoices',
        searchBody,
        tenantContext,
        tracker,
        options.maxItems,
        { enrichment: 'invoices', responseKey: 'invoices' }
      );

      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Invoices', 'query', executionTime, {
        resultCount: result.items.length,
        paginated: true,
        status: result.status,
        pagesFetched: result.pagesFetched
      });

      this.logger.info(`Retrieved ${result.items.length} invoices (paginated)`, {
        status: result.status,
        pagesFetched: result.pagesFetched
      });

      return result.items;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Invoices', 'query', executionTime, { error: true });
      this.logger.error('Failed to search invoices:', error);
      throw error;
    }
  }

  // Task operations
  async getTask(id: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskTask | null> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting task with ID: ${id}`);
      
      const searchBody = {
        filter: [
          { field: 'id', op: 'eq', value: id }
        ]
      };

      this.logger.info('Making direct API call to Tasks/query for single task:', searchBody);

      // Use native library method
      const response = await client.Tasks.query(searchBody);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tasks', 'query', executionTime, { id });
      
      // Extract task from response
      // @apigrate library returns items directly (not in response.data)
      const task: AutotaskTask | null = response.items?.[0] ?? null;
      
      if (task) {
        this.logger.info(`Retrieved task ${id}`);
        return task;
      }
      
      this.logger.info(`Task ${id} not found`);
      return null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tasks', 'query', executionTime, { id, error: true });
      this.logger.error(`Failed to get task ${id}:`, error);
      throw error;
    }
  }

  /**
   * JSON body for POST /Tasks/query (shared by searchTasks).
   */
  buildTasksQueryPayload(options: AutotaskQueryOptions = {}): Record<string, unknown> {
    let filter: unknown[];
    if (
      !options.filter ||
      (Array.isArray(options.filter) && options.filter.length === 0) ||
      (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)
    ) {
      filter = [{ op: 'gte', field: 'id', value: 0 }];
    } else if (!Array.isArray(options.filter)) {
      filter = [];
      for (const [field, value] of Object.entries(options.filter)) {
        filter.push({ op: 'eq', field, value });
      }
    } else {
      filter = options.filter as unknown[];
    }

    const raw = options.pageSize ?? DEFAULT_ENTITY_PAGE_SIZE;
    const pageSize = Math.max(1, Math.min(raw > 0 ? raw : DEFAULT_ENTITY_PAGE_SIZE, 500));
    const body: Record<string, unknown> = {
      filter,
      pageSize,
      MaxRecords: pageSize
    };
    if (options.sort) {
      body.sort = options.sort;
    }
    return body;
  }

  async searchTasks(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskTask[]> {
    const startTime = Date.now();

    try {
      this.logger.info('Searching tasks with options:', options);

      if (options.page && options.page > 1) {
        this.logger.warn(
          `⚠️ searchTasks: page=${options.page} is ignored by Autotask REST; use MCP continue_query with a cursor instead.`
        );
      }

      const searchBody = this.buildTasksQueryPayload(options);
      const result = await this.paginatedQuery.fetchAll<AutotaskTask>(
        'Tasks',
        searchBody,
        tenantContext,
        tracker,
        options.maxItems,
        { enrichment: 'tasks', responseKey: 'tasks' }
      );

      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tasks', 'query', executionTime, {
        resultCount: result.items.length,
        paginated: true,
        status: result.status,
        pagesFetched: result.pagesFetched
      });

      this.logger.info(`Retrieved ${result.items.length} tasks (paginated)`, {
        status: result.status,
        pagesFetched: result.pagesFetched,
        executionTimeMs: executionTime
      });

      return result.items.map((task) => this.optimizeTaskData(task));
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tasks', 'query', executionTime, { error: true });
      this.logger.error('Failed to search tasks:', error);
      throw error;
    }
  }

  /**
   * Optimize task data by truncating large text fields
   */
  private optimizeTaskData(task: AutotaskTask): AutotaskTask {
    const maxDescriptionLength = 400;

    const optimizedDescription = task.description 
      ? (task.description.length > maxDescriptionLength
          ? task.description.substring(0, maxDescriptionLength) + '... [truncated]'
          : task.description)
      : '';

    return {
      ...task,
      description: optimizedDescription,
      // Remove potentially large arrays
      userDefinedFields: []
    };
  }

  async createTask(task: Partial<AutotaskTask>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating task:', task);
      const result = await client.Tasks.create(task as any);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tasks', 'create', executionTime);
      // @apigrate library returns { itemId: id }
      const taskID = result?.itemId;
      this.logger.info(`Task created with ID: ${taskID}`);
      return taskID;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tasks', 'create', executionTime, { error: true });
      this.logger.error('Failed to create task:', error);
      throw error;
    }
  }

  async updateTask(id: number, updates: Partial<AutotaskTask>, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<void> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating task ${id}:`, updates);
      // Add id to updates object for patch operation
      const updateData = { ...updates, id };
      await client.Tasks.update(updateData as any);
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tasks', 'update', executionTime, { id });
      this.logger.info(`Task ${id} updated successfully`);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Tasks', 'update', executionTime, { id, error: true });
      this.logger.error(`Failed to update task ${id}:`, error);
      throw error;
    }
  }

  // Utility methods
  async testConnection(tenantContext?: TenantContext): Promise<boolean> {
    try {
      const client = await this.getClientForTenant(tenantContext);
      
      // Try multiple approaches to test the connection
      // 1. First try: Query companies (safer than getting a specific one)
      try {
        const searchBody = {
          filter: [
            {
              "op": "gte",
              "field": "id",
              "value": 0
            }
          ],
          pageSize: 1  // Only get 1 result to minimize response size
        };
        
        const result = await client.Companies.query(searchBody);
        
        this.logger.info('Connection test successful (Companies/query):', { 
          hasData: !!result.data, 
          statusCode: result.status,
          hasItems: !!(result.data && result.data.items)
        });
        return true;
      } catch (companiesError: any) {
        this.logger.warn('Companies/query test failed, trying alternative...', {
          status: companiesError.response?.status,
          message: companiesError.message
        });
        
        // 2. Second try: Test with zone information (this should always work if credentials are valid)
        try {
          const zoneResult = await (client as any).axios.get('/zoneInformation');
          this.logger.info('Connection test successful (zoneInformation):', { 
            statusCode: zoneResult.status,
            hasData: !!zoneResult.data
          });
          return true;
        } catch (zoneError: any) {
          this.logger.warn('Zone information test also failed', {
            status: zoneError.response?.status,
            message: zoneError.message
          });
          
          // 3. Third try: Check if we can at least make an authenticated request (even if it fails)
          // Some Autotask instances have restrictive permissions
          try {
            await (client as any).axios.get('/Resources/query');
            return true; // If we get here, authentication worked
          } catch (resourceError: any) {
            // If it's a 401/403, authentication failed
            // If it's 405/500, authentication likely worked but endpoint has issues
            if (resourceError.response?.status === 401 || resourceError.response?.status === 403) {
              this.logger.error('Authentication failed (401/403)', resourceError.message);
              return false;
            } else {
              this.logger.info('Connection test passed (authentication working, endpoint restrictions exist):', {
                status: resourceError.response?.status,
                message: 'Authentication successful but endpoint access restricted'
              });
              return true; // Authentication is working, just endpoint restrictions
            }
          }
        }
      }
    } catch (error) {
      this.logger.error('Connection test failed completely:', error);
      return false;
    }
  }

  /**
   * Test zone information discovery for debugging API URL issues
   */
  async testZoneInformation(tenantContext?: TenantContext): Promise<any> {
    try {
      const { username, secret, integrationCode } = tenantContext?.credentials || this.config.autotask || {};
      
      if (!username || !secret || !integrationCode) {
        throw new Error('Missing required credentials for zone information test');
      }

      this.logger.info('Testing zone information discovery...', {
        username: username ? `${username.substring(0, 8)}***` : undefined,
        integrationCode
      });

      // Try to get zone information directly from Autotask
      const zoneUrl = 'https://webservices.autotask.net/ATServicesRest/v1.0/zoneInformation';
      
      // Make direct API call to zone information endpoint
      const response = await fetch(zoneUrl, {
        method: 'GET',
        headers: {
          'ApiIntegrationcode': integrationCode,
          'UserName': username,
          'Secret': secret,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Zone information request failed: ${response.status} ${response.statusText}`);
      }

      const zoneInfo = await response.json() as any;
      
      this.logger.info('Zone information retrieved:', {
        url: zoneInfo.url,
        webUrl: zoneInfo.webUrl,
        zoneInfo
      });

      return zoneInfo;
    } catch (error) {
      this.logger.error('Zone information test failed:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Check if the service is running in multi-tenant mode
   */
  public isInMultiTenantMode(): boolean {
    return this.isMultiTenant;
  }

  // =====================================================
  // NEW ENTITY METHODS - Phase 1: High-Priority Entities
  // =====================================================

  // Note entities - Using the generic notes endpoint
  async getTicketNote(ticketId: number, noteId: number, tenantContext?: TenantContext): Promise<AutotaskTicketNote | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting ticket note - TicketID: ${ticketId}, NoteID: ${noteId}`);
      
      const searchBody = {
        filter: [
          { field: 'ticketID', op: 'eq', value: ticketId },
          { field: 'id', op: 'eq', value: noteId }
        ]
      };

      this.logger.info('Making direct API call to TicketNotes/query for single note:', searchBody);

      // Use the correct TicketNotes/query endpoint
      const response = await client.TicketNotes.query(searchBody);
      const notes = response?.data?.items || [];
      return notes.length > 0 ? notes[0] as AutotaskTicketNote : null;
    } catch (error) {
      this.logger.error(`Failed to get ticket note ${noteId} for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async searchTicketNotes(ticketId: number, options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskTicketNote[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Searching ticket notes for ticket ${ticketId}:`, options);
      
      const searchBody = {
        filter: [
          { field: 'ticketID', op: 'eq', value: ticketId }
        ],
        pageSize: options.pageSize || 25,
        MaxRecords: options.pageSize || 25  // Add MaxRecords for response size control
      };

      this.logger.info('Making direct API call to TicketNotes/query with body:', searchBody);

      // Use the correct TicketNotes/query endpoint
      const response = await client.TicketNotes.query(searchBody);
      const notes = response?.data?.items || [];
      
      this.logger.info(`Retrieved ${notes.length} ticket notes`);
      return notes as AutotaskTicketNote[];
    } catch (error) {
      this.logger.error(`Failed to search ticket notes for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async createTicketNote(ticketId: number, note: Partial<AutotaskTicketNote>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Creating ticket note for ticket ${ticketId}:`, note);
      const noteData = {
        ...note,
        ticketId: ticketId
      };
      const result = await client.notes.create(noteData as any);
      const noteId = (result.data as any)?.id;
      this.logger.info(`Ticket note created with ID: ${noteId}`);
      return noteId;
    } catch (error) {
      this.logger.error(`Failed to create ticket note for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async getProjectNote(projectId: number, noteId: number, tenantContext?: TenantContext): Promise<AutotaskProjectNote | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting project note - ProjectID: ${projectId}, NoteID: ${noteId}`);
      
      const searchBody = {
        filter: [
          { field: 'projectID', op: 'eq', value: projectId },
          { field: 'id', op: 'eq', value: noteId }
        ]
      };

      this.logger.info('Making direct API call to ProjectNotes/query for single note:', searchBody);

      // Use the correct ProjectNotes/query endpoint
      const response = await client.ProjectNotes.query(searchBody);
      const notes = response?.data?.items || [];
      return notes.length > 0 ? notes[0] as AutotaskProjectNote : null;
    } catch (error) {
      this.logger.error(`Failed to get project note ${noteId} for project ${projectId}:`, error);
      throw error;
    }
  }

  async searchProjectNotes(projectId: number, options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskProjectNote[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Searching project notes for project ${projectId}:`, options);
      
      const searchBody = {
        filter: [
          { field: 'projectID', op: 'eq', value: projectId }
        ],
        pageSize: options.pageSize || 25,
        MaxRecords: options.pageSize || 25  // Add MaxRecords for response size control
      };

      this.logger.info('Making direct API call to ProjectNotes/query with body:', searchBody);

      // Use the correct ProjectNotes/query endpoint
      const response = await client.ProjectNotes.query(searchBody);
      const notes = response?.data?.items || [];
      
      this.logger.info(`Retrieved ${notes.length} project notes`);
      return notes as AutotaskProjectNote[];
    } catch (error) {
      this.logger.error(`Failed to search project notes for project ${projectId}:`, error);
      throw error;
    }
  }

  async createProjectNote(projectId: number, note: Partial<AutotaskProjectNote>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Creating project note for project ${projectId}:`, note);
      const noteData = {
        ...note,
        projectId: projectId
      };
      const result = await client.notes.create(noteData as any);
      const noteId = (result.data as any)?.id;
      this.logger.info(`Project note created with ID: ${noteId}`);
      return noteId;
    } catch (error) {
      this.logger.error(`Failed to create project note for project ${projectId}:`, error);
      throw error;
    }
  }

  async getCompanyNote(companyId: number, noteId: number, tenantContext?: TenantContext): Promise<AutotaskCompanyNote | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting company note - CompanyID: ${companyId}, NoteID: ${noteId}`);
      
      const searchBody = {
        filter: [
          { field: 'accountID', op: 'eq', value: companyId },
          { field: 'id', op: 'eq', value: noteId }
        ]
      };

      this.logger.info('Making direct API call to CompanyNotes/query for single note:', searchBody);

      // Use the correct CompanyNotes/query endpoint
      const response = await client.CompanyNotes.query(searchBody);
      const notes = response?.data?.items || [];
      return notes.length > 0 ? notes[0] as AutotaskCompanyNote : null;
    } catch (error) {
      this.logger.error(`Failed to get company note ${noteId} for company ${companyId}:`, error);
      throw error;
    }
  }

  async searchCompanyNotes(companyId: number, options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskCompanyNote[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Searching company notes for company ${companyId}:`, options);
      
      const searchBody = {
        filter: [
          { field: 'companyID', op: 'eq', value: companyId }
        ],
        pageSize: options.pageSize || 25,
        MaxRecords: options.pageSize || 25  // Add MaxRecords for response size control
      };

      this.logger.info('Making direct API call to CompanyNotes/query with body:', searchBody);

      // Use the correct CompanyNotes/query endpoint
      const response = await client.CompanyNotes.query(searchBody);
      const notes = response?.data?.items || [];
      
      this.logger.info(`Retrieved ${notes.length} company notes`);
      return notes as AutotaskCompanyNote[];
    } catch (error) {
      this.logger.error(`Failed to search company notes for company ${companyId}:`, error);
      throw error;
    }
  }

  async createCompanyNote(companyId: number, note: Partial<AutotaskCompanyNote>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Creating company note for company ${companyId}:`, note);
      const noteData = {
        ...note,
        accountId: companyId
      };
      const result = await client.notes.create(noteData as any);
      const noteId = (result.data as any)?.id;
      this.logger.info(`Company note created with ID: ${noteId}`);
      return noteId;
    } catch (error) {
      this.logger.error(`Failed to create company note for company ${companyId}:`, error);
      throw error;
    }
  }

  // Attachment entities - Using the generic attachments endpoint
  async getTicketAttachment(ticketId: number, attachmentId: number, includeData: boolean = false, tenantContext?: TenantContext): Promise<AutotaskTicketAttachment | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting ticket attachment - TicketID: ${ticketId}, AttachmentID: ${attachmentId}, includeData: ${includeData}`);
      
      const searchBody = {
        filter: [
          { field: 'parentID', op: 'eq', value: ticketId },
          { field: 'id', op: 'eq', value: attachmentId }
        ]
      };

      this.logger.info('Making direct API call to TicketAttachments/query for single attachment:', searchBody);

      // Use the correct TicketAttachments/query endpoint
      const response = await client.TicketAttachments.query(searchBody);
      const attachments = response?.data?.items || [];
      return attachments.length > 0 ? attachments[0] as AutotaskTicketAttachment : null;
    } catch (error) {
      this.logger.error(`Failed to get ticket attachment ${attachmentId} for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async searchTicketAttachments(ticketId: number, options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskTicketAttachment[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Searching ticket attachments for ticket ${ticketId}:`, options);
      
      const searchBody = {
        filter: [
          { field: 'parentID', op: 'eq', value: ticketId }
        ],
        pageSize: options.pageSize || 10,
        MaxRecords: options.pageSize || 10  // Add MaxRecords for response size control
      };

      this.logger.info('Making direct API call to TicketAttachments/query with body:', searchBody);

      // Use the correct TicketAttachments/query endpoint
      const response = await client.TicketAttachments.query(searchBody);
      const attachments = response?.data?.items || [];
      
      this.logger.info(`Retrieved ${attachments.length} ticket attachments`);
      return attachments as AutotaskTicketAttachment[];
    } catch (error) {
      this.logger.error(`Failed to search ticket attachments for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  // Expense entities
  async getExpenseReport(id: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskExpenseReport | null> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting expense report with ID: ${id}`);
      
      const searchBody = {
        filter: [
          { field: 'id', op: 'eq', value: id }
        ]
      };

      this.logger.info('Making direct API call to ExpenseReports/query for single report:', searchBody);

      // Use the correct ExpenseReports/query endpoint
      const response = await client.ExpenseReports.query(searchBody);
      const reports = response?.data?.items || [];
      
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('ExpenseReports', 'query', executionTime, { id });
      
      if (reports.length > 0) {
        this.logger.info(`Retrieved expense report ${id}`);
        return reports[0] as AutotaskExpenseReport;
      }
      
      this.logger.info(`Expense report ${id} not found`);
      return null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('ExpenseReports', 'query', executionTime, { id, error: true });
      this.logger.error(`Failed to get expense report ${id}:`, error);
      throw error;
    }
  }

  async searchExpenseReports(options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskExpenseReport[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching expense reports with options:', options);
      
      // Build filter based on provided options
      const filters = [];
      if (options.submitterId) {
        filters.push({ field: 'resourceID', op: 'eq', value: options.submitterId });
      }
      if (options.status) {
        filters.push({ field: 'status', op: 'eq', value: options.status });
      }
      
      // Ensure there's always a filter - Autotask API requires a filter
      if (filters.length === 0) {
        filters.push({ field: 'id', op: 'gte', value: 0 });
      }
      
      const searchBody = {
        filter: filters,
        pageSize: options.pageSize || 25,
        MaxRecords: options.pageSize || 25  // Add MaxRecords for response size control
      };

      this.logger.info('Making direct API call to ExpenseReports/query with body:', searchBody);

      // Use the correct ExpenseReports/query endpoint
      const response = await client.ExpenseReports.query(searchBody);
      const reports = response?.data?.items || [];
      
      this.logger.info(`Retrieved ${reports.length} expense reports`);
      return reports as AutotaskExpenseReport[];
    } catch (error) {
      this.logger.error('Failed to search expense reports:', error);
      throw error;
    }
  }

  async createExpenseReport(report: Partial<AutotaskExpenseReport>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating expense report:', report);
      const result = await client.expenses.create(report as any);
      const reportId = (result.data as any)?.id;
      this.logger.info(`Expense report created with ID: ${reportId}`);
      return reportId;
    } catch (error) {
      this.logger.error('Failed to create expense report:', error);
      throw error;
    }
  }

  async updateExpenseReport(id: number, updates: Partial<AutotaskExpenseReport>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating expense report ${id}:`, updates);
      await client.expenses.update(id, updates as any);
      this.logger.info(`Expense report ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update expense report ${id}:`, error);
      throw error;
    }
  }

  // Expense Items - Child entities of Expense Reports (ExpenseItems → Expenses/Items)
  async getExpenseItem(expenseReportId: number, itemId: number, tenantContext?: TenantContext): Promise<AutotaskExpenseItem | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting expense item - ExpenseReportID: ${expenseReportId}, ItemID: ${itemId}`);
      
      const searchBody = {
        filter: [
          { field: 'expenseReportID', op: 'eq', value: expenseReportId },
          { field: 'id', op: 'eq', value: itemId }
        ]
      };

      this.logger.info('Making direct API call to ExpenseItems/query for single item:', searchBody);

      // Use the correct ExpenseItems/query endpoint
      const response = await client.ExpenseItems.query(searchBody);
      const items = response?.data?.items || [];
      
      if (items.length > 0) {
        this.logger.info(`Retrieved expense item ${itemId} from expense report ${expenseReportId}`);
        return items[0] as AutotaskExpenseItem;
      }
      
      this.logger.info(`Expense item ${itemId} not found in expense report ${expenseReportId}`);
      return null;
    } catch (error: any) {
      this.logger.error(`Failed to get expense item ${itemId} from expense report ${expenseReportId}:`, error);
      throw error;
    }
  }

  async searchExpenseItems(expenseReportId: number, options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskExpenseItem[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Searching expense items for expense report ${expenseReportId}:`, options);
      
      const searchBody = {
        filter: [
          { field: 'expenseReportID', op: 'eq', value: expenseReportId }
        ],
        pageSize: options.pageSize || 25,
        MaxRecords: options.pageSize || 25  // Add MaxRecords for response size control
      };

      this.logger.info('Querying ExpenseItems via native library method');

      const response = await client.ExpenseItems.query(searchBody);
      // @apigrate library returns items directly
      const items = response?.items ?? [];
      
      this.logger.info(`Retrieved ${items.length} expense items for expense report ${expenseReportId}`);
      return items as AutotaskExpenseItem[];
    } catch (error: any) {
      this.logger.error(`Failed to search expense items for expense report ${expenseReportId}:`, error);
      throw error;
    }
  }

  async createExpenseItem(expenseReportId: number, item: Partial<AutotaskExpenseItem>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Creating expense item for expense report ${expenseReportId}:`, item);
      
      // Ensure the expense report ID is set in the item data
      const itemData = {
        ...item,
        expenseReportID: expenseReportId
      };
      
      // Use native library method for parent-child creation
      const response = await client.ExpenseItems.create(expenseReportId, itemData);
      
      // @apigrate library returns itemId directly (not in response.data)
      let itemId: number;
      
      if (response.itemId) {
        itemId = response.itemId;
      } else if (response.id) {
        itemId = response.id;
      } else if (typeof response === 'number') {
        itemId = response;
      } else {
        this.logger.warn('Unexpected response format from expense item creation:', response);
        throw new Error('Unable to determine created expense item ID from API response');
      }
      
      this.logger.info(`Expense item created with ID: ${itemId} for expense report ${expenseReportId}`);
      return itemId;
    } catch (error) {
      this.logger.error(`Failed to create expense item for expense report ${expenseReportId}:`, error);
      throw error;
    }
  }

  async updateExpenseItem(expenseReportId: number, itemId: number, updates: Partial<AutotaskExpenseItem>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating expense item ${itemId} in expense report ${expenseReportId}:`, updates);
      
      // Make direct API call using parent-child update pattern
      await (client as any).axios.patch(`/Expenses/${expenseReportId}/Items/${itemId}`, updates);
      
      this.logger.info(`Expense item ${itemId} updated successfully in expense report ${expenseReportId}`);
    } catch (error) {
      this.logger.error(`Failed to update expense item ${itemId} in expense report ${expenseReportId}:`, error);
      throw error;
    }
  }

  // Quote entity
  async getQuote(id: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<AutotaskQuote | null> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting quote with ID: ${id}`);
      const result = await client.Quotes.get(id);
      
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Quotes', 'get', executionTime, { id });
      
      // @apigrate library returns { item: quoteData } or null
      return result?.item as AutotaskQuote || null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Quotes', 'get', executionTime, { id, error: true });
      this.logger.error(`Failed to get quote ${id}:`, error);
      throw error;
    }
  }

  /**
   * JSON body for POST /Quotes/query (shared by searchQuotes).
   */
  buildQuotesQueryPayload(options: AutotaskQueryOptionsExtended = {}): Record<string, unknown> {
    let filter: unknown[];
    if (Array.isArray(options.filter) && options.filter.length > 0) {
      filter = options.filter as unknown[];
    } else {
      const parts: Record<string, unknown>[] = [];
      if (options.companyId != null) {
        parts.push({ field: 'accountId', op: 'eq', value: options.companyId });
      }
      if (options.contactId != null) {
        parts.push({ field: 'contactId', op: 'eq', value: options.contactId });
      }
      if (options.opportunityId != null) {
        parts.push({ field: 'opportunityId', op: 'eq', value: options.opportunityId });
      }
      if (options.searchTerm) {
        parts.push({ field: 'description', op: 'contains', value: options.searchTerm });
      }
      filter = parts.length > 0 ? parts : [{ field: 'id', op: 'gte', value: 0 }];
    }

    const raw = options.pageSize ?? DEFAULT_ENTITY_PAGE_SIZE;
    const pageSize = Math.max(1, Math.min(raw > 0 ? raw : DEFAULT_ENTITY_PAGE_SIZE, 500));
    const body: Record<string, unknown> = {
      filter,
      pageSize,
      MaxRecords: pageSize
    };
    if (options.sort) {
      body.sort = options.sort;
    }
    return body;
  }

  async searchQuotes(
    options: AutotaskQueryOptionsExtended = {},
    tenantContext?: TenantContext,
    tracker?: ApiCallTracker
  ): Promise<AutotaskQuote[]> {
    const startTime = Date.now();

    try {
      this.logger.info('Searching quotes with options:', options);

      if (options.page && options.page > 1) {
        this.logger.warn(
          `⚠️ searchQuotes: page=${options.page} is ignored by Autotask REST; use MCP continue_query with a cursor instead.`
        );
      }

      const searchBody = this.buildQuotesQueryPayload(options);
      const result = await this.paginatedQuery.fetchAll<AutotaskQuote>(
        'Quotes',
        searchBody,
        tenantContext,
        tracker,
        options.maxItems,
        { enrichment: 'quotes', responseKey: 'quotes' }
      );

      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Quotes', 'query', executionTime, {
        resultCount: result.items.length,
        paginated: true,
        status: result.status,
        pagesFetched: result.pagesFetched
      });

      this.logger.info(`Retrieved ${result.items.length} quotes (paginated)`, {
        status: result.status,
        pagesFetched: result.pagesFetched
      });

      return result.items;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Quotes', 'query', executionTime, { error: true });
      this.logger.error('Failed to search quotes:', error);
      throw error;
    }
  }

  async createQuote(quote: Partial<AutotaskQuote>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating quote:', quote);
      const result = await client.Quotes.create(quote as any);
      const quoteId = result.itemId;
      this.logger.info(`Quote created with ID: ${quoteId}`);
      return quoteId;
    } catch (error) {
      this.logger.error('Failed to create quote:', error);
      throw error;
    }
  }

  // Opportunities
  buildOpportunitiesQueryPayload(options: AutotaskQueryOptionsExtended = {}): Record<string, unknown> {
    const filters: unknown[] =
      Array.isArray(options.filter) && options.filter.length > 0
        ? [...(options.filter as unknown[])]
        : [{ field: 'id', op: 'gte', value: 0 }];
    const pageSize = Math.min(options.pageSize ?? DEFAULT_ENTITY_PAGE_SIZE, 500);
    const body: Record<string, unknown> = {
      filter: filters,
      pageSize,
      MaxRecords: pageSize
    };
    if (options.sort) {
      body.sort = options.sort;
    }
    return body;
  }

  async searchOpportunities(options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<any[]> {
    const startTime = Date.now();

    try {
      this.logger.info('Searching opportunities with options:', options);

      const queryBody = this.buildOpportunitiesQueryPayload(options);
      const result = await this.paginatedQuery.fetchAll(
        'Opportunities',
        queryBody,
        tenantContext,
        tracker,
        options.maxItems,
        { enrichment: 'opportunities', responseKey: 'opportunities' }
      );

      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Opportunities', 'query', executionTime, {
        resultCount: result.items.length,
        paginated: true,
        status: result.status
      });

      const opportunities = result.items || [];

      this.logger.info(`Retrieved ${opportunities.length} opportunities (paginated)`);
      return opportunities;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Opportunities', 'query', executionTime, { error: true });
      this.logger.error('Failed to search opportunities:', error);
      throw error;
    }
  }

  async countOpportunities(options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<number> {
    const startTime = Date.now();
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Counting opportunities with options:', options);
      
      const filter = this.buildOpportunitiesQueryPayload(options).filter as unknown[];

      const result = await client.Opportunities.count({ filter });
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Opportunities', 'count', executionTime);
      
      const count = result.queryCount || 0;
      
      this.logger.info(`Total opportunities count: ${count}`);
      return count;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      tracker?.recordApiCall('Opportunities', 'count', executionTime, { error: true });
      this.logger.error('Failed to count opportunities:', error);
      throw error;
    }
  }

  // BillingCode and Department entities - now available via @apigrate/autotask-restapi
  async getBillingCode(id: number, tenantContext?: TenantContext): Promise<AutotaskBillingCode | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting billing code with ID: ${id}`);
      const result = await client.BillingCodes.get(id);
      return result.item as AutotaskBillingCode || null;
    } catch (error) {
      this.logger.error(`Failed to get billing code ${id}:`, error);
      throw error;
    }
  }

  async searchBillingCodes(options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskBillingCode[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching billing codes');
      const searchBody = {
        filter: options.filter || [{ op: 'gte', field: 'id', value: 0 }]
      };
      const response = await client.BillingCodes.query(searchBody);
      return response.items ?? [];
    } catch (error) {
      this.logger.error('Failed to search billing codes:', error);
      throw error;
    }
  }

  async getDepartment(id: number, tenantContext?: TenantContext): Promise<AutotaskDepartment | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting department with ID: ${id}`);
      const result = await client.Departments.get(id);
      return result.item as AutotaskDepartment || null;
    } catch (error) {
      this.logger.error(`Failed to get department ${id}:`, error);
      throw error;
    }
  }

  async searchDepartments(options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskDepartment[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching departments');
      const searchBody = {
        filter: options.filter || [{ op: 'gte', field: 'id', value: 0 }]
      };
      const response = await client.Departments.query(searchBody);
      return response.items ?? [];
    } catch (error) {
      this.logger.error('Failed to search departments:', error);
      throw error;
    }
  }

  // ===================================
  // GET Query Methods (URL parameter-based search)
  // ===================================

  async queryCompanies(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskCompany[]> {
    this.logger.info('🔍 Querying companies with search parameter:', options.search);
    
    // Use existing searchCompanies with contains filter
    return this.searchCompanies({
      filter: [{
        field: 'companyName',
        op: 'contains',
        value: options.search
      }],
      pageSize: 50
    }, tenantContext);
  }

  async queryContacts(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskContact[]> {
    this.logger.info('🔍 Querying contacts with search parameter:', options.search);
    
    // Use existing searchContacts with contains filter
    return this.searchContacts({
      filter: [{
        field: 'firstName',
        op: 'contains',
        value: options.search
      }, {
        field: 'lastName',
        op: 'contains',
        value: options.search
      }, {
        field: 'emailAddress',
        op: 'contains',
        value: options.search
      }],
      pageSize: 50
    }, tenantContext);
  }

  async queryTickets(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskTicket[]> {
    this.logger.info('🔍 Querying tickets with search parameter:', options.search);
    
    // Use existing searchTickets with searchTerm
    return this.searchTickets({
      searchTerm: options.search,
      pageSize: 50,
      maxItems: 100
    }, tenantContext);
  }

  async queryProjects(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskProject[]> {
    this.logger.info('🔍 Querying projects with search parameter:', options.search);
    
    // Use existing searchProjects with contains filter
    return this.searchProjects({
      filter: [{
        field: 'projectName',
        op: 'contains',
        value: options.search
      }],
      pageSize: 50,
      maxItems: 100
    }, tenantContext);
  }

  async queryResources(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskResource[]> {
    this.logger.info('🔍 Querying resources with search parameter:', options.search);
    
    // Use existing searchResources with contains filter
    return this.searchResources({
      filter: [{
        field: 'firstName',
        op: 'contains',
        value: options.search
      }],
      pageSize: 50,
      maxItems: 100
    }, tenantContext);
  }

  async queryTasks(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskTask[]> {
    this.logger.info('🔍 Querying tasks with search parameter:', options.search);
    
    // Use existing searchTasks with contains filter
    return this.searchTasks({
      filter: [{
        field: 'title',
        op: 'contains',
        value: options.search
      }],
      pageSize: 50,
      maxItems: 100
    }, tenantContext);
  }

  async queryContracts(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskContract[]> {
    this.logger.info('🔍 Querying contracts with search parameter:', options.search);
    
    // Use existing searchContracts with contains filter
    return this.searchContracts({
      filter: [{
        field: 'contractName',
        op: 'contains',
        value: options.search
      }],
      pageSize: 50,
      maxItems: 100
    }, tenantContext);
  }

  async queryQuotes(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskQuote[]> {
    this.logger.info('🔍 Querying quotes with search parameter:', options.search);
    
    // Use existing searchQuotes with searchTerm
    return this.searchQuotes({
      searchTerm: options.search,
      pageSize: 50,
      maxItems: 100
    }, tenantContext);
  }

  async queryInvoices(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskInvoice[]> {
    this.logger.info('🔍 Querying invoices with search parameter:', options.search);
    
    // Use existing searchInvoices with filter
    return this.searchInvoices({
      filter: [{
        field: 'invoiceNumber',
        op: 'contains',
        value: options.search
      }],
      pageSize: 50,
      maxItems: 100
    }, tenantContext);
  }

  async queryTimeEntries(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskTimeEntry[]> {
    this.logger.info('🔍 Querying time entries with search parameter:', options.search);
    
    // Use existing getTimeEntries with filter
    return this.getTimeEntries({
      filter: [{
        field: 'summaryNotes',
        op: 'contains',
        value: options.search
      }],
      pageSize: 50
    }, tenantContext);
  }

  async queryConfigurationItems(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskConfigurationItem[]> {
    this.logger.info('🔍 Querying configuration items with search parameter:', options.search);
    
    // Use existing searchConfigurationItems with filter
    return this.searchConfigurationItems({
      filter: [{
        field: 'referenceTitle',
        op: 'contains',
        value: options.search
      }],
      pageSize: 50
    }, tenantContext);
  }

  async queryExpenseReports(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskExpenseReport[]> {
    this.logger.info('🔍 Querying expense reports with search parameter:', options.search);
    
    // Use existing searchExpenseReports with filter
    return this.searchExpenseReports({
      filter: [{
        field: 'name',
        op: 'contains',
        value: options.search
      }],
      pageSize: 50
    }, tenantContext);
  }

  // Company Categories operations
  async getCompanyCategories(includeInactive: boolean = false, tenantContext?: TenantContext): Promise<any[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('📋 Getting company categories', {
        includeInactive,
        tenantId: tenantContext?.tenantId
      });

      // Build filter for company categories
      const filters: any[] = [];
      
      if (!includeInactive) {
        filters.push({
          field: 'isActive',
          op: 'eq',
          value: true
        });
      }

      // Always include a base filter to ensure we get results
      if (filters.length === 0) {
        filters.push({
          field: 'id',
          op: 'gte',
          value: 0
        });
      }

      // Make direct API call to CompanyCategories/query
      const searchBody = {
        filter: filters,
        pageSize: 100 // Company categories are typically few in number
      };

      this.logger.info('Querying CompanyCategories via native library method');

      // Note: CompanyCategories may need to use a different entity name depending on library
      // Using direct access pattern that @apigrate supports
      const response = await (client as any).CompanyCategories?.query(searchBody) 
        ?? { items: [] };
      
      // Extract categories from response
      let categories: any[] = [];
      // @apigrate library returns items directly
      if (response?.items) {
        categories = response.items;
        this.logger.info(`📊 Extracted ${categories.length} company categories`);
      } else {
        this.logger.warn('❌ Unexpected response format from CompanyCategories/query:', {
          response
        });
        categories = [];
      }

      this.logger.info(`✅ Retrieved ${categories.length} company categories`);
      return categories;
    } catch (error: any) {
      this.logger.error('❌ Failed to get company categories:', {
        error: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        responseData: error.response?.data
      });
      throw error;
    }
  }
} 