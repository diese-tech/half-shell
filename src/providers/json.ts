/**
 * Model output is untrusted text. These helpers recover the first well-formed
 * JSON value from a completion instead of trusting the model to emit clean
 * JSON, and never throw on garbage.
 */

function stripFences(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? raw).trim();
}

/** Scan for the first balanced `{...}` or `[...]`, respecting string literals. */
function firstBalanced(text: string, open: '{' | '['): string | undefined {
  const close = open === '{' ? '}' : ']';
  const start = text.indexOf(open);
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export function parseJsonObject<T = Record<string, unknown>>(raw: string): T | undefined {
  const text = stripFences(raw);
  for (const candidate of [text, firstBalanced(text, '{')]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as T;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/**
 * Recover an array of objects. Accepts a bare array, or an object wrapping the
 * array under a common key such as `findings` or `critiques`.
 */
export function parseJsonArray<T = Record<string, unknown>>(raw: string, keys: string[] = []): T[] {
  const text = stripFences(raw);
  // When a key is expected, try the wrapping object before any bare array:
  // a response holding several arrays must be read by key, not by position.
  const candidates =
    keys.length > 0
      ? [text, firstBalanced(text, '{'), firstBalanced(text, '[')]
      : [text, firstBalanced(text, '['), firstBalanced(text, '{')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (Array.isArray(value)) return value as T[];
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of [...keys, 'items', 'results', 'data']) {
        if (Array.isArray(record[key])) return record[key] as T[];
      }
    }
  }
  return [];
}
