#!/usr/bin/env node

/**
 * Library Comparison: autotask-node vs @apigrate/autotask-restapi
 * 
 * This script evaluates both libraries for:
 * 1. Pagination metadata support (pageDetails, nextPageUrl)
 * 2. Response format consistency
 * 3. Error handling capabilities
 * 4. Multi-tenant compatibility
 * 
 * Run with: node scripts/compare-libraries.js
 */

import { AutotaskClient } from 'autotask-node';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const AUTOTASK_USERNAME = process.env.AUTOTASK_USERNAME;
const AUTOTASK_SECRET = process.env.AUTOTASK_SECRET;
const AUTOTASK_INTEGRATION_CODE = process.env.AUTOTASK_INTEGRATION_CODE;

// Feature comparison matrix
const COMPARISON_RESULTS = {
  library: '',
  features: {
    paginationMetadata: false,
    pageDetailsInResponse: false,
    nextPageUrl: false,
    totalCountAvailable: false,
    autoZoneDiscovery: false,
    errorClassWithDetails: false,
    multiTenantSupport: false,
  },
  testResults: [],
};

/**
 * Test autotask-node library (current)
 */
async function testAutotaskNode() {
  console.log('\n' + '='.repeat(60));
  console.log('📦 TESTING: autotask-node (current library)');
  console.log('='.repeat(60));
  
  const results = { ...COMPARISON_RESULTS, library: 'autotask-node' };
  
  try {
    if (!AUTOTASK_USERNAME || !AUTOTASK_SECRET || !AUTOTASK_INTEGRATION_CODE) {
      console.log('⚠️  Credentials not found. Performing static analysis only.\n');
      
      // Static analysis based on library structure
      results.features = {
        paginationMetadata: false,  // Library doesn't expose pageDetails directly
        pageDetailsInResponse: false, // Need to access via axios response
        nextPageUrl: false,  // Not exposed in standard methods
        totalCountAvailable: false,  // No count method exposed
        autoZoneDiscovery: true,  // Library does auto-discovery
        errorClassWithDetails: false,  // Basic error handling
        multiTenantSupport: true,  // Supports creating multiple clients
      };
      
      results.testResults.push({
        test: 'Static Analysis',
        status: 'partial',
        notes: 'No credentials - analyzed library structure'
      });
      
    } else {
      console.log('🔐 Credentials found. Running live tests...\n');
      
      const client = new AutotaskClient({
        username: AUTOTASK_USERNAME,
        secret: AUTOTASK_SECRET,
        integrationCode: AUTOTASK_INTEGRATION_CODE
      });
      
      // Test 1: Basic query with pagination
      console.log('Test 1: Checking pagination response format...');
      try {
        const response = await client.axios.post('/Companies/query', {
          filter: [{ field: 'id', op: 'gte', value: 0 }],
          pageSize: 5
        });
        
        const hasPageDetails = !!(response.data && response.data.pageDetails);
        const hasNextPageUrl = !!(response.data?.pageDetails?.nextPageUrl);
        const hasCount = !!(response.data?.pageDetails?.count);
        
        results.features.pageDetailsInResponse = hasPageDetails;
        results.features.nextPageUrl = hasNextPageUrl;
        results.features.totalCountAvailable = hasCount;
        results.features.paginationMetadata = hasPageDetails;
        
        results.testResults.push({
          test: 'Pagination Response',
          status: hasPageDetails ? 'pass' : 'fail',
          notes: `pageDetails: ${hasPageDetails}, nextPageUrl: ${hasNextPageUrl}, count: ${hasCount}`,
          rawPageDetails: response.data?.pageDetails
        });
        
        console.log(`   ✅ pageDetails present: ${hasPageDetails}`);
        console.log(`   ✅ nextPageUrl available: ${hasNextPageUrl}`);
        console.log(`   ✅ count available: ${hasCount}`);
        if (response.data?.pageDetails) {
          console.log(`   📊 pageDetails: ${JSON.stringify(response.data.pageDetails)}`);
        }
        
      } catch (error) {
        results.testResults.push({
          test: 'Pagination Response',
          status: 'error',
          notes: error.message
        });
        console.log(`   ❌ Error: ${error.message}`);
      }
      
      // Test 2: Error handling
      console.log('\nTest 2: Checking error handling...');
      try {
        await client.axios.post('/Companies/query', {
          filter: [{ field: 'invalidField', op: 'eq', value: 'test' }]
        });
        results.testResults.push({
          test: 'Error Handling',
          status: 'unexpected',
          notes: 'Expected error but got success'
        });
      } catch (error) {
        const hasErrorDetails = !!(error.response?.data?.errors);
        results.features.errorClassWithDetails = hasErrorDetails;
        results.testResults.push({
          test: 'Error Handling',
          status: 'pass',
          notes: `Error details available: ${hasErrorDetails}`,
          errorFormat: error.response?.data
        });
        console.log(`   ✅ Error details available: ${hasErrorDetails}`);
        if (error.response?.data) {
          console.log(`   📊 Error format: ${JSON.stringify(error.response.data)}`);
        }
      }
      
      // Test 3: TimeEntries query (John's specific case)
      console.log('\nTest 3: TimeEntries pagination test...');
      try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const response = await client.axios.post('/TimeEntries/query', {
          filter: [{ field: 'dateWorked', op: 'gte', value: thirtyDaysAgo.toISOString().split('T')[0] }],
          pageSize: 10
        });
        
        const itemCount = response.data?.items?.length || 0;
        const pageDetails = response.data?.pageDetails;
        
        results.testResults.push({
          test: 'TimeEntries Pagination',
          status: pageDetails ? 'pass' : 'partial',
          notes: `Retrieved ${itemCount} entries, pageDetails: ${!!pageDetails}`,
          pageDetails: pageDetails
        });
        
        console.log(`   ✅ Retrieved ${itemCount} time entries`);
        console.log(`   ✅ pageDetails: ${JSON.stringify(pageDetails)}`);
        
        // Check if there are more pages
        if (pageDetails?.nextPageUrl) {
          console.log(`   📄 More pages available: ${pageDetails.nextPageUrl}`);
        }
        
      } catch (error) {
        results.testResults.push({
          test: 'TimeEntries Pagination',
          status: 'error',
          notes: error.message
        });
        console.log(`   ❌ Error: ${error.message}`);
      }
      
      results.features.autoZoneDiscovery = true;
      results.features.multiTenantSupport = true;
    }
    
  } catch (error) {
    console.error('❌ Failed to test autotask-node:', error.message);
  }
  
  return results;
}

