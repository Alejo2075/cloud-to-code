const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'await',
  'async',
  'props',
  'scope',
  'id',
  'cdk',
]);

export function isIdentifier(s: string): boolean {
  return IDENT.test(s);
}

export function safeVarName(name: string): string {
  const base = name.charAt(0).toLowerCase() + name.slice(1);
  return RESERVED.has(base) ? `${base}Resource` : base;
}

/** Single-quoted TypeScript string literal. */
export function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
  return `'${escaped}'`;
}

/** Segments of a template literal: plain text or a TypeScript expression. */
export type Segment = { text: string } | { expr: string };

export function renderSegments(segments: readonly Segment[]): string {
  const merged: Segment[] = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if ('text' in s && last && 'text' in last) last.text += s.text;
    else merged.push({ ...s });
  }
  if (merged.every((s) => 'text' in s))
    return quote(merged.map((s) => ('text' in s ? s.text : '')).join(''));
  const body = merged
    .map((s) =>
      'text' in s
        ? s.text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
        : `\${${s.expr}}`,
    )
    .join('');
  return `\`${body}\``;
}

export type StringMapper = (s: string) => string;

/** Render a JSON-like value as a TypeScript literal, mapping every string through `mapString`. */
export function renderValue(value: unknown, mapString: StringMapper, indent = 0): string {
  const pad = '  '.repeat(indent + 1);
  const end = '  '.repeat(indent);
  if (value === null) return 'null';
  if (typeof value === 'string') return mapString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => `${pad}${renderValue(v, mapString, indent + 1)},`);
    return `[\n${items.join('\n')}\n${end}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return '{}';
    const props = entries.map(
      ([k, v]) =>
        `${pad}${isIdentifier(k) ? k : quote(k)}: ${renderValue(v, mapString, indent + 1)},`,
    );
    return `{\n${props.join('\n')}\n${end}}`;
  }
  return 'undefined';
}

export function indentBlock(code: string, levels: number): string {
  const pad = '  '.repeat(levels);
  return code
    .split('\n')
    .map((l) => (l.length > 0 ? pad + l : l))
    .join('\n');
}
