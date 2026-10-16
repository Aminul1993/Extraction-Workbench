"""Document -> schema extraction, ported from pms_api/ai_query/utils.py (extraction_workflow).

Framework-free: the Flask app hands in raw bytes, and failures surface as ExtractionError
instead of DRF's APIException. The model comes from environment config rather than the
AIMaster table.
"""
from __future__ import annotations

import io
import json
import logging
import os
import re
import threading
import time
import zipfile
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import httpx
from langchain_ollama import ChatOllama
from markitdown import PRIORITY_GENERIC_FILE_FORMAT, MarkItDown, StreamInfo
from markitdown.converters import (
    DocxConverter,
    HtmlConverter,
    PdfConverter,
    PlainTextConverter,
    PptxConverter,
    XlsxConverter,
)

logger = logging.getLogger(__name__)

MAX_DOCUMENT_CHARS = int(os.getenv('MAX_DOCUMENT_CHARS') or 60_000)
MAX_UNPACKED_BYTES = int(os.getenv('MAX_UNPACKED_MB') or 50) * 1024 * 1024
STRUCTURED_OUTPUT = os.getenv('OLLAMA_STRUCTURED_OUTPUT', '').lower() in ('1', 'true', 'yes')
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg'}


class ExtractionError(Exception):
    """A failure reported back to the caller as {'request_status': 0, 'msg': ...}."""

    def __init__(self, msg: str, status_code: int = 400):
        super().__init__(msg)
        self.msg = msg
        self.status_code = status_code


@dataclass(frozen=True)
class SchemaSpec:
    """A reference schema split into scalar keys and repeatable nested groups.

    Mirrors the workbench: a field is a repeatable child-item group when its metadata carries
    a "nested" sub-schema (a DRF list serializer field); everything else is a scalar field.
    """
    keys: tuple[str, ...]                 # every top-level key, in schema order
    groups: dict[str, tuple[str, ...]]    # nested group key -> its row keys

    @classmethod
    def parse(cls, ref_schema: Any) -> SchemaSpec:
        if isinstance(ref_schema, str):
            try:
                ref_schema = json.loads(ref_schema or '{}')
            except ValueError as e:
                raise ExtractionError('Reference schema is not valid JSON') from e
        if not isinstance(ref_schema, dict) or not ref_schema:
            raise ExtractionError('Reference schema missing')
        groups = {
            key: tuple(meta['nested'])
            for key, meta in ref_schema.items()
            if isinstance(meta, dict) and isinstance(meta.get('nested'), dict) and meta['nested']
        }
        return cls(tuple(ref_schema), groups)

    @property
    def scalar_keys(self) -> tuple[str, ...]:
        return tuple(key for key in self.keys if key not in self.groups)

    def json_schema(self) -> dict[str, Any]:
        """JSON Schema for Ollama structured outputs: every value is a string."""
        text = {'type': 'string'}
        properties: dict[str, Any] = {}
        for key in self.keys:
            if key in self.groups:
                item_keys = self.groups[key]
                properties[key] = {'type': 'array', 'items': {
                    'type': 'object',
                    'properties': {item_key: text for item_key in item_keys},
                    'required': list(item_keys),
                }}
            else:
                properties[key] = text
        return {'type': 'object', 'properties': properties, 'required': list(self.keys)}

    def normalize(self, record: dict[str, Any]) -> dict[str, Any]:
        """Hold the model's output to the documented contract: strings, and lists of row objects."""
        out: dict[str, Any] = {}
        for key in self.keys:
            if key in self.groups:
                rows = record.get(key)
                out[key] = [
                    {item_key: _as_text(row.get(item_key)) for item_key in self.groups[key]}
                    for row in (rows if isinstance(rows, list) else [])
                    if isinstance(row, dict)
                ]
            else:
                out[key] = _as_text(record.get(key))
        return out


def _as_text(value: Any) -> str:
    if value is None:
        return ''
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


@lru_cache(maxsize=1)
def get_ai_model() -> ChatOllama:
    """Built once per process: ChatOllama sets up two HTTP clients, ~1.6 s on every request before."""
    model = os.getenv('OLLAMA_MODEL')
    if not model:
        raise ExtractionError('No model configured - set OLLAMA_MODEL', 500)
    num_ctx = os.getenv('OLLAMA_NUM_CTX')
    return ChatOllama(
        base_url=os.getenv('OLLAMA_BASE_URL', 'https://ollama.com'),
        model=model,
        validate_model_on_init=False,
        temperature=0,
        num_ctx=int(num_ctx) if num_ctx else None,
        # The ollama client has no timeout by default, so a stalled call held the request open forever.
        client_kwargs={'timeout': float(os.getenv('OLLAMA_TIMEOUT_SECONDS') or 120)},
    )


def _build_converter() -> MarkItDown:
    # Only the document formats the workbench handles. The default build also unpacks ZIP
    # archives (even renamed to .pdf), sends audio to Google's speech API for transcription,
    # and parses EPUB, Outlook and notebook files.
    md = MarkItDown(enable_builtins=False, enable_plugins=False)
    for converter in (PdfConverter(), DocxConverter(), XlsxConverter(), PptxConverter()):
        md.register_converter(converter)
    for converter in (HtmlConverter(), PlainTextConverter()):
        md.register_converter(converter, priority=PRIORITY_GENERIC_FILE_FORMAT)
    return md


_thread_local = threading.local()


