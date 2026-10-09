# Extraction API (Flask)

This converts an uploaded document to Markdown with MarkItDown, asks an Ollama model to map it onto a reference schema, and returns the result as JSON. It also serves the workbench page and its schema, so the page's relative `SCHEMA_URL` (`/schema`) and `AI_URL` (`/extract`) work without CORS.

## Run

```sh
cd api
python -m venv .venv
.venv/Scripts/activate        # Windows; use .venv/bin/activate elsewhere
pip install -r requirements.txt
cp .env.example .env          # then set OLLAMA_MODEL (e.g. gpt-oss:120b) and OLLAMA_API_KEY
python app.py
```

Open <http://127.0.0.1:5000/> for the workbench.

## Endpoints

### `GET /`

Serves the workbench, `../index.html`.

### `GET /schema`

Returns the reference schema from `reference_schema.json` (or `REFERENCE_SCHEMA_FILE`). The workbench loads its fields from here, and it's the same schema `/extract` uses by default. Returns 404 if the file is missing.

### `POST /extract`

`multipart/form-data`:

| Field | Required | Notes |
|---|---|---|
| `file` | yes | The document (PDF, DOCX, XLSX, HTML, …: anything MarkItDown can turn into text). |
| `ref_schema` | no | Reference schema as a JSON string. Defaults to `reference_schema.json` (or `REFERENCE_SCHEMA_FILE`). |

On success the response is the extracted object: scalar keys map to strings, and each `nested` group maps to an array of row objects.

```sh
curl -F file=@../invoice_INV-2026-982.pdf http://127.0.0.1:5000/extract
```

On failure the response is `{"request_status": 0, "msg": "..."}`, the same error shape `pms_api` uses:

| Status | Cause |
|---|---|
| 400 | Missing file, missing or invalid schema, or a file MarkItDown can't read |
| 413 | Upload larger than `MAX_UPLOAD_MB` |
| 422 | The file has no readable text (for example, an image with no text layer) |
| 500 | `OLLAMA_MODEL` isn't set |
| 502 | The model call failed or the model didn't return JSON |

### `GET /health`

Returns `{"status": "ok"}`.
