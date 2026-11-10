import io
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

os.environ.setdefault('GROQ_MODEL', 'test-model')  # before the app reads its settings

import app as app_module  # noqa: E402
import extraction  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
SAMPLE_PDF = (REPO / 'invoice_INV-2026-982.pdf').read_bytes()


class StubModel:
    """Stands in for the Groq client: records each chat completion request and answers with
    `content` (or raises)."""

    def __init__(self):
        self.content, self.raises, self.calls = '{}', None, []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **request):
        self.calls.append(request)
        if self.raises:
            raise self.raises
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=self.content))])

    @property
    def prompt(self):
        return self.calls[-1]['messages'][0]['content']


@pytest.fixture(autouse=True)
def app_config():
    """Every test starts from the default settings, whatever api/.env says."""
    config = app_module.app.config
    saved = dict(config)
    config.update(TESTING=True, ALLOW_CLIENT_SCHEMA=False, LAUNCH_SECRET=None,
                  EXTRACT_RATE_LIMIT='', CSP_ENFORCE=False)
    app_module.limiter.reset()
    yield config
    config.clear()
    config.update(saved)


@pytest.fixture
def model(monkeypatch):
    stub = StubModel()
    monkeypatch.setattr(extraction, 'get_ai_model', lambda: stub)
    return stub


@pytest.fixture
def client():
    return app_module.app.test_client()


@pytest.fixture
def post(client):
    def _post(data=SAMPLE_PDF, name='invoice.pdf', query='', **form):
        return client.post('/extract' + query, data={'file': (io.BytesIO(data), name), **form},
                           content_type='multipart/form-data')
    return _post
