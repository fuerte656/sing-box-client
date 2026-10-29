const CYRILLIC_PAIRS: [string, string][] = [
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['д', 'd'], ['е', 'e'], ['ё', 'e'], ['ж', 'zh'],
  ['з', 'z'], ['и', 'i'], ['й', 'y'], ['к', 'k'], ['л', 'l'], ['м', 'm'], ['н', 'n'], ['о', 'o'],
  ['п', 'p'], ['р', 'r'], ['с', 's'], ['т', 't'], ['у', 'u'], ['ф', 'f'], ['х', 'kh'], ['ц', 'ts'],
  ['ч', 'ch'], ['ш', 'sh'], ['щ', 'shch'], ['ъ', ''], ['ы', 'y'], ['ь', ''], ['э', 'e'], ['ю', 'yu'],
  ['я', 'ya'], ['є', 'ye'], ['і', 'i'], ['ї', 'yi'], ['ґ', 'g'], ['ў', 'u'],
];

/** Lower- and upper-case Cyrillic → Latin (BGN/PCGN-style, simplified). */
const CYRILLIC: Map<string, string> = new Map<string, string>(
  CYRILLIC_PAIRS.flatMap(([cyr, lat]) => [
    [cyr, lat],
    [cyr.toUpperCase(), lat.charAt(0).toUpperCase() + lat.slice(1)],
  ]),
);

/** Transliterates Cyrillic letters to Latin; Cyrillic letters without a mapping become `unknown`. */
export function cyrillicToLatin(text: string, unknown = '?'): string {
  return text.replace(/[Ѐ-ӿ]/g, (c) => CYRILLIC.get(c) ?? unknown);
}

/** Reduces text to printable ASCII: accents dropped (é → e), common punctuation mapped, the rest to "?". */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[·•–—]/g, '-')
    .replace(/[«»“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e]/g, '?');
}
