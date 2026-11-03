import type { ZodType } from 'zod';
import { addUsage, AiOutputError, type AiProvider, type Usage } from './types.js';

/** Pull a JSON object out of a model reply (plain, fenced, or surrounded by prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(c.slice(start, end + 1));
      } catch {
        /* try the next candidate */
      }
    }
  }
  throw new SyntaxError('no JSON object found in the reply');
}

export interface StructuredOptions<T> {
  system: string;
  user: string;
  schema: ZodType<T>;
  /** Total attempts including the first (bounded retries). */
  maxAttempts?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Stop spending when input+output tokens exceed this budget. */
  tokenBudget?: number;
  /** Extra semantic validation; return issues to trigger a repair attempt. */
  validate?: (value: T) => string[];
}

export interface StructuredResult<T> {
  value: T;
  usage: Usage;
  attempts: number;
}

/**
 * Ask for JSON, validate it against a strict schema, and retry a bounded number of times by telling the model
 * exactly what was wrong. Output that never validates is an error; it is never repaired silently or trusted.
 */
export async function completeStructured<T>(
  provider: AiProvider,
  options: StructuredOptions<T>,
): Promise<StructuredResult<T>> {
  const max = options.maxAttempts ?? 3;
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let user = options.user;
  let lastProblem = 'no attempt made';
  for (let attempt = 1; attempt <= max; attempt++) {
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (
      options.tokenBudget !== undefined &&
      usage.inputTokens + usage.outputTokens > options.tokenBudget
    ) {
      throw new AiOutputError(
        `Token budget of ${options.tokenBudget} exceeded after ${attempt - 1} attempt(s).`,
        attempt - 1,
        usage,
      );
    }
    const response = await provider.complete({
      system: options.system,
      user,
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      signal: options.signal,
    });
    usage = addUsage(usage, response.usage);
    let problem: string | undefined;
    try {
      const parsed = options.schema.safeParse(extractJson(response.text));
      if (parsed.success) {
        const issues = options.validate?.(parsed.data) ?? [];
        if (issues.length === 0) return { value: parsed.data, usage, attempts: attempt };
        problem = issues.join('; ');
      } else {
        problem = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
      }
    } catch (error) {
      problem = (error as Error).message;
    }
    lastProblem = problem;
    user = `${options.user}\n\nYour previous reply was rejected: ${problem.slice(0, 1500)}\nReturn ONLY the corrected JSON object.`;
  }
  throw new AiOutputError(
    `The model did not produce valid output after ${max} attempt(s): ${lastProblem.slice(0, 500)}`,
    max,
    usage,
  );
}
