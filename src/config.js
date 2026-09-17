// Config loading from .env. OS environment variables override file values.
// CDN sections are optional — a CDN is enabled only when its BASE_URL is present.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// This module lives in src/; .env sits at the project root.
export const ENV_FILE = join(HERE, '..', '.env');
const REQUIRED_KEYS = ['CF_AUTH_TOKEN', 'CF_ACCOUNT_ID', 'CF_LIST_ID', 'URL_IPV4', 'URL_IPV6'];

/**
 * @typedef {{baseUrl: string, apiKey: string, apiSecret: string, wafConfigId: string}} CdnflyCfg
 * @typedef {{baseUrl: string, username: string, password: string, v4ListId: string, v6ListId: string}} GoedgeCfg
 * @typedef {{
 *   cfAuthToken: string,
 *   cfAccountId: string,
 *   cfListId: string,
 *   feedUrls: string[],
 *   cdnfly: CdnflyCfg | null,
 *   goedge: GoedgeCfg | null,
 * }} Config
 */

/**
 * Load config from the .env file; OS environment variables override file
 * values. CDN sections are optional — a CDN is enabled only when its
 * BASE_URL is present.
 * @returns {Config}
 */
export function loadConfig(envFile = ENV_FILE, env = process.env) {
  /** @type {Map<string, string>} */
  const values = new Map();
  try {
    for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      values.set(t.slice(0, i).trim(), t.slice(i + 1).trim().replace(/^['"]|['"]$/g, ''));
    }
  } catch (e) {
    throw new Error(`cannot read ${envFile}: ${e.message}`);
  }
  for (const [k, v] of Object.entries(env)) if (v) values.set(k, v);
  const missing = REQUIRED_KEYS.filter((k) => !values.get(k));
  if (missing.length > 0) {
    throw new Error(`missing config in ${envFile}: ${missing.join(', ')}`);
  }
  const cdnfly = values.get('CDNFLY_BASE_URL')
    ? {
        baseUrl: /** @type {string} */ (values.get('CDNFLY_BASE_URL')),
        apiKey: values.get('CDNFLY_API_KEY') ?? '',
        apiSecret: values.get('CDNFLY_API_SECRET') ?? '',
        wafConfigId: values.get('CDNFLY_WAF_CONFIG_ID') ?? 'global-0-openresty_config-openresty-config',
      }
    : null;
  const goedge = values.get('GOEDGE_BASE_URL')
    ? {
        baseUrl: /** @type {string} */ (values.get('GOEDGE_BASE_URL')),
        username: values.get('GOEDGE_USERNAME') ?? '',
        password: values.get('GOEDGE_PASSWORD') ?? '',
        v4ListId: values.get('GOEDGE_V4_LIST_ID') ?? '',
        v6ListId: values.get('GOEDGE_V6_LIST_ID') ?? '',
      }
    : null;
  return {
    cfAuthToken: /** @type {string} */ (values.get('CF_AUTH_TOKEN')),
    cfAccountId: /** @type {string} */ (values.get('CF_ACCOUNT_ID')),
    cfListId: /** @type {string} */ (values.get('CF_LIST_ID')),
    feedUrls: [/** @type {string} */ (values.get('URL_IPV4')), /** @type {string} */ (values.get('URL_IPV6'))],
    cdnfly,
    goedge,
  };
}
