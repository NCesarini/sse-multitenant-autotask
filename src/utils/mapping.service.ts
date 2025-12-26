/**
 * Mapping Service for Autotask ID-to-Name Resolution
 * Provides per-tenant cached lookup functionality for company IDs and resource IDs
 * 
 * Multi-Tenant Support:
 * - Each tenant gets isolated cache storage (no data leakage)
 * - Memory-bounded with LRU eviction (max 50 tenants)
 * - Automatic cleanup of expired caches (30 minute expiry)
 * - Single-tenant mode uses 'default' cache key
 */

import { AutotaskService } from '../services/autotask.service.js';
import { Logger } from './logger.js';
import { TenantContext } from '../types/mcp.js';
import { ApiCallTracker } from './api-call-tracker.js';

/**
 * Per-tenant cache structure
 * Isolates each tenant's company and resource name mappings
 */
export interface TenantMappingCache {
  companies: Map<number, string>;
  resources: Map<number, string>;
  lastUpdated: {
    companies: Date | null;
    resources: Date | null;
  };
  lastUsed: Date;
  tenantId: string;
}

export interface MappingResult {
  id: number;
  name: string;
  found: boolean;
}

/**
 * Per-tenant cache statistics
 */
export interface TenantCacheStats {
  companies: { count: number; lastUpdated: Date | null; isValid: boolean };
  resources: { count: number; lastUpdated: Date | null; isValid: boolean };
  tenantId: string;
  lastUsed: Date;
}

/**
 * Global cache statistics
 */
export interface GlobalCacheStats {
  tenantCount: number;
  maxTenants: number;
  tenants: TenantCacheStats[];
}

export class MappingService {
  private static instance: MappingService | null = null;
  private static isInitializing: boolean = false;
  
  // Per-tenant caches - keyed by hashed tenant credentials
  private tenantCaches: Map<string, TenantMappingCache> = new Map();
  
  private autotaskService: AutotaskService;
  private logger: Logger;
  
  // Configuration
  private readonly maxTenants: number = 50; // Memory limit
  private readonly cacheExpiryMs: number;
  
  // Cleanup interval reference for proper shutdown
  private cleanupInterval: NodeJS.Timeout | null = null;

  private constructor(autotaskService: AutotaskService, logger: Logger, cacheExpiryMs: number = 30 * 60 * 1000) {
    this.autotaskService = autotaskService;
    this.logger = logger;
    this.cacheExpiryMs = cacheExpiryMs;
    
    // Start automatic cleanup interval (every 5 minutes)
    this.cleanupInterval = setInterval(() => this.cleanupExpiredTenants(), 5 * 60 * 1000);
    
    this.logger.info('MappingService initialized with per-tenant caching', {
      maxTenants: this.maxTenants,
      cacheExpiryMs: this.cacheExpiryMs
    });
  }

  /**
   * Get singleton instance
   */
  public static async getInstance(autotaskService: AutotaskService, logger: Logger): Promise<MappingService> {
    if (MappingService.instance) {
      return MappingService.instance;
    }

    if (MappingService.isInitializing) {
      // Wait for initialization to complete
      return new Promise((resolve) => {
        const checkInit = () => {
          if (MappingService.instance) {
            resolve(MappingService.instance);
          } else {
            setTimeout(checkInit, 100);
          }
        };
        checkInit();
      });
    }

    MappingService.isInitializing = true;
    MappingService.instance = new MappingService(autotaskService, logger);
    MappingService.isInitializing = false;
    
    return MappingService.instance;
  }

  /**
   * Generate a cache key from tenant context
   * Uses same pattern as ClientPool for consistency
   * Returns 'default' for single-tenant mode
   */
  private getTenantCacheKey(tenantContext?: TenantContext): string {
    if (!tenantContext?.credentials) {
      return 'default'; // Single-tenant mode
    }
    const keyData = `${tenantContext.credentials.username}:${tenantContext.credentials.integrationCode}`;
    return Buffer.from(keyData).toString('base64').substring(0, 16);
  }

