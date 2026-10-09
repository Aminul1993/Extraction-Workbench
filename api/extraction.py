"""Document -> schema extraction, ported from pms_api/ai_query/utils.py (extraction_workflow).

Framework-free: the Flask app hands in raw bytes, and failures surface as ExtractionError
instead of DRF's APIException. The model comes from environment config rather than the
AIMaster table.
"""
import io
import json
import os
import re

from langchain_ollama import ChatOllama
from markitdown import MarkItDown, StreamInfo


class ExtractionError(Exception):
    """A failure reported back to the caller as {'request_status': 0, 'msg': ...}."""

    def __init__(self, msg, status_code=400):
        super().__init__(msg)
        self.msg = msg
        self.status_code = status_code


def get_ai_model():
    model = os.getenv('OLLAMA_MODEL')
    if not model:
        raise ExtractionError('No model configured - set OLLAMA_MODEL', 500)
    return ChatOllama(
        base_url=os.getenv('OLLAMA_BASE_URL', 'https://ollama.com'),
        model=model,
        validate_model_on_init=False,
        temperature=0,
    )


def _title_from_snake(text):
    """"schedule_date" -> "Schedule Date" - the same label the workbench UI shows."""
    return ' '.join(word.capitalize() for word in str(text or '').split('_'))


def _split_reference_schema(ref_schema):
    """Split a serializer structure into scalar keys and repeatable nested groups.

    Mirrors the workbench: a field is a repeatable child-item group when its metadata carries
    a "nested" sub-schema (a DRF list serializer field); everything else is a scalar field.
    """
    nested_groups = [
        {'key': key, 'item_keys': list(meta['nested'].keys())}
        for key, meta in ref_schema.items()
        if isinstance(meta, dict) and isinstance(meta.get('nested'), dict) and meta['nested']
    ]
    nested_keys = {group['key'] for group in nested_groups}
    scalar_keys = [key for key in ref_schema if key not in nested_keys]
    return scalar_keys, nested_groups


def _build_extraction_prompt(document_markdown, ref_schema):
    """Turn the document Markdown + the reference schema into one strict extraction prompt."""
    scalar_keys, nested_groups = _split_reference_schema(ref_schema)
    all_keys = ', '.join(scalar_keys + [group['key'] for group in nested_groups])
    field_hints = ', '.join(
        '{key} (labeled "{label}" on the document)'.format(key=key, label=_title_from_snake(key))
        for key in scalar_keys
    )

    items_rules = ''
    for group in nested_groups:
        key_meanings = ', '.join(
            '"{key}" = {label}'.format(key=key, label=_title_from_snake(key))
            for key in group['item_keys']
        )
        items_rules += (
            '\n- "{key}" must be an array with one object per {label} row found in the document '
            '(empty array if none). Each object must have exactly these keys: {item_keys} ({meanings}).'
        ).format(
            key=group['key'],
            label=_title_from_snake(group['key']).lower(),
            item_keys=', '.join(group['item_keys']),
            meanings=key_meanings,
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


def _parse_extraction_response(content):
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
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed

    raise ExtractionError(f'AI did not return valid JSON: {raw[:500]}', 502)


def extraction_workflow(file_bytes, filename, content_type, ref_schema):
    """Convert the uploaded document to Markdown, then extract ref_schema's fields from it."""
    if isinstance(ref_schema, str):
        try:
            ref_schema = json.loads(ref_schema or '{}')
        except ValueError:
            raise ExtractionError('Reference schema is not valid JSON')
    if not isinstance(ref_schema, dict) or not ref_schema:
        raise ExtractionError('Reference schema missing')

    ai_model = get_ai_model()

    # The filename/content type go along so MarkItDown can pick the right converter - no
    # temp file on disk.
    stream_info = StreamInfo(
        extension=(os.path.splitext(filename or '')[1].lower() or None),
        mimetype=content_type or None,
        filename=filename or None,
    )
    try:
        document_markdown = MarkItDown().convert_stream(io.BytesIO(file_bytes), stream_info=stream_info).markdown
    except Exception as e:
        error_message = str(e.args[0]) if e.args else str(e)
        raise ExtractionError(f'Could not read the uploaded file: {error_message}')

    document_markdown = (document_markdown or '').strip()
    if not document_markdown:
        raise ExtractionError('No readable text found in the uploaded file', 422)

    prompt = _build_extraction_prompt(document_markdown, ref_schema)
    try:
        result = ai_model.invoke([{'role': 'user', 'content': prompt}])
    except Exception as e:
        error_message = str(e.args[0]) if e.args else str(e)
        raise ExtractionError(error_message, 502)

    return _parse_extraction_response(result.content)
