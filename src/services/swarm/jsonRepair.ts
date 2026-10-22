/**
 * Best-effort repair of JSON that was cut off mid-stream (model hit its token limit).
 *
 * Strategy: scan the text tracking string/escape state and the stack of open
 * `{`/`[`. If the text ends inside a value we drop the dangling fragment back to the
 * last point where the document was syntactically complete, then close every open
 * container. Returns null when nothing salvageable remains.
 */
export function repairTruncatedJson(input: string): string | null {
  const text = input.trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  /** Index after the last position where closing the stack yields valid JSON. */
  let safeEnd = -1;
  let safeStack: string[] = [];

  const markSafe = (end: number) => {
    safeEnd = end;
    safeStack = [...stack];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        // A finished string is a complete value unless it is an object key (followed by ':').
        const rest = text.slice(i + 1).trimStart();
        if (stack[stack.length - 1] === '[' || rest[0] === ',' || rest[0] === '}' || rest[0] === ']') {
          markSafe(i + 1);
        }
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      stack.push(ch);
      markSafe(i + 1);
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      markSafe(i + 1);
    } else if (/[0-9eE.+\-]|t|r|u|f|a|l|s|n/.test(ch)) {
      // Possible number/literal; only safe once followed by a delimiter (handled when we see it).
    } else if (ch === ',') {
      // Everything before the comma was a complete value.
      markSafe(i);
    }
  }

  if (stack.length === 0 && !inString) return text; // already balanced

  if (safeEnd < 0) return null;
  let body = text.slice(0, safeEnd).replace(/[,\s]+$/, '');
  // `{"a":` style dangling key is excluded by construction (keys are never marked safe).
  const closers = safeStack
    .reverse()
    .map((open) => (open === '{' ? '}' : ']'))
    .join('');
  body += closers;
  return body;
}
