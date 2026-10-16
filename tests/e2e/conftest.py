"""End-to-end fixtures: the real Flask app (with a stubbed model) and a "parent form" page on a
second origin, served on local ports and driven with Playwright.

Needs `pip install -r api/requirements-dev.txt` and a Chromium browser: either
`python -m playwright install chromium`, or an installed Chrome/Edge (set PLAYWRIGHT_CHANNEL to
`chrome` or `msedge` to pick one). The page loads pdf.js and Tesseract.js from their CDNs, so the
tests need network access.
"""
import json
import os
import threading
import time
from types import SimpleNamespace

import pytest
from werkzeug.serving import make_server

import app as app_module
import extraction

from sample_invoice import FORM_TYPE, SAMPLE_RECORD


class StubModel:
    """Answers every extraction with `record` after `delay` seconds and keeps the prompts."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.record, self.delay, self.prompts = SAMPLE_RECORD, 0.0, []

    def invoke(self, messages, **kwargs):
        self.prompts.append(messages[0]['content'])
        time.sleep(self.delay)
        return type('Result', (), {'content': json.dumps(self.record)})()


PARENT_PAGE = b'''<!doctype html><meta charset="utf-8"><title>Parent form</title>
<button id="open">Open workbench</button>
<script>
  window.received = [];
  window.addEventListener('message', e => window.received.push({ origin: e.origin, data: e.data }));
  document.getElementById('open').onclick = () =>
    window.open(new URLSearchParams(location.search).get('target'), 'workbench');
</script>'''


def _parent_app(environ, start_response):
    start_response('200 OK', [('Content-Type', 'text/html; charset=utf-8')])
    return [PARENT_PAGE]


def _serve(wsgi_app):
    server = make_server('127.0.0.1', 0, wsgi_app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture(scope='session')
def stub():
    return StubModel()


@pytest.fixture(scope='session')
def servers(stub):
    original_model = extraction.get_ai_model
    extraction.get_ai_model = lambda: stub
    workbench, parent = _serve(app_module.app), _serve(_parent_app)
    saved_env = {key: os.environ.get(key) for key in ('FORM_URL', 'FORM_TYPE')}
    parent_url = f'http://127.0.0.1:{parent.server_port}'
    os.environ.update(FORM_URL=parent_url, FORM_TYPE=FORM_TYPE)
    yield SimpleNamespace(workbench=f'http://127.0.0.1:{workbench.server_port}', parent=parent_url)
    for server in (workbench, parent):
        server.shutdown()
    extraction.get_ai_model = original_model
    for key, value in saved_env.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


@pytest.fixture(autouse=True)
def fresh_state(stub):
    stub.reset()
    config = app_module.app.config
    saved = dict(config)
    config.update(LAUNCH_SECRET=None, EXTRACT_RATE_LIMIT='', CSP_ENFORCE=False)
    yield
    config.clear()
    config.update(saved)


def _launch(chromium):
    preferred = os.getenv('PLAYWRIGHT_CHANNEL')
    error = None
    for channel in ([preferred] if preferred else [None, 'chrome', 'msedge']):
        try:
            return chromium.launch(channel=channel)
        except Exception as e:  # browser not installed for this channel
            error = e
    pytest.skip(f'No Chromium browser for the end-to-end tests: {error}')


@pytest.fixture(scope='session')
def browser():
    sync_api = pytest.importorskip('playwright.sync_api')
    with sync_api.sync_playwright() as playwright:
        browser = _launch(playwright.chromium)
        yield browser
        browser.close()


@pytest.fixture
def context(browser):
    context = browser.new_context()
    yield context
    context.close()


@pytest.fixture
def page(context):
    page = context.new_page()
    page.console_errors = []
    page.on('console', lambda msg: msg.type == 'error' and page.console_errors.append(msg.text))
    page.on('pageerror', lambda error: page.console_errors.append(str(error)))
    return page
