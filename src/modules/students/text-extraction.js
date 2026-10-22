// Pure helpers shared by the document worker and its callers.
export const STORED_TEXT_LIMIT = 80000;
// A page of real text has hundreds of letters; a scanned page usually has
// none, or only a scanner app's watermark ("Scanned with CamScanner" is 21).
export const LOW_TEXT_PER_PAGE = 50;

/**
 * Normalises extracted text: Unicode compatibility forms (PDF ligatures),
 * line endings, control and zero-width characters, runs of spaces and blank
 * lines. Line breaks are kept because headings and lists depend on them:
 * vertical tabs, form feeds (page breaks), NEL and the Unicode line and
 * paragraph separators become newlines rather than spaces.
 */
export function normalizeExtractedText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?|[\u000b\u000c\u0085\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u00ad\u200b\u2060\ufeff]/g, "")
    .replace(/[\t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Letters and digits: whitespace and punctuation are not evidence of text. */
export const realCharacters = (text) =>
  (String(text).match(/[\p{L}\p{N}]/gu) || []).length;

/**
 * Stored content plus extraction metadata. `lowText` flags a PDF that is
 * probably scanned: fewer than LOW_TEXT_PER_PAGE real characters per page.
 */
export function extractionResult(text, pageCount = null) {
  const normalized = normalizeExtractedText(text);
  const pages = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : null;
  return {
    content: normalized.slice(0, STORED_TEXT_LIMIT),
    pageCount: pages,
    chars: normalized.length,
    truncated: normalized.length > STORED_TEXT_LIMIT,
    lowText:
      pages !== null && realCharacters(normalized) < pages * LOW_TEXT_PER_PAGE,
  };
}
