/**
 * Redaction hook layer. Applied to content before it reaches the CAS store;
 * defaults to identity so nothing is transformed unless a policy is wired in.
 */

export type Redactor = (text: string) => string;

/** Identity redactor: the default pre-persistence hook. */
export const noopRedactor: Redactor = (text) => text;

/** Compose redactors left-to-right: composeRedactors(f, g)(t) === g(f(t)). */
export function composeRedactors(...fns: Redactor[]): Redactor {
  return (text) => {
    let current = text;
    for (const fn of fns) {
      current = fn(current);
    }
    return current;
  };
}
