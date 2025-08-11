# User Impersonation in Autotask MCP Server

This guide explains how to use the user impersonation feature in the Autotask MCP Server to perform actions on behalf of specific users within an organization while maintaining proper access control and audit trails.

## Overview

User impersonation allows you to:
- **Act as different users** within the same Autotask organization
- **Maintain proper permissions** - each user's access rights are respected
- **Create audit trails** - actions appear as performed by the impersonated user
- **Serve multiple users** with a single API service account

## How It Works

The Autotask MCP Server uses the Autotask REST API's `ImpersonationResourceId` header feature:

1. **Service Account**: Your platform uses one API user account with broad permissions
2. **Session-Level Identity**: Each session is established with a specific user identity
3. **Permission Inheritance**: The impersonated user's permissions are applied to all requests
4. **Audit Attribution**: All actions appear as performed by the impersonated user in Autotask

## Prerequisites

### 1. Autotask API User Setup

Your API user must have:
- **API User (API-only)** security level
- **Impersonation permissions** enabled for the entities you'll be working with
- **Sufficient access** to perform operations on behalf of other users

### 2. Target User Permissions

The users you want to impersonate must:
- Have **appropriate permissions** for the actions they'll perform
- Have **impersonation enabled** in their security level settings
- Be **active users** in the Autotask system