  /**
   * Get or create a tenant-specific cache
   * Handles LRU eviction when max tenants is reached
   */
  private getOrCreateTenantCache(tenantContext?: TenantContext): TenantMappingCache {
    const cacheKey = this.getTenantCacheKey(tenantContext);
    const tenantId = tenantContext?.tenantId ?? 'default';
    
    // Check if cache exists
    let cache = this.tenantCaches.get(cacheKey);
    
    if (cache) {
      // Update last used time
      cache.lastUsed = new Date();
      return cache;
    }
    
    // Enforce max tenants limit with LRU eviction
    if (this.tenantCaches.size >= this.maxTenants) {
      this.evictOldestTenant();
    }
    
    // Create new cache for this tenant
    cache = {
      companies: new Map<number, string>(),
      resources: new Map<number, string>(),
      lastUpdated: {
        companies: null,
        resources: null,
      },
      lastUsed: new Date(),
      tenantId
    };
    
    this.tenantCaches.set(cacheKey, cache);
    this.logger.info(`Created new cache for tenant: ${tenantId}`, {
      cacheKey: cacheKey.substring(0, 8) + '...',
      totalTenants: this.tenantCaches.size
    });
    
    return cache;
  }

  /**
   * Check if a specific tenant's cache is valid (not expired)
   */
  private isTenantCacheValid(cache: TenantMappingCache, type: 'companies' | 'resources'): boolean {
    const lastUpdated = cache.lastUpdated[type];
    if (!lastUpdated) {
      return false;
    }

    const now = new Date();
    const timeDiff = now.getTime() - lastUpdated.getTime();
    return timeDiff < this.cacheExpiryMs;
  }

