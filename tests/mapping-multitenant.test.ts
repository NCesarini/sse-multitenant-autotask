/**
 * Multi-Tenant Mapping Service Tests
 * 
 * Tests for:
 * 1. Tenant cache isolation - ensure no data leakage between tenants
 * 2. Memory management - LRU eviction and automatic cleanup
 * 3. Cache key generation - proper tenant isolation
 * 4. Backward compatibility - single-tenant mode continues to work
 */

import { MappingService, TenantCacheStats, GlobalCacheStats } from '../src/utils/mapping.service.js';
import { AutotaskService } from '../src/services/autotask.service.js';
import { Logger } from '../src/utils/logger.js';
import { TenantContext, AutotaskCredentials } from '../src/types/mcp.js';

// Mock AutotaskService
const createMockAutotaskService = () => ({
  isInMultiTenantMode: jest.fn().mockReturnValue(false),
  searchCompanies: jest.fn().mockResolvedValue([
    { id: 1, companyName: 'Company A' },
    { id: 2, companyName: 'Company B' }
  ]),
  searchResources: jest.fn().mockResolvedValue([
    { id: 101, firstName: 'John', lastName: 'Doe' },
    { id: 102, firstName: 'Jane', lastName: 'Smith' }
  ]),
  getCompany: jest.fn().mockImplementation((id: number) => {
    if (id === 1) return Promise.resolve({ id: 1, companyName: 'Company A' });
    if (id === 2) return Promise.resolve({ id: 2, companyName: 'Company B' });
    if (id === 100) return Promise.resolve({ id: 100, companyName: 'Tenant A Company' });
    if (id === 200) return Promise.resolve({ id: 200, companyName: 'Tenant B Company' });
    return Promise.resolve(null);
  }),
  getResource: jest.fn().mockImplementation((id: number) => {
    if (id === 101) return Promise.resolve({ id: 101, firstName: 'John', lastName: 'Doe' });
    if (id === 102) return Promise.resolve({ id: 102, firstName: 'Jane', lastName: 'Smith' });
    if (id === 501) return Promise.resolve({ id: 501, firstName: 'Tenant A', lastName: 'Resource' });
    if (id === 502) return Promise.resolve({ id: 502, firstName: 'Tenant B', lastName: 'Resource' });
    return Promise.resolve(null);
  })
}) as unknown as AutotaskService;

// Mock Logger
const createMockLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}) as unknown as Logger;

// Helper to create tenant context
const createTenantContext = (username: string, integrationCode: string, tenantId: string): TenantContext => ({
  tenantId,
  credentials: {
    username,
    secret: 'test-secret',
    integrationCode
  }
});