Refer to the [Autotask REST API security documentation](https://www.autotask.net/help/developerhelp/Content/APIs/REST/General_Topics/REST_Security_Auth.htm) for detailed setup instructions.

## Usage Examples

### Single-Tenant Mode (One Organization)

In single-tenant mode, you would typically establish the user session at the connection level:

```javascript
// Establish connection as specific user
const mcpClient = new MCPClient({
  sessionContext: {
    impersonationResourceId: 123  // All operations act as user 123
  }
});

// All subsequent operations act as user 123
const ticketsForUser = await mcpClient.callTool({
  name: 'search_tickets',
  arguments: {
    assignedResourceID: 123,
    status: 1
  }
});

// Create a ticket - appears as created by user 123
const newTicket = await mcpClient.callTool({
  name: 'create_ticket',
  arguments: {
    companyID: 456,
    title: 'Network Issue',
    description: 'Server connectivity problems',
    priority: 2
  }
});
```

### Multi-Tenant Mode (Multiple Organizations)

```javascript
// Search companies as a specific user within tenant
const companiesForUser = await mcpClient.callTool({
  name: 'search_companies',
  arguments: {
    isActive: true,
    pageSize: 25,
    _tenant: {
      tenantId: 'customer_acme',
      username: 'api@acme.com',
      secret: process.env.ACME_SECRET,
      integrationCode: process.env.ACME_INTEGRATION_CODE,
      impersonationResourceId: 456  // Act as user 456 in this tenant
    }
  }
});

// Create time entry on behalf of user - session-level identity maintained
const timeEntry = await mcpClient.callTool({
  name: 'create_time_entry',
  arguments: {
    ticketID: 12345,
    resourceID: 456,
    dateWorked: '2024-01-15',
    hoursWorked: 2.5,
    summaryNotes: 'Resolved network connectivity issue',
    _tenant: {
      tenantId: 'customer_acme',
      username: 'api@acme.com',
      secret: process.env.ACME_SECRET,
      integrationCode: process.env.ACME_INTEGRATION_CODE,
      impersonationResourceId: 456  // Consistent user identity
    }
  }
});
```

## Tenant Context Structure

The `impersonationResourceId` is now part of the tenant context:

```typescript
interface TenantContext {
  tenantId: string;
  credentials: {
    username: string;
    secret: string;
    integrationCode: string;
    apiUrl?: string;
  };
  sessionId?: string;
  impersonationResourceId?: number;  // User to impersonate for this session
}
```

## Architecture Benefits

### 1. Session-Level Identity
- **Consistent User Context**: Once established, all operations in a session act as the same user
- **Cleaner API**: No need to specify user for each individual operation
- **Better Security**: User identity is established at the session/connection level

### 2. Simplified Tool Calls
- **No Repetition**: Don't need to specify `impersonationResourceId` on every tool call
- **Cleaner Schemas**: Tool schemas focus on business logic, not authentication
- **Intuitive Design**: Matches how real applications work (login once, act as that user)

### 3. Multi-User Sessions
```javascript
// Different sessions for different users
const managerSession = {
  _tenant: {
    tenantId: 'company_abc',
    username: 'api@company.com',
    secret: 'api-secret',
    integrationCode: 'INTEGRATION-CODE',
    impersonationResourceId: 789  // Manager user
  }
};

const technicianSession = {
  _tenant: {
    tenantId: 'company_abc', 
    username: 'api@company.com',
    secret: 'api-secret',
    integrationCode: 'INTEGRATION-CODE',
    impersonationResourceId: 456  // Technician user
  }
};

// Manager sees all tickets
const allTickets = await mcpClient.callTool({
  name: 'search_tickets',
  arguments: { status: 1, ...managerSession }
});

// Technician sees only assigned tickets
const myTickets = await mcpClient.callTool({
  name: 'search_tickets', 
  arguments: { status: 1, ...technicianSession }
});
```

## Supported Tools

All Autotask MCP tools automatically respect the tenant-level impersonation context:

### Company Operations
- `search_companies`
- `create_company` 
- `update_company`

### Contact Operations
- `search_contacts`
- `create_contact`

### Ticket Operations
- `search_tickets`
- `get_ticket_details`
- `create_ticket`
- `create_ticket_note`

### Project Operations
- `search_projects`
- `create_project`
- `create_task`

### Time Tracking
- `create_time_entry`

### Resource Operations
- `search_resources`

### And all other available tools...

## Response Format

When impersonation is used, the response includes an `impersonatedAs` field:

```json
{
  "message": "Found 5 tickets",
  "data": [...],
  "timestamp": "2024-01-15T10:30:00.000Z",
  "impersonatedAs": 123
}
```

## Error Handling

### Invalid User ID
```json
{
  "error": "Resource ID 999 not found or cannot be impersonated",
  "tool": "search_tickets",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Insufficient Permissions
```json
{
  "error": "User does not have permission to access this resource",
  "tool": "create_ticket",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Impersonation Not Allowed
```json
{
  "error": "Impersonation not permitted for this user or entity type",
  "tool": "update_company",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Best Practices

### 1. Session Management
```javascript
// Create dedicated sessions for different users
class UserSession {
  constructor(userId, credentials) {
    this.tenantContext = {
      ...credentials,
      impersonationResourceId: userId
    };
  }

  async callTool(name, arguments) {
    return mcpClient.callTool({
      name,
      arguments: {
        ...arguments,
        _tenant: this.tenantContext
      }
    });
  }
}

const managerSession = new UserSession(789, companyCredentials);
const techSession = new UserSession(456, companyCredentials);
```

### 2. User ID Validation
```javascript
// Always validate user IDs at session creation
function createUserSession(userId, credentials) {
  const parsedUserId = parseInt(userId);
  if (!parsedUserId || parsedUserId < 1) {
    throw new Error('Invalid user ID');
  }
  
  return {
    ...credentials,
    impersonationResourceId: parsedUserId
  };
}
```

### 3. Permission Testing
```javascript
// Test user permissions when establishing session
async function validateUserSession(tenantContext) {
  try {
    const testResult = await mcpClient.callTool({
      name: 'search_tickets',
      arguments: { 
        pageSize: 1,
        _tenant: tenantContext
      }
    });
    
    return !testResult.isError;
  } catch (error) {
    console.log(`User ${tenantContext.impersonationResourceId} validation failed:`, error);
    return false;
  }
}
```

## Integration Examples

### Help Desk Application
```javascript
// Agent session established at login
const agentSession = {
  tenantId: 'helpdesk_company',
  username: 'api@company.com',
  secret: process.env.API_SECRET,
  integrationCode: process.env.INTEGRATION_CODE,
  impersonationResourceId: agentUserId
};

// All ticket operations appear as performed by the agent
const ticket = await mcpClient.callTool({
  name: 'create_ticket',
  arguments: {
    companyID: customerCompanyId,
    title: issueTitle,
    description: issueDescription,
    contactID: customerContactId,
    _tenant: agentSession
  }
});
```

### Project Management System
```javascript
// Project manager session
const pmSession = {
  tenantId: 'project_company',
  username: 'api@company.com', 
  secret: process.env.API_SECRET,
  integrationCode: process.env.INTEGRATION_CODE,
  impersonationResourceId: projectManagerId
};

// Task assignment appears as done by PM
const task = await mcpClient.callTool({
  name: 'create_task',
  arguments: {
    projectID: projectId,
    title: taskTitle,
    description: taskDescription,
    assignedResourceID: teamMemberId,
    _tenant: pmSession
  }
});
```

### Time Tracking Application  
```javascript
// Employee session for time logging
const employeeSession = {
  tenantId: 'company_abc',
  username: 'api@company.com',
  secret: process.env.API_SECRET, 
  integrationCode: process.env.INTEGRATION_CODE,
  impersonationResourceId: employeeId
};

// Time entry logged by employee themselves
const timeEntry = await mcpClient.callTool({
  name: 'create_time_entry',
  arguments: {
    ticketID: ticketId,
    resourceID: employeeId,
    dateWorked: workDate,
    hoursWorked: hours,
    summaryNotes: workDescription,
    _tenant: employeeSession
  }
});
```

## Resources

- [Autotask REST API Security Documentation](https://www.autotask.net/help/developerhelp/Content/APIs/REST/General_Topics/REST_Security_Auth.htm)
- [Autotask API User Setup Guide](https://www.autotask.net/help/developerhelp/Content/APIs/REST/General_Topics/REST_Getting_Started.htm)
- [Multi-Tenant Usage Guide](../MULTI_TENANT_USAGE.md)
- [API Documentation](../README.md) 