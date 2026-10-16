"""Flask API for the Extraction Workbench: POST a document, get back the schema's fields as JSON."""
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from itsdangerous import BadSignature, SignatureExpired
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()

import launch_token  # noqa: E402
from extraction import ExtractionError, extraction_workflow  # noqa: E402 - needs .env loaded first

BASE_DIR = Path(__file__).resolve().parent
WORKBENCH_DIR = BASE_DIR.parent


def _flag(name):
    return os.getenv(name, '').strip().lower() in ('1', 'true', 'yes')


logging.basicConfig(level=os.getenv('LOG_LEVEL', 'INFO'))

# The page's scripts and styles come from the dedicated static/ folder. Never point this at the
# repository root: that would also serve api/.env.
app = Flask(__name__, static_folder=str(WORKBENCH_DIR / 'static'), static_url_path='/static')
app.config.update(
    MAX_CONTENT_LENGTH=int(os.getenv('MAX_UPLOAD_MB') or 20) * 1024 * 1024,
    ALLOW_CLIENT_SCHEMA=_flag('ALLOW_CLIENT_SCHEMA'),
    LAUNCH_SECRET=os.getenv('WORKBENCH_LAUNCH_SECRET') or None,
    LAUNCH_MAX_AGE=int(os.getenv('WORKBENCH_LAUNCH_MAX_AGE') or 3600),
    EXTRACT_RATE_LIMIT=os.getenv('EXTRACT_RATE_LIMIT', '').strip(),
    CSP_ENFORCE=_flag('CSP_ENFORCE'),
    RATELIMIT_STORAGE_URI=os.getenv('RATELIMIT_STORAGE_URI') or 'memory://',
)
app.json.sort_keys = False  # keep the schema's field order in responses

# Behind a reverse proxy, trust its X-Forwarded-* headers so rate limits count per client.
if os.getenv('TRUST_PROXY_HOPS'):
    hops = int(os.getenv('TRUST_PROXY_HOPS'))
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=hops, x_proto=hops)

# The workbench page is usually served from another origin, so allow it explicitly.
cors_origins = [origin.strip() for origin in os.getenv('CORS_ORIGINS', '').split(',') if origin.strip()]
if cors_origins:
    CORS(app, origins=cors_origins)

limiter = Limiter(get_remote_address, app=app)

# Sent as Report-Only unless CSP_ENFORCE is set. No 'unsafe-eval', which also keeps pdf.js off
# its font-eval path; WebAssembly (Tesseract) only needs 'wasm-unsafe-eval'.
CSP = '; '.join([
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "worker-src 'self' blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "connect-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
])

# Reachable without a launch token: the page itself, its assets, and the health check.
PUBLIC_ENDPOINTS = {'workbench', 'static', 'health'}


@app.before_request
def require_launch_token():
    """With WORKBENCH_LAUNCH_SECRET set, API calls must carry the parent app's signed ?token=."""
    secret = app.config['LAUNCH_SECRET']
    if not secret or request.endpoint in PUBLIC_ENDPOINTS or request.method == 'OPTIONS':
        return None
    try:
        launch_token.verify(secret, request.args.get('token', ''), app.config['LAUNCH_MAX_AGE'])
    except SignatureExpired as e:
        raise ExtractionError('Launch link expired - reopen the workbench from the form', 401) from e
    except BadSignature as e:
        raise ExtractionError('Missing or invalid launch token', 401) from e
    return None


@app.after_request
def set_security_headers(response):
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Referrer-Policy', 'no-referrer')
    csp_header = 'Content-Security-Policy' if app.config['CSP_ENFORCE'] else 'Content-Security-Policy-Report-Only'
    response.headers.setdefault(csp_header, CSP)
    return response


def _schema_path():
    configured = os.getenv('REFERENCE_SCHEMA_FILE')
    # Relative paths resolve against api/, not the directory the server was started from.
    return BASE_DIR / configured if configured else BASE_DIR / 'reference_schema.json'


def _load_default_schema():
    """Schema used when the request doesn't send one - the workbench only posts the file."""
    path = _schema_path()
    if not path.is_file():
        return None
    with path.open(encoding='utf-8') as schema_file:
        return json.load(schema_file)


@app.get('/')
def workbench():
    # Served from here so the page's relative /schema and /extract calls hit this API.
    return send_from_directory(WORKBENCH_DIR, 'index.html')


@app.get('/schema')
def schema():
    ref_schema = _load_default_schema()
    if ref_schema is None:
        raise ExtractionError('Reference schema file not found', 404)
    return jsonify(ref_schema)


@app.get('/config')
def client_config():
    """Settings pms_api rendered into the page's template; the page reads them from here instead."""
    return jsonify({
        'form_url': os.getenv('FORM_URL', ''),
        'form_type': os.getenv('FORM_TYPE', ''),
    })


@app.get('/health')
def health():
    return jsonify({'status': 'ok'})


def _extract_rate_limit():
    return app.config['EXTRACT_RATE_LIMIT'] or '1000 per second'  # placeholder; exempt when unset


@app.post('/extract')
@limiter.limit(_extract_rate_limit, exempt_when=lambda: not app.config['EXTRACT_RATE_LIMIT'])
def extract():
    upload = request.files.get('file')
    if not upload or not upload.filename:
        raise ExtractionError('File missing')

    ref_schema = request.form.get('ref_schema')
    if ref_schema and not app.config['ALLOW_CLIENT_SCHEMA']:
        # Schema keys are written into the prompt, so callers can't supply their own unless enabled.
        raise ExtractionError('ref_schema is not accepted by this server (set ALLOW_CLIENT_SCHEMA)')

    return jsonify(extraction_workflow(
        upload.read(),
        upload.filename,
        upload.mimetype,
        ref_schema or _load_default_schema(),
        ocr_text=request.form.get('ocr_text', ''),
    ))


@app.errorhandler(ExtractionError)
def handle_extraction_error(error):
    return jsonify({'request_status': 0, 'msg': error.msg}), error.status_code


@app.errorhandler(Exception)
def handle_unexpected_error(error):
    if isinstance(error, HTTPException):
        return jsonify({'request_status': 0, 'msg': error.description}), error.code
    app.logger.exception('Unhandled error during extraction')
    # Details stay in the log; exception text can carry hostnames, paths or credentials.
    return jsonify({'request_status': 0, 'msg': 'Internal server error'}), 500


if __name__ == '__main__':
    # Development server. In production use a WSGI server instead, for example:
    #   waitress-serve --host 127.0.0.1 --port 5000 --threads 8 --channel-timeout 180 app:app
    app.run(host=os.getenv('HOST', '127.0.0.1'), port=int(os.getenv('PORT') or 5000))
