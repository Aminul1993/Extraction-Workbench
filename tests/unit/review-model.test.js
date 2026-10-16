import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSchema } from '../../static/js/schema.js';
import {
  HIGH, WEAK_MATCH_CONF, normText, hasToken, linesContaining, lineHasLabel, lineHasAllCells,
  statusOf, verifiedBy, itemsFromRecord, fieldsFromRawLines, buildJson, buildSubmitJson, labelOf,
  recheckEvidence,
} from '../../static/js/review-model.js';

const SCHEMA = parseSchema({
  invoice_no: '', vendor_company_name: '', vendor_state: '', tax_amount: '', subtotal: '',
  construction_services: { nested: { description: '', sq_ft: '', price_per_sq_ft: '', total: '' } },
});

// OCR lines as Tesseract reports them for the sample invoice, at a 1000 x 1000 px page.
let nextY = 0;
const line = (text, confidence = 92) => ({ text: text + '\n', confidence, bbox: { x0: 10, y0: nextY += 20, x1: 500, y1: nextY + 15 } });
const LINES = [
  line('INVOICE'),
  line('Invoice No. INV-2026-982 Summit Property Holdings Ltd. Emerald Heights Residential Tower'),
  line('Due Date 12 October 2026 Denver, CO 80203 Denver, CO 80205'),
  line('accounts@summitproperty.com Site Code: EHT-2026-DV'),
  line('CONSTRUCTION SERVICES — STRUCTURAL'),
  line('1 Site Preparation & Excavation 750 $12.00 $9,000.00'),
  line('2 Foundation Construction 750 $28.00 $21,000.00'),
  line('Subtotal $130,500.00'),
  line('Tax (8%) $10,440.00'),
];
const PAGE = { lines: LINES, width: 1000, height: 1000 };

test('values match whole tokens only', () => {
  assert.equal(hasToken(normText('Denver, CO 80203'), 'co'), true);
  assert.equal(hasToken(normText('accounts@summitproperty.com'), 'co'), false);
  assert.equal(hasToken(normText('CONSTRUCTION SERVICES'), 'co'), false);
  assert.equal(hasToken(normText('Qty 7500'), '750'), false);
  assert.equal(hasToken('anything', ''), false);
});

test('case, whitespace and thousands separators are ignored', () => {
  assert.equal(normText('  Subtotal\n $130,500.00 '), 'subtotal $130500.00');
  assert.equal(normText('1,234,567'), '1234567');
  assert.equal(hasToken(normText('Subtotal $130,500.00'), normText('130500.00')), true);
});

test('one-character values are never located', () => {
  assert.deepEqual(linesContaining(LINES, '8'), []);
});

test('label evidence comes from the key\'s words', () => {
  assert.equal(lineHasLabel(LINES[8], 'tax_amount'), true);
  assert.equal(lineHasLabel(LINES[1], 'invoice_no'), true);
  assert.equal(lineHasLabel(LINES[1], 'vendor_company_name'), false);
});

test('a row matches its line only when every filled cell is on it', () => {
  const group = SCHEMA.groups[0];
  const row = { cells: { description: 'Site Preparation & Excavation', sq_ft: '750', price_per_sq_ft: '12.00', total: '9000.00' } };
  assert.equal(lineHasAllCells(LINES[5], row, group), true);
  assert.equal(lineHasAllCells(LINES[5], { cells: { ...row.cells, total: '$9,500.00' } }, group), false);
});

test('a value beside its label is verified; one away from its label waits for review', () => {
  const items = itemsFromRecord({
    invoice_no: 'INV-2026-982', vendor_company_name: 'Summit Property Holdings Ltd.',
    vendor_state: 'CO', tax_amount: '$10,440.00', subtotal: '$130,500.00',
  }, SCHEMA, PAGE);
  const byKey = Object.fromEntries(items.map(it => [it.field, it]));
  assert.equal(statusOf(byKey.invoice_no), 'verified');
  assert.equal(statusOf(byKey.tax_amount), 'verified');
  assert.equal(statusOf(byKey.subtotal), 'verified');
  // The BILL TO company, read as the vendor: found on the page, but not beside a vendor label.
  assert.equal(byKey.vendor_company_name.located, true);
  assert.equal(byKey.vendor_company_name.weak, true);
  assert.equal(statusOf(byKey.vendor_company_name), 'review');
  assert.ok(byKey.vendor_state.conf <= WEAK_MATCH_CONF);
});

test('line-item rows need every cell on the row\'s line', () => {
  const items = itemsFromRecord({ construction_services: [
    { description: 'Site Preparation & Excavation', sq_ft: '750', price_per_sq_ft: '$12.00', total: '$9,000.00' },
    { description: 'Foundation Construction', sq_ft: '750', price_per_sq_ft: '$28.00', total: '$12,000.00' },
  ] }, SCHEMA, PAGE);
  const rows = items.filter(it => it.kind === 'row');
  assert.equal(statusOf(rows[0]), 'verified');
  assert.equal(rows[1].weak, true);               // the total doesn't read on its line
  assert.equal(statusOf(rows[1]), 'review');
});

