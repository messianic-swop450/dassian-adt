/**
 * Auth resolution for dassian-adt.
 *
 * Single-system env vars (checked in order):
 *   1. SAP_SERVICE_KEY  — BTP service key JSON string or file path
 *   2. SAP_OAUTH_TOKEN_URL + SAP_CLIENT_ID + SAP_CLIENT_SECRET  — individual OAuth vars
 *   3. SAP_ENTRA_TENANT_ID + SAP_ENTRA_CLIENT_ID + SAP_ENTRA_CLIENT_SECRET  — Entra ID
 *   4. SAP_USER + SAP_PASSWORD  — basic auth (on-prem default)
 *
 * Multi-system:
 *   SAP_SYSTEMS — JSON array of SystemConfig objects (inline)
 *   SAP_SYSTEMS_FILE — path to a JSON file containing the same array
 *   When either is set, the single-system vars are ignored.
 *   SAP_DEFAULT_SYSTEM — id of the default system (first entry if omitted)
 *
 * The ADTClient accepts a token-fetcher function in place of a password string.
 * Tokens are cached with expiry awareness; re-fetched with a 60-second buffer before expiry.
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';

export interface AuthConfig {
  /** System identifier — defaults to 'default' in single-system mode. */
  id: string;
  url: string;
  user: string;
  /** String for basic auth; function for OAuth (passed to ADTClient as password param). */
  password: string | (() => Promise<string>);
  client: string;
  language: string;
  authType: 'basic' | 'oauth';
}

// ─── Token fetching — XSUAA / generic OAuth ──────────────────────────────────

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

function fetchTokenFromEndpoint(
  tokenUrl: string,
  clientId: string,
  clientSecret: string
): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = 'grant_type=client_credentials';
    const url = new URL(tokenUrl);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`OAuth token fetch failed (${res.statusCode}): ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as TokenResponse);
        } catch {
          reject(new Error(`OAuth token endpoint returned non-JSON: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Returns a caching token fetcher for XSUAA / generic OAuth (Basic-auth header style).
 * Refreshes the token 60 seconds before it expires.
 */
export function makeTokenFetcher(
  tokenUrl: string,
  clientId: string,
  clientSecret: string
): () => Promise<string> {
  let cachedToken: string | null = null;
  let expiresAt = 0;

  return async (): Promise<string> => {
    const now = Date.now();
    if (cachedToken && expiresAt > now + 60_000) {
      return cachedToken;
    }
    const result = await fetchTokenFromEndpoint(tokenUrl, clientId, clientSecret);
    cachedToken = result.access_token;
    expiresAt = now + result.expires_in * 1000;
    return cachedToken;
  };
}

// ─── Token fetching — Entra ID (Azure AD) ────────────────────────────────────

/**
 * Fetch a token from Microsoft Entra ID (Azure AD) using client credentials.
 * Credentials go in the POST body, NOT as a Basic auth header (unlike XSUAA).
 */
function fetchEntraToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  scope: string
): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const bodyParams = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    });
    const body = bodyParams.toString();
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const url = new URL(tokenUrl);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Entra ID token fetch failed (${res.statusCode}): ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as TokenResponse);
        } catch {
          reject(new Error(`Entra ID token endpoint returned non-JSON: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Returns a caching token fetcher for Microsoft Entra ID.
 * scope defaults to the SAP BTP XSUAA scope pattern; override for on-prem SAP via Entra.
 */
export function makeEntraTokenFetcher(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  scope: string
): () => Promise<string> {
  let cachedToken: string | null = null;
  let expiresAt = 0;

  return async (): Promise<string> => {
    const now = Date.now();
    if (cachedToken && expiresAt > now + 60_000) {
      return cachedToken;
    }
    const result = await fetchEntraToken(tenantId, clientId, clientSecret, scope);
    cachedToken = result.access_token;
    expiresAt = now + result.expires_in * 1000;
    return cachedToken;
  };
}

// ─── Service key parsing ─────────────────────────────────────────────────────

interface Uaa {
  url: string;
  clientid: string;
  clientsecret: string;
}

interface ServiceKey {
  uaa?: Uaa;
  credentials?: { uaa: Uaa; url?: string };
  url?: string;
}

function parseServiceKey(raw: string): { uaa: Uaa; systemUrl: string } {
  let key: ServiceKey;
  try {
    const src = raw.trimStart().startsWith('{') ? raw : fs.readFileSync(raw.trim(), 'utf8');
    key = JSON.parse(src) as ServiceKey;
  } catch (e: any) {
    throw new Error(`SAP_SERVICE_KEY: could not parse as JSON or read file — ${e.message}`);
  }

  const uaa = key.uaa ?? key.credentials?.uaa;
  const systemUrl = key.url ?? key.credentials?.url;

  if (!uaa?.url || !uaa?.clientid || !uaa?.clientsecret) {
    throw new Error(
      'SAP_SERVICE_KEY: missing required fields (uaa.url, uaa.clientid, uaa.clientsecret). ' +
      'Ensure the service key is a valid BTP ABAP Cloud service key.'
    );
  }

  return { uaa, systemUrl: systemUrl || '' };
}

// ─── Multi-system config ─────────────────────────────────────────────────────

/**
 * Per-system configuration entry in SAP_SYSTEMS / SAP_SYSTEMS_FILE.
 * Exactly one auth method should be provided; priority order:
 *   serviceKey > oauthTokenUrl > entraTenantId > password
 */
export interface SystemConfig {
  /** Short identifier used as sap_system_id in tool calls (e.g. "x22", "d23"). */
  id: string;
  /** SAP system base URL (e.g. "https://myhost:8443"). */
  url: string;
  /** SAP logon client (optional, defaults to ''). */
  client?: string;
  /** Logon language (optional, defaults to 'EN'). */
  language?: string;

  // ── Auth option 1: BTP service key ──────────────────────────────────────────
  /** BTP ABAP Cloud service key — JSON string or file path. */
  serviceKey?: string;

  // ── Auth option 2: Individual OAuth (XSUAA) ─────────────────────────────────
  oauthTokenUrl?: string;
  clientId?: string;
  clientSecret?: string;

  // ── Auth option 3: Entra ID (Azure AD) ──────────────────────────────────────
  entraTenantId?: string;
  entraClientId?: string;
  entraClientSecret?: string;
  /** OAuth2 scope for Entra ID. Defaults to "<url>/.default" if omitted. */
  entraScope?: string;

  // ── Auth option 4: Basic auth ────────────────────────────────────────────────
  user?: string;
  password?: string;

  /** Username to present to SAP (defaults to clientId for OAuth flows). */
  oauthUser?: string;
}

/**
 * Resolve auth config for a single SystemConfig entry.
 * Same priority order as resolveAuth() but operating on a config object.
 */
export function resolveSystemAuth(cfg: SystemConfig): AuthConfig {
  const client   = cfg.client   ?? '';
  const language = cfg.language ?? 'EN';

  // 1. Service key
  if (cfg.serviceKey) {
    const { uaa, systemUrl } = parseServiceKey(cfg.serviceKey);
    const url = cfg.url || systemUrl;
    if (!url) throw new Error(`System "${cfg.id}": url is required.`);
    const tokenUrl = `${uaa.url.replace(/\/$/, '')}/oauth/token`;
    return {
      id: cfg.id, url, user: cfg.oauthUser ?? uaa.clientid,
      password: makeTokenFetcher(tokenUrl, uaa.clientid, uaa.clientsecret),
      client, language, authType: 'oauth'
    };
  }

  // 2. Individual OAuth (XSUAA)
  if (cfg.oauthTokenUrl && cfg.clientId && cfg.clientSecret) {
    const url = cfg.url;
    if (!url) throw new Error(`System "${cfg.id}": url is required.`);
    return {
      id: cfg.id, url, user: cfg.oauthUser ?? cfg.clientId,
      password: makeTokenFetcher(cfg.oauthTokenUrl, cfg.clientId, cfg.clientSecret),
      client, language, authType: 'oauth'
    };
  }

  // 3. Entra ID
  if (cfg.entraTenantId && cfg.entraClientId && cfg.entraClientSecret) {
    const url = cfg.url;
    if (!url) throw new Error(`System "${cfg.id}": url is required.`);
    const scope = cfg.entraScope ?? `${url.replace(/\/$/, '')}/.default`;
    return {
      id: cfg.id, url, user: cfg.oauthUser ?? cfg.entraClientId,
      password: makeEntraTokenFetcher(cfg.entraTenantId, cfg.entraClientId, cfg.entraClientSecret, scope),
      client, language, authType: 'oauth'
    };
  }

  // 4. Basic auth
  if (!cfg.url) throw new Error(`System "${cfg.id}": url is required.`);
  if (!cfg.user || !cfg.password) {
    throw new Error(
      `System "${cfg.id}": authentication required. Provide one of: ` +
      'serviceKey, oauthTokenUrl+clientId+clientSecret, entraTenantId+entraClientId+entraClientSecret, or user+password.'
    );
  }
  return { id: cfg.id, url: cfg.url, user: cfg.user, password: cfg.password, client, language, authType: 'basic' };
}

// ─── SAP UI Landscape XML loader ─────────────────────────────────────────────

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    lib.get(url, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        } else {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Extract unique SAP system entries from a SAP UI Landscape XML string.
 * Returns a map of systemId → ADT base URL.
 *
 * ADT URL is built as: https://{host_with_domain_substitution}:{adtPort}
 *
 * SAP_LANDSCAPE_HOST_DOMAIN: replace the domain portion of landscape hostnames.
 *   e.g. set to "dassian.org" to rewrite "d23app.dassian.azure" → "d23app.dassian.org"
 *   Useful when the landscape XML uses internal DNS but ADT is exposed on a different domain.
 *   If omitted, hostnames are used as-is from the XML.
 */
function parseLandscapeXml(xml: string, adtPort: number, hostDomain?: string): Map<string, string> {
  const systems = new Map<string, string>();
  const serviceRe = /<Service\s([^>]+?)\/?>|<Service\s([^>]+?)>/g;
  let match: RegExpExecArray | null;

  while ((match = serviceRe.exec(xml)) !== null) {
    const attrs = match[1] || match[2];
    const getId   = /\bsystemid="([^"]+)"/i.exec(attrs);
    const getHost = /\bserver="([^"]+)"/i.exec(attrs);
    if (!getId || !getHost) continue;

    const id = getId[1].toLowerCase();
    // server is "hostname:port" — strip port
    let host = getHost[1].split(':')[0];
    if (!host) continue;

    // Optionally rewrite the domain (e.g. .dassian.azure → .dassian.org)
    if (hostDomain) {
      const dotIdx = host.indexOf('.');
      if (dotIdx !== -1) {
        host = `${host.slice(0, dotIdx)}.${hostDomain}`;
      }
    }

    // Skip duplicates (DR entries share the same host)
    if (!systems.has(id)) {
      systems.set(id, `https://${host}:${adtPort}`);
    }
  }
  return systems;
}

