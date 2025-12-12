/**
 * Mapping Service for Autotask ID-to-Name Resolution
 * Provides cached lookup functionality for company IDs and resource IDs
 */

import { AutotaskService } from '../services/autotask.service.js';
import { Logger } from './logger.js';

export interface MappingCache {
  companies: Map<number, string>;
  resources: Map<number, string>;
  lastUpdated: {
    companies: Date | null;
    resources: Date | null;
  };
}

export interface MappingResult {
  id: number;
  name: string;
  found: boolean;
}

export class MappingService {
  private static instance: MappingService | null = null;
  private static isInitializing: boolean = false;
  
  private cache: MappingCache;
  private autotaskService: AutotaskService;
  private logger: Logger;
  private cacheExpiryMs: number;

  private constructor(autotaskService: AutotaskService, logger: Logger, cacheExpiryMs: number = 30 * 60 * 1000) { // 30 minutes default
    this.autotaskService = autotaskService;
    this.logger = logger;
    this.cacheExpiryMs = cacheExpiryMs;
    this.cache = {
      companies: new Map<number, string>(),
      resources: new Map<number, string>(),
      lastUpdated: {
        companies: null,
        resources: null,
      },
    };
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
    
    try {
      await MappingService.instance.initializeCache();
    } catch (error) {
      MappingService.instance = null;
      MappingService.isInitializing = false;
      throw error;
    }
    
    MappingService.isInitializing = false;
    return MappingService.instance;
  }

  /**
   * Initialize cache with company and resource data
   */
  private async initializeCache(): Promise<void> {
    // Skip cache initialization in multi-tenant mode
    if (this.autotaskService.isInMultiTenantMode()) {
      this.logger.info('Multi-tenant mode detected - skipping cache initialization (mapping will use direct API calls)');
      return;
    }

    if (this.isCacheValid('companies') && this.isCacheValid('resources')) {
      return;
    }

    this.logger.info('Initializing mapping cache...');
    await Promise.all([
      this.refreshCompanyCache(),
      this.refreshResourceCache()
    ]);
    this.cache.lastUpdated.companies = new Date();
    this.cache.lastUpdated.resources = new Date();
    this.logger.info('Mapping cache initialized successfully', {
      companies: this.cache.companies.size,
      resources: this.cache.resources.size
    });
  }

  /**
   * Check if cache is valid (not expired)
   */
  private isCacheValid(type: 'companies' | 'resources'): boolean {
    const lastUpdated = this.cache.lastUpdated[type];
    if (!lastUpdated) {
      return false;
    }

    const now = new Date();
    const timeDiff = now.getTime() - lastUpdated.getTime();
    return timeDiff < this.cacheExpiryMs;
  }

