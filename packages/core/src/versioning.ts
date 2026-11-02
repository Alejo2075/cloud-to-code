/**
 * Versioned model migrations. Every serialized public model carries `schemaVersion`; reading older data
 * runs registered migrations in order. There are no released older versions yet, so the registry starts empty
 * and future schema changes must register a migration plus a compatibility fixture.
 */

export type ModelName = 'snapshot' | 'session' | 'plan';

export interface Migration {
  model: ModelName;
  from: string;
  to: string;
  migrate(input: Record<string, unknown>): Record<string, unknown>;
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(
    readonly model: string,
    readonly found: unknown,
    readonly supported: string,
  ) {
    super(
      `Unsupported ${model} schemaVersion ${JSON.stringify(found)}; this build supports "${supported}". ` +
        `Upgrade Cloud to Code or migrate the file.`,
    );
    this.name = 'UnsupportedSchemaVersionError';
  }
}

export class MigrationRegistry {
  private readonly migrations: Migration[] = [];

  register(migration: Migration): this {
    this.migrations.push(migration);
    return this;
  }

  /** Migrate `raw` to `target`, applying registered steps. Throws when no path exists. */
  migrate(model: ModelName, raw: unknown, target: string): Record<string, unknown> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError(`${model} must be a JSON object`);
    }
    let current = raw as Record<string, unknown>;
    const seen = new Set<string>();
    while (current['schemaVersion'] !== target) {
      const version = String(current['schemaVersion']);
      if (seen.has(version))
        throw new UnsupportedSchemaVersionError(model, current['schemaVersion'], target);
      seen.add(version);
      const step = this.migrations.find((m) => m.model === model && m.from === version);
      if (!step) throw new UnsupportedSchemaVersionError(model, current['schemaVersion'], target);
      current = { ...step.migrate(current), schemaVersion: step.to };
    }
    return current;
  }
}

export const defaultMigrations = new MigrationRegistry();
