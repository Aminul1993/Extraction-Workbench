import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSchema, cellKeysOf } from '../../static/js/schema.js';
import { ApiError, unwrapRecord, extractionFailureMessage } from '../../static/js/api.js';

test('nested groups are read the way the API reads them', () => {
  const schema = parseSchema({
    invoice_no: '',
    lines: { nested: { description: '', total: '' } },
    not_a_group: { nested: true },
    empty_group: { nested: {} },
  });
  assert.deepEqual(schema.groups.map(g => g.key), ['lines']);
  assert.deepEqual(schema.scalarKeys, ['invoice_no', 'not_a_group', 'empty_group']);
  assert.equal(schema.isEmpty, false);
  assert.equal(parseSchema(null).isEmpty, true);
  assert.equal(parseSchema([]).isEmpty, true);
});

test('a DRF-style group puts its first content column first', () => {
  const [group] = parseSchema({ items: { nested: {
    id: { type: 'IntegerField', read_only: true },
    is_active: { type: 'BooleanField' },
    description: { type: 'CharField' },
    total: { type: 'DecimalField' },
  } } }).groups;
  assert.equal(group.primary, 'description');
  assert.deepEqual(cellKeysOf(group), ['description', 'id', 'is_active', 'total']);
});

test('records are accepted as objects, pms_api message envelopes, or JSON strings', () => {
  assert.deepEqual(unwrapRecord({ invoice_no: '1' }), { invoice_no: '1' });
  assert.deepEqual(unwrapRecord({ message: { content: 'Here: {"invoice_no": "2"}' } }), { invoice_no: '2' });
  assert.deepEqual(unwrapRecord('{"invoice_no": "3"}'), { invoice_no: '3' });
  assert.throws(() => unwrapRecord(null), ApiError);
  assert.throws(() => unwrapRecord([1, 2]), ApiError);
});

test('failure messages say what happened', () => {
  assert.match(extractionFailureMessage(new ApiError('No readable text found', 422)), /^No readable text/);
  assert.match(extractionFailureMessage(Object.assign(new Error('x'), { name: 'TimeoutError' })), /^Extraction timed out/);
  assert.match(extractionFailureMessage(new ApiError('Missing or invalid launch token', 401)), /launch token/);
  assert.match(extractionFailureMessage(new TypeError('Failed to fetch')), /^Extraction service unreachable/);
});