/**
 * Analyze @apigrate/autotask-restapi capabilities
 * (Static analysis since it may not be installed)
 */
function analyzeApigrateLibrary() {
  console.log('\n' + '='.repeat(60));
  console.log('📦 ANALYZING: @apigrate/autotask-restapi');
  console.log('='.repeat(60));
  
  const results = { ...COMPARISON_RESULTS, library: '@apigrate/autotask-restapi' };
  
  console.log('\n📋 Based on documentation analysis:\n');
  
  // Based on the library documentation in .cursorrules
  results.features = {
    paginationMetadata: true,  // Returns pageDetails with count, requestCount, prevPageUrl, nextPageUrl
    pageDetailsInResponse: true,  // Native in query responses
    nextPageUrl: true,  // Included in pageDetails
    totalCountAvailable: true,  // Has count() method
    autoZoneDiscovery: true,  // "API calls automatically invoke zoneInformation"
    errorClassWithDetails: true,  // AutotaskApiError class with status, details
    multiTenantSupport: true,  // Can create multiple AutotaskRestApi instances
  };
  
  const features = [
    { name: 'Native pageDetails in responses', supported: true, detail: 'items[], pageDetails: {count, requestCount, prevPageUrl, nextPageUrl}' },
    { name: 'count() method', supported: true, detail: 'Autotask.Companies.count({filter: [...]}) → {queryCount: N}' },
    { name: 'Automatic zone discovery', supported: true, detail: 'No initialization needed, auto-discovers on first call' },
    { name: 'AutotaskApiError class', supported: true, detail: 'err.message, err.status, err.details' },
    { name: 'Child entity support', supported: true, detail: 'Proper parent-child relationships for create/update' },
    { name: 'UDF querying', supported: true, detail: 'filter with udf: true for user-defined fields' },
    { name: 'Impersonation', supported: true, detail: 'Via ImpersonationResourceId header' },
  ];
  
  features.forEach(f => {
    console.log(`   ${f.supported ? '✅' : '❌'} ${f.name}`);
    console.log(`      ${f.detail}`);
  });
  
  results.testResults.push({
    test: 'Documentation Analysis',
    status: 'pass',
    notes: 'All key pagination features supported per documentation'
  });
  
  return results;
}

