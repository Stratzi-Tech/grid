'use client';

import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, EditorContent, useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { wrappingInputRule } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { OrderedList, TaskList, TaskItem } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Color, BackgroundColor } from '@tiptap/extension-text-style';
import {
  Bold, Italic, Strikethrough, Code, Heading1, Heading2, Heading3, List, ListOrdered,
  ListChecks, Quote, Link2, Table as TableIcon, Minus, Undo2, Redo2, SquareCode,
  ExternalLink, Pencil, Unlink,
} from 'lucide-react';
import { ButtonCore, Input } from '../ui';
import { tokens } from '../../design-system/tokens';
import { createSlashCommand, SuggestionPopup, useSuggestionMenu } from './suggestionCommand';
import { createMentionCommand, MentionHighlight, useMentionUsers } from './mentions';
import { toEditorHtml } from './richText';
import { ColoredTextStyle } from './coloredText';
import { ColorPreview, colorPreviewKey, ColorPreviewState } from './colorPreview';
import { ColorPicker } from './ColorPicker';
import './rich-editor.css';

export interface OutlineItem {
  level: number;
  text: string;
}

export interface RichEditorHandle {
  /** Scroll to the nth heading of the document (matches the order of `onOutline`). */
  scrollToHeading: (index: number) => void;
  /** Put the cursor at the start of the document. */
  focus: () => void;
}

/**
 * Numbered lists start from typing "1. ", as in TipTap's default. This adds the lettered
 * and roman styles people expect from Word and Google Docs: "a. ", "A. ", "i. " and "I. "
 * at the start of a line.
 */
const OrderedListWithLetters = OrderedList.extend({
  addInputRules() {
    return [
      ...(this.parent?.() ?? []),
      wrappingInputRule({
        find: /^([aAiI])\.\s$/,
        type: this.type,
        getAttributes: (match) => ({ type: match[1], start: 1 }),
      }),
    ];
  },
});

interface RichEditorProps {
  /**
   * The content, in `format`. It is read when the editor mounts, and again whenever it changes
   * to something other than what the editor last reported through `onChange` - so a parent can
   * clear or replace it (after submitting a form, say) without remounting.
   */
  value: string;
  editable: boolean;
  /** How the content is stored: markdown for wiki pages, HTML for tickets and comments. */
  format?: 'markdown' | 'html';
  onChange?: (content: string) => void;
  /**
   * 'full' is the wiki layout: every tool, docked or sticky toolbar. 'compact' is a framed box
   * with a small toolbar for modals and comments; headings, tables and the rest stay one
   * "/" away.
   */
  variant?: 'full' | 'compact';
  /** Turns on @mentions of the people on this project. */
  mentionProjectId?: number;
  /** Height of the writing area before it grows with the content. */
  minHeight?: number;
  /**
   * Show the small formatting popup over selected text. On for the wiki; off for the compact
   * editors (descriptions, comments, modals), which have a toolbar and would only be crowded by
   * a second set of buttons. Links keep their own small popup either way.
   */
  selectionMenu?: boolean;
  frameStyle?: React.CSSProperties;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Ctrl/Cmd+Enter: submit, for editors that live in a form or a comment box. */
  onSubmit?: () => void;
  onOutline?: (items: OutlineItem[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * Where to put the formatting toolbar. The page passes a bar that sits above its scrolling
   * area, so the toolbar is never on top of the text. Without it the toolbar sticks to the top
   * of whatever scrolls, which is fine on its own but is what the selection bubble used to
   * collide with.
   */
  toolbarContainer?: HTMLElement | null;
}

function collectOutline(editor: Editor): OutlineItem[] {
  const items: OutlineItem[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'heading') {
      items.push({ level: node.attrs.level as number, text: node.textContent });
    }
  });
  return items;
}

/** Open a link in a new tab. Only web, mail and phone links: never javascript: or data:. */
function openHref(href: string) {
  let url: URL;
  try {
    url = new URL(href, window.location.href); // "/page" and "#part" links resolve against this page
  } catch {
    return;
  }
  if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) window.open(url.href, '_blank', 'noopener,noreferrer');
}

function normalizeUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  if (/^(https?:|mailto:|tel:|\/|#)/i.test(url)) return url;
  return `https://${url}`;
}

/** Why a typed address cannot be used, as a fix-it hint; null when it is fine (or empty). */
function linkUrlError(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/\s/.test(value)) return 'Remove the spaces from the link';
  let url: URL;
  try {
    url = new URL(normalizeUrl(value), 'https://page.invalid'); // base lets "/page" and "#part" through
  } catch {
    return 'Enter a web address, like example.com';
  }
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return 'Use a web, email or phone link';
  const isWeb = url.protocol === 'http:' || url.protocol === 'https:';
  if (isWeb && !/^[/#]/.test(value) && !url.hostname.includes('.') && url.hostname !== 'localhost') {
    return 'Enter a full web address, like example.com';
  }
  return null;
}

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(
  {
    value,
    editable,
    format = 'markdown',
    onChange,
    onOutline,
    placeholder = "Type '/' for commands…",
    autoFocus,
    toolbarContainer,
    variant = 'full',
    mentionProjectId,
    minHeight,
    selectionMenu,
    frameStyle,
    onFocus,
    onBlur,
    onSubmit,
  },
  ref,
) {
  const compact = variant === 'compact';
  const showSelectionMenu = selectionMenu ?? !compact;
  const isHtml = format === 'html';
  // The "/" and "@" menus live in React state, fed by their suggestion plugins through a bridge.
  const slashMenu = useSuggestionMenu();
  const mentionMenu = useSuggestionMenu();
  const mentionUsers = useMentionUsers(mentionProjectId);

  const rootRef = useRef<HTMLDivElement>(null);
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);

  const [linkMode, setLinkMode] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  // The words shown for the link. null when the selection spans several blocks: replacing
  // that with one line of text would merge them, so only the address can be set then.
  const [linkText, setLinkText] = useState<string | null>('');
  // The shared Input does not forward refs, so each field sits in a wrapper we can reach into.
  const linkTextFieldRef = useRef<HTMLDivElement>(null);
  const linkUrlFieldRef = useRef<HTMLDivElement>(null);
  const linkTextInput = () => linkTextFieldRef.current?.querySelector('input') ?? null;
  const linkUrlInput = () => linkUrlFieldRef.current?.querySelector('input') ?? null;
  // Changing an existing link (offers Remove Link) rather than adding one.
  const [linkEditing, setLinkEditing] = useState(false);
  // Shown under the Link field. Checked ~300ms after typing stops; once shown, on every key.
  const [linkError, setLinkError] = useState<string | null>(null);
  const linkErrorTimer = useRef<number | undefined>(undefined);
  // The text the open link box applies to; selection moving outside it closes the box.
  const linkRangeRef = useRef<{ from: number; to: number } | null>(null);
  // Read by the bubble's "should it show" check and by the Ctrl+K handler, both of which
  // are created once and must see the current value, not the one from their first render.
  const linkModeRef = useRef(false);
  linkModeRef.current = linkMode;
  const openLinkRef = useRef<() => void>(() => {});
  // Own key for the selection bubble, so openLink can tell it to show (see openLink).
  const [bubbleKey] = useState(() => new PluginKey('richEditorBubble'));
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const slashExtension = useMemo(() => createSlashCommand(slashMenu.bridge), [slashMenu.bridge]);
  const mentionExtension = useMemo(
    () => (mentionProjectId ? createMentionCommand(mentionMenu.bridge, mentionUsers) : null),
    [mentionProjectId, mentionMenu.bridge, mentionUsers],
  );

  // What the editor last told its parent. A different `value` from the parent means the
  // content was replaced from outside (see the sync effect below).
  const lastEmittedRef = useRef(value);

  const editor = useEditor({
    immediatelyRender: false, // Next renders on the server first; the editor needs the DOM
    editable,
    autofocus: autoFocus ? 'end' : false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        orderedList: false, // replaced by OrderedListWithLetters below
        link: {
          openOnClick: false, // handleClick below opens links, editable or not
          autolink: true,
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        },
      }),
      OrderedListWithLetters,
      ...(isHtml ? [] : [Markdown]),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      ColoredTextStyle,
      Color,
      BackgroundColor,
      ColorPreview,
      Placeholder.configure({ placeholder }),
      slashExtension,
      ...(mentionExtension ? [mentionExtension, MentionHighlight] : []),
    ],
    content: isHtml ? toEditorHtml(value) : value,
    ...(isHtml ? {} : { contentType: 'markdown' as const }),
    editorProps: {
      // A click on a link opens it in a new tab. To change it, hover it and pick Edit, or move
      // the cursor into it with the arrow keys. Shift+click still extends the selection.
      handleClick: (_view, _pos, event) => {
        if (event.shiftKey) return false;
        const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!anchor) return false;
        event.preventDefault();
        openHref(anchor.href);
        return true;
      },
      // Ctrl/Cmd+K: add or edit a link. Ctrl/Cmd+Enter: submit, when the editor has somewhere to submit to.
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && onSubmitRef.current) {
          event.preventDefault();
          // Only this editor's submit: the ticket window also treats Ctrl+Enter as "save and close".
          event.stopPropagation();
          onSubmitRef.current();
          return true;
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          openLinkRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const out = isHtml ? (ed.isEmpty ? '' : ed.getHTML()) : ed.getMarkdown();
      lastEmittedRef.current = out;
      onChange?.(out);
      onOutline?.(collectOutline(ed));
    },
    onCreate: ({ editor: ed }) => onOutline?.(collectOutline(ed)),
    onFocus: () => onFocus?.(),
    onBlur: () => onBlur?.(),
  });

  // The parent replaced the content (cleared a form after submitting, restored a version,
  // loaded the server's copy): show it. Anything the editor itself just reported is ignored,
  // so typing never fights this.
  useEffect(() => {
    if (!editor || value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    editor.commands.setContent(isHtml ? toEditorHtml(value) : value, {
      emitUpdate: false,
      ...(isHtml ? {} : { contentType: 'markdown' as const }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToHeading: (index: number) => {
        const headings = editor?.view.dom.querySelectorAll('h1, h2, h3, h4');
        headings?.[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
      focus: () => {
        editor?.commands.focus('start');
      },
    }),
    [editor],
  );

  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) =>
      ed
        ? {
            bold: ed.isActive('bold'),
            italic: ed.isActive('italic'),
            strike: ed.isActive('strike'),
            code: ed.isActive('code'),
            h1: ed.isActive('heading', { level: 1 }),
            h2: ed.isActive('heading', { level: 2 }),
            h3: ed.isActive('heading', { level: 3 }),
            bullet: ed.isActive('bulletList'),
            ordered: ed.isActive('orderedList'),
            task: ed.isActive('taskList'),
            quote: ed.isActive('blockquote'),
            codeBlock: ed.isActive('codeBlock'),
            link: ed.isActive('link'),
            table: ed.isActive('table'),
            // The attributes are "" when unset, so normalise to null for the picker.
            textColor: (ed.getAttributes('textStyle').color as string | undefined) || null,
            highlightColor: (ed.getAttributes('textStyle').backgroundColor as string | undefined) || null,
            canUndo: ed.can().undo(),
            canRedo: ed.can().redo(),
          }
        : null,
  });

  // Leave link-editing mode as soon as the selection moves outside the text being linked.
  // Moves inside it (opening the box selects the whole link) keep the box open.
  useEffect(() => {
    if (!editor) return;
    const reset = () => {
      const { from, to } = editor.state.selection;
      const range = linkRangeRef.current;
      if (range && from >= range.from && to <= range.to) return;
      window.clearTimeout(linkErrorTimer.current);
      setLinkMode(false);
    };
    editor.on('selectionUpdate', reset);
    return () => {
      editor.off('selectionUpdate', reset);
      window.clearTimeout(linkErrorTimer.current); // no late error check after unmount
    };
  }, [editor]);

  // Hovering a link shows a small card with its address (and Edit / Remove when editable).
  // It closes a moment after the pointer leaves, so the pointer can move onto the card.
  const [hoverLink, setHoverLink] = useState<HTMLAnchorElement | null>(null);
  const [hoverCardPos, setHoverCardPos] = useState<{ top: number; left: number } | null>(null);
  const hoverCardRef = useRef<HTMLDivElement>(null);
  const hoverHideTimer = useRef<number | undefined>(undefined);
  const keepHoverCard = () => window.clearTimeout(hoverHideTimer.current);
  const hideHoverCardSoon = () => {
    window.clearTimeout(hoverHideTimer.current);
    hoverHideTimer.current = window.setTimeout(() => setHoverLink(null), 200);
  };

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const anchorOf = (event: Event) =>
      ((event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null) ?? null;
    const onOver = (event: MouseEvent) => {
      const anchor = anchorOf(event);
      if (!anchor) return;
      window.clearTimeout(hoverHideTimer.current);
      setHoverLink(anchor);
    };
    const onOut = (event: MouseEvent) => {
      if (!anchorOf(event)) return;
      window.clearTimeout(hoverHideTimer.current);
      hoverHideTimer.current = window.setTimeout(() => setHoverLink(null), 200);
    };
    // The card is placed once, against where the link was: scrolling or typing closes it.
    const close = () => setHoverLink(null);
    dom.addEventListener('mouseover', onOver);
    dom.addEventListener('mouseout', onOut);
    dom.addEventListener('keydown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      dom.removeEventListener('mouseover', onOver);
      dom.removeEventListener('mouseout', onOut);
      dom.removeEventListener('keydown', close);
      window.removeEventListener('scroll', close, true);
      window.clearTimeout(hoverHideTimer.current);
    };
  }, [editor]);

  // Below the link when it fits, above it when not, and never past the window's edges.
  useLayoutEffect(() => {
    const card = hoverCardRef.current;
    if (!hoverLink || !card) {
      setHoverCardPos(null);
      return;
    }
    const link = hoverLink.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const below = link.bottom + gap;
    const top =
      below + card.offsetHeight > window.innerHeight - margin && link.top - gap - card.offsetHeight > margin
        ? link.top - gap - card.offsetHeight
        : below;
    const left = Math.max(margin, Math.min(link.left, window.innerWidth - card.offsetWidth - margin));
    setHoverCardPos({ top, left });
  }, [hoverLink]);

  // Focus the link box's first useful field: Text when it is empty, else the address.
  // preventScroll: the popup is not placed yet at this point (it still sits below the page
  // content), and a plain focus scrolled the editor down to it, out of sight of the text.
  useEffect(() => {
    if (!linkMode) return;
    const label = linkTextInput();
    (label && !label.value ? label : linkUrlInput())?.focus({ preventScroll: true });
  }, [linkMode]);

  // Place the bubble again whenever its size changes (it wraps to fit, or swaps formatting
  // buttons for the link fields): it is placed with the size it had before.
  const bubbleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bubbleRef.current;
    if (!editor || !el) return;
    const observer = new ResizeObserver(() => {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, 'updatePosition'));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [editor, editable, bubbleKey]);

  const editorReady = !!editor;

  // Find the box the page scrolls in. The selection bubble flips against it, so it needs to
  // be a positioned box: the positioning library only treats a scroll container as the
  // bubble's boundary when it is the bubble's containing block, which an unpositioned
  // container is not. That is what let the bubble open outside the visible area before.
  useEffect(() => {
    let node: HTMLElement | null = rootRef.current?.parentElement ?? null;
    while (node) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') break;
      node = node.parentElement;
    }
    if (node && window.getComputedStyle(node).position === 'static') node.style.position = 'relative';
    setScrollParent(node);
  }, [editorReady]);

  // Above the text when there is room, below it when there is not. With the toolbar docked
  // above the scrolling area, "no room" is simply the top edge of that area.
  const bubbleOptions = useMemo(
    () => ({
      placement: 'top' as const,
      offset: 8,
      flip: { padding: 8 },
      // Slide sideways instead of running past the left or right edge of the visible area.
      shift: { padding: 8 },
      // Never wider than the visible area: in a narrow editor column the fields shrink and
      // the buttons wrap, instead of the popup spilling over the panels next to it.
      size: {
        padding: 8,
        apply: ({ availableWidth, elements }: { availableWidth: number; elements: { floating: HTMLElement } }) => {
          elements.floating.style.maxWidth = `${Math.max(160, availableWidth)}px`;
        },
      },
      // Hidden while its text is scrolled out of view, instead of floating over other UI.
      // Not while a link is being typed: the field has focus, and hiding it would send the
      // typing into an invisible box.
      hide: !linkMode,
      // The page scrolls inside that box, not the window: follow that scrolling.
      scrollTarget: scrollParent ?? window,
    }),
    [scrollParent, linkMode],
  );

  if (!editor) {
    return <div className="rich-prose" style={{ minHeight: minHeight ?? (compact ? 120 : 320) }} />;
  }

  const chain = () => editor.chain().focus();

  const tool = (
    label: string,
    icon: React.ReactNode,
    active: boolean,
    run: () => void,
    disabled = false,
  ) => (
    <ButtonCore
      key={label}
      size="sm"
      variant={active ? 'secondary' : 'ghost'}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()} // keep the selection
      onClick={run}
      style={active ? { background: tokens.colors.primary[50], borderColor: tokens.colors.primary[200], color: tokens.colors.primary[700] } : { padding: '0 8px' }}
    >
      {icon}
    </ButtonCore>
  );

  const divider = (key: string) => (
    <span key={key} style={{ width: 1, alignSelf: 'stretch', background: tokens.colors.neutral[200], margin: '2px 4px' }} />
  );

  const closeLink = () => {
    window.clearTimeout(linkErrorTimer.current);
    setLinkMode(false);
    editor.commands.focus();
  };

  const onLinkUrlChange = (value: string) => {
    setLinkUrl(value);
    window.clearTimeout(linkErrorTimer.current);
    if (linkError) setLinkError(linkUrlError(value)); // already wrong: say when it is fixed
    else linkErrorTimer.current = window.setTimeout(() => setLinkError(linkUrlError(value)), 300);
  };

  const removeLink = () => {
    window.clearTimeout(linkErrorTimer.current);
    chain().extendMarkRange('link').unsetLink().run();
    setLinkMode(false);
  };

  const applyLink = () => {
    window.clearTimeout(linkErrorTimer.current);
    const error = linkUrl.trim() ? linkUrlError(linkUrl) : 'Paste or type a link to add';
    if (error) {
      setLinkError(error);
      linkUrlInput()?.focus({ preventScroll: true });
      return;
    }
    const href = normalizeUrl(linkUrl);
    const text = linkText?.trim() ?? '';
    const nothingSelected = editor.state.selection.empty && !editor.isActive('link');
    if (nothingSelected) {
      // No text was selected: insert the display text (or the address itself) as a link.
      // The plain space after it matters: without it the cursor stays inside the link and
      // whatever is typed next becomes part of it.
      chain()
        .insertContent([
          { type: 'text', text: text || href.replace(/^https?:\/\//i, ''), marks: [{ type: 'link', attrs: { href } }] },
          { type: 'text', text: ' ' },
        ])
        .run();
    } else {
      chain().extendMarkRange('link').run();
      const { from, to } = editor.state.selection;
      // Raw compare: a double-clicked word often carries its trailing space, and an untouched
      // field must not replace the words (that would drop their bold, italic and so on).
      if (text && linkText !== editor.state.doc.textBetween(from, to)) {
        // New words: replace the range, then select them so the cursor does not sit at the
        // end of the link (typing there would extend it). Other marks on the old words go.
        chain()
          .insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })
          .setTextSelection({ from, to: from + text.length })
          .run();
      } else {
        chain().setLink({ href }).run();
      }
    }
    setLinkMode(false);
  };

  const openLink = () => {
    // Inside a link: take in the whole link, so its full text shows and edits replace all of it.
    const editing = editor.isActive('link');
    if (editing) editor.commands.extendMarkRange('link');
    setLinkEditing(editing);
    window.clearTimeout(linkErrorTimer.current);
    setLinkError(null);
    const { $from, $to, from, to } = editor.state.selection;
    linkRangeRef.current = { from, to };
    // Line breaks or other inline nodes in the range would be lost if the text were replaced,
    // so only the address can be set then (the placeholder char marks them).
    const leaf = String.fromCharCode(0xfffc);
    const selected = editor.state.doc.textBetween(from, to, undefined, leaf);
    setLinkText($from.sameParent($to) && !selected.includes(leaf) ? selected : null);
    setLinkUrl((editor.getAttributes('link').href as string) || '');
    // Ref first, then tell the bubble to show now. A plain empty transaction is not enough:
    // the bubble ignores one that changes neither selection nor content, so with nothing
    // selected it stayed hidden and the Label field could not take focus.
    linkModeRef.current = true;
    setLinkMode(true);
    // Bring the text into view first, so the popup opens next to it, not over other UI.
    editor.commands.scrollIntoView();
    editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, 'show'));
    // "show" places the bubble before it is visible, which is skipped; place it again now.
    editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, 'updatePosition'));
  };
  openLinkRef.current = openLink;

  const onLinkInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyLink();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation(); // close the link box, not the window around the editor
      closeLink();
    }
  };

  const openLinkInNewTab = () => {
    const href = editor.getAttributes('link').href as string | undefined;
    if (href) openHref(href);
  };

  // Hover card actions. The cursor goes inside the link first (one in from its start, where
  // the link mark is active), so Edit and Remove act on that whole link.
  const placeCursorInLink = (anchor: HTMLAnchorElement) => {
    setHoverLink(null);
    editor.commands.setTextSelection(editor.view.posAtDOM(anchor, 0) + 1);
  };
  const editHoveredLink = (anchor: HTMLAnchorElement) => {
    placeCursorInLink(anchor);
    openLink();
  };
  const removeHoveredLink = (anchor: HTMLAnchorElement) => {
    placeCursorInLink(anchor);
    chain().extendMarkRange('link').unsetLink().run();
  };

  const previewColor = (preview: ColorPreviewState | null) => {
    editor.view.dispatch(editor.state.tr.setMeta(colorPreviewKey, preview));
  };

  const setTextColor = (color: string | null) => {
    if (color) chain().setColor(color).run();
    else chain().unsetColor().run();
  };
  const setHighlightColor = (color: string | null) => {
    if (color) chain().setBackgroundColor(color).run();
    else chain().unsetBackgroundColor().run();
  };

  const s = state;
  // The cursor is inside a link with nothing selected: offer Open / Edit / Remove.
  const linkPreview = !!s?.link && editor.state.selection.empty;

  const dockedToolbarStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 2,
    padding: '6px 24px',
    background: '#FFFFFF',
    borderBottom: `1px solid ${tokens.colors.neutral[200]}`,
  };
  const inlineToolbarStyle: React.CSSProperties = {
    position: 'sticky',
    top: 0,
    zIndex: 20,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 2,
    padding: '6px 8px',
    marginBottom: 16,
    background: '#FFFFFF',
    border: `1px solid ${tokens.colors.neutral[200]}`,
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(9,30,66,0.08)',
  };
  const wrapToolbar = (node: React.ReactElement) => (toolbarContainer ? createPortal(node, toolbarContainer) : node);

  const compactToolbar =
    editable && s && compact ? (
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 2,
          padding: '4px 6px',
          borderBottom: `1px solid ${tokens.colors.neutral[200]}`,
          background: tokens.colors.neutral[50],
          borderRadius: '8px 8px 0 0',
        }}
      >
        {tool('Bold (Ctrl+B)', <Bold size={15} />, s.bold, () => chain().toggleBold().run())}
        {tool('Italic (Ctrl+I)', <Italic size={15} />, s.italic, () => chain().toggleItalic().run())}
        {tool('Strikethrough', <Strikethrough size={15} />, s.strike, () => chain().toggleStrike().run())}
        <ColorPicker
          textColor={s.textColor}
          highlightColor={s.highlightColor}
          disabled={s.code}
          onTextColor={setTextColor}
          onHighlightColor={setHighlightColor}
          onPreview={previewColor}
        />
        {divider('c1')}
        {tool('Bulleted list', <List size={15} />, s.bullet, () => chain().toggleBulletList().run())}
        {tool('Numbered list', <ListOrdered size={15} />, s.ordered, () => chain().toggleOrderedList().run())}
        {tool('Task list', <ListChecks size={15} />, s.task, () => chain().toggleTaskList().run())}
        {divider('c2')}
        {tool('Link (Ctrl+K)', <Link2 size={15} />, s.link, openLink)}
        {tool('Code block', <SquareCode size={15} />, s.codeBlock, () => chain().toggleCodeBlock().run())}
        {tool('Insert table', <TableIcon size={15} />, s.table, () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), s.table)}
      </div>
    ) : null;

  return (
    <div
      ref={rootRef}
      className={`rich-prose${editable ? ' is-editing' : ''}${compact ? ' is-compact' : ''}`}
      style={minHeight ? ({ '--rich-min-height': `${minHeight}px` } as React.CSSProperties) : undefined}
    >
      {editable && s && !compact && wrapToolbar(
        <div style={toolbarContainer ? dockedToolbarStyle : inlineToolbarStyle}>
          {tool('Undo', <Undo2 size={15} />, false, () => chain().undo().run(), !s.canUndo)}
          {tool('Redo', <Redo2 size={15} />, false, () => chain().redo().run(), !s.canRedo)}
          {divider('d1')}
          {tool('Heading 1', <Heading1 size={15} />, s.h1, () => chain().toggleHeading({ level: 1 }).run())}
          {tool('Heading 2', <Heading2 size={15} />, s.h2, () => chain().toggleHeading({ level: 2 }).run())}
          {tool('Heading 3', <Heading3 size={15} />, s.h3, () => chain().toggleHeading({ level: 3 }).run())}
          {divider('d2')}
          {tool('Bold (Ctrl+B)', <Bold size={15} />, s.bold, () => chain().toggleBold().run())}
          {tool('Italic (Ctrl+I)', <Italic size={15} />, s.italic, () => chain().toggleItalic().run())}
          {tool('Strikethrough', <Strikethrough size={15} />, s.strike, () => chain().toggleStrike().run())}
          {tool('Inline code', <Code size={15} />, s.code, () => chain().toggleCode().run())}
          <ColorPicker
            textColor={s.textColor}
            highlightColor={s.highlightColor}
            disabled={s.code}
            onTextColor={setTextColor}
            onHighlightColor={setHighlightColor}
            onPreview={previewColor}
          />
          {divider('d3')}
          {tool('Bulleted list', <List size={15} />, s.bullet, () => chain().toggleBulletList().run())}
          {tool('Numbered list', <ListOrdered size={15} />, s.ordered, () => chain().toggleOrderedList().run())}
          {tool('Task list', <ListChecks size={15} />, s.task, () => chain().toggleTaskList().run())}
          {divider('d4')}
          {tool('Link (Ctrl+K)', <Link2 size={15} />, s.link, openLink)}
          {tool('Quote', <Quote size={15} />, s.quote, () => chain().toggleBlockquote().run())}
          {tool('Code block', <SquareCode size={15} />, s.codeBlock, () => chain().toggleCodeBlock().run())}
          {tool('Divider', <Minus size={15} />, false, () => chain().setHorizontalRule().run())}
          {tool('Insert table', <TableIcon size={15} />, s.table, () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), s.table)}

          {s.table && (
            <div
              style={{
                flexBasis: '100%',
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 4,
                paddingTop: 6,
                marginTop: 4,
                borderTop: `1px solid ${tokens.colors.neutral[200]}`,
              }}
            >
              <span style={{ fontSize: 12, color: tokens.colors.neutral[600], marginRight: 4 }}>Table</span>
              <ButtonCore size="sm" variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addRowBefore().run()}>Row above</ButtonCore>
              <ButtonCore size="sm" variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addRowAfter().run()}>Row below</ButtonCore>
              <ButtonCore size="sm" variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addColumnBefore().run()}>Column left</ButtonCore>
              <ButtonCore size="sm" variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addColumnAfter().run()}>Column right</ButtonCore>
              <ButtonCore size="sm" variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().toggleHeaderRow().run()}>Header row on/off</ButtonCore>
              <ButtonCore size="sm" variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteRow().run()}>Delete row</ButtonCore>
              <ButtonCore size="sm" variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteColumn().run()}>Delete column</ButtonCore>
              <ButtonCore size="sm" variant="danger" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteTable().run()}>Delete table</ButtonCore>
            </div>
          )}
        </div>
      )}

      {editable && (
        <BubbleMenu
          editor={editor}
          pluginKey={bubbleKey}
          options={bubbleOptions}
          shouldShow={({ editor: ed, state: pmState }) => {
            if (!ed.isEditable) return false;
            if (linkModeRef.current) return true; // typing a link address
            if (ed.isActive('codeBlock') || ed.isActive('table')) return false;
            if (!pmState.selection.empty) return showSelectionMenu; // selected text: formatting
            return ed.isActive('link'); // cursor inside a link: Open / Edit / Remove
          }}
        >
          <div
            ref={bubbleRef}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 2,
              padding: 4,
              background: '#FFFFFF',
              border: `1px solid ${tokens.colors.neutral[200]}`,
              borderRadius: 8,
              boxShadow: '0 8px 24px rgba(9,30,66,0.18)',
            }}
          >
            {linkMode ? (
              <div
                role="group"
                aria-label={linkEditing ? 'Edit link' : 'Add link'}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: tokens.spacing[3],
                  padding: tokens.spacing[2],
                  width: 320,
                  maxWidth: '100%',
                  minWidth: 0,
                  boxSizing: 'border-box',
                }}
              >
                {linkText !== null && (
                  <div ref={linkTextFieldRef}>
                    <Input
                      label="Text"
                      value={linkText}
                      placeholder="Text to show"
                      onChange={(event) => setLinkText(event.target.value)}
                      onKeyDown={onLinkInputKeyDown}
                    />
                  </div>
                )}
                <div ref={linkUrlFieldRef}>
                  <Input
                    label="Link"
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    value={linkUrl}
                    placeholder="Paste or type a link"
                    error={linkError ?? undefined}
                    onChange={(event) => onLinkUrlChange(event.target.value)}
                    onKeyDown={onLinkInputKeyDown}
                  />
                </div>
                {/* One primary action on the right; Remove (editing only) sits apart on the left.
                    Wraps in a narrow editor column instead of cutting a button off. */}
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacing[2] }}>
                  {linkEditing && (
                    <ButtonCore size="sm" variant="ghost" onClick={removeLink} style={{ color: tokens.colors.error[600] }}>
                      Remove
                    </ButtonCore>
                  )}
                  <span style={{ flex: 1 }} />
                  <ButtonCore size="sm" variant="ghost" onClick={closeLink}>
                    Cancel
                  </ButtonCore>
                  <ButtonCore size="sm" variant="primary" onClick={applyLink}>
                    {linkEditing ? 'Update Link' : 'Add Link'}
                  </ButtonCore>
                </div>
              </div>
            ) : linkPreview ? (
              <>
                <span
                  title={(editor.getAttributes('link').href as string) || ''}
                  style={{
                    maxWidth: 240,
                    padding: '0 8px',
                    fontSize: 13,
                    color: tokens.colors.neutral[700],
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {(editor.getAttributes('link').href as string) || ''}
                </span>
                {tool('Open link', <ExternalLink size={15} />, false, openLinkInNewTab)}
                {tool('Edit link', <Pencil size={15} />, false, openLink)}
                {tool('Remove link', <Unlink size={15} />, false, () => chain().extendMarkRange('link').unsetLink().run())}
              </>
            ) : (
              s && (
                <>
                  {tool('Bold', <Bold size={15} />, s.bold, () => chain().toggleBold().run())}
                  {tool('Italic', <Italic size={15} />, s.italic, () => chain().toggleItalic().run())}
                  {tool('Strikethrough', <Strikethrough size={15} />, s.strike, () => chain().toggleStrike().run())}
                  {tool('Inline code', <Code size={15} />, s.code, () => chain().toggleCode().run())}
                  <ColorPicker
                    textColor={s.textColor}
                    highlightColor={s.highlightColor}
                    disabled={s.code}
                    onTextColor={setTextColor}
                    onHighlightColor={setHighlightColor}
                    onPreview={previewColor}
                  />
                  {tool('Link', <Link2 size={15} />, s.link, openLink)}
                </>
              )
            )}
          </div>
        </BubbleMenu>
      )}

      {compact && editable ? (
        <div className="rich-frame" style={frameStyle}>
          {compactToolbar}
          <div style={{ padding: '8px 12px' }}>
            <EditorContent editor={editor} />
          </div>
        </div>
      ) : (
        <EditorContent editor={editor} />
      )}

      {hoverLink && !linkMode && hoverLink.isConnected && typeof document !== 'undefined' &&
        createPortal(
          // On the page body, like the "/" menu: fixed positions inside a transformed window
          // (the ticket modal) would be measured from that window instead of the screen.
          <div
            ref={hoverCardRef}
            role="tooltip"
            onMouseEnter={keepHoverCard}
            onMouseLeave={hideHoverCardSoon}
            style={{
              position: 'fixed',
              top: hoverCardPos?.top ?? 0,
              left: hoverCardPos?.left ?? 0,
              visibility: hoverCardPos ? 'visible' : 'hidden', // measured before it is shown
              maxWidth: 'calc(100vw - 16px)',
              zIndex: 100030, // above every modal, as the "/" menu
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              padding: 4,
              background: '#FFFFFF',
              border: `1px solid ${tokens.colors.neutral[200]}`,
              borderRadius: 8,
              boxShadow: '0 8px 24px rgba(9,30,66,0.18)',
            }}
          >
            <span
              title={hoverLink.href}
              style={{
                maxWidth: 260,
                minWidth: 0,
                padding: '0 8px',
                fontSize: 13,
                color: tokens.colors.neutral[700],
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {hoverLink.getAttribute('href')}
            </span>
            {tool('Open link', <ExternalLink size={15} />, false, () => openHref(hoverLink.href))}
            {editable && tool('Edit link', <Pencil size={15} />, false, () => editHoveredLink(hoverLink))}
            {editable && tool('Remove link', <Unlink size={15} />, false, () => removeHoveredLink(hoverLink))}
          </div>,
          document.body,
        )}

      {slashMenu.menu && (
        <SuggestionPopup
          menu={slashMenu.menu}
          index={slashMenu.index}
          onHover={slashMenu.setIndex}
          borderColor={tokens.colors.neutral[200]}
          hoverBackground={tokens.colors.neutral[100]}
          titleColor={tokens.colors.neutral[900]}
          hintColor={tokens.colors.neutral[600]}
        />
      )}
      {mentionMenu.menu && (
        <SuggestionPopup
          menu={mentionMenu.menu}
          index={mentionMenu.index}
          onHover={mentionMenu.setIndex}
          borderColor={tokens.colors.neutral[200]}
          hoverBackground={tokens.colors.neutral[100]}
          titleColor={tokens.colors.neutral[900]}
          hintColor={tokens.colors.neutral[600]}
        />
      )}
    </div>
  );
});