  /**
   * Get company name by ID with direct lookup (not fetching all companies)
   */
  public async getCompanyName(companyId: number, tenantContext: any): Promise<string | null> {
    try {
      // Try cache first
      const cachedName = this.cache.companies.get(companyId);
      if (cachedName) {
        return cachedName;
      }
      
      // Direct API lookup by ID (efficient - single API call)
      this.logger.info(`Company ${companyId} not in cache, doing direct ID lookup`);
      const company = await this.autotaskService.getCompany(companyId, tenantContext);
      
      if (company && company.companyName) {
        // Add to cache for future use
        this.cache.companies.set(companyId, company.companyName);
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
   * Get resource name by ID with direct lookup
   */
  public async getResourceName(resourceId: number, tenantContext: any): Promise<string | null> {
    try {
      // Try cache first
      const cachedName = this.cache.resources.get(resourceId);
      if (cachedName) {
        return cachedName;
      }
      
      // Direct API lookup by ID
      this.logger.info(`Resource ${resourceId} not in cache, doing direct ID lookup`);
      const resource = await this.autotaskService.getResource(resourceId, tenantContext);
      if (resource && resource.firstName && resource.lastName) {
        const fullName = `${resource.firstName} ${resource.lastName}`.trim();
        // Add to cache for future use
        this.cache.resources.set(resourceId, fullName);
        return fullName;
      }
      
      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Failed to get resource name for ID ${resourceId}: ${errorMessage}`);
      return null;
    }
  }

  /**
   * Get multiple company names in a single call
   */
  async getCompanyNames(companyIds: number[], tenantContext: any): Promise<(string | null)[]> {
    const results = await Promise.all(
      companyIds.map(id => this.getCompanyName(id, tenantContext))
    );
    return results;
  }

  /**
   * Get multiple resource names in a single call
   */
  async getResourceNames(resourceIds: number[], tenantContext: any): Promise<(string | null)[]> {
    const results = await Promise.all(
      resourceIds.map(id => this.getResourceName(id, tenantContext))
    );
    return results;
  }

  /**
   * Refresh company cache safely - handles multi-tenant environments
   */
  private async refreshCompanyCache(): Promise<void> {
    // Skip cache refresh in multi-tenant mode
    if (this.autotaskService.isInMultiTenantMode()) {
      this.logger.debug('Multi-tenant mode - skipping company cache refresh');
      return;
    }

    if (this.isCacheValid('companies')) {
      return; // Cache is still valid
    }

    try {
      this.logger.info('Refreshing company cache...');
      
      // Use pagination-by-default to get ALL companies for complete accuracy
      // Pass undefined tenant context for single-tenant mode
      const companies = await this.autotaskService.searchCompanies({
        // No pageSize specified - gets ALL companies via pagination by default
      }, undefined);

      this.cache.companies.clear();
      
      for (const company of companies) {
        if (company.id && company.companyName) {
          this.cache.companies.set(company.id, company.companyName);
        }
      }

      this.cache.lastUpdated.companies = new Date();
      this.logger.info(`Company cache refreshed with ${this.cache.companies.size} entries (COMPLETE dataset)`);

    } catch (error) {
      this.logger.error('Failed to refresh company cache:', error);
      // Don't throw error - allow fallback to direct lookup
    }
  }

  /**
   * Refresh resource cache safely (handle endpoint limitations and multi-tenant mode)
   */
  private async refreshResourceCache(): Promise<void> {
    // Skip cache refresh in multi-tenant mode
    if (this.autotaskService.isInMultiTenantMode()) {
      this.logger.debug('Multi-tenant mode - skipping resource cache refresh');
      return;
    }

    try {
      this.logger.debug('Refreshing resource cache...');
      
      // Note: Some Autotask instances don't support resource listing via REST API
      // This is a known limitation - see Autotask documentation
      // Pass undefined tenant context for single-tenant mode
      const resources = await this.autotaskService.searchResources({ pageSize: 0 }, undefined);
      
      this.cache.resources.clear();
      for (const resource of resources) {
        if (resource.id && resource.firstName && resource.lastName) {
          const fullName = `${resource.firstName} ${resource.lastName}`.trim();
          this.cache.resources.set(resource.id, fullName);
        }
      }
      
      this.cache.lastUpdated.resources = new Date();
      this.logger.info(`Resource cache refreshed: ${this.cache.resources.size} resources`);
      
    } catch (error) {
      // Handle the common case where Resources endpoint returns 405 Method Not Allowed
      if ((error as any)?.response?.status === 405) {
        this.logger.warn('Resources endpoint not available (405 Method Not Allowed) - this is common in Autotask REST API. Resource name mapping will be disabled.');
        this.cache.lastUpdated.resources = new Date(); // Mark as "refreshed" to prevent retry loops
        return;
      }
      
      // Handle other resource endpoint errors gracefully
      this.logger.error('Failed to refresh resource cache, continuing without resource names:', error);
      this.cache.lastUpdated.resources = new Date(); // Mark as "refreshed" to prevent retry loops
    }
  }

  /**
   * Clear all caches
   */
  public clearCache(): void {
    this.cache.companies.clear();
    this.cache.resources.clear();
    this.cache.lastUpdated.companies = null;
    this.cache.lastUpdated.resources = null;
    this.logger.info('Mapping cache cleared');
  }

  /**
   * Clear company cache only
   */
  public clearCompanyCache(): void {
    this.cache.companies.clear();
    this.cache.lastUpdated.companies = null;
    this.logger.info('Company cache cleared');
  }

  /**
   * Clear resource cache only
   */
  public clearResourceCache(): void {
    this.cache.resources.clear();
    this.cache.lastUpdated.resources = null;
    this.logger.info('Resource cache cleared');
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): {
    companies: { count: number; lastUpdated: Date | null; isValid: boolean };
    resources: { count: number; lastUpdated: Date | null; isValid: boolean };
  } {
    return {
      companies: {
        count: this.cache.companies.size,
        lastUpdated: this.cache.lastUpdated.companies,
        isValid: this.isCacheValid('companies'),
      },
      resources: {
        count: this.cache.resources.size,
        lastUpdated: this.cache.lastUpdated.resources,
        isValid: this.isCacheValid('resources'),
      },
    };
  }

  /**
   * Preload caches (useful for warming up on startup)
   */
  async preloadCaches(): Promise<void> {
    this.logger.info('Preloading mapping caches...');
    try {
      await Promise.all([
        this.refreshCompanyCache(),
        this.refreshResourceCache(),
      ]);
      this.logger.info('Mapping caches preloaded successfully');
    } catch (error) {
      this.logger.error('Failed to preload caches:', error);
      throw error;
    }
  }
} 