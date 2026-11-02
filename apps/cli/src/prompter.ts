import * as p from '@clack/prompts';
import type { Answer, ReconstructionQuestion } from '@cloud-to-code/core';
import type { Prompter } from './io.js';
import { renderQuestion } from './render.js';

const NOTE_OPTIONS = new Set(['local-dir', 'git-repo']);
const SKIP = '__skip__';
const UNKNOWN = 'unknown';

/** Interactive terminal prompter built on @clack/prompts. Skipping is always possible; nothing defaults to yes. */
export class ClackPrompter implements Prompter {
  async ask(
    q: ReconstructionQuestion,
    position: { index: number; total: number },
  ): Promise<Answer | undefined> {
    p.log.message(renderQuestion(q, position));
    if (q.type === 'text') {
      const text = await p.text({ message: q.title });
      return p.isCancel(text) || !String(text).trim()
        ? undefined
        : { kind: 'text', text: String(text) };
    }
    if (q.type === 'confirmation') {
      const yes = await p.confirm({ message: q.title, initialValue: false });
      return p.isCancel(yes) ? undefined : { kind: 'confirmation', confirmed: yes };
    }
    const options = [
      ...(q.options ?? []).map((o) => ({
        value: o.id,
        label: o.label,
        hint: o.id === q.suggestedOptionId ? 'recommended' : undefined,
      })),
      ...(q.allowUnknown
        ? [
            {
              value: UNKNOWN,
              label: "I don't know",
              hint: 'blocking questions then stop the session',
            },
          ]
        : []),
      { value: SKIP, label: 'Skip for now', hint: 'no answer is recorded' },
    ];
    if (q.type === 'multi-choice') {
      const picked = await p.multiselect({
        message: q.title,
        options: options.filter((o) => o.value !== SKIP && o.value !== UNKNOWN),
        required: true,
      });
      return p.isCancel(picked) ? undefined : { kind: 'choices', optionIds: picked as string[] };
    }
    const choice = await p.select({ message: q.title, options });
    if (p.isCancel(choice) || choice === SKIP) return undefined;
    if (choice === UNKNOWN) return { kind: 'unknown' };
    if (NOTE_OPTIONS.has(choice as string)) {
      const detail = await p.text({
        message:
          choice === 'git-repo'
            ? 'Repository URL (never include credentials)'
            : 'Local source directory',
      });
      return {
        kind: 'choice',
        optionId: choice as string,
        ...(p.isCancel(detail) || !String(detail).trim() ? {} : { note: String(detail) }),
      };
    }
    return { kind: 'choice', optionId: choice as string };
  }

  async chooseApplication(names: readonly string[]): Promise<string | undefined> {
    const choice = await p.select({
      message: 'Which application do you want to reconstruct?',
      options: names.map((n) => ({ value: n, label: n })),
    });
    return p.isCancel(choice) ? undefined : (choice as string);
  }
}
