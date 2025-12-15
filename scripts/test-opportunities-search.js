#!/usr/bin/env node
/**
 * Test script for opportunities search functionality
 * 
 * Usage:
 *   node scripts/test-opportunities-search.js
 * 
 * Environment variables required:
 *   AUTOTASK_USER, AUTOTASK_SECRET, AUTOTASK_INTEGRATION_CODE
 */

import { AutotaskService } from '../dist/services/autotask.service.js';
import { Logger } from '../dist/utils/logger.js';

async function testOpportunitiesSearch() {
  const logger = new Logger({ level: 'info', prefix: 'test-opportunities' });
  
  // Create service
  const service = new AutotaskService(
    {
      username: process.env.AUTOTASK_USER,
      secret: process.env.AUTOTASK_SECRET,
      integrationCode: process.env.AUTOTASK_INTEGRATION_CODE
    },
    logger
  );

  console.log('🔍 Testing Opportunities Search...\n');

  try {
    // Test 1: Search all opportunities (limited to 10)
    console.log('Test 1: Search all opportunities (first 10)');
    const allOpportunities = await service.searchOpportunities({ pageSize: 10 });
    console.log(`✅ Found ${allOpportunities.length} opportunities`);
    if (allOpportunities.length > 0) {
      console.log('Sample opportunity:', {
        id: allOpportunities[0].id,
        title: allOpportunities[0].title,
        status: allOpportunities[0].status,
        amount: allOpportunities[0].amount,
        accountID: allOpportunities[0].accountID
      });
    }
    console.log('');

    // Test 2: Count opportunities
    console.log('Test 2: Count all opportunities');
    const totalCount = await service.countOpportunities();
    console.log(`✅ Total opportunities in system: ${totalCount}`);
    console.log('');

    // Test 3: Search by status (open opportunities)
    console.log('Test 3: Search for open opportunities (status=1)');
    const openOpportunities = await service.searchOpportunities({
      filter: [{ field: 'status', op: 'eq', value: 1 }],
      pageSize: 5
    });
    console.log(`✅ Found ${openOpportunities.length} open opportunities`);
    console.log('');

    // Test 4: Search by title
    if (allOpportunities.length > 0 && allOpportunities[0].title) {
      const searchTerm = allOpportunities[0].title.substring(0, 5);
      console.log(`Test 4: Search by title containing "${searchTerm}"`);
      const searchResults = await service.searchOpportunities({
        filter: [{ field: 'title', op: 'contains', value: searchTerm }],
        pageSize: 5
      });
      console.log(`✅ Found ${searchResults.length} opportunities matching search term`);
      console.log('');
    }

    console.log('✅ All opportunities search tests passed!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
    process.exit(1);
  }
}

// Run the test
testOpportunitiesSearch().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});

