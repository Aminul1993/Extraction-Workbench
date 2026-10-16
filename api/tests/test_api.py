import io
import json
import time
import zipfile
from pathlib import Path

import httpx
import pytest

import extraction
import launch_token

SAMPLE_PNG = (Path(__file__).resolve().parents[2] / 'sample.png').read_bytes()


def make_zip(entries, compression=zipfile.ZIP_STORED):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return buf.getvalue()


# ---------- output contract ----------

def test_output_is_held_to_the_schema_contract(model, post):
    model.content = json.dumps({
        'invoice_no': 982, 'extra': 'x', 'construction_services': 'oops',
        'installations_and_finishing': [{'description': 'Roofing', 'total': 16500.0, 'bogus': 1}, 'junk'],
    })
    r = post()
    body = r.get_json()
    assert r.status_code == 200
    assert body['invoice_no'] == '982'
    assert 'extra' not in body
    assert body['due_date'] == ''
    assert body['construction_services'] == []
    assert body['installations_and_finishing'] == [
        {'description': 'Roofing', 'sq_ft': '', 'price_per_sq_ft': '', 'total': '16500.0'}]
    assert list(body)[:3] == ['invoice_no', 'invoice_date', 'due_date']


def test_model_output_in_code_fences_is_accepted(model, post):
    model.content = 'Here you go:\n```json\n{"invoice_no": "INV-1"}\n```'
    assert post().get_json()['invoice_no'] == 'INV-1'


def test_prompt_lists_every_key_and_carries_the_document(model, post):
    post()
    assert 'exactly these keys: invoice_no, invoice_date' in model.prompt
    assert 'INV-2026-982' in model.prompt
    assert model.calls[-1][1]['format'] is None


def test_structured_output_sends_a_json_schema(model, post, monkeypatch):
    monkeypatch.setattr(extraction, 'STRUCTURED_OUTPUT', True)
    post()
    schema = model.calls[-1][1]['format']
    assert schema['properties']['construction_services']['type'] == 'array'
    assert 'invoice_no' in schema['required']


def test_schema_parsing_matches_the_workbench():
    spec = extraction.SchemaSpec.parse({'a': '', 'b': {'nested': True}, 'c': {'nested': {}}, 'd': {'nested': {'x': ''}}})
    assert spec.scalar_keys == ('a', 'b', 'c')
    assert spec.groups == {'d': ('x',)}
    with pytest.raises(extraction.ExtractionError):
        extraction.SchemaSpec.parse('{not json')


# ---------- what gets converted ----------

def test_zip_archives_are_refused_even_renamed(model, post):
    archive = make_zip({'inner.txt': 'Invoice No: SMUGGLED'})
    assert post(archive, 'x.zip').status_code == 400
    assert post(archive, 'x.pdf').status_code == 400
    assert model.calls == []


def test_documents_that_inflate_too_far_are_refused_quickly(model, post):
    bomb = make_zip({'word/document.xml': 'A' * 60_000_000}, zipfile.ZIP_DEFLATED)
    started = time.perf_counter()
    r = post(bomb, 'bomb.docx')
    assert r.status_code == 413
    assert time.perf_counter() - started < 3
    assert model.calls == []


def test_over_long_document_text_is_refused(model, post):
    r = post(('Invoice No: 1\n' * 6000).encode(), 'long.txt')
    assert r.status_code == 413
    assert 'too long' in r.get_json()['msg']


@pytest.mark.parametrize('ocr_text, status', [('', 422), ('Invoice No: INV-1', 200)])
def test_images_are_extracted_from_the_pages_ocr_text(model, post, ocr_text, status):
    model.content = '{"invoice_no": "INV-1"}'
    r = post(SAMPLE_PNG, 'scan.png', ocr_text=ocr_text)
    assert r.status_code == status
    if status == 200:
        assert 'Invoice No: INV-1' in model.prompt


def test_missing_file_is_a_400(client):
    r = client.post('/extract', data={}, content_type='multipart/form-data')
    assert r.status_code == 400
    assert r.get_json() == {'request_status': 0, 'msg': 'File missing'}


def test_oversized_upload_is_a_413(post, app_config):
    app_config['MAX_CONTENT_LENGTH'] = 1024
    assert post(b'x' * 4096, 'big.txt').status_code == 413


# ---------- client-supplied schema ----------

def test_client_schema_is_refused_by_default(model, post):
    assert post(ref_schema='{"poem": ""}').status_code == 400
    assert model.calls == []


def test_client_schema_can_be_enabled(model, post, app_config):
    app_config['ALLOW_CLIENT_SCHEMA'] = True
    model.content = '{"poem": "x"}'
    assert post(ref_schema='{"poem": ""}').get_json() == {'poem': 'x'}


