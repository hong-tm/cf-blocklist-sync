// Shared HTTP policy: one place for the read/write timeout budget and for the
// decision of whether a thrown error was a timeout rather than a real failure.

export const FETCH_TIMEOUT_MS = 30_000; // reads
export const PUSH_TIMEOUT_MS = 60_000; // writes

/** @param {{name: string, message?: string}} e */
export const timedOut = (e) => e.name === 'AbortError' || e.name === 'TimeoutError';

/**
 * Base URL with one trailing slash stripped (panel base URLs may or may not include it).
 * @param {string} url
 * @returns {string}
 */
export const trimTrailingSlash = (url) => url.replace(/\/$/, '');