/**
 * Load systems from a SAP UI Landscape XML file (URL or local path).
 * Shared credentials (user/password/client/language) apply to all systems.
 * SAP_SYSTEMS_FILTER: comma-separated list of system IDs to include (default: all).
 */
async function loadLandscapeConfigs(
  source: string,
  adtPort: number,
  user: string,
  password: string,
  client: string,
  language: string,
  hostDomain?: string
): Promise<AuthConfig[]> {
  const xml = source.startsWith('http://') || source.startsWith('https://')
    ? await fetchUrl(source)
    : fs.readFileSync(source.trim(), 'utf8');

  const systems = parseLandscapeXml(xml, adtPort, hostDomain);
  if (systems.size === 0) {
    throw new Error(`SAP_LANDSCAPE: no Service entries with systemid+server found in "${source}".`);
  }

  const filterEnv = process.env.SAP_SYSTEMS_FILTER;
  const allowed = filterEnv
    ? new Set(filterEnv.split(',').map(s => s.trim().toLowerCase()))
    : null;

  const result: AuthConfig[] = [];
  for (const [id, url] of systems) {
    if (allowed && !allowed.has(id)) continue;
    result.push({ id, url, user, password, client, language, authType: 'basic' });
  }

  if (result.length === 0) {
    const available = [...systems.keys()].join(', ');
    throw new Error(`SAP_SYSTEMS_FILTER excluded all systems. Available: ${available}`);
  }

  return result;
}

