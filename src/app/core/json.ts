/**
 * Blanks out // and /* *\/ comments outside of strings (sing-box accepts commented JSON).
 * Comment characters are replaced with spaces and newlines are kept, so character
 * positions in the result match the original text — error offsets stay accurate.
 */
export function stripJsonComments(text: string): string {
  const out: string[] = text.split('');
  let inString: boolean = false;
  for (let i: number = 0; i < text.length; i++) {
    const c: string = text[i];
    const next: string = text[i + 1];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && next === '*') {
      const end: number = text.indexOf('*/', i + 2);
      const stop: number = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== '\n') out[i] = ' ';
      i--;
    }
  }
  return out.join('');
}

/**
 * Blanks out trailing commas before `}` / `]` outside of strings; sing-box accepts them.
 * Like stripJsonComments, positions are preserved. Expects comments to be stripped already.
 */
export function stripTrailingCommas(text: string): string {
  const out: string[] = text.split('');
  let inString: boolean = false;
  for (let i: number = 0; i < text.length; i++) {
    const c: string = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === ',') {
      let j: number = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') out[i] = ' ';
    }
  }
  return out.join('');
}

/** Converts sing-box's relaxed JSON (comments, trailing commas) to strict JSON, keeping positions. */
export function toStrictJson(text: string): string {
  return stripTrailingCommas(stripJsonComments(text));
}

export function parseConfig<T = Record<string, any>>(text: string): T {
  return JSON.parse(toStrictJson(text)) as T;
}

/** Character offset of a JSON.parse error, when the engine reports one. */
export function jsonErrorOffset(error: unknown, text: string): number | null {
  const message: string = error instanceof Error ? error.message : '';
  const position: RegExpExecArray | null = /at position (\d+)/.exec(message);
  if (position) return Number(position[1]);
  const lineColumn: RegExpExecArray | null = /line (\d+) column (\d+)/.exec(message);
  if (lineColumn) {
    const lines: string[] = text.split('\n');
    const line: number = Number(lineColumn[1]) - 1;
    let offset: number = 0;
    for (let i: number = 0; i < line && i < lines.length; i++) offset += lines[i].length + 1;
    return offset + Number(lineColumn[2]) - 1;
  }
  return /end of JSON input/i.test(message) ? text.length : null;
}
