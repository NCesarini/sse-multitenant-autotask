import { EnhancedAutotaskToolHandler } from '../src/handlers/enhanced.tool.handler.js';
import type { Logger } from '../src/utils/logger.js';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
} as unknown as Logger;

function createHandler(): EnhancedAutotaskToolHandler {
  return new EnhancedAutotaskToolHandler({} as any, logger);
}

describe('EnhancedAutotaskToolHandler tenant context', () => {
  it('ignores impersonationResourceId for read-mode tenants', () => {
    const handler = createHandler();

    const tenantContext = (handler as any).extractTenantContext({
      tenant: {
        tenantId: 'tenant-1',
        username: 'api@example.com',
        secret: 'secret',
        integrationCode: 'code',
        mode: 'read',
        impersonationResourceId: '29683316'
      }
    });

    expect(tenantContext.mode).toBe('read');
    expect(tenantContext.impersonationResourceId).toBeUndefined();
  });

  it('preserves numeric impersonationResourceId for write-mode tenants', () => {
    const handler = createHandler();

    const tenantContext = (handler as any).extractTenantContext({
      tenant: {
        tenantId: 'tenant-1',
        username: 'api@example.com',
        secret: 'secret',
        integrationCode: 'code',
        mode: 'write',
        impersonationResourceId: '29683316'
      }
    });

    expect(tenantContext.mode).toBe('write');
    expect(tenantContext.impersonationResourceId).toBe(29683316);
  });
});