/**
 * Generate comparison summary and recommendation
 */
function generateRecommendation(autotaskNodeResults, apigrateResults) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 COMPARISON SUMMARY');
  console.log('='.repeat(60));
  
  const features = [
    'paginationMetadata',
    'pageDetailsInResponse', 
    'nextPageUrl',
    'totalCountAvailable',
    'autoZoneDiscovery',
    'errorClassWithDetails',
    'multiTenantSupport'
  ];
  
  console.log('\n| Feature                  | autotask-node | @apigrate/autotask-restapi |');
  console.log('|--------------------------|---------------|---------------------------|');
  
  features.forEach(f => {
    const node = autotaskNodeResults.features[f] ? '✅' : '❌';
    const apigrate = apigrateResults.features[f] ? '✅' : '❌';
    const label = f.replace(/([A-Z])/g, ' $1').trim();
    console.log(`| ${label.padEnd(24)} | ${node.padEnd(13)} | ${apigrate.padEnd(25)} |`);
  });
  
  console.log('\n' + '='.repeat(60));
  console.log('💡 RECOMMENDATION');
  console.log('='.repeat(60));
  
  // Check if autotask-node actually provides pageDetails
  const nodeHasPageDetails = autotaskNodeResults.testResults.some(
    t => t.test === 'Pagination Response' && t.rawPageDetails
  );
  
  if (nodeHasPageDetails) {
    console.log(`
FINDING: autotask-node DOES provide pageDetails when using axios directly!

The current implementation can access pagination metadata by:
1. Using client.axios.post() instead of entity methods
2. Capturing response.data.pageDetails from API responses
3. Extracting: count, requestCount, prevPageUrl, nextPageUrl

RECOMMENDATION: Keep autotask-node but refactor AutotaskService to:
- Capture and return pageDetails from all query responses
- Build PaginatedResponse wrapper with "Showing X of Y" metadata
- No library change needed - just better response handling

This approach:
✅ Maintains backward compatibility
✅ Avoids migration risk
✅ Leverages existing tested code
✅ Provides all needed pagination info
`);
  } else {
    console.log(`
FINDING: Consider switching to @apigrate/autotask-restapi

Benefits:
- Native pageDetails in all responses
- count() method for total counts
- Better error handling with AutotaskApiError
- Active maintenance

Migration path:
1. Add @apigrate/autotask-restapi as dependency
2. Create adapter layer matching AutotaskService interface
3. Gradually migrate entity by entity
4. Run parallel tests to ensure parity
`);
  }
  
  return {
    recommendation: nodeHasPageDetails ? 'keep-autotask-node' : 'consider-apigrate',
    autotaskNodeResults,
    apigrateResults
  };
}

/**
 * Main execution
 */
async function main() {
  console.log('🔬 Autotask Library Comparison Tool');
  console.log('Comparing pagination and response handling capabilities\n');
  
  const autotaskNodeResults = await testAutotaskNode();
  const apigrateResults = analyzeApigrateLibrary();
  const recommendation = generateRecommendation(autotaskNodeResults, apigrateResults);
  
  // Write results to file for reference
  const outputPath = './scripts/library-comparison-results.json';
  const fs = await import('fs');
  fs.writeFileSync(outputPath, JSON.stringify(recommendation, null, 2));
  console.log(`\n📁 Full results saved to: ${outputPath}`);
  
  console.log('\n✅ Comparison complete!');
}

main().catch(console.error);




