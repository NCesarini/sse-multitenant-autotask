/**
 * Apigrate Adapter
 * 
 * Implementation of AutotaskAdapter using @apigrate/autotask-restapi library.
 * This is the recommended adapter for new deployments.
 * 
 * Features:
 * - Native fetch (Node >= 18)
 * - Automatic zone discovery
 * - Complete entity support
 * - Explicit pagination protocol
 * - Built-in rate limiting
 */

import {
  AutotaskAdapter,
  QueryOptions,
  FilterExpression,
  PaginatedResult,
  CreateResult,
  CountResult,
  GetResult,
  FieldInfo,
  EntityInfo
} from './autotask-adapter.interface.js';
import { PaginationEnforcer } from '../core/pagination.js';
import { RateLimiter, ConcurrencyLimiter } from '../core/rate-limiter.js';
import { TenantContext, AutotaskCredentials } from '../types/mcp.js';
import { Logger } from '../utils/logger.js';

// ============================================
// Types for @apigrate/autotask-restapi
// ============================================

// Note: These types are based on the library's actual API
// The library doesn't export TypeScript types, so we define them here

interface ApigrateQueryResult {
  items: any[];
  pageDetails: {
    count: number;
    requestCount: number;
    prevPageUrl: string | null;
    nextPageUrl: string | null;
  };
}

interface ApigrateCreateResult {
  itemId: number;
}

interface ApigrateGetResult {
  item: any | null;
}

interface ApigrateCountResult {
  queryCount: number;
}

// ============================================
// Client Pool for Multi-Tenant Support
// ============================================

interface PooledClient {
  client: any; // AutotaskRestApi instance
  tenantId: string;
  credentials: AutotaskCredentials;
  lastUsed: Date;
  createdAt: Date;
}

class ClientPool {
  private clients: Map<string, PooledClient> = new Map();
  private readonly maxSize: number;
  private readonly maxAge: number; // milliseconds
  private readonly logger: Logger | undefined;
  
  constructor(maxSize: number = 50, maxAgeMs: number = 30 * 60 * 1000, logger?: Logger) {
    this.maxSize = maxSize;
    this.maxAge = maxAgeMs;
    this.logger = logger;
    
    // Start cleanup interval
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }
  
  private getCacheKey(credentials: AutotaskCredentials): string {
    const keyData = `${credentials.username}:${credentials.integrationCode}`;
    return Buffer.from(keyData).toString('base64').substring(0, 16);
  }
  
  get(credentials: AutotaskCredentials): any | null {
    const key = this.getCacheKey(credentials);
    const pooled = this.clients.get(key);
    
    if (pooled && !this.isExpired(pooled)) {
      pooled.lastUsed = new Date();
      this.logger?.debug(`Using cached client for tenant: ${pooled.tenantId}`);
      return pooled.client;
    }
    
    if (pooled) {
      this.clients.delete(key);
    }
    
    return null;
  }
  
  set(credentials: AutotaskCredentials, tenantId: string, client: any): void {
    const key = this.getCacheKey(credentials);
    
    // Enforce size limit
    if (this.clients.size >= this.maxSize) {
      this.evictOldest();
    }
    
    this.clients.set(key, {
      client,
      tenantId,
      credentials,
      lastUsed: new Date(),
      createdAt: new Date()
    });
    
    this.logger?.info(`Client cached for tenant: ${tenantId}`);
  }
  
  private isExpired(pooled: PooledClient): boolean {
    return Date.now() - pooled.lastUsed.getTime() > this.maxAge;
  }
  
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();
    
    for (const [key, pooled] of this.clients) {
      if (pooled.lastUsed.getTime() < oldestTime) {
        oldestTime = pooled.lastUsed.getTime();
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.clients.delete(oldestKey);
      this.logger?.debug(`Evicted oldest client from pool`);
    }
  }
  
  private cleanup(): void {
    const before = this.clients.size;
    
    for (const [key, pooled] of this.clients) {
      if (this.isExpired(pooled)) {
        this.clients.delete(key);
      }
    }
    
    const removed = before - this.clients.size;
    if (removed > 0) {
      this.logger?.info(`Cleaned up ${removed} expired clients from pool`);
    }
  }
  
