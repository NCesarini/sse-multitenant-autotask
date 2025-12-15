#!/usr/bin/env node

/**
 * Debug script to test contracts search and verify status values
 */

require('dotenv').config();
const { AutotaskRestApi } = require('@apigrate/autotask-restapi');

async function main() {
  console.log('🔍 Testing Contracts Search Debug');
  console.log('================================\n');

  // Create Autotask client
  const autotask = new AutotaskRestApi(
    process.env.AUTOTASK_USERNAME,
    process.env.AUTOTASK_SECRET,
    process.env.AUTOTASK_INTEGRATION_CODE
  );

  try {
    // Test 1: Get field info for Contracts to see what status values are valid
    console.log('📊 Step 1: Getting field information for Contracts entity...\n');
    const fieldInfo = await autotask.Contracts.fieldInfo();
    const statusField = fieldInfo.fields.find(f => f.name === 'status');
    
    if (statusField && statusField.picklistValues) {
      console.log('✅ Contract Status Values:');
      statusField.picklistValues.forEach(pv => {
        console.log(`   ${pv.value}: ${pv.label} (active: ${pv.isActive}, default: ${pv.isDefaultValue})`);
      });
      console.log('');
    } else {
      console.log('⚠️  No picklist values found for status field\n');
    }

    // Test 2: Search for ALL contracts (no status filter) to see what's in the system
    console.log('📊 Step 2: Searching for all contracts (no status filter)...\n');
    const allContractsQuery = {
      filter: [{
        field: 'id',
        op: 'gte',
        value: 0
      }],
      pageSize: 10
    };
    console.log('Query body:', JSON.stringify(allContractsQuery, null, 2));
    
    const allContractsResponse = await autotask.Contracts.query(allContractsQuery);
    console.log(`\n✅ Found ${allContractsResponse.items?.length || 0} contracts (first 10)`);
    
    if (allContractsResponse.items && allContractsResponse.items.length > 0) {
      console.log('\nStatus values in actual contracts:');
      const statusCounts = {};
      allContractsResponse.items.forEach(c => {
        const status = c.status || 'null';
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      });
      Object.entries(statusCounts).forEach(([status, count]) => {
        console.log(`   Status ${status}: ${count} contract(s)`);
      });
      
      console.log('\nFirst contract sample:');
      const sample = allContractsResponse.items[0];
      console.log(JSON.stringify({
        id: sample.id,
        contractName: sample.contractName,
        status: sample.status,
        companyID: sample.companyID,
        startDate: sample.startDate,
        endDate: sample.endDate
      }, null, 2));
    } else {
      console.log('⚠️  No contracts found in the system\n');
    }

    // Test 3: Try searching with status=2
    console.log('\n📊 Step 3: Searching for contracts with status=2...\n');
    const status2Query = {
      filter: [{
        field: 'status',
        op: 'eq',
        value: 2
      }],
      pageSize: 10
    };
    console.log('Query body:', JSON.stringify(status2Query, null, 2));
    
    const status2Response = await autotask.Contracts.query(status2Query);
    console.log(`\n✅ Found ${status2Response.items?.length || 0} contracts with status=2`);
    
    if (status2Response.items && status2Response.items.length > 0) {
      console.log('\nSample contract with status=2:');
      console.log(JSON.stringify(status2Response.items[0], null, 2));
    }

    // Test 4: Try searching with status=1
    console.log('\n📊 Step 4: Searching for contracts with status=1...\n');
    const status1Query = {
      filter: [{
        field: 'status',
        op: 'eq',
        value: 1
      }],
      pageSize: 10
    };
    console.log('Query body:', JSON.stringify(status1Query, null, 2));
    
    const status1Response = await autotask.Contracts.query(status1Query);
    console.log(`\n✅ Found ${status1Response.items?.length || 0} contracts with status=1`);

    console.log('\n✅ Test complete!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

main();