  /**
   * Evict the least recently used tenant cache
   */
  private evictOldestTenant(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();
    
    for (const [key, cache] of this.tenantCaches) {
      if (cache.lastUsed.getTime() < oldestTime) {
        oldestTime = cache.lastUsed.getTime();
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      const evicted = this.tenantCaches.get(oldestKey);
      this.tenantCaches.delete(oldestKey);
      this.logger.info(`Evicted oldest tenant cache due to size limit`, {
        tenantId: evicted?.tenantId,
        lastUsed: evicted?.lastUsed,
        remainingTenants: this.tenantCaches.size
      });
    }
  }

  /**
   * Clean up expired tenant caches (called automatically every 5 minutes)
   */
  private cleanupExpiredTenants(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, cache] of this.tenantCaches) {
      // Remove if unused for longer than cache expiry time
      if (now - cache.lastUsed.getTime() > this.cacheExpiryMs) {
        this.tenantCaches.delete(key);
        cleaned++;
        this.logger.debug(`Cleaned up expired cache for tenant: ${cache.tenantId}`);
      }
    }
    
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} expired tenant caches`, {
        remainingTenants: this.tenantCaches.size
      });
    }
  }

  /**
   * Get company name by ID with fallback lookup
   * Uses tenant-specific cache
   */
  public async getCompanyName(companyId: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<string | null> {
    try {
      const cache = this.getOrCreateTenantCache(tenantContext);
      
      // Try cache first
      const cachedName = cache.companies.get(companyId);
      if (cachedName) {
        this.logger.debug(`Company ${companyId} found in cache: ${cachedName}`);
        tracker?.recordCacheHit('Companies', 'getName', { id: companyId });
        return cachedName;
      }
      
      // Fallback to direct API lookup
      this.logger.debug(`Company ${companyId} not in cache, doing direct lookup`);
      
      try {
        // Try to get company by ID directly first (more efficient)
        const company = await this.autotaskService.getCompany(companyId, tenantContext, tracker);
        if (company && company.companyName) {
          // Add to cache for future use
          cache.companies.set(companyId, company.companyName);
          return company.companyName;
        }
      } catch (directError) {
        this.logger.debug(`Direct company lookup failed for ${companyId}, trying search`);
      }
      
      // Fallback to search if direct lookup fails
      const companies = await this.autotaskService.searchCompanies({ 
        filter: [{ field: 'id', op: 'eq', value: companyId }],
        pageSize: 1
      }, tenantContext, tracker);
      
      const company = companies.find((c: any) => c.id === companyId);
      if (company && company.companyName) {
        // Add to cache for future use
        cache.companies.set(companyId, company.companyName);
        return company.companyName;
      }
      
      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Failed to get company name for ID ${companyId}: ${errorMessage}`);
      return null;
    }
  }

  /**
   * Get resource name by ID with fallback lookup
   * Uses tenant-specific cache
   */
  public async getResourceName(resourceId: number, tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<string | null> {
    try {
      const cache = this.getOrCreateTenantCache(tenantContext);
      
      // Try cache first
      const cachedName = cache.resources.get(resourceId);
      if (cachedName) {
        this.logger.debug(`Resource ${resourceId} found in cache: ${cachedName}`);
        tracker?.recordCacheHit('Resources', 'getName', { id: resourceId });
        return cachedName;
      }
      
      // Fallback to direct API lookup
      this.logger.debug(`Resource ${resourceId} not in cache, attempting direct lookup`);
      
      try {
        const resource = await this.autotaskService.getResource(resourceId, tenantContext, tracker);
        if (resource && resource.firstName && resource.lastName) {
          const fullName = `${resource.firstName} ${resource.lastName}`.trim();
          // Add to cache for future use
          cache.resources.set(resourceId, fullName);
          return fullName;
        }
      } catch (directError) {
        this.logger.debug(`Direct resource lookup failed for ${resourceId}:`, directError);
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Failed to get resource name for ${resourceId}:`, error);
      return null;
    }
  }

  /**
   * Get multiple company names in a single call
   * Batches lookups for efficiency while using tenant-specific cache
   */
  async getCompanyNames(companyIds: number[], tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<(string | null)[]> {
    // Deduplicate IDs
    const uniqueIds = [...new Set(companyIds)];
    
    // Build results map from cache first, identify misses
    const cache = this.getOrCreateTenantCache(tenantContext);
    const resultMap = new Map<number, string | null>();
    const cacheMisses: number[] = [];
    
    for (const id of uniqueIds) {
      const cached = cache.companies.get(id);
      if (cached) {
        resultMap.set(id, cached);
        tracker?.recordCacheHit('Companies', 'getName', { id });
      } else {
        cacheMisses.push(id);
      }
    }
    
    // Fetch cache misses in parallel (with reasonable concurrency)
    if (cacheMisses.length > 0) {
      this.logger.debug(`Fetching ${cacheMisses.length} company names not in cache`);
      const fetchResults = await Promise.all(
        cacheMisses.map(id => this.getCompanyName(id, tenantContext, tracker))
      );
      
      cacheMisses.forEach((id, index) => {
        resultMap.set(id, fetchResults[index]);
      });
    }
    
    // Return in original order
    return companyIds.map(id => resultMap.get(id) ?? null);
  }

  /**
   * Get multiple resource names in a single call
   * Batches lookups for efficiency while using tenant-specific cache
   */
  async getResourceNames(resourceIds: number[], tenantContext?: TenantContext, tracker?: ApiCallTracker): Promise<(string | null)[]> {
    // Deduplicate IDs
    const uniqueIds = [...new Set(resourceIds)];
    
    // Build results map from cache first, identify misses
    const cache = this.getOrCreateTenantCache(tenantContext);
    const resultMap = new Map<number, string | null>();
    const cacheMisses: number[] = [];
    
    for (const id of uniqueIds) {
      const cached = cache.resources.get(id);
      if (cached) {
        resultMap.set(id, cached);
        tracker?.recordCacheHit('Resources', 'getName', { id });
      } else {
        cacheMisses.push(id);
      }
    }
    
    // Fetch cache misses in parallel (with reasonable concurrency)
    if (cacheMisses.length > 0) {
      this.logger.debug(`Fetching ${cacheMisses.length} resource names not in cache`);
      const fetchResults = await Promise.all(
        cacheMisses.map(id => this.getResourceName(id, tenantContext, tracker))
      );
      
      cacheMisses.forEach((id, index) => {
        resultMap.set(id, fetchResults[index]);
      });
    }
    
    // Return in original order
    return resourceIds.map(id => resultMap.get(id) ?? null);
  }

  /**
   * Preload cache for a specific tenant
   * Useful for warming up on first request
   */
  async preloadTenantCache(tenantContext?: TenantContext): Promise<void> {
    const tenantId = tenantContext?.tenantId ?? 'default';
    this.logger.info(`Preloading cache for tenant: ${tenantId}`);
    
    const cache = this.getOrCreateTenantCache(tenantContext);
    
    try {
      // Load all companies
      const companies = await this.autotaskService.searchCompanies({}, tenantContext);
      for (const company of companies) {
        if (company.id && company.companyName) {
          cache.companies.set(company.id, company.companyName);
        }
      }
      cache.lastUpdated.companies = new Date();
      
      this.logger.info(`Preloaded ${cache.companies.size} companies for tenant: ${tenantId}`);
    } catch (error) {
      this.logger.warn(`Failed to preload companies for tenant ${tenantId}:`, error);
    }
    
    try {
      // Load all resources
      const resources = await this.autotaskService.searchResources({ pageSize: 0 }, tenantContext);
      for (const resource of resources) {
        if (resource.id && resource.firstName && resource.lastName) {
          const fullName = `${resource.firstName} ${resource.lastName}`.trim();
          cache.resources.set(resource.id, fullName);
        }
      }
      cache.lastUpdated.resources = new Date();
      
      this.logger.info(`Preloaded ${cache.resources.size} resources for tenant: ${tenantId}`);
    } catch (error) {
      // Handle common 405 error for Resources endpoint
      if ((error as any)?.response?.status === 405) {
        this.logger.warn(`Resources endpoint not available for tenant ${tenantId} (405)`);
        cache.lastUpdated.resources = new Date(); // Prevent retry loops
      } else {
        this.logger.warn(`Failed to preload resources for tenant ${tenantId}:`, error);
      }
    }
  }

  /**
   * Clear all caches (all tenants)
   */
  public clearCache(): void {
    const count = this.tenantCaches.size;
    this.tenantCaches.clear();
    this.logger.info(`Cleared all mapping caches (${count} tenants)`);
  }

  /**
   * Clear cache for a specific tenant
   */
  public clearTenantCache(tenantContext?: TenantContext): void {
    const cacheKey = this.getTenantCacheKey(tenantContext);
    const cache = this.tenantCaches.get(cacheKey);
    
    if (cache) {
      this.tenantCaches.delete(cacheKey);
      this.logger.info(`Cleared cache for tenant: ${cache.tenantId}`);
    }
  }

  /**
   * Clear company cache for a specific tenant
   */
  public clearCompanyCache(tenantContext?: TenantContext): void {
    const cache = this.getOrCreateTenantCache(tenantContext);
    cache.companies.clear();
    cache.lastUpdated.companies = null;
    this.logger.info(`Company cache cleared for tenant: ${cache.tenantId}`);
  }

  /**
   * Clear resource cache for a specific tenant
   */
  public clearResourceCache(tenantContext?: TenantContext): void {
    const cache = this.getOrCreateTenantCache(tenantContext);
    cache.resources.clear();
    cache.lastUpdated.resources = null;
    this.logger.info(`Resource cache cleared for tenant: ${cache.tenantId}`);
  }

  /**
   * Get cache statistics for a specific tenant
   */
  public getCacheStats(tenantContext?: TenantContext): TenantCacheStats {
    const cache = this.getOrCreateTenantCache(tenantContext);
    
    return {
      companies: {
        count: cache.companies.size,
        lastUpdated: cache.lastUpdated.companies,
        isValid: this.isTenantCacheValid(cache, 'companies'),
      },
      resources: {
        count: cache.resources.size,
        lastUpdated: cache.lastUpdated.resources,
        isValid: this.isTenantCacheValid(cache, 'resources'),
      },
      tenantId: cache.tenantId,
      lastUsed: cache.lastUsed
    };
  }

  /**
   * Get global cache statistics (all tenants)
   */
  public getGlobalCacheStats(): GlobalCacheStats {
    const tenantStats: TenantCacheStats[] = [];
    
    for (const [, cache] of this.tenantCaches) {
      tenantStats.push({
        companies: {
          count: cache.companies.size,
          lastUpdated: cache.lastUpdated.companies,
          isValid: this.isTenantCacheValid(cache, 'companies'),
        },
        resources: {
          count: cache.resources.size,
          lastUpdated: cache.lastUpdated.resources,
          isValid: this.isTenantCacheValid(cache, 'resources'),
        },
        tenantId: cache.tenantId,
        lastUsed: cache.lastUsed
      });
    }
    
    return {
      tenantCount: this.tenantCaches.size,
      maxTenants: this.maxTenants,
      tenants: tenantStats
    };
  }

  /**
   * Preload caches (useful for warming up on startup in single-tenant mode)
   * @deprecated Use preloadTenantCache(tenantContext) instead
   */
  async preloadCaches(): Promise<void> {
    await this.preloadTenantCache(undefined);
  }

  /**
   * Shutdown cleanup - stop intervals
   */
  public shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.tenantCaches.clear();
    this.logger.info('MappingService shutdown complete');
  }

  /**
   * Reset singleton for testing purposes
   */
  public static resetInstance(): void {
    if (MappingService.instance) {
      MappingService.instance.shutdown();
      MappingService.instance = null;
    }
    MappingService.isInitializing = false;
  }
}