  getStats(): { size: number; maxSize: number } {
    return { size: this.clients.size, maxSize: this.maxSize };
  }
}

// ============================================
// Apigrate Adapter Implementation
// ============================================

export interface ApigrateAdapterConfig {
  /** Default credentials for single-tenant mode */
  defaultCredentials?: AutotaskCredentials;
  
  /** Requests per second limit */
  requestsPerSecond?: number;
  
  /** Maximum concurrent requests */
  maxConcurrency?: number;
  
  /** Client pool size for multi-tenant */
  poolSize?: number;
  
  /** Client session timeout in ms */
  sessionTimeout?: number;
  
  /** Logger instance */
  logger?: Logger;
}

export class ApigrateAdapter implements AutotaskAdapter {
  private readonly clientPool: ClientPool;
  private readonly rateLimiter: RateLimiter;
  private readonly concurrencyLimiter: ConcurrencyLimiter;
  private readonly logger: Logger | undefined;
  private readonly defaultCredentials: AutotaskCredentials | undefined;
  
  // The @apigrate/autotask-restapi library (dynamically imported)
  private AutotaskRestApiClass: any = null;
  
  constructor(config: ApigrateAdapterConfig = {}) {
    this.logger = config.logger;
    this.defaultCredentials = config.defaultCredentials;
    
    this.clientPool = new ClientPool(
      config.poolSize ?? 50,
      config.sessionTimeout ?? 30 * 60 * 1000,
      config.logger
    );
    
    this.rateLimiter = RateLimiter.perSecond(config.requestsPerSecond ?? 5, config.logger);
    this.concurrencyLimiter = new ConcurrencyLimiter(config.maxConcurrency ?? 10);
  }
  
  /**
   * Lazy load the @apigrate/autotask-restapi library.
   */
  private async getAutotaskRestApiClass(): Promise<any> {
    if (this.AutotaskRestApiClass) {
      return this.AutotaskRestApiClass;
    }
    
    try {
      // Dynamic import of the library
      const module = await import('@apigrate/autotask-restapi');
      // Try named export first, then default export
      this.AutotaskRestApiClass = module.AutotaskRestApi || module.default;
      
      if (!this.AutotaskRestApiClass) {
        throw new Error('Could not find AutotaskRestApi class in module');
      }
      
      this.logger?.info('Loaded @apigrate/autotask-restapi library');
      return this.AutotaskRestApiClass;
    } catch (error) {
      this.logger?.error('Failed to load @apigrate/autotask-restapi:', error);
      throw new Error(
        'Failed to load @apigrate/autotask-restapi library. ' +
        'Make sure it is installed: npm install @apigrate/autotask-restapi'
      );
    }
  }
  
  /**
   * Get or create an API client for the given credentials.
   */
  private async getClient(tenantContext?: TenantContext): Promise<any> {
    const credentials = tenantContext?.credentials ?? this.defaultCredentials;
    
    if (!credentials) {
      throw new Error('No credentials provided and no default credentials configured');
    }
    
    // Check pool first
    let client = this.clientPool.get(credentials);
    if (client) {
      return client;
    }
    
    // Create new client
    const AutotaskRestApi = await this.getAutotaskRestApiClass();
    
    this.logger?.info('Creating new Autotask REST API client', {
      username: credentials.username.substring(0, 8) + '***',
      integrationCode: credentials.integrationCode
    });
    
    client = new AutotaskRestApi(
      credentials.username,
      credentials.secret,
      credentials.integrationCode
    );
    
    // Cache it
    this.clientPool.set(
      credentials,
      tenantContext?.tenantId ?? 'default',
      client
    );
    
    return client;
  }
  
