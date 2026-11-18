'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Extension } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import {
  Heading1, Heading2, Heading3, List, ListOrdered, ListChecks, Quote, SquareCode, Table as TableIcon, Minus, Type,
} from 'lucide-react';

/** One row in a suggestion menu: a "/" command, or a person after "@". */
export interface SlashItem {
  id: string;
  title: string;
  hint: string;
  /** Extra words the query also matches, e.g. "ul" for a bulleted list. */
  keywords: string[];
  icon: React.ReactNode;
  run: (editor: Editor, range: Range) => void;
}

const icon = (Icon: React.ElementType) => <Icon size={16} />;
const MENU_MAX_HEIGHT = 320;

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', title: 'Text', hint: 'Plain paragraph', keywords: ['paragraph', 'p'], icon: icon(Type), run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { id: 'h1', title: 'Heading 1', hint: 'Big section heading', keywords: ['h1', 'title'], icon: icon(Heading1), run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
  { id: 'h2', title: 'Heading 2', hint: 'Medium section heading', keywords: ['h2', 'subtitle'], icon: icon(Heading2), run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { id: 'h3', title: 'Heading 3', hint: 'Small section heading', keywords: ['h3'], icon: icon(Heading3), run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  { id: 'bullet', title: 'Bulleted list', hint: 'A simple list of points', keywords: ['ul', 'unordered', 'bullets'], icon: icon(List), run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { id: 'ordered', title: 'Numbered list', hint: 'A list with numbers', keywords: ['ol', 'ordered', 'steps'], icon: icon(ListOrdered), run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { id: 'task', title: 'Task list', hint: 'Checklist with checkboxes', keywords: ['todo', 'checkbox', 'checklist'], icon: icon(ListChecks), run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { id: 'table', title: 'Table', hint: 'Insert a 3 × 3 table', keywords: ['grid', 'rows', 'columns'], icon: icon(TableIcon), run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'quote', title: 'Quote', hint: 'Call out a quotation', keywords: ['blockquote', 'callout'], icon: icon(Quote), run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { id: 'code', title: 'Code block', hint: 'Monospaced snippet', keywords: ['pre', 'snippet'], icon: icon(SquareCode), run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  { id: 'divider', title: 'Divider', hint: 'A horizontal line', keywords: ['hr', 'line', 'separator'], icon: icon(Minus), run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
];

/** What a suggestion menu needs to draw itself. */
export interface SuggestionState {
  items: SlashItem[];
  run: (item: SlashItem) => void;
  /** Where the cursor is right now. A function, not a snapshot: the page can scroll under an open menu. */
  getRect: () => DOMRect | null;
}

export interface SuggestionBridge {
  onOpen: (state: SuggestionState) => void;
  onUpdate: (state: SuggestionState) => void;
  onClose: () => void;
  /** Return true when the key was handled (the editor then ignores it). */
  onKey: (event: KeyboardEvent) => boolean;
}

/**
 * Keeps the state of one suggestion menu ("/" commands, or "@" people) in React, and hands
 * the editor a bridge to feed it. The menu itself is drawn by the editor component; the
 * extension below only detects the trigger character and what has been typed after it.
 */
export function useSuggestionMenu() {
  const [menu, setMenu] = useState<SuggestionState | null>(null);
  const [index, setIndex] = useState(0);
  const menuRef = useRef(menu);
  const indexRef = useRef(0);
  menuRef.current = menu;
  indexRef.current = index;

  const bridge = useMemo<SuggestionBridge>(
    () => ({
      onOpen: (state) => {
        setMenu(state);
        setIndex(0);
      },
      onUpdate: (state) => {
        setMenu(state);
        setIndex((current) => Math.min(current, Math.max(state.items.length - 1, 0)));
      },
      onClose: () => setMenu(null),
      onKey: (event) => {
        const current = menuRef.current;
        if (!current || current.items.length === 0) return false;
        if (event.key === 'ArrowDown') {
          setIndex((indexRef.current + 1) % current.items.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setIndex((indexRef.current - 1 + current.items.length) % current.items.length);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          current.run(current.items[indexRef.current]);
          return true;
        }
        return false;
      },
    }),
    [],
  );

  return { menu, index, setIndex, bridge };
}

interface SuggestionOptions {
  /** Unique per extension: two suggestion plugins in one editor cannot share a name or key. */
  name: string;
  char: string;
  bridge: SuggestionBridge;
  getItems: (query: string) => SlashItem[];
}

export function createSuggestionCommand({ name, char, bridge, getItems }: SuggestionOptions) {
  const pluginKey = new PluginKey(`${name}Suggestion`);
  return Extension.create({
    name,
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          pluginKey,
          editor: this.editor,
          char,
          allowSpaces: false,
          startOfLine: false,
          items: ({ query }) => getItems(query),
          command: ({ editor, range, props }) => props.run(editor, range),
          render: () => {
            const toState = (props: { items: SlashItem[]; command: (item: SlashItem) => void; clientRect?: (() => DOMRect | null) | null }): SuggestionState => ({
              items: props.items,
              run: props.command,
              getRect: () => props.clientRect?.() ?? null,
            });
            return {
              onStart: (props) => bridge.onOpen(toState(props)),
              onUpdate: (props) => bridge.onUpdate(toState(props)),
              onKeyDown: ({ event }) => {
                if (event.key === 'Escape') {
                  // Closes this menu only. Without stopping it here the key also reaches the
                  // page, where Escape closes the whole ticket window around the editor.
                  event.stopPropagation();
                  bridge.onClose();
                  return true;
                }
                return bridge.onKey(event);
              },
              onExit: () => bridge.onClose(),
            };
          },
        }),
      ];
    },
  });
}

/** The "/" menu of block types. */
export function createSlashCommand(bridge: SuggestionBridge) {
  return createSuggestionCommand({
    name: 'slashCommand',
    char: '/',
    bridge,
    getItems: (query) => {
      const q = query.trim().toLowerCase();
      if (!q) return SLASH_ITEMS;
      return SLASH_ITEMS.filter((item) => item.title.toLowerCase().includes(q) || item.keywords.some((k) => k.startsWith(q)));
    },
  });
}

/** The floating list under the cursor. Mouse-down is swallowed so the editor keeps its focus. */
export function SuggestionPopup({
  menu,
  index,
  onHover,
  borderColor,
  hoverBackground,
  titleColor,
  hintColor,
}: {
  menu: SuggestionState;
  index: number;
  onHover: (index: number) => void;
  borderColor: string;
  hoverBackground: string;
  titleColor: string;
  hintColor: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [placement, setPlacement] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  // The page, or the window the editor sits in, can scroll while the menu is open: follow the cursor.
  useEffect(() => {
    const update = () => setTick((tick) => tick + 1);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, []);

  const rect = menu.getRect();

  // Below the cursor when the list fits there; otherwise on whichever side has more room,
  // made shorter (it scrolls) so it never runs off screen. Never past the left or right edge.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !rect) return;
    const gap = 6;
    const margin = 8;
    const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;
    const natural = Math.min(node.scrollHeight, MENU_MAX_HEIGHT);
    const above = natural > spaceBelow && spaceAbove > spaceBelow;
    // ponytail: 80px floor, so a cursor at the very edge still gets a usable (scrolling) list.
    const maxHeight = Math.max(80, Math.min(MENU_MAX_HEIGHT, above ? spaceAbove : spaceBelow));
    const height = Math.min(natural, maxHeight);
    // The 80px floor can be more than the chosen side has: then keep the list on screen,
    // overlapping the cursor line a little, rather than letting it run past the edge.
    const top = Math.max(
      margin,
      Math.min(above ? rect.top - gap - height : rect.bottom + gap, window.innerHeight - margin - height),
    );
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - node.offsetWidth - margin));
    setPlacement((current) =>
      current && current.top === top && current.left === left && current.maxHeight === maxHeight
        ? current
        : { top, left, maxHeight },
    );
  });

  if (!rect || menu.items.length === 0 || typeof document === 'undefined') return null;

  // Drawn on the page body, not inside the editor: the ticket window is centred with a CSS
  // transform, and inside a transformed parent "fixed" positions are measured from that window
  // instead of the screen, so the list landed in the wrong corner and drifted when scrolling.
  return createPortal(
    <div
      ref={ref}
      role="listbox"
      style={{
        position: 'fixed',
        top: placement?.top ?? rect.bottom + 6,
        left: placement?.left ?? rect.left,
        visibility: placement ? 'visible' : 'hidden',
        width: 'min(280px, calc(100vw - 16px))',
        maxHeight: placement?.maxHeight ?? MENU_MAX_HEIGHT,
        overflowY: 'auto',
        // Above every modal in the app (ticket detail sits at 9999), since this opens inside them.
        zIndex: 100030,
        background: '#FFFFFF',
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(9,30,66,0.18)',
        padding: 4,
      }}
    >
      {menu.items.map((item, i) => (
        <div
          key={item.id}
          role="option"
          aria-selected={i === index}
          onMouseDown={(event) => {
            event.preventDefault();
            menu.run(item);
          }}
          onMouseEnter={() => onHover(i)}
          ref={(node) => {
            if (node && i === index) node.scrollIntoView({ block: 'nearest' });
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '6px 8px',
            borderRadius: 6,
            cursor: 'pointer',
            background: i === index ? hoverBackground : 'transparent',
          }}
        >
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: `1px solid ${borderColor}`,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: titleColor,
              flexShrink: 0,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {item.icon}
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: titleColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
            <span style={{ fontSize: 12, color: hintColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.hint}</span>
          </span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
