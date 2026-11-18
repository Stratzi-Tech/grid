/**
 * Helpers for text that is stored as HTML: ticket descriptions and comments.
 *
 * Older descriptions and comments were saved as plain text, with newlines as line breaks,
 * and some as HTML from the previous editor. Everything here has to cope with all of them.
 */

/** True if the string already contains HTML markup. */
export function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * What to load into the editor: HTML as it is, plain text as one paragraph per line (so
 * line breaks and blank lines survive; HTML would otherwise collapse them to single spaces).
 */
export function toEditorHtml(value: string): string {
  if (!value) return '';
  if (looksLikeHtml(value)) return value;
  return value
    .split(/\r?\n/)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}

/** True when there is nothing a reader would see: no text, no image, no table, no rule. */
export function isRichEmpty(value: string | null | undefined): boolean {
  if (!value) return true;
  if (!looksLikeHtml(value)) return value.trim() === '';
  if (/<(img|hr|table|input)\b/i.test(value)) return false;
  const text = value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').trim();
  return text === '';
}

const MENTION = /(^|[\s(>])(@[\w.+-]+)/g;

/**
 * Wrap @mentions in the HTML in a styled span, for read-only display. Only text between
 * tags is touched, never inside a tag, a link, or code.
 */
export function highlightMentionsInHtml(html: string): string {
  if (typeof window === 'undefined' || !html.includes('@')) return html;
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root');
  if (!root) return html;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = (node as Text).parentElement;
    if (parent?.closest('a, code, pre')) continue;
    if ((node as Text).data.includes('@')) targets.push(node as Text);
  }

  for (const textNode of targets) {
    const text = textNode.data;
    MENTION.lastIndex = 0;
    if (!MENTION.test(text)) continue;
    MENTION.lastIndex = 0;
    const fragment = doc.createDocumentFragment();
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = MENTION.exec(text)) !== null) {
      const start = match.index + match[1].length;
      fragment.append(text.slice(last, start));
      const span = doc.createElement('span');
      span.className = 'rich-mention';
      span.textContent = match[2];
      fragment.append(span);
      last = start + match[2].length;
    }
    fragment.append(text.slice(last));
    textNode.replaceWith(fragment);
  }
  return root.innerHTML;
}