/**
 * Resolve all system configurations.
 *
 * Priority order:
 *   1. SAP_LANDSCAPE_URL or SAP_LANDSCAPE_FILE — SAP UI Landscape XML (all systems share credentials)
 *   2. SAP_SYSTEMS (inline JSON) or SAP_SYSTEMS_FILE — per-system config JSON array
 *   3. Single-system env vars (SAP_URL + auth) — backward-compatible fallback
 *
 * Returns [configs, defaultSystemId].
 */
export async function resolveSystemConfigs(): Promise<[AuthConfig[], string]> {
  const landscapeSource = process.env.SAP_LANDSCAPE_URL || process.env.SAP_LANDSCAPE_FILE;

  if (landscapeSource) {
    const adtPort    = parseInt(process.env.SAP_LANDSCAPE_ADT_PORT || '44300', 10);
    const hostDomain = process.env.SAP_LANDSCAPE_HOST_DOMAIN;
    const user       = process.env.SAP_USER     ?? '';
    const password   = process.env.SAP_PASSWORD ?? '';
    const client     = process.env.SAP_CLIENT   ?? '';
    const language   = process.env.SAP_LANGUAGE ?? 'EN';
    if (!user || !password) {
      throw new Error('SAP_USER and SAP_PASSWORD are required when using SAP_LANDSCAPE_URL / SAP_LANDSCAPE_FILE.');
    }
    const authConfigs = await loadLandscapeConfigs(landscapeSource, adtPort, user, password, client, language, hostDomain);
    const defaultId = process.env.SAP_DEFAULT_SYSTEM ?? authConfigs[0].id;
    if (!authConfigs.find(a => a.id === defaultId)) {
      throw new Error(`SAP_DEFAULT_SYSTEM "${defaultId}" not found in landscape. Available: ${authConfigs.map(a => a.id).join(', ')}`);
    }
    return [authConfigs, defaultId];
  }

  const systemsEnv  = process.env.SAP_SYSTEMS;
  const systemsFile = process.env.SAP_SYSTEMS_FILE;
  let configs: SystemConfig[] | null = null;

  if (systemsEnv) {
    try {
      configs = JSON.parse(systemsEnv) as SystemConfig[];
    } catch (e: any) {
      throw new Error(`SAP_SYSTEMS: invalid JSON — ${e.message}`);
    }
  } else if (systemsFile) {
    try {
      const raw = fs.readFileSync(systemsFile.trim(), 'utf8');
      configs = JSON.parse(raw) as SystemConfig[];
    } catch (e: any) {
      throw new Error(`SAP_SYSTEMS_FILE "${systemsFile}": could not read or parse — ${e.message}`);
    }
  }

  if (configs) {
    if (!Array.isArray(configs) || configs.length === 0) {
      throw new Error('SAP_SYSTEMS / SAP_SYSTEMS_FILE must be a non-empty JSON array of system configs.');
    }
    const authConfigs = configs.map(resolveSystemAuth);
    const defaultId = process.env.SAP_DEFAULT_SYSTEM ?? authConfigs[0].id;
    if (!authConfigs.find(a => a.id === defaultId)) {
      throw new Error(`SAP_DEFAULT_SYSTEM "${defaultId}" not found in system list.`);
    }
    return [authConfigs, defaultId];
  }

  // Single-system fallback
  const single = resolveAuth();
  return [[single], single.id];
}

