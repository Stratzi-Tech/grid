'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { apiGet } from '../../lib/api/client';
import { createSuggestionCommand, SlashItem, SuggestionBridge } from './suggestionCommand';

export interface MentionUser {
  user_id: number;
  name: string;
  email: string;
}

interface MemberRow {
  user_id: number;
  name?: string | null;
  email?: string | null;
}

/**
 * Who can be @mentioned in a project: its members, plus people who could still be added
 * (a mention is how you get someone's attention before they are on the project).
 */
export function useMentionUsers(projectId: number | undefined): React.MutableRefObject<MentionUser[]> {
  const usersRef = useRef<MentionUser[]>([]);
  const [, setLoaded] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      const users: MentionUser[] = [];
      const seen = new Set<string>();
      const add = (rows: MemberRow[]) => {
        for (const row of rows) {
          if (row.email && !seen.has(row.email)) {
            seen.add(row.email);
            users.push({ user_id: row.user_id, name: row.name || row.email, email: row.email });
          }
        }
      };
      try {
        add(await apiGet<MemberRow[]>(`/projects/${projectId}/members`));
      } catch {
        return; // no people to suggest; the editor still works
      }
      try {
        add(await apiGet<MemberRow[]>(`/projects/${projectId}/members/available`));
      } catch {
        // optional
      }
      if (cancelled) return;
      users.sort((a, b) => a.name.localeCompare(b.name));
      usersRef.current = users;
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return usersRef;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

/**
 * Typing "@" opens a list of people. Picking one inserts plain text, `@local.part `, which
 * is exactly what the backend already reads to notify people (it takes the part before the
 * "@" of their email), so nothing about how mentions are stored or sent changes.
 */
export function createMentionCommand(bridge: SuggestionBridge, usersRef: React.MutableRefObject<MentionUser[]>) {
  return createSuggestionCommand({
    name: 'mentionCommand',
    char: '@',
    bridge,
    getItems: (query) => {
      const q = query.trim().toLowerCase();
      const matches = usersRef.current.filter(
        (user) => !q || user.name.toLowerCase().includes(q) || user.email.toLowerCase().startsWith(q),
      );
      return matches.slice(0, 8).map<SlashItem>((user) => {
        const local = user.email.split('@')[0];
        return {
          id: user.email,
          title: user.name,
          hint: `@${local}`,
          keywords: [],
          icon: initials(user.name),
          run: (editor, range) => editor.chain().focus().deleteRange(range).insertContent(`@${local} `).run(),
        };
      });
    },
  });
}

const MENTION_PATTERN = /(^|\s)(@[\w.+-]+)/g;
const mentionKey = new PluginKey('richMentionHighlight');

/** Shows @names in blue, the way saved comments already do. Display only; the text is unchanged. */
export const MentionHighlight = Extension.create({
  name: 'mentionHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: mentionKey,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              if (node.marks.some((mark) => mark.type.name === 'code')) return;
              MENTION_PATTERN.lastIndex = 0;
              let match: RegExpExecArray | null;
              while ((match = MENTION_PATTERN.exec(node.text)) !== null) {
                const start = pos + match.index + match[1].length;
                decorations.push(Decoration.inline(start, start + match[2].length, { class: 'rich-mention' }));
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
