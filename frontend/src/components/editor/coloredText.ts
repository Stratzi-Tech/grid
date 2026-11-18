import { TextStyle } from '@tiptap/extension-text-style';

/**
 * Pages are stored as markdown, which has no way to say "this text is red". The colour
 * and highlight are saved as inline HTML, `<span style="color: …">`, which markdown
 * allows and which this editor reads back.
 *
 * Two details here are load-bearing:
 *
 * - `priority: 1` makes the colour the innermost mark, so bold-and-red is saved as
 *   `**<span …>text</span>**`. The other way round, `<span …>**text**</span>`, is not
 *   read back: markdown inside an HTML span is shown literally and then escaped further
 *   on every save, which would corrupt the text. Checked for bold, italic, strike, link
 *   and highlight, alone and stacked.
 * - Only plain colour values are written out. Anything else is dropped rather than put
 *   into a style attribute.
 */
const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))$/;

export const ColoredTextStyle = TextStyle.extend({
  priority: 1,
  renderMarkdown(node, helpers) {
    const inner = helpers.renderChildren(node);
    const attrs = (node.attrs ?? {}) as { color?: string | null; backgroundColor?: string | null };
    const style: string[] = [];
    if (attrs.color && SAFE_COLOR.test(attrs.color)) style.push(`color: ${attrs.color}`);
    if (attrs.backgroundColor && SAFE_COLOR.test(attrs.backgroundColor)) {
      style.push(`background-color: ${attrs.backgroundColor}`);
    }
    return style.length ? `<span style="${style.join('; ')}">${inner}</span>` : inner;
  },
});

/** Text colours. Dark enough to read on a white page; "default" removes the colour. */
export const TEXT_COLORS: { name: string; value: string }[] = [
  { name: 'Gray', value: '#6B778C' },
  { name: 'Red', value: '#DE350B' },
  { name: 'Orange', value: '#B65C02' },
  { name: 'Green', value: '#006644' },
  { name: 'Teal', value: '#008DA6' },
  { name: 'Blue', value: '#0052CC' },
  { name: 'Purple', value: '#5243AA' },
  { name: 'Pink', value: '#C9358A' },
];

/** Highlight (background) colours. Soft, so dark text stays readable on top. */
export const HIGHLIGHT_COLORS: { name: string; value: string }[] = [
  { name: 'Gray', value: '#EBECF0' },
  { name: 'Red', value: '#FFEBE6' },
  { name: 'Yellow', value: '#FFF0B3' },
  { name: 'Green', value: '#E3FCEF' },
  { name: 'Teal', value: '#E6FCFF' },
  { name: 'Blue', value: '#DEEBFF' },
  { name: 'Purple', value: '#EAE6FF' },
  { name: 'Pink', value: '#FFE0F0' },
];