test('values the page doesn\'t contain stay unplaced, empty ones are missing', () => {
  const items = itemsFromRecord({ invoice_no: 'INV-0000-000', subtotal: '' }, SCHEMA, PAGE);
  const byKey = Object.fromEntries(items.filter(it => it.kind === 'field').map(it => [it.field, it]));
  assert.equal(byKey.invoice_no.located, false);
  assert.equal(statusOf(byKey.invoice_no), 'review');
  assert.equal(statusOf(byKey.subtotal), 'missing');
});

test('the label: value fallback never auto-confirms', () => {
  const page = { lines: [line('Invoice No: INV-1', 99), line('To: Someone', 99)], width: 1000, height: 1000 };
  const fields = fieldsFromRawLines(SCHEMA, page);
  const invoiceNo = fields.find(f => f.field === 'invoice_no');
  assert.equal(invoiceNo.value, 'INV-1');
  assert.ok(invoiceNo.conf < HIGH);
  // "To" is not a whole word of "Tax Amount" or "Subtotal", so it fills nothing.
  assert.equal(fields.find(f => f.field === 'tax_amount').value, '');
});

test('exports record who verified each item', () => {
  const items = itemsFromRecord({ invoice_no: 'INV-2026-982', subtotal: 'nope' }, SCHEMA, PAGE);
  items.find(it => it.field === 'subtotal').confirmed = true;
  const json = buildJson(items, SCHEMA, { fileName: 'inv.pdf', extractedAt: '2026-10-16T00:00:00.000Z' });
  const field = key => json.fields.find(f => f.key === key);
  assert.equal(field('invoice_no').verified_by, 'auto');
  assert.equal(field('subtotal').verified_by, 'reviewer');
  assert.equal(field('vendor_company_name').verified_by, null);
  assert.equal(json.extracted_at, '2026-10-16T00:00:00.000Z');
  assert.equal(verifiedBy({ kind: 'field', value: '', confirmed: false }), null);
});

test('the submitted record keeps the API\'s shape', () => {
  const items = itemsFromRecord({ invoice_no: 'INV-1', construction_services: [{ description: 'Roofing', total: '$1.00' }] }, SCHEMA, PAGE);
  assert.deepEqual(buildSubmitJson(items, SCHEMA), {
    invoice_no: 'INV-1', vendor_company_name: '', vendor_state: '', tax_amount: '', subtotal: '',
    construction_services: [{ description: 'Roofing', sq_ft: '', price_per_sq_ft: '', total: '$1.00' }],
  });
  const row = items.find(it => it.kind === 'row');
  assert.equal(labelOf(row, items, SCHEMA), 'Construction Service 1');
});

// What readBoxInto does with the text OCR reads under a box, before rechecking it.
function reread(it, text, confidence = 0.95){
  Object.assign(it, { value: text, evidence: text, suggestion: text, conf: confidence, located: true, weak: false, confirmed: false });
  recheckEvidence(it, SCHEMA);
}

test('re-reading a box keeps the label check', () => {
  const items = itemsFromRecord({ invoice_no: 'INV-2026-982', vendor_company_name: 'Summit Property Holdings Ltd.' }, SCHEMA, PAGE);
  const byKey = Object.fromEntries(items.map(it => [it.field, it]));
  // "Re-read boxes" reads the whole BILL TO line into the vendor field: still no vendor label.
  reread(byKey.vendor_company_name, LINES[1].text.trim());
  assert.equal(byKey.vendor_company_name.weak, true);
  assert.equal(statusOf(byKey.vendor_company_name), 'review');
  // A box that reads its own label stays confirmed.
  reread(byKey.invoice_no, 'Invoice No. INV-2026-982');
  assert.equal(statusOf(byKey.invoice_no), 'verified');
});

test('editing a row cell keeps it confirmed only while the page still backs it', () => {
  const [row] = itemsFromRecord({ construction_services: [
    { description: 'Site Preparation & Excavation', sq_ft: '750', price_per_sq_ft: '$12.00', total: '$9,000.00' },
  ] }, SCHEMA, PAGE).filter(it => it.kind === 'row');
  row.edited = true;
  row.cells.total = '9000.00';                    // same number, different formatting
  recheckEvidence(row, SCHEMA);
  assert.equal(statusOf(row), 'verified');
  assert.equal(verifiedBy(row), 'edited');
  row.cells.total = '$9,500.00';                  // no longer what the page says
  recheckEvidence(row, SCHEMA);
  assert.equal(statusOf(row), 'review');
});

test('values the reviewer changed are never reported as checked automatically', () => {
  const [field] = itemsFromRecord({ invoice_no: 'INV-2026-982' }, SCHEMA, PAGE);
  assert.equal(verifiedBy(field), 'auto');
  Object.assign(field, { value: 'INV-9999', edited: true });
  assert.equal(verifiedBy(field), 'edited');
  field.confirmed = true;
  assert.equal(verifiedBy(field), 'reviewer');
});
