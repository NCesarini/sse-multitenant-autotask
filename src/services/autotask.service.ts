// Autotask Service Layer
// Wraps the @apigrate/autotask-restapi client with pagination support
// Implements "Showing X of Y" pattern for AI agent awareness

// @ts-ignore - @apigrate/autotask-restapi doesn't have type definitions
import { AutotaskRestApi, AutotaskApiError } from '@apigrate/autotask-restapi';
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
  AutotaskOpportunity,
  AutotaskBillingCode,
  AutotaskDepartment,
  AutotaskQueryOptionsExtended,
  PaginatedResponse,
  PaginationInfo,
  AutotaskPageDetails,
  AutotaskCountResponse,
  formatPaginationStatus,
  formatNextAction,
  PAGINATION_CONFIG
} from '../types/autotask.js';
import { McpServerConfig, AutotaskCredentials, TenantContext } from '../types/mcp.js';
import { Logger } from '../utils/logger.js';

/**
 * Helper to create PaginationInfo from Autotask API response
 */
function createPaginationInfo(
  itemCount: number,
  pageDetails: AutotaskPageDetails | undefined,
  totalCount: number | undefined,
  currentPage: number,
  pageSize: number
): PaginationInfo {
  const total = totalCount ?? (pageDetails?.count ?? itemCount);
  const hasMore = pageDetails?.nextPageUrl != null;
  
  // Build base pagination info
  const paginationInfo: PaginationInfo = {
    showing: itemCount,
    total: total,
    totalKnown: totalCount !== undefined || pageDetails !== undefined,
    currentPage: currentPage,
    pageSize: pageSize,
    hasMore: hasMore,
    percentComplete: total > 0 ? Math.round((itemCount / total) * 100) : 100
  };
  
  // Conditionally add optional URL properties (for exactOptionalPropertyTypes compliance)
  if (pageDetails?.nextPageUrl) {
    paginationInfo.nextPageUrl = pageDetails.nextPageUrl;
  }
  if (pageDetails?.prevPageUrl) {
    paginationInfo.prevPageUrl = pageDetails.prevPageUrl;
  }
  
  return paginationInfo;
}

/**
 * Helper to wrap items with pagination metadata
 */
function createPaginatedResponse<T>(
  items: T[],
  pagination: PaginationInfo,
  toolName: string
): PaginatedResponse<T> {
  const response: PaginatedResponse<T> = {
    items,
    pagination,
    _paginationStatus: formatPaginationStatus(pagination)
  };
  
  // Conditionally add _nextAction (for exactOptionalPropertyTypes compliance)
  if (pagination.hasMore) {
    response._nextAction = formatNextAction(pagination, toolName);
  }
  
  return response;
} 


// Use centralized PAGINATION_CONFIG for all thresholds
export const LARGE_RESPONSE_THRESHOLDS = {
  tickets: PAGINATION_CONFIG.MAX_PAGE_SIZE,        
  companies: PAGINATION_CONFIG.MAX_PAGE_SIZE,     
  contacts: PAGINATION_CONFIG.MAX_PAGE_SIZE,     
  projects: PAGINATION_CONFIG.MAX_PAGE_SIZE,      
  resources: PAGINATION_CONFIG.MAX_PAGE_SIZE,     
  tasks: PAGINATION_CONFIG.MAX_PAGE_SIZE,          
  timeentries: PAGINATION_CONFIG.MAX_PAGE_SIZE,    
  contracts: PAGINATION_CONFIG.MAX_PAGE_SIZE,      
  default: PAGINATION_CONFIG.MAX_PAGE_SIZE,        
  responseSizeKB: 200  
};


// Client pool management for multi-tenant support
interface ClientPoolEntry {
  client: AutotaskRestApi;
  tenantId: string;
  lastUsed: Date;
  credentials: AutotaskCredentials;
  // Health tracking for circuit breaker pattern
  consecutiveErrors: number;
  lastError?: Date;
  isHealthy: boolean;
}

// Circuit breaker configuration
const CIRCUIT_BREAKER_CONFIG = {
  maxConsecutiveErrors: 10,        // More tolerance before tripping
  cooldownPeriodMs: 30000,         // 30 second cooldown (reduced from 1 minute)
  resetOnSuccess: true             // Reset error count on first success
};

export class AutotaskService {
  private client: AutotaskRestApi | null = null;
  private logger: Logger;
  private config: McpServerConfig;
  private initializationPromise: Promise<void> | null = null;
  
  // Multi-tenant support
  private isMultiTenant: boolean;
  private clientPool: Map<string, ClientPoolEntry> = new Map();
  private readonly poolSize: number;
  private readonly sessionTimeout: number;
  