def _converter() -> MarkItDown:
    """One MarkItDown per worker thread; building one costs ~200 ms."""
    md = getattr(_thread_local, 'markitdown', None)
    if md is None:
        md = _thread_local.markitdown = _build_converter()
    return md


def _check_unpacked_size(file_bytes: bytes) -> None:
    """DOCX/XLSX/PPTX are ZIP containers; refuse any that inflate past MAX_UNPACKED_MB."""
    if not file_bytes.startswith(b'PK\x03\x04'):
        return
    try:
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as archive:
            unpacked = sum(info.file_size for info in archive.infolist())
    except zipfile.BadZipFile as e:
        raise ExtractionError('Could not read the uploaded file: damaged archive') from e
    if unpacked > MAX_UNPACKED_BYTES:
        raise ExtractionError('The uploaded file unpacks to more than the allowed size', 413)


def _document_text(file_bytes: bytes, filename: str, content_type: str | None) -> str:
    extension = os.path.splitext(filename or '')[1].lower()
    if extension in IMAGE_EXTENSIONS or (content_type or '').startswith('image/'):
        return ''  # no OCR here; the workbench sends the page's own OCR text as ocr_text
    _check_unpacked_size(file_bytes)
    # The filename/content type go along so MarkItDown can pick the right converter - no
    # temp file on disk.
    stream_info = StreamInfo(extension=extension or None, mimetype=content_type or None,
                             filename=filename or None)
    try:
        result = _converter().convert_stream(io.BytesIO(file_bytes), stream_info=stream_info)
    except Exception as e:
        logger.info('Could not convert %r: %s', filename, e)
        raise ExtractionError(
            'Could not read the uploaded file - supported types are PDF, DOCX, XLSX, PPTX, HTML and text'
        ) from e
    return (result.markdown or '').strip()


def _title_from_snake(text: str) -> str:
    """"schedule_date" -> "Schedule Date" - the same label the workbench UI shows."""
    return ' '.join(word.capitalize() for word in str(text or '').split('_'))


def _build_extraction_prompt(document_markdown: str, spec: SchemaSpec) -> str:
    """Turn the document Markdown + the reference schema into one strict extraction prompt."""
    all_keys = ', '.join([*spec.scalar_keys, *spec.groups])
    field_hints = ', '.join(
        f'{key} (labeled "{_title_from_snake(key)}" on the document)' for key in spec.scalar_keys
    )
    items_rules = ''
    for key, item_keys in spec.groups.items():
        meanings = ', '.join(f'"{item_key}" = {_title_from_snake(item_key)}' for item_key in item_keys)
        items_rules += (
            f'\n- "{key}" must be an array with one object per {_title_from_snake(key).lower()} row found in the document '
            f'(empty array if none). Each object must have exactly these keys: {", ".join(item_keys)} ({meanings}).'
        )

    return f'''You are a strict data extraction engine. Read the document text below and output ONLY one JSON object with exactly these keys: {all_keys}.
Field meanings: {field_hints}.
Rules:
- Use "" for any scalar field you cannot find in the text.
- Do not invent values.{items_rules}
- Output raw JSON only - no markdown, no code fences, no explanation.

Document text:
"""
{document_markdown}
"""'''


def _parse_extraction_response(content: Any) -> dict[str, Any]:
    """The model is told to emit raw JSON; still tolerate code fences or surrounding prose."""
    raw = str(content or '').strip()
    if raw.startswith('```'):
        raw = re.sub(r'^```[a-zA-Z]*\s*', '', raw)
        raw = re.sub(r'```$', '', raw.strip()).strip()

    candidates = [raw]
    opening, closing = raw.find('{'), raw.rfind('}')
    if opening != -1 and closing > opening:
        candidates.append(raw[opening:closing + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(parsed, dict):
            return parsed

    logger.warning('Model returned non-JSON output: %s', raw[:500])
    raise ExtractionError('AI did not return valid JSON', 502)


def extraction_workflow(file_bytes: bytes, filename: str, content_type: str | None,
                        ref_schema: Any, ocr_text: str = '') -> dict[str, Any]:
    """Convert the uploaded document to Markdown, then extract ref_schema's fields from it.

    ocr_text is the workbench's in-browser OCR of the page, used when the file itself has
    no text layer (an image).
    """
    spec = SchemaSpec.parse(ref_schema)
    ai_model = get_ai_model()

    started = time.perf_counter()
    document_markdown = _document_text(file_bytes, filename, content_type) or (ocr_text or '').strip()
    if not document_markdown:
        raise ExtractionError('No readable text found in the uploaded file', 422)
    if len(document_markdown) > MAX_DOCUMENT_CHARS:
        raise ExtractionError(
            f'Document text is too long ({len(document_markdown):,} characters; the limit is {MAX_DOCUMENT_CHARS:,})',
            413,
        )

    prompt = _build_extraction_prompt(document_markdown, spec)
    converted = time.perf_counter()
    try:
        result = ai_model.invoke(
            [{'role': 'user', 'content': prompt}],
            format=spec.json_schema() if STRUCTURED_OUTPUT else None,
        )
    except httpx.TimeoutException as e:
        logger.warning('Model call timed out: %s', e)
        raise ExtractionError('The extraction model timed out', 504) from e
    except Exception as e:
        logger.exception('Model call failed')
        raise ExtractionError('The extraction model could not be reached', 502) from e

    logger.info('Extracted %r: %d characters, converted in %.2fs, model call %.2fs',
                filename, len(document_markdown), converted - started, time.perf_counter() - converted)
    return spec.normalize(_parse_extraction_response(result.content))