// ─── Single-system resolver ───────────────────────────────────────────────────

/**
 * Resolve auth configuration from environment variables (single-system mode).
 * Called once at server startup in stdio mode.
 * In HTTP per-user mode, basic credentials are passed directly — don't call this.
 */
export function resolveAuth(): AuthConfig {
  const client   = process.env.SAP_CLIENT   ?? '';
  const language = process.env.SAP_LANGUAGE ?? 'EN';
  const id       = process.env.SAP_SYSTEM_ID ?? 'default';

  // ── 1. Service key ──────────────────────────────────────────────────────────
  const serviceKeyEnv = process.env.SAP_SERVICE_KEY;
  if (serviceKeyEnv) {
    const { uaa, systemUrl } = parseServiceKey(serviceKeyEnv);
    const url = process.env.SAP_URL ?? systemUrl;
    if (!url) throw new Error('SAP_URL is required (or provide it in the service key).');
    const tokenUrl = `${uaa.url.replace(/\/$/, '')}/oauth/token`;
    return {
      id, url,
      user: process.env.SAP_OAUTH_USER ?? uaa.clientid,
      password: makeTokenFetcher(tokenUrl, uaa.clientid, uaa.clientsecret),
      client, language, authType: 'oauth'
    };
  }

  // ── 2. Individual OAuth vars ────────────────────────────────────────────────
  const oauthTokenUrl = process.env.SAP_OAUTH_TOKEN_URL;
  const clientId      = process.env.SAP_CLIENT_ID;
  const clientSecret  = process.env.SAP_CLIENT_SECRET;
  if (oauthTokenUrl && clientId && clientSecret) {
    const url = process.env.SAP_URL;
    if (!url) throw new Error('SAP_URL is required.');
    return {
      id, url,
      user: process.env.SAP_OAUTH_USER ?? clientId,
      password: makeTokenFetcher(oauthTokenUrl, clientId, clientSecret),
      client, language, authType: 'oauth'
    };
  }

  // ── 3. Entra ID ─────────────────────────────────────────────────────────────
  const entraTenantId    = process.env.SAP_ENTRA_TENANT_ID;
  const entraClientId    = process.env.SAP_ENTRA_CLIENT_ID;
  const entraClientSecret = process.env.SAP_ENTRA_CLIENT_SECRET;
  if (entraTenantId && entraClientId && entraClientSecret) {
    const url = process.env.SAP_URL;
    if (!url) throw new Error('SAP_URL is required.');
    const scope = process.env.SAP_ENTRA_SCOPE ?? `${url.replace(/\/$/, '')}/.default`;
    return {
      id, url,
      user: process.env.SAP_OAUTH_USER ?? entraClientId,
      password: makeEntraTokenFetcher(entraTenantId, entraClientId, entraClientSecret, scope),
      client, language, authType: 'oauth'
    };
  }

  // ── 4. Basic auth ───────────────────────────────────────────────────────────
  const url  = process.env.SAP_URL;
  const user = process.env.SAP_USER;
  const pass = process.env.SAP_PASSWORD;

  if (!url) throw new Error('SAP_URL is required.');
  if (!user || !pass) {
    throw new Error(
      'Authentication required. Provide one of:\n' +
      '  Basic auth:    SAP_USER + SAP_PASSWORD\n' +
      '  Service key:   SAP_SERVICE_KEY (BTP JSON string or file path)\n' +
      '  OAuth vars:    SAP_OAUTH_TOKEN_URL + SAP_CLIENT_ID + SAP_CLIENT_SECRET\n' +
      '  Entra ID:      SAP_ENTRA_TENANT_ID + SAP_ENTRA_CLIENT_ID + SAP_ENTRA_CLIENT_SECRET'
    );
  }

  return { id, url, user, password: pass, client, language, authType: 'basic' };
}
