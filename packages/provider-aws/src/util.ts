import { shortHash } from '@cloud-to-code/core';

export async function paginate<T>(
  fetchPage: (
    token: string | undefined,
  ) => Promise<{ items: readonly T[]; next?: string | undefined }>,
  maxPages = 200,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(token);
    out.push(...result.items);
    if (!result.next) return out;
    token = result.next;
  }
  return out;
}

/** Bounded-concurrency map preserving input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export type ErrorKind = 'access-denied' | 'throttled' | 'not-found' | 'aborted' | 'other';

export function classifyError(error: unknown): ErrorKind {
  const e = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const name = `${e?.name ?? ''} ${e?.Code ?? ''} ${e?.code ?? ''}`;
  if (/AbortError|TimeoutError/.test(name)) return 'aborted';
  if (/AccessDenied|UnauthorizedOperation|Unauthorized|AuthorizationError|NotAuthorized/.test(name))
    return 'access-denied';
  if (
    /Throttl|TooManyRequests|RequestLimitExceeded|SlowDown/.test(name) ||
    e?.$metadata?.httpStatusCode === 429
  )
    return 'throttled';
  if (/NotFound|NoSuch|ResourceNotFound/.test(name) || e?.$metadata?.httpStatusCode === 404)
    return 'not-found';
  return 'other';
}

export function errorMessage(error: unknown): string {
  return (error as Error)?.message?.slice(0, 300) ?? String(error);
}

export const evidenceId = (source: string, detail: string): string =>
  `ev-${shortHash({ source, detail }, 10)}`;
