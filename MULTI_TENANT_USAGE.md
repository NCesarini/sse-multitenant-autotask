# Multi-Tenant Autotask MCP Server Usage Guide

This guide explains how to use the Autotask MCP Server in multi-tenant mode for SaaS applications where you want to serve multiple customers with their own Autotask credentials from a single server instance.

## Overview

The multi-tenant mode allows you to:
- Run **one server instance** for multiple customers
- Provide **dynamic authentication** per request
- Maintain **client connection pooling** for performance
- Support **session management** with automatic cleanup
- Isolate tenant data and credentials securely

## Configuration

### Environment Variables

```bash
# Enable multi-tenant mode
MULTI_TENANT_ENABLED=true

# Optional: Default API URL for all tenants
MULTI_TENANT_DEFAULT_API_URL=https://webservices.autotask.net/atservices/1.6/atws.asmx

# Optional: Client pool configuration
MULTI_TENANT_POOL_SIZE=100              # Max cached clients (default: 50)
MULTI_TENANT_SESSION_TIMEOUT=3600000    # Session timeout in ms (default: 30 min)

# Server configuration
MCP_SERVER_NAME=autotask-mcp-saas
MCP_SERVER_VERSION=1.0.0
LOG_LEVEL=info
```

### Programmatic Configuration

```typescript
import { createMultiTenantConfig } from './src/utils/config.js';

const config = createMultiTenantConfig({
  name: 'my-saas-autotask-server',
  version: '2.0.0',
  clientPoolSize: 100,
  sessionTimeout: 60 * 60 * 1000, // 1 hour
  defaultApiUrl: 'https://webservices.autotask.net/atservices/1.6/atws.asmx'
});
```

## Usage

### Tool Call Format

In multi-tenant mode, all tool calls must include a `_tenant` parameter with the customer's Autotask credentials:

```json
{
  "name": "search_companies",
  "arguments": {
    "searchTerm": "Acme Corp",
    "pageSize": 10,
    "_tenant": {
      "tenantId": "customer_123",
      "username": "customer123@autotask.com",
      "secret": "customer-secret-key",
      "integrationCode": "CUSTOMER-INTEGRATION-CODE",
      "apiUrl": "https://webservices2.autotask.net/atservices/1.6/atws.asmx",
      "sessionId": "optional-session-identifier"
    }
  }
}
```

### Required Tenant Fields

| Field | Required | Description |
|-------|----------|-------------|
| `tenantId` | No* | Unique identifier for the tenant (auto-generated if not provided) |
| `username` | Yes | Autotask API username (email) |
| `secret` | Yes | Autotask API secret key |
| `integrationCode` | Yes | Autotask integration code |
| `apiUrl` | No | Tenant-specific API URL (uses default if not provided) |
| `sessionId` | No | Optional session identifier for tracking |

*If `tenantId` is not provided, it will be auto-generated as `tenant_{username}`

### Available Tools

All standard Autotask MCP tools support the `_tenant` parameter:

#### Company Operations
- `search_companies` - Search companies with tenant credentials
- `create_company` - Create company for specific tenant
- `update_company` - Update company using tenant credentials

#### Contact Operations  
- `search_contacts` - Search contacts with tenant credentials
- `create_contact` - Create contact for specific tenant

#### Ticket Operations
- `search_tickets` - Search tickets with tenant credentials
- `create_ticket` - Create ticket for specific tenant

#### Utility Operations
- `test_connection` - Test tenant's Autotask API connectivity

### Example Usage Scenarios

#### 1. Customer Dashboard Integration

```javascript
// Search for customer's companies
const companiesResponse = await mcpClient.callTool({
  name: 'search_companies',
  arguments: {
    searchTerm: '',
    isActive: true,
    pageSize: 50,
    _tenant: {
      tenantId: 'customer_acme',
      username: 'acme@autotask.com',
      secret: process.env.CUSTOMER_ACME_SECRET,
      integrationCode: process.env.CUSTOMER_ACME_INTEGRATION
    }
  }
});
```

#### 2. Multi-Customer Ticket Management

