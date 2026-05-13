/**
 * Pagination protocol tests (cursor + continue_query).
 */

import { PaginationEnforcer } from '../src/core/pagination';

describe('PaginationEnforcer (cursor protocol)', () => {
  it('COMPLETE omits nextAction', () => {
    const r = PaginationEnforcer.enforce({
      items: [{ id: 1 }],
      totalEstimate: 1,
      entityName: 'tickets',
      status: 'COMPLETE',
      pagesFetched: 1
    });
    expect(r.protocol.status).toBe('COMPLETE');
    expect(r.protocol.nextAction).toBeUndefined();
    expect(r.protocol.itemsAccumulated).toBe(1);
  });

  it('INCOMPLETE includes continue_query cursor', () => {
    const r = PaginationEnforcer.enforce({
      items: [{ id: 1 }],
      totalEstimate: 5000,
      entityName: 'tickets',
      status: 'INCOMPLETE',
      cursor: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      truncationReason: 'budget-pages',
      pagesFetched: 20
    });
    expect(r.protocol.status).toBe('INCOMPLETE');
    expect(r.protocol.nextAction?.tool).toBe('continue_query');
    expect(r.protocol.nextAction?.callWith.cursor).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
    expect(r.protocol.truncationReason).toBe('budget-pages');
  });
});
