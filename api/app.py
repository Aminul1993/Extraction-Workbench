"""Flask API for the Extraction Workbench: POST a document, get back the schema's fields as JSON."""
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

load_dotenv()

from extraction import ExtractionError, extraction_workflow  # noqa: E402 - needs .env loaded first

BASE_DIR = Path(__file__).resolve().parent
WORKBENCH_DIR = BASE_DIR.parent

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = int(os.getenv('MAX_UPLOAD_MB', '20')) * 1024 * 1024
app.json.sort_keys = False  # keep the schema's field order in responses

# The workbench page is usually served from another origin, so allow it explicitly.
cors_origins = [origin.strip() for origin in os.getenv('CORS_ORIGINS', '').split(',') if origin.strip()]
if cors_origins:
    CORS(app, origins=cors_origins)


def _load_default_schema():
    """Schema used when the request doesn't send one - the workbench only posts the file."""
    path = Path(os.getenv('REFERENCE_SCHEMA_FILE') or BASE_DIR / 'reference_schema.json')
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


@app.get('/health')
def health():
    return jsonify({'status': 'ok'})


@app.post('/extract')
def extract():
    upload = request.files.get('file')
    if not upload or not upload.filename:
        raise ExtractionError('File missing')

    ref_schema = request.form.get('ref_schema') or _load_default_schema()
    return jsonify(extraction_workflow(
        upload.read(),
        upload.filename,
        upload.mimetype,
        ref_schema,
    ))


@app.errorhandler(ExtractionError)
def handle_extraction_error(error):
    return jsonify({'request_status': 0, 'msg': error.msg}), error.status_code


@app.errorhandler(Exception)
def handle_unexpected_error(error):
    if isinstance(error, HTTPException):
        return jsonify({'request_status': 0, 'msg': error.description}), error.code
    logging.exception('Unhandled error during extraction')
    return jsonify({'request_status': 0, 'msg': str(error)}), 500


if __name__ == '__main__':
    app.run(host=os.getenv('HOST', '127.0.0.1'), port=int(os.getenv('PORT', '5000')))