  /**
   * Execute an API call with rate limiting and concurrency control.
   */
  private async execute<T>(
    fn: () => Promise<T>,
    operation: string
  ): Promise<T> {
    return this.concurrencyLimiter.execute(async () => {
      await this.rateLimiter.waitForSlot();
      
      const startTime = Date.now();
      try {
        const result = await fn();
        const duration = Date.now() - startTime;
        
        this.logger?.debug(`API call completed: ${operation}`, { durationMs: duration });
        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        this.logger?.error(`API call failed: ${operation}`, { 
          durationMs: duration,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    });
  }
  
  // ============================================
  // AutotaskAdapter Implementation
  // ============================================
  
  async query<T>(
    entity: string,
    options: QueryOptions,
    tenantContext?: TenantContext
  ): Promise<PaginatedResult<T>> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getEntityApi(client, entity);
    
    // Build query options for Apigrate library
    const queryOptions: any = {};
    
    if (options.filter && options.filter.length > 0) {
      queryOptions.filter = options.filter;
    } else {
      // Autotask API requires a filter
      queryOptions.filter = [{ field: 'id', op: 'gte', value: 0 }];
    }
    
    if (options.includeFields) {
      queryOptions.includeFields = options.includeFields;
    }
    
    // Note: @apigrate/autotask-restapi handles pagination via nextPageUrl
    // We'll use page/pageSize if provided
    const currentPage = options.page ?? 1;
    const pageSize = Math.min(options.pageSize ?? 500, 500); // API max is 500
    
    // Execute query
    const result: ApigrateQueryResult = await this.execute(
      () => entityApi.query(queryOptions),
      `query ${entity}`
    );
    
    // Build pagination protocol
    const paginatedResult = PaginationEnforcer.wrapResult<T>(
      result.items as T[],
      result.pageDetails,
      currentPage,
      pageSize
    );
    
    return paginatedResult;
  }
  
  async get<T>(
    entity: string,
    id: number,
    tenantContext?: TenantContext
  ): Promise<GetResult<T>> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getEntityApi(client, entity);
    
    const result: ApigrateGetResult = await this.execute(
      () => entityApi.get(id),
      `get ${entity}/${id}`
    );
    
    return { item: result.item as T | null };
  }
  
  async getChild<T>(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    childId: number,
    tenantContext?: TenantContext
  ): Promise<GetResult<T>> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getChildEntityApi(client, parentEntity, childEntity);
    
    // @apigrate/autotask-restapi uses: entity.get(parentId, childId) for attachments
    const result = await this.execute(
      () => entityApi.get(parentId, childId),
      `get ${parentEntity}/${parentId}/${childEntity}/${childId}`
    ) as ApigrateGetResult;
    
    return { item: result.item as T | null };
  }
  
  async create<T>(
    entity: string,
    data: Partial<T>,
    tenantContext?: TenantContext
  ): Promise<CreateResult> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getEntityApi(client, entity);
    
    const result: ApigrateCreateResult = await this.execute(
      () => entityApi.create(data),
      `create ${entity}`
    );
    
