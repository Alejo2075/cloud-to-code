/**
 * Central sanitization. Every data path (persistence, logs, prompts, MCP responses, diagrams, reports)
 * must pass through here. It is defense in depth: collectors also use property allowlists.
 */

export const REDACTED = '[REDACTED]';

const MAX_STRING = 1000;
const MAX_ARRAY = 200;
const MAX_DEPTH = 8;

/** Normalized (lowercase, alphanumeric) key suffixes whose string values are treated as secrets. */
const SECRET_KEY_SUFFIXES = [
  'password',
  'passwd',
  'secret',
  'secretaccesskey',
  'secretkey',
  'apikey',
  'privatekey',
  'accesstoken',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'sessiontoken',
  'credential',
  'credentials',
  'connectionstring',
];

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
];

/** `password=hunter2`, `api_key: abc`, `aws_secret_access_key = ...` inside free text. */
const KEY_VALUE_SECRET =
  /\b((?:[A-Za-z0-9_-]*?)(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_-]*)(\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;

export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export interface RedactionResult {
  text: string;
  redactions: number;
}

/** Redact secret-like fragments from free text and strip control characters. */
export function redactSecrets(input: string): RedactionResult {
  let redactions = 0;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  let text = input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const pattern of SECRET_VALUE_PATTERNS) {
    text = text.replace(pattern, () => {
      redactions++;
      return REDACTED;
    });
  }
  text = text.replace(KEY_VALUE_SECRET, (_m, key: string, sep: string) => {
    redactions++;
    return `${key}${sep}${REDACTED}`;
  });
  return { text, redactions };
}

export interface SanitizeStats {
  redactions: number;
}

/**
 * Recursively sanitize an arbitrary JSON-like value: redact secret-looking values and keys, strip control
 * characters, cap string/array sizes and depth. Pure; returns a new value.
 */
export function sanitizeValue(
  value: unknown,
  stats: SanitizeStats = { redactions: 0 },
  depth = 0,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const { text, redactions } = redactSecrets(value);
    stats.redactions += redactions;
    return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…[truncated]` : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => sanitizeValue(v, stats, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} more omitted]`);
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && isSecretKey(key)) {
        stats.redactions++;
        out[key] = REDACTED;
      } else {
        out[key] = sanitizeValue(v, stats, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

/** Sanitize a flat map of tags. Tags are untrusted data; values are redacted and capped. */
export function sanitizeTags(tags: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(tags ?? {})) {
    const stats = { redactions: 0 };
    const safeKey = String(sanitizeValue(key, stats)).slice(0, 128);
    out[safeKey] = isSecretKey(key) ? REDACTED : String(sanitizeValue(v, stats)).slice(0, 256);
  }
  return out;
}

/** Keep only allowlisted top-level properties of `source`. */
export function pickAllowed(
  source: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * Wrap untrusted AWS-derived text (tags, names, descriptions) before it is shown to a model. The wrapper
 * labels the content as data and neutralizes delimiter forging.
 */
export function wrapUntrusted(label: string, text: string): string {
  const safe = redactSecrets(text).text.replace(/<\/?untrusted[^>]*>/gi, '');
  return `<untrusted source="${label.replace(/[^A-Za-z0-9_.:-]/g, '_')}">${safe}</untrusted>`;
}
