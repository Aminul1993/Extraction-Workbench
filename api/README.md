# Extraction API (Flask)

This converts an uploaded document to Markdown with MarkItDown, asks an Ollama model to map it onto a reference schema, and returns the result as JSON. It also serves the workbench page, its static files and its schema, so the page's relative `/schema`, `/config` and `/extract` calls work without CORS.

## Run

```sh
cd api
python -m venv .venv
.venv/Scripts/activate        # Windows; use .venv/bin/activate elsewhere
pip install -r requirements.txt
cp .env.example .env          # then set OLLAMA_MODEL (e.g. gpt-oss:120b), OLLAMA_API_KEY and FORM_URL
python app.py
```

Open <http://127.0.0.1:5000/> for the workbench.

`python app.py` is Flask's development server. In production use a WSGI server, for example:

```sh
waitress-serve --host 127.0.0.1 --port 5000 --threads 8 --channel-timeout 180 app:app
```

Keep `--channel-timeout` above `OLLAMA_TIMEOUT_SECONDS`, and put a TLS-terminating proxy in front. Behind a proxy, set `TRUST_PROXY_HOPS` so rate limits see client addresses.

## Endpoints

### `GET /`

Serves the workbench, `../index.html`. Its scripts and styles are served from `../static/` under `/static/`. Nothing else in the repository is served.

### `GET /schema`

Returns the reference schema from `reference_schema.json` (or `REFERENCE_SCHEMA_FILE`). The workbench loads its fields from here, and it's the same schema `/extract` uses. Returns 404 if the file is missing.

### `GET /config`

Returns `{"form_url": ..., "form_type": ...}` from `FORM_URL` and `FORM_TYPE`: where the page posts submitted records, and the message type it uses.

### `POST /extract`

`multipart/form-data`:

| Field | Required | Notes |
|---|---|---|
| `file` | yes | The document: PDF, DOCX, XLSX, PPTX, HTML or plain text. Images (PNG/JPG) are accepted with `ocr_text`. |
| `ocr_text` | no | Text read from the page by the workbench's OCR. Used when the file has no text layer, such as an image. |
| `ref_schema` | no | Reference schema as a JSON string. Refused unless `ALLOW_CLIENT_SCHEMA` is set, because its keys are written into the prompt. |

On success the response is the extracted record, held to the schema: every scalar key maps to a string (`""` when not found), and every `nested` group maps to an array of row objects with exactly the group's keys. Keys outside the schema are dropped.

```sh
curl -F file=@../invoice_INV-2026-982.pdf http://127.0.0.1:5000/extract
```

On failure the response is `{"request_status": 0, "msg": "..."}`, the same error shape `pms_api` uses:

| Status | Cause |
|---|---|
| 400 | Missing file, missing or invalid schema, a `ref_schema` the server doesn't accept, or a file type it doesn't read (ZIP archives, audio and others are refused) |
| 401 | Missing, invalid or expired launch token (only when `WORKBENCH_LAUNCH_SECRET` is set) |
| 413 | Upload larger than `MAX_UPLOAD_MB`, an Office file that unpacks past `MAX_UNPACKED_MB`, or document text longer than `MAX_DOCUMENT_CHARS` |
| 422 | The file has no readable text and no `ocr_text` was sent |
| 429 | More requests than `EXTRACT_RATE_LIMIT` allows |
| 500 | `OLLAMA_MODEL` isn't set, or an unexpected error (details go to the log, not the response) |
| 502 | The model call failed or the model didn't return JSON |
| 504 | The model didn't answer within `OLLAMA_TIMEOUT_SECONDS` |

### `GET /health`

Returns `{"status": "ok"}`.

## Settings

All settings are environment variables, read from `api/.env`. [`.env.example`](.env.example) lists them with their defaults. Beyond the model connection:

- **Model:** `OLLAMA_TIMEOUT_SECONDS` (120), `OLLAMA_NUM_CTX` (for a self-hosted Ollama, whose default context can silently truncate long documents), and `OLLAMA_STRUCTURED_OUTPUT` (sends the schema as a JSON Schema `format`; off by default because some models ignore it).
- **Limits:** `MAX_UPLOAD_MB` (20), `MAX_UNPACKED_MB` (50), `MAX_DOCUMENT_CHARS` (60,000).
- **Logging:** `LOG_LEVEL` (INFO). Each extraction logs the file name, the document's length, and how long conversion and the model call took.

Documents are sent to the configured Ollama server. With the default `OLLAMA_BASE_URL` that's ollama.com; point it at a self-hosted Ollama for documents that mustn't leave your network.

## Access control

By default the API trusts whoever can reach it, which is fine on `127.0.0.1`. Before exposing it further:

- **Launch tokens.** Set `WORKBENCH_LAUNCH_SECRET`. The parent application then signs a token with the same secret and opens the workbench at `/?token=<token>`. The page forwards its query string, so `/schema`, `/config` and `/extract` all receive it. Tokens expire after `WORKBENCH_LAUNCH_MAX_AGE` seconds (3600). The page itself, `/static/` and `/health` stay public.

  ```python
  from itsdangerous import URLSafeTimedSerializer
  token = URLSafeTimedSerializer(secret, salt='extraction-workbench').dumps({'form_type': 'invoice'})
  ```

  [`launch_token.py`](launch_token.py) does the same (`issue()` and `verify()`); `python launch_token.py` prints a token for local testing.
- **Rate limit.** Set `EXTRACT_RATE_LIMIT`, for example `20 per minute`, to cap extractions per client. With several server processes, point `RATELIMIT_STORAGE_URI` at a shared store such as Redis.
- **Content Security Policy.** Every response carries one, as `Content-Security-Policy-Report-Only` so violations only show in the browser console. Set `CSP_ENFORCE=true` to enforce it once the console stays clean in normal use. One end-to-end test runs the whole PDF flow in Chromium with it enforced; other browsers haven't been tested that way.

## Tests

From the repository root:

```sh
pip install -r api/requirements-dev.txt
pytest api/tests        # API only; plain `pytest` also runs the browser tests
```

The tests replace the model with a stub, so they need no Ollama access.

## Dependencies

[`requirements.in`](requirements.in) lists the direct dependencies; [`requirements.txt`](requirements.txt) pins the whole tree for every platform. After changing `requirements.in`:

```sh
uv pip compile requirements.in --universal --python-version 3.10 -o requirements.txt
pip-audit -r requirements.txt --no-deps --disable-pip
```
