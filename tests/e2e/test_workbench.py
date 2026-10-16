import json

import pytest

import app as app_module
from sample_invoice import FORM_TYPE, SAMPLE_PDF, SAMPLE_PNG, SAMPLE_RECORD

pytestmark = pytest.mark.e2e

# The first run downloads Tesseract's WASM core and language data.
REVIEW_TIMEOUT_MS = 180_000


def upload(page, path):
    page.set_input_files('#fileInput', str(path))


def wait_for_review(page):
    page.wait_for_function("() => +document.getElementById('totalCount').textContent > 0", timeout=REVIEW_TIMEOUT_MS)


def review_record(page):
    """The JSON panel's record: every field and row with its status and who verified it."""
    page.click('#jsonToggleBtn')
    record = json.loads(page.inner_text('#jsonView'))
    page.click('#jsonToggleBtn')
    return record


def statuses(record):
    fields = {f['key']: f for f in record['fields']}
    rows = record['construction_services'] + record['installations_and_finishing']
    return fields, rows


def csp_violations(page):
    return [m for m in page.console_errors if 'Content Security Policy' in m]


def test_pdf_review_flow(page, servers, stub):
    page.goto(servers.workbench)
    upload(page, SAMPLE_PDF)
    wait_for_review(page)

    assert page.inner_text('#totalCount') == '29'
    fields, rows = statuses(review_record(page))
    # Values read beside their labels are confirmed automatically...
    for key in ('invoice_no', 'invoice_date', 'due_date', 'subtotal', 'total_amount_due'):
        assert fields[key]['verified_by'] == 'auto', key
    # ...but the BILL TO company read as the vendor is not, and neither is a row whose total
    # doesn't match its line on the page.
    for key in ('vendor_company_name', 'vendor_address', 'vendor_email'):
        assert fields[key]['status'] == 'review', key
    foundation = next(r for r in rows if r['description'] == 'Foundation Construction')
    assert foundation['status'] == 'review'
    site_prep = next(r for r in rows if r['description'] == 'Site Preparation & Excavation')
    assert site_prep['verified_by'] == 'auto'

    assert len(stub.prompts) == 1 and 'INV-2026-982' in stub.prompts[0]
    assert csp_violations(page) == []


def test_rereading_every_box_keeps_the_label_check(page, servers):
    page.goto(servers.workbench)
    upload(page, SAMPLE_PDF)
    wait_for_review(page)
    page.wait_for_timeout(3_500)          # let the completion toast clear
    page.click('#rereadAllBtn')
    page.wait_for_selector('.proc-overlay', state='hidden', timeout=REVIEW_TIMEOUT_MS)
    fields, _ = statuses(review_record(page))
    # Re-reading the BILL TO line into the vendor field still doesn't make it the vendor.
    for key in ('vendor_company_name', 'vendor_address', 'vendor_email'):
        assert fields[key]['status'] == 'review', key


def test_submit_reaches_the_parent_window(context, servers):
    parent = context.new_page()
    parent.goto(f'{servers.parent}/?target={servers.workbench}/')
    with parent.expect_popup() as popup:
        parent.click('#open')
    workbench = popup.value
    workbench.wait_for_load_state()       # the page's modules attach the upload handler on load
    upload(workbench, SAMPLE_PDF)
    wait_for_review(workbench)

    workbench.click('#submitBtn')
    workbench.click('#mSubmit')
    parent.wait_for_function('() => window.received.length > 0', timeout=10_000)
    message = parent.evaluate('() => window.received[0]')
    assert message['origin'] == servers.workbench
    assert message['data']['type'] == FORM_TYPE
    assert message['data']['data']['invoice_no'] == SAMPLE_RECORD['invoice_no']
    assert len(message['data']['data']['construction_services']) == 5


def test_images_are_extracted_from_the_pages_ocr_text(page, servers, stub):
    page.goto(servers.workbench)
    upload(page, SAMPLE_PNG)
    wait_for_review(page)
    # The screenshot has no text layer, so the API can only have read the page's OCR text.
    assert 'workbench' in stub.prompts[-1].lower()


def test_reset_during_extraction_discards_the_result(page, servers, stub):
    stub.delay = 4
    page.goto(servers.workbench)
    upload(page, SAMPLE_PDF)
    page.wait_for_selector('.proc-overlay', state='visible')
    page.click('#resetBtn')
    page.wait_for_timeout(7_000)
    assert page.inner_text('#totalCount') == '0'
    assert page.inner_text('#fileMeta') == 'No document'
    assert page.is_visible('#dropzone')


def test_extracted_values_are_rendered_as_text(page, servers, stub):
    payload = '<img src=x onerror="window.__xss=1">'
    stub.record = {**SAMPLE_RECORD, 'invoice_no': payload, 'tagline': payload,
                   'construction_services': [{'description': payload, 'sq_ft': payload, 'price_per_sq_ft': '', 'total': ''}]}
    page.goto(servers.workbench)
    upload(page, SAMPLE_PDF)
    wait_for_review(page)
    page.click('#jsonToggleBtn')
    page.click('#jsonToggleBtn')
    page.click('#submitBtn')
    # Shown as (JSON-escaped) text in the submit preview, never parsed as markup.
    assert '<img src=x onerror=' in page.inner_text('#modalBox')
    assert page.evaluate('() => window.__xss') is None
    assert page.locator('img[src="x"]').count() == 0


def test_reextract_asks_before_discarding_review(page, servers, stub):
    page.goto(servers.workbench)
    upload(page, SAMPLE_PDF)
    wait_for_review(page)
    page.keyboard.press('Enter')          # confirm the item in focus
    page.click('#rerunAiBtn')
    assert 'Re-extract this document?' in page.inner_text('#modalBox')
    page.click('#mCancel')
    assert len(stub.prompts) == 1
    page.click('#rerunAiBtn')
    page.click('#mReextract')
    page.wait_for_function('() => document.querySelector(".proc-overlay")?.style.display === "none"', timeout=30_000)
    assert len(stub.prompts) == 2


def test_page_works_with_the_csp_enforced(page, servers):
    app_module.app.config['CSP_ENFORCE'] = True
    page.goto(servers.workbench)
    upload(page, SAMPLE_PDF)
    wait_for_review(page)
    fields, _ = statuses(review_record(page))
    # Text recognition (Tesseract's worker and WebAssembly) ran, so values were located.
    assert fields['invoice_no']['verified_by'] == 'auto'
    assert csp_violations(page) == []
