import type { CloudResource } from '@cloud-to-code/core';
import type { PropertyCoverage, PropertyStatus } from './types.js';

/**
 * Records, per resource, what happened to every observed property. Anything the rule never touched ends up
 * as `not-mapped`, so the coverage report cannot silently overstate what was reproduced.
 */
export class Tracker {
  private readonly seen = new Map<string, PropertyCoverage>();

  constructor(private readonly resource: CloudResource) {}

  /** Read an observed property and mark it as preserved. */
  take<T = unknown>(name: string): T | undefined {
    const value = this.resource.observedProperties[name];
    if (value !== undefined) this.mark(name, 'preserved');
    return value as T | undefined;
  }

  has(name: string): boolean {
    return this.resource.observedProperties[name] !== undefined;
  }

  peek<T = unknown>(name: string): T | undefined {
    return this.resource.observedProperties[name] as T | undefined;
  }

  mark(name: string, status: PropertyStatus, note?: string): void {
    const previous = this.seen.get(name);
    // Never downgrade a worse status to a better one.
    const rank: Record<PropertyStatus, number> = {
      preserved: 0,
      'intentionally-omitted': 1,
      approximated: 2,
      'not-mapped': 3,
      unresolved: 4,
    };
    if (previous && rank[previous.status] >= rank[status]) return;
    this.seen.set(name, { name, status, ...(note ? { note } : {}) });
  }

  approximated(name: string, note: string): void {
    this.mark(name, 'approximated', note);
  }

  omitted(name: string, note: string): void {
    if (this.has(name)) this.mark(name, 'intentionally-omitted', note);
  }

  unresolved(name: string, note: string): void {
    this.mark(name, 'unresolved', note);
  }

  finish(): PropertyCoverage[] {
    for (const name of Object.keys(this.resource.observedProperties)) {
      if (!this.seen.has(name))
        this.mark(
          name,
          'not-mapped',
          'Observed but not reproduced by the generator; verify manually.',
        );
    }
    if (Object.keys(this.resource.tags).length > 0 && !this.seen.has('tags')) {
      const user = Object.keys(this.resource.tags).filter((k) => !k.startsWith('aws:'));
      if (user.length === 0)
        this.mark(
          'tags',
          'intentionally-omitted',
          'Only AWS-reserved (aws:*) tags were observed; they cannot be set.',
        );
    }
    return [...this.seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