# ---------- errors ----------

def test_model_failures_do_not_leak_details(model, post):
    model.raises = RuntimeError('connect failed: https://internal-host:11434 token=abc')
    r = post()
    assert r.status_code == 502
    assert 'token' not in r.get_data(as_text=True)


def test_model_timeouts_are_a_504(model, post):
    model.raises = httpx.ReadTimeout('timed out')
    assert post().status_code == 504


def test_non_json_model_output_is_a_502_without_echo(model, post):
    model.content = 'secret internal reasoning'
    r = post()
    assert r.status_code == 502
    assert 'secret' not in r.get_json()['msg']


def test_unexpected_errors_are_generic(post, monkeypatch):
    def boom():
        raise RuntimeError('password=hunter2')
    monkeypatch.setattr(extraction, 'get_ai_model', boom)
    r = post()
    assert r.status_code == 500
    assert r.get_json() == {'request_status': 0, 'msg': 'Internal server error'}


# ---------- model client ----------

def test_model_client_is_built_once_with_a_timeout(monkeypatch):
    monkeypatch.setenv('OLLAMA_MODEL', 'some-model')
    monkeypatch.setenv('OLLAMA_TIMEOUT_SECONDS', '45')
    extraction.get_ai_model.cache_clear()
    try:
        first = extraction.get_ai_model()
        assert extraction.get_ai_model() is first
        assert first.client_kwargs == {'timeout': 45.0}
    finally:
        extraction.get_ai_model.cache_clear()


def test_missing_model_setting_is_reported(monkeypatch):
    monkeypatch.delenv('OLLAMA_MODEL')
    extraction.get_ai_model.cache_clear()
    with pytest.raises(extraction.ExtractionError) as error:
        extraction.get_ai_model()
    assert error.value.status_code == 500


# ---------- page, config and headers ----------

def test_page_and_assets_are_served(client):
    assert client.get('/').status_code == 200
    assert client.get('/static/js/main.js').status_code == 200
    assert client.get('/static/css/workbench.css').status_code == 200


def test_files_outside_static_are_not_served(client):
    for path in ('/static/../api/.env.example', '/static/%2e%2e/api/app.py', '/api/app.py', '/README.md'):
        assert client.get(path).status_code == 404, path


def test_security_headers(client, app_config):
    headers = client.get('/').headers
    assert headers['X-Frame-Options'] == 'DENY'
    assert headers['X-Content-Type-Options'] == 'nosniff'
    assert "frame-ancestors 'none'" in headers['Content-Security-Policy-Report-Only']
    assert 'unsafe-eval' not in headers['Content-Security-Policy-Report-Only'].replace('wasm-unsafe-eval', '')
    app_config['CSP_ENFORCE'] = True
    assert 'Content-Security-Policy' in client.get('/').headers


def test_config_comes_from_the_environment(client, monkeypatch):
    monkeypatch.setenv('FORM_URL', 'https://app.example.com')
    monkeypatch.setenv('FORM_TYPE', 'invoice')
    assert client.get('/config').get_json() == {'form_url': 'https://app.example.com', 'form_type': 'invoice'}


def test_schema_and_health(client):
    assert 'invoice_no' in client.get('/schema').get_json()
    assert client.get('/health').get_json() == {'status': 'ok'}


# ---------- launch tokens ----------

def test_launch_token_is_required_when_configured(client, model, post, app_config):
    app_config['LAUNCH_SECRET'] = 's3cret'
    token = launch_token.issue('s3cret', {'form_type': 'invoice'})
    assert client.get('/schema').status_code == 401
    assert client.get('/schema?token=forged').status_code == 401
    assert post().status_code == 401
    assert client.get(f'/schema?token={token}').status_code == 200
    assert client.get(f'/config?token={token}').status_code == 200
    assert post(query=f'?token={token}').status_code == 200
    # The page, its assets and the health check stay public.
    for path in ('/', '/static/js/main.js', '/health'):
        assert client.get(path).status_code == 200, path


def test_expired_launch_token(client, app_config):
    app_config.update(LAUNCH_SECRET='s3cret', LAUNCH_MAX_AGE=-1)
    r = client.get('/schema?token=' + launch_token.issue('s3cret'))
    assert r.status_code == 401
    assert 'expired' in r.get_json()['msg']


# ---------- rate limiting ----------

def test_rate_limit_applies_when_configured(model, post, app_config):
    app_config['EXTRACT_RATE_LIMIT'] = '2 per minute'
    assert [post().status_code for _ in range(3)] == [200, 200, 429]
    assert post().get_json()['request_status'] == 0


def test_no_rate_limit_by_default(model, post):
    assert {post().status_code for _ in range(5)} == {200}
