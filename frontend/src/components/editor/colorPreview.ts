import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface ColorPreviewState {
  kind: 'text' | 'highlight';
  color: string;
}

export const colorPreviewKey = new PluginKey<ColorPreviewState | null>('wikiColorPreview');

/**
 * Shows what a colour would look like on the selected text while the pointer is over a
 * swatch, without touching the document.
 *
 * It is a decoration, not an edit: nothing is saved, nothing goes into undo history, and
 * the editor's change events do not fire, so hovering around the palette cannot trigger an
 * autosave or leave stray formatting behind. The preview ends when the pointer leaves, when
 * a colour is actually applied, or as soon as the document or selection changes.
 * The colour itself is applied by CSS (see rich-editor.css) so that it also wins over text
 * that already has a colour of its own.
 */
export const ColorPreview = Extension.create({
  name: 'colorPreview',

  addProseMirrorPlugins() {
    return [
      new Plugin<ColorPreviewState | null>({
        key: colorPreviewKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(colorPreviewKey) as ColorPreviewState | null | undefined;
            if (meta !== undefined) return meta;
            return tr.docChanged || tr.selectionSet ? null : value;
          },
        },
        props: {
          decorations(state) {
            const preview = colorPreviewKey.getState(state);
            const { from, to, empty } = state.selection;
            if (!preview || empty) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.inline(from, to, {
                class: preview.kind === 'text' ? 'wiki-preview-text' : 'wiki-preview-bg',
                style: `--wiki-preview: ${preview.color}`,
              }),
            ]);
          },
        },
      }),
    ];
  },
});
