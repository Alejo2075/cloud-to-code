import { describe, expect, it } from 'vitest';
import { MigrationRegistry, UnsupportedSchemaVersionError } from './versioning.js';

describe('MigrationRegistry', () => {
  it('returns data already at the target version unchanged', () => {
    const reg = new MigrationRegistry();
    const data = { schemaVersion: '1', a: 1 };
    expect(reg.migrate('snapshot', data, '1')).toBe(data);
  });

  it('applies chained migrations in order', () => {
    const reg = new MigrationRegistry()
      .register({
        model: 'snapshot',
        from: '0',
        to: '1',
        migrate: (i) => ({ ...i, renamed: i['old'] }),
      })
      .register({ model: 'snapshot', from: '1', to: '2', migrate: (i) => ({ ...i, extra: true }) });
    const out = reg.migrate('snapshot', { schemaVersion: '0', old: 'x' }, '2');
    expect(out).toMatchObject({ schemaVersion: '2', renamed: 'x', extra: true });
  });

  it('rejects unknown and future versions with a clear error', () => {
    const reg = new MigrationRegistry();
    expect(() => reg.migrate('snapshot', { schemaVersion: '99' }, '1')).toThrow(
      UnsupportedSchemaVersionError,
    );
    expect(() => reg.migrate('snapshot', 'nope', '1')).toThrow(TypeError);
  });
});