describe('MappingService Multi-Tenant Support', () => {
  let mockAutotaskService: AutotaskService;
  let mockLogger: Logger;

  beforeEach(() => {
    // Reset singleton before each test
    MappingService.resetInstance();
    mockAutotaskService = createMockAutotaskService();
    mockLogger = createMockLogger();
  });

  afterEach(() => {
    MappingService.resetInstance();
  });

  describe('Tenant Cache Isolation', () => {
    it('should create separate caches for different tenants', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      const tenantA = createTenantContext('userA@company.com', 'CODE_A', 'tenant-a');
      const tenantB = createTenantContext('userB@company.com', 'CODE_B', 'tenant-b');
      
      // Get company name for tenant A
      await service.getCompanyName(100, tenantA);
      
      // Get company name for tenant B
      await service.getCompanyName(200, tenantB);
      
      // Get stats for each tenant
      const statsA = service.getCacheStats(tenantA);
      const statsB = service.getCacheStats(tenantB);
      
      expect(statsA.tenantId).toBe('tenant-a');
      expect(statsB.tenantId).toBe('tenant-b');
      
      // Verify global stats show 2 tenants
      const globalStats = service.getGlobalCacheStats();
      expect(globalStats.tenantCount).toBe(2);
    });

    it('should not leak data between tenants', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      const tenantA = createTenantContext('userA@company.com', 'CODE_A', 'tenant-a');
      const tenantB = createTenantContext('userB@company.com', 'CODE_B', 'tenant-b');
      
      // Cache a company for tenant A
      await service.getCompanyName(100, tenantA);
      
      // Tenant B should NOT have this cached
      const statsB = service.getCacheStats(tenantB);
      expect(statsB.companies.count).toBe(0);
      
      // Tenant A should have it cached
      const statsA = service.getCacheStats(tenantA);
      expect(statsA.companies.count).toBe(1);
    });

    it('should use default cache key for single-tenant mode', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      // No tenant context = single-tenant mode
      await service.getCompanyName(1, undefined);
      
      const stats = service.getCacheStats(undefined);
      expect(stats.tenantId).toBe('default');
      expect(stats.companies.count).toBe(1);
    });

    it('should clear only specific tenant cache when requested', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      const tenantA = createTenantContext('userA@company.com', 'CODE_A', 'tenant-a');
      const tenantB = createTenantContext('userB@company.com', 'CODE_B', 'tenant-b');
      
      // Populate both caches
      await service.getCompanyName(100, tenantA);
      await service.getCompanyName(200, tenantB);
      
      // Clear only tenant A's cache
      service.clearTenantCache(tenantA);
      
      // Tenant A should be gone
      const globalStats = service.getGlobalCacheStats();
      expect(globalStats.tenantCount).toBe(1);
      
      // Tenant B should still exist
      const statsB = service.getCacheStats(tenantB);
      expect(statsB.companies.count).toBe(1);
    });
  });

  describe('Memory Management - LRU Eviction', () => {
    it('should evict oldest tenant when max tenants is exceeded', async () => {
      // Create service with low max tenants for testing
      // Note: We'll test this by creating many tenants and checking eviction happens
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      // Create 51 tenants (default max is 50)
      const tenants: TenantContext[] = [];
      for (let i = 0; i < 51; i++) {
        tenants.push(createTenantContext(`user${i}@company.com`, `CODE_${i}`, `tenant-${i}`));
      }
      
      // Populate caches for all tenants
      for (const tenant of tenants) {
        await service.getCompanyName(1, tenant);
      }
      
      // Should not exceed 50 tenants
      const globalStats = service.getGlobalCacheStats();
      expect(globalStats.tenantCount).toBeLessThanOrEqual(globalStats.maxTenants);
    });

    it('should update lastUsed when cache is accessed', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      const tenant = createTenantContext('user@company.com', 'CODE_A', 'tenant-a');
      
      // First access
      await service.getCompanyName(1, tenant);
      const stats1 = service.getCacheStats(tenant);
      const firstAccess = stats1.lastUsed;
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Second access
      await service.getCompanyName(1, tenant);
      const stats2 = service.getCacheStats(tenant);
      const secondAccess = stats2.lastUsed;
      
      // lastUsed should be updated
      expect(secondAccess.getTime()).toBeGreaterThan(firstAccess.getTime());
    });
  });

  describe('Cache Key Generation', () => {
    it('should generate same key for same credentials', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      const tenant1 = createTenantContext('user@company.com', 'CODE_A', 'tenant-1');
      const tenant2 = createTenantContext('user@company.com', 'CODE_A', 'tenant-2'); // Same creds, diff tenantId
      
      // Both should use same cache
      await service.getCompanyName(1, tenant1);
      await service.getCompanyName(2, tenant2);
      
      // Should be only 1 tenant cache (same credentials)
      const globalStats = service.getGlobalCacheStats();
      expect(globalStats.tenantCount).toBe(1);
      
      // Cache should have both companies
      const stats = service.getCacheStats(tenant1);
      expect(stats.companies.count).toBe(2);
    });

    it('should generate different keys for different credentials', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      const tenant1 = createTenantContext('user1@company.com', 'CODE_A', 'tenant-a');
      const tenant2 = createTenantContext('user2@company.com', 'CODE_B', 'tenant-b');
      
      await service.getCompanyName(1, tenant1);
      await service.getCompanyName(1, tenant2);
      
      // Should be 2 separate tenant caches
      const globalStats = service.getGlobalCacheStats();
      expect(globalStats.tenantCount).toBe(2);
    });
  });

  describe('Backward Compatibility', () => {
    it('should work in single-tenant mode without tenant context', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      // Should work without tenant context
      const companyName = await service.getCompanyName(1, undefined);
      expect(companyName).toBe('Company A');
    });

    it('should support legacy getCacheStats without tenant context', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      await service.getCompanyName(1, undefined);
      
      // Legacy method should work
      const stats = service.getCacheStats();
      expect(stats.companies.count).toBe(1);
      expect(stats.tenantId).toBe('default');
    });

    it('should support preloadCaches for single-tenant mode', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      // Legacy method should work
      await service.preloadCaches();
      
      const stats = service.getCacheStats();
      expect(stats.companies.count).toBeGreaterThan(0);
    });
  });

  describe('Batch Operations', () => {
    it('should efficiently batch company name lookups', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      const tenant = createTenantContext('user@company.com', 'CODE_A', 'tenant-a');
      
      // First, cache one company
      await service.getCompanyName(1, tenant);
      
      // Request multiple company names (one cached, one not)
      const names = await service.getCompanyNames([1, 2], tenant);
      
      expect(names).toHaveLength(2);
      expect(names[0]).toBe('Company A');
      expect(names[1]).toBe('Company B');
    });

    it('should efficiently batch resource name lookups', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      const tenant = createTenantContext('user@company.com', 'CODE_A', 'tenant-a');
      
      const names = await service.getResourceNames([101, 102], tenant);
      
      expect(names).toHaveLength(2);
      expect(names[0]).toBe('John Doe');
      expect(names[1]).toBe('Jane Smith');
    });

    it('should deduplicate IDs in batch operations', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      const tenant = createTenantContext('user@company.com', 'CODE_A', 'tenant-a');
      
      // Request same ID multiple times
      const names = await service.getCompanyNames([1, 1, 1, 2, 2], tenant);
      
      expect(names).toHaveLength(5);
      expect(names[0]).toBe('Company A');
      expect(names[1]).toBe('Company A');
      expect(names[2]).toBe('Company A');
      expect(names[3]).toBe('Company B');
      expect(names[4]).toBe('Company B');
    });
  });

  describe('Error Handling', () => {
    it('should return null for non-existent company', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      const name = await service.getCompanyName(99999, undefined);
      
      expect(name).toBeNull();
    });

    it('should return null for non-existent resource', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      const name = await service.getResourceName(99999, undefined);
      
      expect(name).toBeNull();
    });

    it('should gracefully handle API errors', async () => {
      const errorService = {
        ...createMockAutotaskService(),
        getCompany: jest.fn().mockRejectedValue(new Error('API Error'))
      } as unknown as AutotaskService;
      
      const service = await MappingService.getInstance(errorService, mockLogger);
      
      const name = await service.getCompanyName(1, undefined);
      
      expect(name).toBeNull();
    });
  });

  describe('Shutdown', () => {
    it('should properly clean up on shutdown', async () => {
      const service = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      // Populate some cache
      await service.getCompanyName(1, undefined);
      
      // Shutdown
      service.shutdown();
      
      // Get new instance after reset
      MappingService.resetInstance();
      const newService = await MappingService.getInstance(mockAutotaskService, mockLogger);
      
      // Should have clean state
      const stats = newService.getGlobalCacheStats();
      expect(stats.tenantCount).toBe(0);
    });
  });
});


