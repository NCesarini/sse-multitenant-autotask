#!/usr/bin/env node
/**
 * Demo: cursor pagination protocol (PaginationEnforcer + continue_query).
 * Run after `npm run build`.
 *
 *   node scripts/test-large-result-handling.js
 */

import { PaginationEnforcer } from '../dist/core/pagination.js';

console.log('📋 Cursor pagination protocol demo\n');
console.log('='.repeat(80));

// Small tenant — complete in one response
console.log('\n📊 Scenario 1: COMPLETE (all rows merged this call)');
console.log('-'.repeat(80));
const s1 = PaginationEnforcer.enforce({
  items: Array(120).fill({ id: 1 }),
  totalEstimate: 120,
  entityName: 'tickets',
  status: 'COMPLETE',
  pagesFetched: 1
});
console.log(JSON.stringify(s1.protocol, null, 2));

// Budget truncation — agent must continue_query
console.log('\n📊 Scenario 2: INCOMPLETE (server budget — use continue_query)');
console.log('-'.repeat(80));
const s2 = PaginationEnforcer.enforce({
  items: Array(2000).fill({ id: 1 }),
  totalEstimate: 50_000,
  entityName: 'tickets',
  status: 'INCOMPLETE',
  cursor: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  truncationReason: 'budget-pages',
  pagesFetched: 20,
  availableFilters: ['status', 'companyID', 'createdDateFrom']
});
console.log(JSON.stringify(s2.protocol, null, 2));

console.log('\n' + '='.repeat(80));
console.log('✅ Demo complete. Agents: never pass page>1; call continue_query with cursor until COMPLETE.\n');
