/* Where the page talks to the extraction API. Relative because the Flask API serves the page;
   if index.html is hosted somewhere else, use the API's full URLs here and add the page's
   origin to CORS_ORIGINS in api/.env. */
export const SCHEMA_URL = '/schema';
export const CONFIG_URL = '/config';
export const AI_URL = '/extract';

// A little longer than the API's own model timeout (OLLAMA_TIMEOUT_SECONDS, 120 s by default).
export const EXTRACT_TIMEOUT_MS = 150_000;