  // Rate limiting tracking (Autotask limit: 10,000 requests/hour)
  private requestCounts: Map<string, { count: number; resetTime: Date }> = new Map();
  private readonly RATE_LIMIT_THRESHOLD = 9000; // Warn at 90% of limit

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
  }
 

  /**
   * Get or create Autotask client for tenant
   */
  private async getClientForTenant(tenantContext?: TenantContext): Promise<AutotaskRestApi> {
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

    // Check circuit breaker before proceeding
    if (!this.isCircuitClosed(cacheKey)) {
      throw new Error(`Circuit breaker OPEN for tenant ${tenantId}. Please wait before retrying.`);
    }

    this.logger.info('🔍 Checking client pool for tenant', {
      tenantId,
      cacheKey: cacheKey.substring(0, 8) + '...',
      poolSize: this.clientPool.size,
      poolKeys: Array.from(this.clientPool.keys()).map(k => k.substring(0, 8) + '...')
    });

    // Track this request for rate limiting
    this.trackRequest(tenantId);

    // Check if we have a cached client for this tenant
    const poolEntry = this.clientPool.get(cacheKey);
    if (poolEntry && this.isClientValid(poolEntry)) {
      poolEntry.lastUsed = new Date();
      this.logger.info(`♻️ Using cached client for tenant: ${tenantId}`, {
        tenantId,
        cacheKey: cacheKey.substring(0, 8) + '...',
        clientAge: Date.now() - poolEntry.lastUsed.getTime(),
        poolSize: this.clientPool.size,
        isHealthy: poolEntry.isHealthy,
        consecutiveErrors: poolEntry.consecutiveErrors
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

    // Store in pool (with size limit) - including health tracking fields
    this.managePoolSize();
    this.clientPool.set(cacheKey, {
      client,
      tenantId,
      lastUsed: new Date(),
      credentials: tenantContext.credentials,
      consecutiveErrors: 0,
      isHealthy: true
    });

    this.logger.info(`✅ Client created and cached for tenant: ${tenantId}`, {
      tenantId,
      cacheKey: cacheKey.substring(0, 8) + '...',
      poolSizeAfter: this.clientPool.size
    });

    return client;
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
   * Track API request for rate limiting
   */
  private trackRequest(tenantId: string): void {
    const now = new Date();
    const hourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
    
    let rateInfo = this.requestCounts.get(tenantId);
    if (!rateInfo || rateInfo.resetTime < now) {
      rateInfo = { count: 0, resetTime: hourFromNow };
    }
    
    rateInfo.count++;
    this.requestCounts.set(tenantId, rateInfo);
    
    if (rateInfo.count >= this.RATE_LIMIT_THRESHOLD) {
      this.logger.warn(`⚠️ Rate limit warning for tenant ${tenantId}: ${rateInfo.count}/10000 requests used`);
    }
  }

  /**
   * Mark client as healthy after successful request
   */
  private markClientHealthy(cacheKey: string): void {
    const entry = this.clientPool.get(cacheKey);
    if (entry) {
      entry.consecutiveErrors = 0;
      entry.isHealthy = true;
    }
  }

  /**
   * Mark client as having an error, implement circuit breaker
   */
  private markClientError(cacheKey: string): boolean {
    const entry = this.clientPool.get(cacheKey);
    if (entry) {
      entry.consecutiveErrors++;
      entry.lastError = new Date();
      
      if (entry.consecutiveErrors >= CIRCUIT_BREAKER_CONFIG.maxConsecutiveErrors) {
        entry.isHealthy = false;
        this.logger.error(`🔴 Circuit breaker OPEN for tenant ${entry.tenantId}: ${entry.consecutiveErrors} consecutive errors`);
        return false; // Circuit is open
      }
    }
    return true; // Circuit is still closed
  }

  /**
   * Check if circuit breaker allows requests
   */
  private isCircuitClosed(cacheKey: string): boolean {
    const entry = this.clientPool.get(cacheKey);
    if (!entry) return true;
    
    if (!entry.isHealthy && entry.lastError) {
      const cooldownElapsed = Date.now() - entry.lastError.getTime() > CIRCUIT_BREAKER_CONFIG.cooldownPeriodMs;
      if (cooldownElapsed) {
        // Try to close the circuit (half-open state)
        entry.isHealthy = true;
        entry.consecutiveErrors = 0;
        this.logger.info(`🟡 Circuit breaker HALF-OPEN for tenant ${entry.tenantId}: attempting recovery`);
        return true;
      }
      return false;
    }
    
    return entry.isHealthy;
  }

  /**
   * Create Autotask client for specific tenant using @apigrate/autotask-restapi
   */
  private async createTenantClient(credentials: AutotaskCredentials, impersonationResourceId?: number): Promise<AutotaskRestApi> {
    try {
      const { username, secret, integrationCode } = credentials;
      
      this.logger.info('Creating Autotask client for tenant...', { 
        impersonationResourceId: impersonationResourceId ? `[Resource ID: ${impersonationResourceId}]` : undefined,
        credentials: {
          username: username ? `${username.substring(0, 8)}***` : undefined,
          secret: secret ? `${secret.substring(0, 3)}***` : undefined,
          integrationCode
        }
      });

      if (!username || !secret || !integrationCode) {
        throw new Error('Missing required Autotask credentials: username, secret, and integrationCode are required');
      }

      // @apigrate/autotask-restapi uses synchronous constructor
      // Zone discovery happens automatically on first API call
      const client = new AutotaskRestApi(
        username,
        secret,
        integrationCode
      );
      
      this.logger.info('✅ Autotask client created (zone will be discovered on first call)', {
        impersonationResourceId: impersonationResourceId ? `[Resource ID: ${impersonationResourceId}]` : undefined 
      });

      // Note: @apigrate/autotask-restapi handles impersonation via ImpersonationResourceId header
      // Store impersonation info for later use if needed
      if (impersonationResourceId) {
        this.logger.info(`Impersonation will be used for resource ID: ${impersonationResourceId}`);
      }
      
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
   * Uses @apigrate/autotask-restapi which has synchronous constructor
   */
  async initialize(): Promise<void> {
    try {
      const { username, secret, integrationCode } = this.config.autotask || {};
      
      if (!username || !secret || !integrationCode) {
        const missing = [];
        if (!username) missing.push('AUTOTASK_USERNAME');
        if (!secret) missing.push('AUTOTASK_SECRET');
        if (!integrationCode) missing.push('AUTOTASK_INTEGRATION_CODE');
        
        throw new Error(
          `Single-tenant mode requires Autotask credentials. Missing: ${missing.join(', ')}. ` +
          `Either set these environment variables, or enable multi-tenant mode with MULTI_TENANT_ENABLED=true ` +
          `and pass credentials in each request via _tenant argument.`
        );
      }

      this.logger.info('Initializing Autotask client (@apigrate/autotask-restapi)...');
      
      // @apigrate/autotask-restapi uses synchronous constructor
      // Zone discovery happens automatically on first API call
      this.client = new AutotaskRestApi(
        username,
        secret,
        integrationCode
      );

      this.logger.info('✅ Autotask client initialized successfully (zone will be discovered on first call)');
    } catch (error) {
      this.logger.error('Failed to initialize Autotask client:', error);
      throw error;
    }
  }

  /**
   * Ensure client is initialized (with lazy initialization) - single-tenant mode
   */
  private async ensureClient(): Promise<AutotaskRestApi> {
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

  // Company operations (updated to support multi-tenant and @apigrate/autotask-restapi)
  async getCompany(id: number, tenantContext?: TenantContext): Promise<AutotaskCompany | null> {
    const startTime = Date.now();
    const cacheKey = tenantContext ? this.getTenantCacheKey(tenantContext.credentials!) : 'single-tenant';
    
    this.logger.info('🏢 Getting company by ID', {
      companyId: id,
      hasTenantContext: !!tenantContext,
      tenantId: tenantContext?.tenantId,
      operation: 'getCompany'
    });

    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting company with ID: ${id}`, { tenant: tenantContext?.tenantId });
      
      // @apigrate/autotask-restapi uses Companies.get(id)
      const result = await client.Companies.get(id);
      
      const executionTime = Date.now() - startTime;
      this.markClientHealthy(cacheKey);
      
      this.logger.info('✅ Company retrieved successfully', {
        companyId: id,
        found: !!result?.item,
        tenantId: tenantContext?.tenantId,
        executionTimeMs: executionTime
      });
      
      // @apigrate returns { item: ... } for get operations
      return result?.item as AutotaskCompany || null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.markClientError(cacheKey);
      
      // Handle error - AutotaskApiError or standard Error
      const err = error as Error & { status?: number; details?: unknown };
      this.logger.error(`❌ Failed to get company ${id}:`, {
        companyId: id,
        tenantId: tenantContext?.tenantId,
        error: err.message || 'Unknown error',
        status: err.status,
        details: err.details,
        executionTimeMs: executionTime
      });
      throw error;
    }
  }

  /**
   * Search companies with pagination metadata
   * Returns PaginatedResponse for "Showing X of Y" pattern
   */
  async searchCompaniesWithPagination(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<PaginatedResponse<AutotaskCompany>> {
    const startTime = Date.now();
    const cacheKey = tenantContext ? this.getTenantCacheKey(tenantContext.credentials!) : 'single-tenant';
    
    this.logger.info('🔍 Searching companies with pagination', {
      hasTenantContext: !!tenantContext,
      tenantId: tenantContext?.tenantId,
      operation: 'searchCompaniesWithPagination'
    });

    const client = await this.getClientForTenant(tenantContext);
    
    try {
      // Build filter array for @apigrate/autotask-restapi
      let filterArray: any[] = [];
      
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0) || 
          (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)) {
        filterArray = [{ op: 'gte', field: 'id', value: 0 }];
      } else if (!Array.isArray(options.filter)) {
        for (const [field, value] of Object.entries(options.filter)) {
          filterArray.push({ op: 'eq', field, value });
        }
      } else {
        filterArray = options.filter;
      }

      // Enforce page size limits from centralized config
      const pageSize = Math.min(options.pageSize || PAGINATION_CONFIG.DEFAULT_PAGE_SIZE, PAGINATION_CONFIG.MAX_PAGE_SIZE);
      const currentPage = options.page || 1;
      
      // Use @apigrate/autotask-restapi query method
      const queryBody: any = { filter: filterArray };
      if (options.includeFields) queryBody.includeFields = options.includeFields;
      
      // Calculate how many items we need based on page and pageSize
      const itemsNeeded = currentPage * pageSize;
      const apiMaxPerCall = PAGINATION_CONFIG.API_MAX;
      
      this.logger.info('📡 Calling Companies.query with @apigrate', { 
        filterArray, 
        pageSize, 
        currentPage,
        itemsNeeded,
        maxAllowed: PAGINATION_CONFIG.MAX_PAGE_SIZE 
      });
      
      // Fetch first batch
      let result = await client.Companies.query(queryBody);
      this.markClientHealthy(cacheKey);
      
      let companies: AutotaskCompany[] = result.items || [];
      let pageDetails = result.pageDetails as AutotaskPageDetails | undefined;
      
      // If we need more items and there's a next page, fetch additional pages
      // This allows returning up to 1000 items by fetching 2 API pages (2 x 500)
      let fetchCount = 1;
      const maxFetches = Math.ceil(PAGINATION_CONFIG.MAX_ITEMS_PER_CALL / apiMaxPerCall);
      
      while (companies.length < itemsNeeded && pageDetails?.nextPageUrl && fetchCount < maxFetches) {
        this.logger.info(`Fetching additional page (${fetchCount + 1}/${maxFetches}) - have ${companies.length}, need ${itemsNeeded}`);
        
        try {
          // @apigrate uses nextPageUrl for pagination - we need to make another query
          // For now, we've fetched what we can from the first call
          // TODO: Implement nextPageUrl following if needed
          break;
        } catch (nextPageError) {
          this.logger.warn('Failed to fetch next page:', nextPageError);
          break;
        }
      }
      
      // Handle page-based pagination (slice results based on page and pageSize)
      const startIndex = (currentPage - 1) * pageSize;
      const endIndex = startIndex + pageSize;
      
      this.logger.info('Pagination calculation for companies:', {
        totalFromAPI: companies.length,
        currentPage,
        pageSize,
        startIndex,
        endIndex,
        willSlice: startIndex > 0 || companies.length > pageSize
      });
      
      // Apply pagination offset and limit
      if (startIndex > 0 || companies.length > pageSize) {
        companies = companies.slice(startIndex, endIndex);
        this.logger.info(`Companies sliced for page ${currentPage}: showing ${companies.length} items`);
      }
      
      // Optimize company data to reduce response size - keep only essential fields
      const optimizedCompanies = companies.map(company => this.optimizeCompanyData(company));
      
      // Try to get total count if not in pageDetails
      let totalCount: number | undefined;
      try {
        const countResult = await client.Companies.count({ filter: filterArray }) as AutotaskCountResponse;
        totalCount = countResult.queryCount;
      } catch (countError) {
        this.logger.warn('Could not get total count for companies:', countError);
      }
      
      const pagination = createPaginationInfo(
        optimizedCompanies.length,
        pageDetails,
        totalCount,
        currentPage,
        pageSize
      );
      
      const executionTime = Date.now() - startTime;
      this.logger.info(`✅ Retrieved ${optimizedCompanies.length} companies with pagination`, {
        tenantId: tenantContext?.tenantId,
        showing: pagination.showing,
        total: pagination.total,
        hasMore: pagination.hasMore,
        executionTimeMs: executionTime
      });
      
      return createPaginatedResponse(optimizedCompanies, pagination, 'search_companies');
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.markClientError(cacheKey);
      
      const err = error as Error & { status?: number; details?: unknown };
      this.logger.error('❌ Failed to search companies:', {
        tenantId: tenantContext?.tenantId,
        error: err.message || 'Unknown error',
        status: err.status,
        details: err.details,
        executionTimeMs: executionTime
      });
      throw error;
    }
  }

  /**
   * Search companies (backward compatible - returns array only)
   * @deprecated Use searchCompaniesWithPagination for pagination support
   */
  async searchCompanies(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskCompany[]> {
    const result = await this.searchCompaniesWithPagination(options, tenantContext);
    return result.items;
  }

  /**
   * Optimize company data to reduce response size for listings.
   * Keeps only essential fields needed for company listings/searches.
   * Based on Autotask Companies Entity documentation.
   */
  private optimizeCompanyData(company: AutotaskCompany): AutotaskCompany {
    // Keep only essential fields for listings - reduces ~2KB per company to ~200 bytes
    const optimized: AutotaskCompany = {};
    
    // Core identification
    if (company.id !== undefined) optimized.id = company.id;
    if (company.companyName !== undefined) optimized.companyName = company.companyName;
    if (company.companyNumber !== undefined) optimized.companyNumber = company.companyNumber;
    if (company.companyType !== undefined) optimized.companyType = company.companyType;
    
    // Status
    if (company.isActive !== undefined) optimized.isActive = company.isActive;
    
    // Contact info (primary)
    if (company.phone !== undefined) optimized.phone = company.phone;
    if (company.webAddress !== undefined) optimized.webAddress = company.webAddress;
    
    // Location (summary)
    if (company.city !== undefined) optimized.city = company.city;
    if (company.state !== undefined) optimized.state = company.state;
    if (company.postalCode !== undefined) optimized.postalCode = company.postalCode;
    if (company.countryID !== undefined) optimized.countryID = company.countryID;
    
    // Organization
    if (company.ownerResourceID !== undefined) optimized.ownerResourceID = company.ownerResourceID;
    if (company.parentCompanyID !== undefined) optimized.parentCompanyID = company.parentCompanyID;
    if (company.territoryID !== undefined) optimized.territoryID = company.territoryID;
    
    // Classification
    if (company.classification !== undefined) optimized.classification = company.classification;
    if (company.marketSegmentID !== undefined) optimized.marketSegmentID = company.marketSegmentID;
    
    return optimized;
  }

  async createCompany(company: Partial<AutotaskCompany>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    const cacheKey = tenantContext ? this.getTenantCacheKey(tenantContext.credentials!) : 'single-tenant';
    
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
        apiEndpoint: 'Companies.create'
      });

      // @apigrate/autotask-restapi uses Companies.create()
      const result = await client.Companies.create(company as any);
      this.markClientHealthy(cacheKey);
      
      const companyId = result?.itemId;
      this.logger.info(`Company created with ID: ${companyId}`);
      return companyId;
    } catch (error) {
      this.markClientError(cacheKey);
      this.logger.error('Failed to create company:', error);
      throw error;
    }
  }

  async updateCompany(id: number, updates: Partial<AutotaskCompany>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating company ${id}:`, updates);
      await client.Companies.update({ id, ...updates } as any);
      this.logger.info(`Company ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update company ${id}:`, error);
      throw error;
    }
  }

  // Contact operations
  async getContact(id: number, tenantContext?: TenantContext): Promise<AutotaskContact | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting contact with ID: ${id}`);
      const result = await client.Contacts.get(id);
      // @apigrate returns result.item for get operations
      return (result?.item || null) as AutotaskContact;
    } catch (error) {
      this.logger.error(`Failed to get contact ${id}:`, error);
      throw error;
    }
  }

  async searchContacts(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskContact[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching contacts with options:', options);
      
      // Build filter array for @apigrate/autotask-restapi
      let filterArray: any[] = [];
      
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0) || 
          (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)) {
        filterArray = [{ op: 'gte', field: 'id', value: 0 }];
      } else if (!Array.isArray(options.filter)) {
        for (const [field, value] of Object.entries(options.filter)) {
          filterArray.push({ op: 'eq', field, value });
        }
      } else {
        filterArray = options.filter;
      }

      // @apigrate query format - only filter and includeFields are valid
      const queryBody: any = { filter: filterArray };
      if (options.includeFields) queryBody.includeFields = options.includeFields;
      
      this.logger.info('Calling Contacts.query with @apigrate:', { filterArray });

      const result = await client.Contacts.query(queryBody);
      let contacts = (result?.items || []) as AutotaskContact[];
      
      // Apply page size limit in code (API returns up to 500)
      const maxResults = Math.min(options.pageSize || PAGINATION_CONFIG.DEFAULT_PAGE_SIZE, PAGINATION_CONFIG.MAX_PAGE_SIZE);
      if (contacts.length > maxResults) {
        contacts = contacts.slice(0, maxResults);
        this.logger.info(`Results capped to ${maxResults} (from ${result?.items?.length || 0})`);
      }
      
      this.logger.info(`Retrieved ${contacts.length} contacts`);
      return contacts;
    } catch (error) {
      this.logger.error('Failed to search contacts:', error);
      throw error;
    }
  }

  async createContact(contact: Partial<AutotaskContact>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating contact:', contact);
      const result = await client.CompanyContacts.create(contact.companyID, contact as any);
      const contactId = result?.itemId;
      this.logger.info(`Contact created with ID: ${contactId}`);
      return contactId;
    } catch (error) {
      this.logger.error('Failed to create contact:', error);
      throw error;
    }
  }

  async updateContact(id: number, updates: Partial<AutotaskContact>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating contact ${id}:`, updates);
      // Contacts are child entities - need parent company ID
      const companyID = (updates as any).companyID;
      await client.CompanyContacts.update(companyID, { id, ...updates } as any);
      this.logger.info(`Contact ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update contact ${id}:`, error);
      throw error;
    }
  }

  // Ticket operations
  async getTicket(id: number, fullDetails: boolean = false, tenantContext?: TenantContext): Promise<AutotaskTicket | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting ticket with ID: ${id}, fullDetails: ${fullDetails}`);
      
      const result = await client.Tickets.get(id);
      // @apigrate returns result.item for get operations
      const ticket = (result?.item || null) as AutotaskTicket;
      
      if (!ticket) {
        return null;
      }
      
      // Apply optimization unless full details requested
      return fullDetails ? ticket : this.optimizeTicketData(ticket);
    } catch (error) {
      this.logger.error(`Failed to get ticket ${id}:`, error);
      throw error;
    }
  }

  async getTicketByNumber(ticketNumber: string, fullDetails: boolean = false, tenantContext?: TenantContext): Promise<AutotaskTicket | null> {
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
        ]
      };

      this.logger.info('Calling Tickets.query for ticket number');
      
      const result = await client.Tickets.query(searchBody);
      const tickets = (result?.items || []) as AutotaskTicket[];
      
      if (tickets.length === 0) {
        this.logger.info(`Ticket with number ${ticketNumber} not found`);
        return null;
      }
      
      const ticket = tickets[0];
      this.logger.info(`Found ticket with number ${ticketNumber}, ID: ${ticket.id}`);
      
      // Apply optimization unless full details requested
      return fullDetails ? ticket : this.optimizeTicketData(ticket);
    } catch (error) {
      this.logger.error(`Failed to get ticket by number ${ticketNumber}:`, error);
      throw error;
    }
  }



  async searchTickets(options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskTicket[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('🎫 Searching tickets', {
        tenantId: tenantContext?.tenantId,
        impersonationResourceId: tenantContext?.impersonationResourceId,
        hasSearchTerm: !!options.searchTerm,
        hasStatusFilter: options.status !== undefined,
        pageSize: options.pageSize,
        operation: 'searchTickets'
      });

      // Log detailed API parameters
      this.logger.info('📋 API Parameters for searchTickets', {
        tenantId: tenantContext?.tenantId,
        impersonationResourceId: tenantContext?.impersonationResourceId,
        searchCriteria: {
          searchTerm: options.searchTerm,
          status: options.status,
          pageSize: options.pageSize,
          // Don't log the full filter array as it can be large, just summary
          filterCount: 'will be calculated'
        },
        apiEndpoint: 'Tickets.query'
      });
      
      // Build proper filter array for Autotask API
      const filters: any[] = [];
      
      // Handle searchTerm - search in ticket number and title
      if (options.searchTerm) {
        const searchTerm = options.searchTerm;
        
        // Smart search: determine search strategy based on the term format
        const looksLikeTicketNumber = /^T\d+\.\d+$/.test(searchTerm);
        
        if (looksLikeTicketNumber) {
          // For ticket number format, search ticket number field first
          filters.push({
            op: 'eq',
            field: 'ticketNumber',
            value: searchTerm
          });
        } else {
          // For other search terms, search in title first
          filters.push({
            op: 'contains',
            field: 'title',
            value: searchTerm
          });
        }
      }
      
      // Handle status filter with more accurate open ticket definition
      if (options.status !== undefined) {
        filters.push({
          op: 'eq',
          field: 'status',
          value: options.status
        });
      }
      
      // If no other filters specified, add a base filter to ensure query works
      // (Autotask API requires at least one filter)
      if (filters.length === 0) {
        // Use id >= 0 as a base filter to get all tickets
        filters.push({
          op: 'gte',
          field: 'id',
          value: 0
        });
      }
      
      // Handle assignedResourceID filter or unassigned filter
      if (options.unassigned === true) {
        // Search for tickets with no assigned resource (null assignedResourceID)
        filters.push({
          op: 'eq',
          field: 'assignedResourceID',
          value: null
        });
      } else if (options.assignedResourceID !== undefined) {
        filters.push({
          op: 'eq',
          field: 'assignedResourceID',
          value: options.assignedResourceID
        });
      }
      
      // Handle priority filter
      if (options.priority !== undefined) {
        filters.push({
          op: 'eq',
          field: 'priority',
          value: options.priority
        });
      }
      
      // Only add company filter if explicitly provided
      if (options.companyId !== undefined) {
        filters.push({
          op: 'eq',
          field: 'companyID',
          value: options.companyId
        });
      }
      
      // Handle projectID filter
      if (options.projectId !== undefined) {
        filters.push({
          op: 'eq',
          field: 'projectID',
          value: options.projectId
        });
      }
      
      // Handle contractID filter
      if (options.contractId !== undefined) {
        filters.push({
          op: 'eq',
          field: 'contractID',
          value: options.contractId
        });
      }
      
      // Handle createdDate range filters
      if (options.createdDateFrom) {
        filters.push({
          op: 'gte',
          field: 'createDate',
          value: options.createdDateFrom
        });
      }
      
      if (options.createdDateTo) {
        filters.push({
          op: 'lte',
          field: 'createDate',
          value: options.createdDateTo
        });
      }
      
      // Handle completedDate range filters
      if (options.completedDateFrom) {
        filters.push({
          op: 'gte',
          field: 'completedDate',
          value: options.completedDateFrom
        });
      }
      
      if (options.completedDateTo) {
        filters.push({
          op: 'lte',
          field: 'completedDate',
          value: options.completedDateTo
        });
      }
      
      // @apigrate query format - only filter is valid
      const queryBody = { filter: filters };
      const maxResults = Math.min(options.pageSize || PAGINATION_CONFIG.DEFAULT_PAGE_SIZE, PAGINATION_CONFIG.MAX_PAGE_SIZE);

      this.logger.info('Calling Tickets.query with @apigrate:', { 
        filterCount: filters.length,
        filters: filters.map(f => `${f.field} ${f.op} ${f.value}`)
      });
      
      // Use @apigrate/autotask-restapi query method
      const result = await client.Tickets.query(queryBody);
      
      this.logger.info('Tickets.query raw response:', {
        hasResult: !!result,
        hasItems: !!(result?.items),
        itemCount: result?.items?.length || 0,
        pageDetails: result?.pageDetails
      });
      
      let tickets = (result?.items || []) as AutotaskTicket[];
      
      // Handle page-based pagination (since @apigrate returns up to 500 at once)
      const page = options.page || 1;
      const startIndex = (page - 1) * maxResults;
      const endIndex = startIndex + maxResults;
      
      this.logger.info('Pagination calculation:', {
        totalFromAPI: tickets.length,
        page,
        maxResults,
        startIndex,
        endIndex
      });
      
      // Apply pagination offset and limit
      if (startIndex > 0 || tickets.length > maxResults) {
        tickets = tickets.slice(startIndex, endIndex);
        this.logger.info(`Tickets sliced for page ${page}: showing ${tickets.length} items (index ${startIndex}-${endIndex})`);
      }
      
      // Log API call result
      this.logger.info('📊 API Result for searchTickets', {
        tenantId: tenantContext?.tenantId,
        resultCount: tickets.length,
        filterCount: filters.length
      });
      
      const optimizedTickets = tickets.map(ticket => this.optimizeTicketDataAggressive(ticket));
      
      this.logger.info(`✅ Retrieved ${optimizedTickets.length} tickets`, {
        tenantId: tenantContext?.tenantId,
        resultCount: optimizedTickets.length
      });
      return optimizedTickets;
    } catch (error) {
      this.logger.error('Failed to search tickets:', error);
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

  async createTicket(ticket: Partial<AutotaskTicket>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating ticket:', ticket);
      const result = await client.Tickets.create(ticket as any);
      const ticketId = result?.itemId;
      this.logger.info(`Ticket created with ID: ${ticketId}`);
      return ticketId;
    } catch (error) {
      this.logger.error('Failed to create ticket:', error);
      throw error;
    }
  }

  async updateTicket(id: number, updates: Partial<AutotaskTicket>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating ticket ${id}:`, updates);
      await client.Tickets.update({ id, ...updates } as any);
      this.logger.info(`Ticket ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update ticket ${id}:`, error);
      throw error;
    }
  }

  // Time entry operations
  async createTimeEntry(timeEntry: Partial<AutotaskTimeEntry>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating time entry:', timeEntry);
      const result = await client.TimeEntries.create(timeEntry as any);
      const timeEntryId = result?.itemId;
      this.logger.info(`Time entry created with ID: ${timeEntryId}`);
      return timeEntryId;
    } catch (error) {
      this.logger.error('Failed to create time entry:', error);
      throw error;
    }
  }

  /**
   * Get time entries with full pagination metadata
   * Returns PaginatedResponse with "Showing X of Y" pattern
   * CRITICAL: This is the primary method for time entry searches
   */
  async getTimeEntriesWithPagination(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<PaginatedResponse<AutotaskTimeEntry>> {
    const startTime = Date.now();
    const cacheKey = tenantContext ? this.getTenantCacheKey(tenantContext.credentials!) : 'single-tenant';
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('⏱️ Getting time entries with pagination', { options });
      
      // Build filter array for @apigrate/autotask-restapi
      let filterArray: any[] = [];
      
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0) || 
          (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)) {
        filterArray = [{ op: 'gte', field: 'id', value: 0 }];
      } else if (!Array.isArray(options.filter)) {
        for (const [field, value] of Object.entries(options.filter)) {
          filterArray.push({ op: 'eq', field, value });
        }
      } else {
        filterArray = options.filter;
      }

      const pageSize = options.pageSize || 100;
      const currentPage = options.page || 1;
      
      // Use @apigrate/autotask-restapi query method for TimeEntries
      const queryBody: any = { filter: filterArray };
      
      this.logger.info('📡 Calling TimeEntries.query with @apigrate', { filterArray, pageSize, currentPage });
      
      const result = await client.TimeEntries.query(queryBody);
      
      this.markClientHealthy(cacheKey);
      
      let timeEntries: AutotaskTimeEntry[] = result.items || [];
      const pageDetails = result.pageDetails as AutotaskPageDetails | undefined;
      
      // Handle page-based pagination (slice results based on page and pageSize)
      const maxPageSize = Math.min(pageSize, PAGINATION_CONFIG.MAX_PAGE_SIZE);
      const startIndex = (currentPage - 1) * maxPageSize;
      const endIndex = startIndex + maxPageSize;
      
      this.logger.info('Pagination calculation for time entries:', {
        totalFromAPI: timeEntries.length,
        currentPage,
        maxPageSize,
        startIndex,
        endIndex
      });
      
      // Apply pagination offset and limit
      if (startIndex > 0 || timeEntries.length > maxPageSize) {
        timeEntries = timeEntries.slice(startIndex, endIndex);
        this.logger.info(`Time entries sliced for page ${currentPage}: showing ${timeEntries.length} items`);
      }
      
      // Get total count for accurate "Showing X of Y"
      let totalCount: number | undefined;
      try {
        const countResult = await client.TimeEntries.count({ filter: filterArray }) as AutotaskCountResponse;
        totalCount = countResult.queryCount;
        this.logger.info(`📊 Total time entries matching filter: ${totalCount}`);
      } catch (countError) {
        this.logger.warn('Could not get total count for time entries:', countError);
        // Fall back to pageDetails count if available
        totalCount = pageDetails?.count;
      }
      
      const pagination = createPaginationInfo(
        timeEntries.length,
        pageDetails,
        totalCount,
        currentPage,
        pageSize
      );
      
      const executionTime = Date.now() - startTime;
      this.logger.info(`✅ Retrieved ${timeEntries.length} time entries with pagination`, {
        tenantId: tenantContext?.tenantId,
        showing: pagination.showing,
        total: pagination.total,
        hasMore: pagination.hasMore,
        percentComplete: pagination.percentComplete,
        executionTimeMs: executionTime
      });
      
      // Log warning if incomplete data
      if (pagination.hasMore) {
        this.logger.warn(`⚠️ INCOMPLETE DATA: Showing ${pagination.showing} of ${pagination.total} time entries (${pagination.percentComplete}%)`);
      }
      
      return createPaginatedResponse(timeEntries, pagination, 'search_time_entries');
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.markClientError(cacheKey);
      
      const err = error as Error & { status?: number; details?: unknown };
      this.logger.error('❌ Failed to get time entries:', {
        tenantId: tenantContext?.tenantId,
        error: err.message || 'Unknown error',
        status: err.status,
        details: err.details,
        executionTimeMs: executionTime
      });
      throw error;
    }
  }

  /**
   * Get time entries (backward compatible - returns array only)
   * @deprecated Use getTimeEntriesWithPagination for pagination support
   */
  async getTimeEntries(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskTimeEntry[]> {
    const result = await this.getTimeEntriesWithPagination(options, tenantContext);
    return result.items;
  }

  async getTimeEntry(id: number, tenantContext?: TenantContext): Promise<AutotaskTimeEntry | null> {
    const cacheKey = tenantContext ? this.getTenantCacheKey(tenantContext.credentials!) : 'single-tenant';
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting time entry with ID: ${id}`);
      
      // @apigrate/autotask-restapi uses TimeEntries.get(id)
      const result = await client.TimeEntries.get(id);
      
      this.markClientHealthy(cacheKey);
      
      if (result?.item) {
        this.logger.info(`Retrieved time entry ${id}`);
        return result.item as AutotaskTimeEntry;
      }
      
      this.logger.info(`Time entry ${id} not found`);
      return null;
    } catch (error) {
      this.markClientError(cacheKey);
      this.logger.error(`Failed to get time entry ${id}:`, error);
      throw error;
    }
  }

  // Project operations
  async getProject(id: number, tenantContext?: TenantContext): Promise<AutotaskProject | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting project with ID: ${id}`);
      const result = await client.Projects.get(id);
      
      // @apigrate returns result.item for get operations
      return (result?.item || null) as AutotaskProject;
    } catch (error) {
      this.logger.error(`Failed to get project ${id}:`, error);
      throw error;
    }
  }

  async searchProjects(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskProject[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching projects with options:', options);
      
      // WORKAROUND: The autotask-node library's projects.list() method is broken
      // It uses GET with query params instead of POST with body like the working companies endpoint
      // We'll bypass it and make the correct API call directly
      
      // Prepare search body - let API return all available fields instead of restricting them
      const searchBody: any = {};
      
      // Ensure there's a filter - Autotask API requires a filter
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0) || 
          (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)) {
        searchBody.filter = [
          {
            "op": "gte",
            "field": "id",
            "value": 0
          }
        ];
      } else {
        // If filter is provided as an object, convert to array format expected by API
        if (!Array.isArray(options.filter)) {
          const filterArray = [];
          for (const [field, value] of Object.entries(options.filter)) {
            filterArray.push({
              "op": "eq",
              "field": field,
              "value": value
            });
          }
          searchBody.filter = filterArray;
        } else {
          searchBody.filter = options.filter;
        }
      }

      // Add other search parameters
      if (options.sort) searchBody.sort = options.sort;
      if (options.page) searchBody.page = options.page;
      
      // @apigrate query format - only filter and includeFields are valid
      // pageSize/MaxRecords are NOT valid query body parameters
      this.logger.info('Calling Projects.query with @apigrate:', { filter: searchBody.filter });

      // Make the API call using @apigrate library
      const result = await client.Projects.query({ filter: searchBody.filter });
      
      // Extract projects from response
      let projects: AutotaskProject[] = [];
      if (result && result.items) {
        projects = result.items;
      } else if (Array.isArray(result)) {
        projects = result;
      } else {
        this.logger.warn('Unexpected response format from Projects.query');
        projects = [];
      }
      
      // Apply page size limit in code (API returns up to 500)
      const maxResults = Math.min(options.pageSize || PAGINATION_CONFIG.DEFAULT_PAGE_SIZE, PAGINATION_CONFIG.MAX_PAGE_SIZE);
      if (projects.length > maxResults) {
        this.logger.info(`Projects capped from ${projects.length} to ${maxResults}`);
        projects = projects.slice(0, maxResults);
      }
      
      // Transform projects to optimize data size
      const optimizedProjects = projects.map(project => this.optimizeProjectData(project));
      
      this.logger.info(`✅ Projects search successful:`, {
        resultCount: optimizedProjects.length,
        fieldsReturned: projects.length > 0 ? Object.keys(projects[0]).length : 0
      });
      
      return optimizedProjects;
    } catch (error: any) {
      // Check if it's the same 405 error pattern
      if (error.response && error.response.status === 405) {
        this.logger.warn('Projects endpoint may not support listing via API (405 Method Not Allowed). This is common with some Autotask configurations.');
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

  async createProject(project: Partial<AutotaskProject>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating project:', project);
      const result = await client.Projects.create(project as any);
      const projectId = result?.itemId;
      this.logger.info(`Project created with ID: ${projectId}`);
      return projectId;
    } catch (error) {
      this.logger.error('Failed to create project:', error);
      throw error;
    }
  }

  async updateProject(id: number, updates: Partial<AutotaskProject>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating project ${id}:`, updates);
      await client.Projects.update({ id, ...updates } as any);
      this.logger.info(`Project ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update project ${id}:`, error);
      throw error;
    }
  }

  // Resource operations
  async getResource(id: number, tenantContext?: TenantContext): Promise<AutotaskResource | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try { 
      const result = await client.Resources.get(id); 
      
      // @apigrate returns result.item for get operations
      return (result?.item || null) as AutotaskResource;
    } catch (error) {
      this.logger.error(`Failed to get resource ${id}:`, error);
      throw error;
    }
  }

  async searchResources(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskResource[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching resources with options:', options);
      

      // Prepare search body in the same format as working endpoints
      const searchBody: any = {};
      
      // Ensure there's a filter - Autotask API requires a filter
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0) || 
          (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)) {
        searchBody.filter = [
          {
            "op": "gte",
            "field": "id",
            "value": 0
          }
        ];
      } else {
        // If filter is provided as an object, convert to array format expected by API
        if (!Array.isArray(options.filter)) {
          const filterArray = [];
          for (const [field, value] of Object.entries(options.filter)) {
            filterArray.push({
              "op": "eq",
              "field": field,
              "value": value
            });
          }
          searchBody.filter = filterArray;
        } else {
          searchBody.filter = options.filter;
        }
      }

      // Add other search parameters
      if (options.sort) searchBody.sort = options.sort;
      if (options.page) searchBody.page = options.page;
      
      // @apigrate query format - only filter and includeFields are valid
      this.logger.info('Calling Resources.query with @apigrate:', { filter: searchBody.filter });

      // Use @apigrate/autotask-restapi query method
      const result = await client.Resources.query({ filter: searchBody.filter });
      
      this.logger.info('✅ Resources.query successful:', {
        hasItems: !!(result && result.items),
        itemsLength: result?.items?.length
      });

      // Extract resources from response
      let resources: AutotaskResource[] = [];
      if (result && result.items) {
        resources = result.items;
      } else if (Array.isArray(result)) {
        resources = result;
      } else {
        this.logger.warn('❌ Unexpected response format from Resources.query');
        resources = [];
      }
      
      // Apply page size limit in code (API returns up to 500)
      const maxResults = Math.min(options.pageSize || PAGINATION_CONFIG.DEFAULT_PAGE_SIZE, PAGINATION_CONFIG.MAX_PAGE_SIZE);
      if (resources.length > maxResults) {
        this.logger.info(`Resources capped from ${resources.length} to ${maxResults}`);
        resources = resources.slice(0, maxResults);
      }
      
      this.logger.info(`Retrieved ${resources.length} resources`);
      return resources;
    } catch (error: any) {
      // Check if it's the same 405 error pattern
      if (error.response && error.response.status === 405) {
        this.logger.warn('Resources endpoint may not support listing via API (405 Method Not Allowed). This is common with some Autotask configurations.');
        return [];
      }
      this.logger.error('Failed to search resources:', error);
      throw error;
    }
  }

  // Opportunity operations
  async searchOpportunities(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskOpportunity[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching opportunities with options:', options);
      
      // Build filter array for @apigrate/autotask-restapi
      let filterArray: any[] = [];
      
      if (options.filter) {
        if (Array.isArray(options.filter)) {
          filterArray = options.filter.map(filter => {
            if (typeof filter === 'string') {
              return { op: "contains", field: "title", value: filter };
            }
            return filter;
          });
        } else if (typeof options.filter === 'object') {
          for (const [field, value] of Object.entries(options.filter)) {
            filterArray.push({ op: 'eq', field, value });
          }
        }
      }
      
      // Default filter if none provided
      if (filterArray.length === 0) {
        filterArray = [{ op: 'gte', field: 'id', value: 0 }];
      }

      // @apigrate query format - only filter is valid
      const queryBody = { filter: filterArray };
      
      this.logger.info('Calling Opportunities.query with @apigrate:', { filterCount: queryBody.filter.length });
      
      try {
        const result = await client.Opportunities.query(queryBody);
        
        this.logger.info('✅ Opportunities.query successful:', {
          hasItems: !!(result && result.items),
          itemsLength: result?.items?.length
        });
        
        return (result?.items || []) as AutotaskOpportunity[];
      } catch (apiError: any) {
        this.logger.error('❌ Opportunities.query failed:', {
          error: apiError?.message,
          details: apiError?.details
        });
        throw apiError;
      }
    } catch (error) {
      this.logger.error('Failed to search opportunities:', error);
      throw error;
    }
  }

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
  async getConfigurationItem(id: number, tenantContext?: TenantContext): Promise<AutotaskConfigurationItem | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting configuration item with ID: ${id}`);
      const result = await client.ConfigurationItems.get(id);
      // @apigrate returns result.item for get operations
      return (result?.item || null) as AutotaskConfigurationItem;
    } catch (error) {
      this.logger.error(`Failed to get configuration item ${id}:`, error);
      throw error;
    }
  }

  async searchConfigurationItems(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskConfigurationItem[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching configuration items with options:', options);
      
      // Build filter for @apigrate
      let filterArray: any[] = [];
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0)) {
        filterArray = [{ op: 'gte', field: 'id', value: 0 }];
      } else if (!Array.isArray(options.filter)) {
        for (const [field, value] of Object.entries(options.filter)) {
          filterArray.push({ op: 'eq', field, value });
        }
      } else {
        filterArray = options.filter;
      }
      
      const result = await client.ConfigurationItems.query({ filter: filterArray });
      let items = (result?.items || []) as AutotaskConfigurationItem[];
      
      // Apply page size limit
      const maxResults = Math.min(options.pageSize || PAGINATION_CONFIG.DEFAULT_PAGE_SIZE, PAGINATION_CONFIG.MAX_PAGE_SIZE);
      if (items.length > maxResults) {
        items = items.slice(0, maxResults);
      }
      
      return items;
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
      await client.configurationItems.update(id, updates as any);
      this.logger.info(`Configuration item ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update configuration item ${id}:`, error);
      throw error;
    }
  }

  // Product operations (Note: products endpoint may not be available in autotask-node)
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
  async getContract(id: number, tenantContext?: TenantContext): Promise<AutotaskContract | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting contract with ID: ${id}`);
      const result = await client.Contracts.get(id);
      return (result?.item || null) as AutotaskContract;
    } catch (error) {
      this.logger.error(`Failed to get contract ${id}:`, error);
      throw error;
    }
  }

  async searchContracts(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskContract[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching contracts with options:', options);
      
      // Build filter array for @apigrate/autotask-restapi
      let filterArray: any[] = [];
      
      if (options.filter) {
        if (Array.isArray(options.filter)) {
          filterArray = options.filter.map(filter => {
            if (typeof filter === 'string') {
              return { op: "contains", field: "ContractName", value: filter };
            }
            return filter;
          });
        } else if (typeof options.filter === 'object') {
          for (const [field, value] of Object.entries(options.filter)) {
            filterArray.push({ op: 'eq', field, value });
          }
        }
      }
      
      // Default filter if none provided
      if (filterArray.length === 0) {
        filterArray = [{ op: 'gte', field: 'id', value: 0 }];
      }

      // @apigrate query format - only filter is valid
      const queryBody = { filter: filterArray };
      
      this.logger.info('Calling Contracts.query with @apigrate:', { filterCount: queryBody.filter.length });
      
      try {
        const result = await client.Contracts.query(queryBody);
        
        this.logger.info('✅ Contracts.query successful:', {
          hasItems: !!(result && result.items),
          itemsLength: result?.items?.length
        });

        // Extract contracts from response
        let contracts: AutotaskContract[] = [];
        if (result && result.items) {
          contracts = result.items;
        } else if (Array.isArray(result)) {
          contracts = result;
        } else {
          this.logger.warn('❌ Unexpected response format from Contracts.query');
          contracts = [];
        }
        
        // Apply page size limit in code (API returns up to 500)
        const maxResults = Math.min(options.pageSize || PAGINATION_CONFIG.DEFAULT_PAGE_SIZE, PAGINATION_CONFIG.MAX_PAGE_SIZE);
        if (contracts.length > maxResults) {
          this.logger.info(`Contracts capped from ${contracts.length} to ${maxResults}`);
          contracts = contracts.slice(0, maxResults);
        }
        
        this.logger.info(`✅ Contracts search completed: ${contracts.length} contracts`);
        return contracts;
      } catch (error) {
        this.logger.error('Failed to search contracts:', error);
        throw error;
      }
    } catch (error) {
      this.logger.error('Failed to search contracts:', error);
      throw error;
    }
  }

  // Invoice operations (read-only)
  async getInvoice(id: number, tenantContext?: TenantContext): Promise<AutotaskInvoice | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting invoice with ID: ${id}`);
      const result = await client.Invoices.get(id);
      return (result?.item || null) as AutotaskInvoice;
    } catch (error) {
      this.logger.error(`Failed to get invoice ${id}:`, error);
      throw error;
    }
  }

  async searchInvoices(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskInvoice[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching invoices with options:', options);
      

      // Log the options being passed to the library method
      this.logger.info('Invoice search options being passed to library:', {
        originalOptions: options,
        hasFilter: !!options.filter,
        filterType: Array.isArray(options.filter) ? 'array' : typeof options.filter,
        filterLength: Array.isArray(options.filter) ? options.filter.length : 'not array',
        pageSize: options.pageSize,
        page: options.page,
        sort: options.sort
      });

      // CORRECTED APPROACH: Use POST /Invoices/query with JSON body
      // According to https://webservices5.autotask.net/atservicesrest/swagger/ui/index#/Invoices/Invoices_Query
      // The POST version might be supported even if GET is not
      
      this.logger.info('Making direct POST API call to Invoices/query with JSON body (like Resources/Projects)');
       
      // Prepare search body in the same format as working endpoints
      const searchBody: any = {};
      
      // Ensure there's a filter - Autotask API requires a filter
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0) || 
          (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)) {
        searchBody.filter = [
          {
            "op": "gte",
            "field": "id",
            "value": 0
          }
        ];
      } else {
        // If filter is provided as an object, convert to array format expected by API
        if (!Array.isArray(options.filter)) {
          const filterArray = [];
          for (const [field, value] of Object.entries(options.filter)) {
            filterArray.push({
              "op": "eq",
              "field": field,
              "value": value
            });
          }
          searchBody.filter = filterArray;
        } else {
          searchBody.filter = options.filter;
        }
      }

      // Add other search parameters
      if (options.sort) searchBody.sort = options.sort;
      if (options.page) searchBody.page = options.page;
       
      // @apigrate query format - only filter is valid
      const queryBody = { filter: searchBody.filter };
      
      this.logger.info('Calling Invoices.query with @apigrate:', { filterCount: queryBody.filter.length });
      
      try {
        const result = await client.Invoices.query(queryBody);
        
        this.logger.info('✅ Invoices.query successful:', {
          hasItems: !!(result && result.items),
          itemsLength: result?.items?.length
        });

        // Extract invoices from response
        let invoices: AutotaskInvoice[] = [];
        if (result && result.items) {
          invoices = result.items;
        } else if (Array.isArray(result)) {
          invoices = result;
        } else {
          this.logger.warn('❌ Unexpected response format from Invoices.query');
          invoices = [];
        }
        
        // Apply page size limit in code (API returns up to 500)
        const maxResults = Math.min(options.pageSize || PAGINATION_CONFIG.DEFAULT_PAGE_SIZE, PAGINATION_CONFIG.MAX_PAGE_SIZE);
        if (invoices.length > maxResults) {
          this.logger.info(`Invoices capped from ${invoices.length} to ${maxResults}`);
          invoices = invoices.slice(0, maxResults);
        }
        
        this.logger.info(`✅ Retrieved ${invoices.length} invoices`);
        return invoices;
        
      } catch (directApiError: any) {
        this.logger.error('❌ Direct POST /Invoices/query failed:', {
          error: directApiError.message,
          name: directApiError.name,
          status: directApiError.response?.status,
          statusText: directApiError.response?.statusText,
          responseData: directApiError.response?.data,
          requestUrl: directApiError.config?.url,
          requestMethod: directApiError.config?.method,
          requestParams: directApiError.config?.params,
          timeout: directApiError.code === 'ECONNABORTED'
        });
        
        // Handle specific error cases
        if (directApiError.response && directApiError.response.status === 405) {
          this.logger.warn('Invoices endpoint may not support listing via API (405 Method Not Allowed). This is common with some Autotask configurations.');
          return [];
        }
        
        if (directApiError.code === 'ECONNABORTED') {
          this.logger.warn('Invoices request timed out after 15 seconds. The API may be overloaded or the query too complex.');
          return [];
        }
        
        throw directApiError;
      }
    } catch (error) {
      this.logger.error('Failed to search invoices:', error);
      throw error;
    }
  }

  // Task operations
  async getTask(id: number, tenantContext?: TenantContext): Promise<AutotaskTask | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting task with ID: ${id}`);
      
      const searchBody = {
        filter: [
          { field: 'id', op: 'eq', value: id }
        ]
      };

      this.logger.info('Calling Tasks.query with @apigrate:', searchBody);

      // Use @apigrate/autotask-restapi query method
      const result = await client.Tasks.query(searchBody);
      
      // Extract task from response
      let task: AutotaskTask | null = null;
      if (result && result.items && result.items.length > 0) {
        task = result.items[0];
      } else if (Array.isArray(result) && result.length > 0) {
        task = result[0];
      }
      
      if (task) {
        this.logger.info(`Retrieved task ${id}`);
        return task;
      }
      
      this.logger.info(`Task ${id} not found`);
      return null;
    } catch (error) {
      this.logger.error(`Failed to get task ${id}:`, error);
      throw error;
    }
  }

  async searchTasks(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskTask[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching tasks with options:', options);
      
      // Prepare search body
      const searchBody: any = {};
      
      // Ensure there's a filter - Autotask API requires a filter
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0) || 
          (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)) {
        searchBody.filter = [
          {
            "op": "gte",
            "field": "id",
            "value": 0
          }
        ];
      } else {
        // If filter is provided as an object, convert to array format expected by API
        if (!Array.isArray(options.filter)) {
          const filterArray = [];
          for (const [field, value] of Object.entries(options.filter)) {
            filterArray.push({
              "op": "eq",
              "field": field,
              "value": value
            });
          }
          searchBody.filter = filterArray;
        } else {
          searchBody.filter = options.filter;
        }
      }

      // Add other search parameters
      if (options.sort) searchBody.sort = options.sort;
      if (options.page) searchBody.page = options.page;
      
      // @apigrate query format - only filter is valid
      const queryBody = { filter: searchBody.filter };
      
      this.logger.info('Calling Tasks.query with @apigrate:', { filterCount: queryBody.filter.length });

      // Use @apigrate/autotask-restapi query method
      const result = await client.Tasks.query(queryBody);
      
      // Extract tasks from response
      let tasks: AutotaskTask[] = [];
      if (result && result.items) {
        tasks = result.items;
      } else if (Array.isArray(result)) {
        tasks = result;
      } else {
        this.logger.warn('Unexpected response format from Tasks.query');
        tasks = [];
      }
      
      // Apply page size limit in code (API returns up to 500)
      const maxResults = Math.min(options.pageSize || PAGINATION_CONFIG.DEFAULT_PAGE_SIZE, PAGINATION_CONFIG.MAX_PAGE_SIZE);
      if (tasks.length > maxResults) {
        this.logger.info(`Tasks capped from ${tasks.length} to ${maxResults}`);
        tasks = tasks.slice(0, maxResults);
      }
      
      // Transform tasks to optimize data size
      const optimizedTasks = tasks.map(task => this.optimizeTaskData(task));
      
      this.logger.info(`✅ Tasks search successful:`, {
        resultCount: optimizedTasks.length,
        fieldsReturned: tasks.length > 0 ? Object.keys(tasks[0]).length : 0
      });
      
      return optimizedTasks;
    } catch (error) {
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

  async createTask(task: Partial<AutotaskTask>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating task:', task);
      // Tasks are child entities of Projects
      const result = await client.Tasks.create(task.projectID, task as any);
      const taskID = result?.itemId;
      this.logger.info(`Task created with ID: ${taskID}`);
      return taskID;
    } catch (error) {
      this.logger.error('Failed to create task:', error);
      throw error;
    }
  }

  async updateTask(id: number, updates: Partial<AutotaskTask>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating task ${id}:`, updates);
      // Tasks are child entities - need parent project ID
      const projectID = (updates as any).projectID;
      await client.Tasks.update(projectID, { id, ...updates } as any);
      this.logger.info(`Task ${id} updated successfully`);
    } catch (error) {
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
          ]
        };
        
        const result = await client.Companies.query(searchBody);
        
        this.logger.info('Connection test successful (Companies.query):', { 
          hasItems: !!(result && result.items),
          itemCount: result?.items?.length || 0
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
      const result = await client.TicketNotes.query(searchBody);
      const notes = result?.items || [];
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
        ]
      };

      this.logger.info('Making direct API call to TicketNotes/query with body:', searchBody);

      // Use the correct TicketNotes/query endpoint
      const result = await client.TicketNotes.query(searchBody);
      const notes = result?.items || [];
      
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
      this.logger.info(`Creating ticket note for ticket ${ticketId}`);
      const noteData = {
        ...note,
        ticketId: ticketId
      };
      // TicketNotes is a child entity of Tickets
      const result = await client.TicketNotes.create(ticketId, noteData as any);
      const noteId = result?.itemId;
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
      const result = await client.ProjectNotes.query(searchBody);
      const notes = result?.items || [];
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
        ]
      };

      this.logger.info('Making direct API call to ProjectNotes/query with body:', searchBody);

      // Use the correct ProjectNotes/query endpoint
      const result = await client.ProjectNotes.query(searchBody);
      const notes = result?.items || [];
      
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
      this.logger.info(`Creating project note for project ${projectId}`);
      const noteData = {
        ...note,
        projectId: projectId
      };
      // ProjectNotes is a child entity of Projects
      const result = await client.ProjectNotes.create(projectId, noteData as any);
      const noteId = result?.itemId;
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
      const result = await client.CompanyNotes.query(searchBody);
      const notes = result?.items || [];
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
        ]
      };

      this.logger.info('Making direct API call to CompanyNotes/query with body:', searchBody);

      // Use the correct CompanyNotes/query endpoint
      const result = await client.CompanyNotes.query(searchBody);
      const notes = result?.items || [];
      
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
      this.logger.info(`Creating company note for company ${companyId}`);
      const noteData = {
        ...note,
        companyID: companyId
      };
      // CompanyNotes is a child entity of Companies
      const result = await client.CompanyNotes.create(companyId, noteData as any);
      const noteId = result?.itemId;
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
      const result = await client.TicketAttachments.query(searchBody);
      const attachments = result?.items || [];
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
        ]
      };

      this.logger.info('Making direct API call to TicketAttachments/query with body:', searchBody);

      // Use the correct TicketAttachments/query endpoint
      const result = await client.TicketAttachments.query(searchBody);
      const attachments = result?.items || [];
      
      this.logger.info(`Retrieved ${attachments.length} ticket attachments`);
      return attachments as AutotaskTicketAttachment[];
    } catch (error) {
      this.logger.error(`Failed to search ticket attachments for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  // Expense entities
  async getExpenseReport(id: number, tenantContext?: TenantContext): Promise<AutotaskExpenseReport | null> {
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
      const result = await client.ExpenseReports.query(searchBody);
      const reports = result?.items || [];
      
      if (reports.length > 0) {
        this.logger.info(`Retrieved expense report ${id}`);
        return reports[0] as AutotaskExpenseReport;
      }
      
      this.logger.info(`Expense report ${id} not found`);
      return null;
    } catch (error) {
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
        filter: filters
      };

      this.logger.info('Making direct API call to ExpenseReports/query with body:', searchBody);

      // Use the correct ExpenseReports/query endpoint
      const result = await client.ExpenseReports.query(searchBody);
      const reports = result?.items || [];
      
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
      const result = await client.ExpenseReports.create(report as any);
      const reportId = result?.itemId;
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
      await client.ExpenseReports.update({ id, ...updates } as any);
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
      const result = await client.ExpenseItems.query(searchBody);
      const items = result?.items || [];
      
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
        ]
      };

      this.logger.info('Making direct API call to ExpenseItems/query with body:', searchBody);

      // Use the correct ExpenseItems/query endpoint
      const result = await client.ExpenseItems.query(searchBody);
      const items = result?.items || [];
      
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
      
      // Use @apigrate parent-child creation pattern: create(parentId, data)
      this.logger.info('Creating expense item with ExpenseItems.create:', { expenseReportId, itemData });
      const result = await client.ExpenseItems.create(expenseReportId, itemData);
      
      let itemId: number;
      
      if (result && result.itemId) {
        itemId = result.itemId;
      } else if (result && result.id) {
        itemId = result.id;
      } else if (result && typeof result === 'number') {
        itemId = result;
      } else {
        this.logger.warn('Unexpected response format from expense item creation:', result);
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
  async getQuote(id: number, tenantContext?: TenantContext): Promise<AutotaskQuote | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting quote with ID: ${id}`);
      const result = await client.Quotes.get(id);
      return (result?.item || null) as AutotaskQuote;
    } catch (error) {
      this.logger.error(`Failed to get quote ${id}:`, error);
      throw error;
    }
  }

  async searchQuotes(options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskQuote[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching quotes with options:', options);
      
      // Build filter based on provided options
      const filters = [];
      if (options.companyId) {
        filters.push({ field: 'accountId', op: 'eq', value: options.companyId });
      }
      if (options.contactId) {
        filters.push({ field: 'contactId', op: 'eq', value: options.contactId });
      }
      if (options.opportunityId) {
        filters.push({ field: 'opportunityId', op: 'eq', value: options.opportunityId });
      }
      if (options.searchTerm) {
        filters.push({ field: 'description', op: 'contains', value: options.searchTerm });
      }

      // @apigrate query format - only filter is valid
      const queryBody = {
        filter: filters.length > 0 ? filters : [{ field: 'id', op: 'gte', value: 0 }]
      };

      this.logger.info('Calling Quotes.query with @apigrate:', { filterCount: queryBody.filter.length });
      
      const result = await client.Quotes.query(queryBody);
      let quotes = (result?.items || []) as AutotaskQuote[];
      
      // Apply page size limit in code (API returns up to 500)
      const maxResults = Math.min(options.pageSize || PAGINATION_CONFIG.DEFAULT_PAGE_SIZE, PAGINATION_CONFIG.MAX_PAGE_SIZE);
      if (quotes.length > maxResults) {
        this.logger.info(`Quotes capped from ${quotes.length} to ${maxResults}`);
        quotes = quotes.slice(0, maxResults);
      }
      
      this.logger.info(`Retrieved ${quotes.length} quotes`);
      return quotes;
    } catch (error) {
      this.logger.error('Failed to search quotes:', error);
      throw error;
    }
  }

  async createQuote(quote: Partial<AutotaskQuote>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating quote:', quote);
      const result = await client.Quotes.create(quote as any);
      const quoteId = result?.itemId;
      this.logger.info(`Quote created with ID: ${quoteId}`);
      return quoteId;
    } catch (error) {
      this.logger.error('Failed to create quote:', error);
      throw error;
    }
  }

  // BillingCode and Department entities are not directly available in autotask-node
  // These would need to be implemented via custom API calls or alternative endpoints
  async getBillingCode(_id: number, _tenantContext?: TenantContext): Promise<AutotaskBillingCode | null> {
    throw new Error('Billing codes API not directly available in autotask-node library');
  }

  async searchBillingCodes(_options: AutotaskQueryOptionsExtended = {}, _tenantContext?: TenantContext): Promise<AutotaskBillingCode[]> {
    throw new Error('Billing codes API not directly available in autotask-node library');
  }

  async getDepartment(_id: number, _tenantContext?: TenantContext): Promise<AutotaskDepartment | null> {
    throw new Error('Departments API not directly available in autotask-node library');
  }

  async searchDepartments(_options: AutotaskQueryOptionsExtended = {}, _tenantContext?: TenantContext): Promise<AutotaskDepartment[]> {
    throw new Error('Departments API not directly available in autotask-node library');
  }

  // ===================================
  // GET Query Methods (URL parameter-based search)
  // These use simpler filter-based searches as GET /V1.0/{Entity}/query 
  // endpoints are not directly supported by autotask-node library
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
      pageSize: 50
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
      pageSize: 50
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
      pageSize: 50
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
      pageSize: 50
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
      pageSize: 50
    }, tenantContext);
  }

  async queryQuotes(options: { search: string }, tenantContext?: TenantContext): Promise<AutotaskQuote[]> {
    this.logger.info('🔍 Querying quotes with search parameter:', options.search);
    
    // Use existing searchQuotes with searchTerm
    return this.searchQuotes({
      searchTerm: options.search,
      pageSize: 50
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
      pageSize: 50
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

      // @apigrate query format - only filter is valid
      const searchBody = {
        filter: filters
      };

      this.logger.info('Calling CompanyCategories.query with @apigrate:', { filterCount: filters.length });

      // Note: CompanyCategories might not be directly available in all Autotask instances
      // Using dynamic access pattern since it's not a standard entity
      const result = await (client as any).CompanyCategories?.query?.(searchBody) || 
                     { items: [] };
      
      // Extract categories from response
      let categories: any[] = [];
      if (result && result.items) {
        categories = result.items;
        this.logger.info(`📊 Extracted ${categories.length} company categories from result.items`);
      } else if (Array.isArray(result)) {
        categories = result;
        this.logger.info(`📊 Extracted ${categories.length} company categories from result (direct array)`);
      } else {
        this.logger.warn('❌ CompanyCategories not available or unexpected response format');
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