```javascript
// Create ticket for specific customer
const ticketResponse = await mcpClient.callTool({
  name: 'create_ticket',
  arguments: {
    title: 'Server maintenance request',
    description: 'Monthly server maintenance needed',
    companyID: 12345,
    priority: 2,
    _tenant: {
      tenantId: 'customer_beta',
      username: 'beta@autotask.com', 
      secret: customerCredentials.secret,
      integrationCode: customerCredentials.integrationCode
    }
  }
});
```

#### 3. Health Check for Customer Connection

```javascript
// Test customer's API connectivity
const connectionTest = await mcpClient.callTool({
  name: 'test_connection',
  arguments: {
    _tenant: {
      tenantId: 'customer_gamma',
      username: 'gamma@autotask.com',
      secret: process.env.CUSTOMER_GAMMA_SECRET,
      integrationCode: process.env.CUSTOMER_GAMMA_INTEGRATION
    }
  }
});
```

## Architecture Benefits

### 1. Client Connection Pooling
- Autotask clients are cached for each tenant
- Automatic cleanup of expired connections
- Configurable pool size and session timeouts
- Efficient reuse of authenticated connections

### 2. Security Isolation
- Each tenant's credentials are isolated
- No cross-tenant data access
- Secure credential handling with logging sanitization
- Automatic session expiration

### 3. Performance Optimization
- Connection reuse reduces API authentication overhead
- Parallel processing of multiple tenant requests
- Configurable caching and timeout strategies
- Automatic resource cleanup

### 4. Scalability Features
- Single server instance handles multiple tenants
- Horizontal scaling support
- Memory-efficient client management
- Graceful handling of high concurrent loads

## Error Handling

### Authentication Errors
```json
{
  "content": [{
    "type": "text", 
    "text": "Error: Multi-tenant mode requires tenant credentials"
  }],
  "isError": true
}
```

### Invalid Credentials
```json
{
  "content": [{
    "type": "text",
    "text": "Error: Missing required Autotask credentials: username, secret, and integrationCode are required"
  }],
  "isError": true
}
```

### Connection Failures
```json
{
  "content": [{
    "type": "text",
    "text": "❌ Failed to connect to Autotask API for tenant: customer_123"
  }],
  "isError": true
}
```

## Monitoring and Logging

### Tenant Activity Tracking
```
INFO: Creating new Autotask client for tenant: customer_123
INFO: Using cached client for tenant: customer_456  
INFO: Cleaned up 3 expired clients from pool
```

### Security Logging
Sensitive credentials are automatically sanitized in logs:
```
DEBUG: Calling tool: search_companies { args: { _tenant: { username: "cus***", secret: "[REDACTED]" } } }
```

### Performance Metrics
```
INFO: Retrieved 25 companies across 1 pages (COMPLETE dataset for accuracy)
INFO: Multi-tenant mode enabled { poolSize: 50, sessionTimeout: 1800000 }
```

## Best Practices

### 1. Credential Management
- Store customer credentials securely (encrypted at rest)
- Use environment variables or secure secret management
- Rotate credentials regularly
- Implement credential validation

### 2. Session Management
- Set appropriate session timeouts for your use case
- Monitor pool size and adjust based on usage patterns
- Implement graceful degradation for pool exhaustion
- Use meaningful tenant IDs for tracking

### 3. Error Handling
- Implement retry logic for transient failures
- Validate tenant credentials before making calls
- Handle rate limiting appropriately
- Log errors with tenant context (without exposing credentials)

### 4. Performance Optimization
- Configure pool size based on expected concurrent users
- Use appropriate session timeouts (balance performance vs memory)
- Monitor and tune based on actual usage patterns
- Implement connection warming for high-priority tenants

## Migration from Single-Tenant

If you're migrating from single-tenant mode:

1. **Enable multi-tenant mode**: Set `MULTI_TENANT_ENABLED=true`
2. **Update tool calls**: Add `_tenant` parameter to all requests
3. **Remove global credentials**: Remove `AUTOTASK_USERNAME`, `AUTOTASK_SECRET`, `AUTOTASK_INTEGRATION_CODE` from environment
4. **Test thoroughly**: Verify tenant isolation and credential handling

The server will automatically detect multi-tenant mode and handle credential management per request instead of global initialization. 