    return { itemId: result.itemId };
  }
  
  async createChild<T>(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    data: Partial<T>,
    tenantContext?: TenantContext
  ): Promise<CreateResult> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getChildEntityApi(client, parentEntity, childEntity);
    
    // @apigrate/autotask-restapi uses: entity.create(parentId, data)
    const result = await this.execute(
      () => entityApi.create(parentId, data),
      `create ${parentEntity}/${parentId}/${childEntity}`
    ) as ApigrateCreateResult;
    
    return { itemId: result.itemId };
  }
  
  async update(
    entity: string,
    id: number,
    data: Record<string, any>,
    tenantContext?: TenantContext
  ): Promise<void> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getEntityApi(client, entity);
    
    await this.execute(
      () => entityApi.update({ id, ...data }),
      `update ${entity}/${id}`
    );
  }
  
  async updateChild(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    childId: number,
    data: Record<string, any>,
    tenantContext?: TenantContext
  ): Promise<void> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getChildEntityApi(client, parentEntity, childEntity);
    
    await this.execute(
      () => entityApi.update(parentId, { id: childId, ...data }),
      `update ${parentEntity}/${parentId}/${childEntity}/${childId}`
    );
  }
  
  async replace<T>(
    entity: string,
    id: number,
    data: T,
    tenantContext?: TenantContext
  ): Promise<void> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getEntityApi(client, entity);
    
    await this.execute(
      () => entityApi.replace({ id, ...data }),
      `replace ${entity}/${id}`
    );
  }
  
  async delete(
    entity: string,
    id: number,
    tenantContext?: TenantContext
  ): Promise<void> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getEntityApi(client, entity);
    
    await this.execute(
      () => entityApi.delete(id),
      `delete ${entity}/${id}`
    );
  }
  
  async count(
    entity: string,
    filter: FilterExpression[],
    tenantContext?: TenantContext
  ): Promise<CountResult> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getEntityApi(client, entity);
    
    const queryFilter = filter.length > 0 ? filter : [{ field: 'id', op: 'gte', value: 0 }];
    
    const result: ApigrateCountResult = await this.execute(
      () => entityApi.count({ filter: queryFilter }),
      `count ${entity}`
    );
    
    return { queryCount: result.queryCount };
  }
  
  async fieldInfo(
    entity: string,
    tenantContext?: TenantContext
  ): Promise<FieldInfo[]> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getEntityApi(client, entity);
    
    const result = await this.execute(
      () => entityApi.fieldInfo(),
      `fieldInfo ${entity}`
    ) as { fields: FieldInfo[] };
    
    return result.fields;
  }
  
  async entityInfo(
    entity: string,
    tenantContext?: TenantContext
  ): Promise<EntityInfo> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getEntityApi(client, entity);
    
    const result = await this.execute(
      () => entityApi.info(),
      `info ${entity}`
    );
    
    return result as EntityInfo;
  }
  
  async udfInfo(
    entity: string,
    tenantContext?: TenantContext
  ): Promise<FieldInfo[]> {
    const client = await this.getClient(tenantContext);
    const entityApi = this.getEntityApi(client, entity);
    
    const result = await this.execute(
      () => entityApi.udfInfo(),
      `udfInfo ${entity}`
    ) as { fields: FieldInfo[] };
    
    return result.fields;
  }
  
  async testConnection(tenantContext?: TenantContext): Promise<boolean> {
    try {
      const client = await this.getClient(tenantContext);
      
      // Get the root company (ID 0) as a connection test
      const result = await client.Companies.get(0);
      return result.item !== null;
    } catch (error) {
      this.logger?.error('Connection test failed:', error);
      return false;
    }
  }
  
  async getZoneInfo(tenantContext?: TenantContext): Promise<{ url: string; webUrl: string }> {
    const client = await this.getClient(tenantContext);
    
    // Access zone information from the client
    // @apigrate/autotask-restapi stores this internally after first API call
    const result = await this.execute(
      () => client.ZoneInformation.get(),
      'getZoneInfo'
    ) as { url: string; webUrl: string };
    
    return {
      url: result.url,
      webUrl: result.webUrl
    };
  }
  
  // ============================================
  // Helper Methods
  // ============================================
  
  /**
   * Get the API accessor for a given entity.
   */
  private getEntityApi(client: any, entity: string): any {
    const api = client[entity];
    
    if (!api) {
      throw new Error(`Unknown entity: ${entity}. Available entities: ${Object.keys(client).filter(k => typeof client[k] === 'object').join(', ')}`);
    }
    
    return api;
  }
  
  /**
   * Get the API accessor for a child entity.
   */
  private getChildEntityApi(client: any, parentEntity: string, childEntity: string): any {
    // In @apigrate/autotask-restapi, child entities are accessed directly
    // e.g., client.TicketNotes, client.CompanyContacts
    const combinedName = `${parentEntity.replace(/s$/, '')}${childEntity}`;
    
    // Try common naming patterns
    const possibleNames = [
      combinedName,
      `${parentEntity}${childEntity}`,
      childEntity
    ];
    
    for (const name of possibleNames) {
      if (client[name]) {
        return client[name];
      }
    }
    
    throw new Error(`Unknown child entity: ${childEntity} of ${parentEntity}`);
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Create an Apigrate adapter instance.
 */
export function createApigrateAdapter(config: ApigrateAdapterConfig): ApigrateAdapter {
  return new ApigrateAdapter(config);
}


