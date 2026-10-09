# Extraction Workbench

A review tool for AI-extracted document data. Upload an invoice or form, check every extracted value against the page, and submit the verified record to the application that opened the workbench.

The review UI is a single file, `index.html`, with no build step. A small Flask API in [`api/`](api/) serves the page, supplies the reference schema, and runs the AI extraction.

## Screenshot

![Extraction Workbench reviewing invoice_INV-2026-982.pdf](sample.png)

*`invoice_INV-2026-982.pdf` right after extraction: 26 of 29 items confirmed automatically, 3 left to check.*

## Running it

```sh
cd api
python -m venv .venv
.venv/Scripts/activate        # Windows; use .venv/bin/activate elsewhere
pip install -r requirements.txt
cp .env.example .env          # set OLLAMA_MODEL and OLLAMA_API_KEY
python app.py
```

Then open <http://127.0.0.1:5000/>. To try it, drop in [`invoice_INV-2026-982.pdf`](invoice_INV-2026-982.pdf).

See [`api/README.md`](api/README.md) for the API's endpoints and settings.

## What it does

1. **Upload** an image (JPG/PNG) or PDF (first page only) of a document.
2. The page runs **OCR** locally in the browser (Tesseract.js) to read text and locate it on the page.
3. The file is sent once to the **extraction API** (`POST /extract`). The API converts it to text with MarkItDown, then asks an Ollama model to map that text onto the reference schema (for example invoice number, vendor address, line items).
4. Each extracted field is shown as a **marker box** on the document image, color-coded by status. Next to it, a **review rail** lets you confirm, edit, flag or skip each value.
5. When every field is checked (or you submit early), the JSON record is **posted back to the parent window** (`window.opener`) that launched the workbench.

## Key features

- **Document viewer**: zoom in and out, fit to page or width, and a close-up mode that keeps the focused field centered and readable.
- **Draggable, resizable markers**: if a box is in the wrong place, drag it over the correct text and click "Re-read box" to run OCR on just that region. "Re-read boxes" in the toolbar does this for every unconfirmed box.
- **Status model** for every field and row:
  - **Confirmed**: you confirmed it, or it's high-confidence and located on the page.
  - **Needs a look**: extracted but low-confidence, not located on the page, or flagged.
  - **Not found**: nothing was extracted.
- **Review rail** with three views (*To check*, *All*, *Done*), plus a progress bar and running counts in the top bar.
- **Repeatable line-item groups** (for example `construction_services` and `installations_and_finishing`) for any schema field that declares a `nested` sub-schema. You can add rows by hand when none were detected.
- **One-click suggestions**: when the OCR reading of a field's box differs from the extracted value, the OCR text is offered as a one-click replacement.
- **Keyboard-driven review**: press `?` to see the shortcuts.

  | Key | Action |
  |---|---|
  | `Enter` | Confirm the focused item and move to the next |
  | `↑` / `↓` (or `k` / `j`) | Move through the queue |
  | `/` | Focus the value input |
  | `F` | Flag the item for later |
  | `S` | Skip the item |
  | `R` | Re-read the item's box |

- **JSON preview**: the "JSON" tab shows a live snapshot of the record, and the rail footer has "Download" and "Copy JSON".
- **Reset**: "Revert edits" puts every value and box back to the last extraction. "Clear document" starts over.

## Configuration

The backend settings sit near the top of the `<script>` block in `index.html`:

```js
const SCHEMA_URL = "/schema";
const AI_URL = "/extract";
```

- **`SCHEMA_URL`**: where the page loads the reference schema from when it starts.
- **`AI_URL`**: where the uploaded file is sent, as `multipart/form-data`. The page's own query string is forwarded to this URL.

Both are relative because the Flask API serves the page. If you host `index.html` somewhere else, change them to the API's full URLs and add the page's origin to `CORS_ORIGINS` in `api/.env`.

```js
const FORM_TYPE = "{{form_type|escapejs}}";
const FORM_URL = "{{form_url|escapejs}}";
```

- **`FORM_URL`**: the target origin used when posting the submitted record back to the parent window. It must be the exact origin of the launching application. Don't use `*` in production.
- **`FORM_TYPE`**: sent as the message's `type`, so the parent can tell which form the record is for.

Both are still Django template placeholders from when the page was rendered by `pms_api`. When the Flask API serves the page, replace them with literal values.

### Defining the schema

The extraction target schema is in [`api/reference_schema.json`](api/reference_schema.json). The page loads it from `GET /schema`, and `POST /extract` maps documents onto the same file, so the two always agree. To use a different file, set `REFERENCE_SCHEMA_FILE` in `api/.env`.

```json
{
  "invoice_no": "",
  "invoice_date": "",
  ...
  "construction_services": { "nested": {
    "description": "", "sq_ft": "", "price_per_sq_ft": "", "total": ""
  }}
}
```

- Top-level scalar keys become individual review fields.
- A key whose value is an object with a `nested` sub-object becomes a **repeatable group**. It's shown as multiple rows, with a "+ Row" button in the queue.
- Field labels come from title-casing the snake_case key (for example `vendor_company_name` becomes "Vendor Company Name").

The schema should mirror the backend serializer or model the extracted data is saved to.

## Integration

This page is designed to be opened as a **popup or child window** from another application:

- On submit, it calls `window.opener.postMessage({ type: FORM_TYPE, data }, FORM_URL)` with the final record. The record is shaped as `{ field_key: value, ..., group_key: [ {cell_key: value, ...}, ... ] }`.
- If there's no `window.opener` (for example, the page was opened directly), the record is copied to the clipboard instead and a notice is shown.
- The parent application should listen for the `message` event and check `event.origin` before trusting the payload.

## Dependencies

Browser (loaded from CDNs):

- [pdf.js](https://cdnjs.cloudflare.com/ajax/libs/pdf.js/): renders the first page of an uploaded PDF to a canvas.
- [Tesseract.js](https://cdn.jsdelivr.net/npm/tesseract.js/): in-browser OCR, used for the initial text and line detection and for "Re-read box".
- Google Fonts: Plus Jakarta Sans (UI) and IBM Plex Mono (data and values).

API: Flask, MarkItDown and langchain-ollama (see [`api/requirements.txt`](api/requirements.txt)).

## Fallbacks and limits

- **Images:** the API has no OCR, so it can't read text from a JPG or PNG and the extraction request fails. The page then falls back to matching `label: value` lines in the in-browser OCR text. Line items aren't filled in this way; you add them by hand.
- **Extraction API down:** the page uses the same `label: value` fallback.
- **Tesseract.js fails to load:** values can't be located on the page, so their boxes start in default positions.
- **Schema can't be loaded:** the page shows a warning and has no fields to review. This also happens if `index.html` is opened as a local file instead of through the API.

## Browser support

Requires a modern browser with support for ES modules (including top-level `await`), `fetch`, `FormData`, Canvas, and the Clipboard API.
