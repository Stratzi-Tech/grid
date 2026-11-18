'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiDelete, apiGet, apiPost, apiPut } from '../../lib/api/client';
import { useToast } from '../ui';
import { CreatePageDialog } from './CreatePageDialog';
import { wikiPageHref, type WikiPage } from './wikiUrls';

interface WikiContextValue {
  projectId: number;
  loading: boolean;
  /** Every page in the project, flat. */
  pages: WikiPage[];
  /** Root pages with `children` filled in, for the sidebar tree. */
  tree: WikiPage[];
  byId: (id: number) => WikiPage | undefined;
  starredIds: Set<number>;
  /** Most recently opened first. */
  recentIds: number[];
  refresh: () => Promise<void>;
  toggleStar: (pageId: number) => Promise<void>;
  recordView: (pageId: number) => void;
  createPage: (input: { title: string; content: string; parentId?: number | null }) => Promise<WikiPage>;
  /** Replaces a page in the list after it was saved elsewhere. */
  applySaved: (page: WikiPage) => void;
  /** Permanently deletes the page and everything under it; resolves to how many pages went. */
  deletePage: (pageId: number) => Promise<number>;
  /** How many pages sit under this one, at any depth. */
  countDescendants: (pageId: number) => number;
  /** Opens the create-page dialog, optionally nested under a page. */
  openCreate: (parentId?: number | null) => void;
}

const WikiContext = createContext<WikiContextValue | null>(null);

export function useWiki(): WikiContextValue {
  const ctx = useContext(WikiContext);
  if (!ctx) throw new Error('useWiki must be used inside a WikiProvider');
  return ctx;
}

function buildTree(pages: WikiPage[]): WikiPage[] {
  const map = new Map<number, WikiPage>();
  pages.forEach((p) => map.set(p.id, { ...p, children: [] }));
  const roots: WikiPage[] = [];
  pages.forEach((p) => {
    const node = map.get(p.id)!;
    const parent = p.parent_id != null ? map.get(p.parent_id) : undefined;
    if (parent) parent.children!.push(node);
    else roots.push(node);
  });
  const byTitle = (a: WikiPage, b: WikiPage) => a.title.localeCompare(b.title);
  const sortDeep = (list: WikiPage[]) => {
    list.sort(byTitle);
    list.forEach((n) => sortDeep(n.children ?? []));
  };
  sortDeep(roots);
  return roots;
}

export function WikiProvider({ projectId, children }: { projectId: number; children: React.ReactNode }) {
  const toast = useToast();
  const router = useRouter();
  const [createFor, setCreateFor] = useState<{ parentId: number | null } | null>(null);
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [starredIds, setStarredIds] = useState<Set<number>>(new Set());
  const [recentIds, setRecentIds] = useState<number[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [list, starred, recent] = await Promise.all([
        apiGet<WikiPage[]>(`/wiki?project_id=${projectId}`),
        apiGet<number[]>(`/wiki/starred?project_id=${projectId}`).catch(() => [] as number[]),
        apiGet<number[]>(`/wiki/recent?project_id=${projectId}`).catch(() => [] as number[]),
      ]);
      setPages(list);
      setStarredIds(new Set(starred));
      setRecentIds(recent);
    } catch (error) {
      console.error('Failed to load wiki pages:', error);
      toast.error('Could not load wiki pages');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const tree = useMemo(() => buildTree(pages), [pages]);
  const byId = useCallback((id: number) => pages.find((p) => p.id === id), [pages]);

  const toggleStar = useCallback(
    async (pageId: number) => {
      const wasStarred = starredIds.has(pageId);
      // Optimistic: flip now, roll back if the server refuses.
      setStarredIds((prev) => {
        const next = new Set(prev);
        if (wasStarred) next.delete(pageId);
        else next.add(pageId);
        return next;
      });
      try {
        if (wasStarred) await apiDelete(`/wiki/${pageId}/star`);
        else await apiPut(`/wiki/${pageId}/star`, {});
      } catch {
        setStarredIds((prev) => {
          const next = new Set(prev);
          if (wasStarred) next.add(pageId);
          else next.delete(pageId);
          return next;
        });
        toast.error('Could not update the star');
      }
    },
    [starredIds, toast],
  );

  const recordView = useCallback((pageId: number) => {
    // Move to the front straight away; the server write is fire-and-forget.
    setRecentIds((prev) => [pageId, ...prev.filter((id) => id !== pageId)].slice(0, 10));
    apiPost(`/wiki/${pageId}/view`, {}).catch(() => {});
  }, []);

  const createPage = useCallback(
    async ({ title, content, parentId }: { title: string; content: string; parentId?: number | null }) => {
      const created = await apiPost<unknown, WikiPage>('/wiki', {
        title,
        content,
        project_id: projectId,
        parent_id: parentId ?? null,
      });
      setPages((prev) => [created, ...prev]);
      return created;
    },
    [projectId],
  );

  const applySaved = useCallback((page: WikiPage) => {
    setPages((prev) => prev.map((p) => (p.id === page.id ? { ...p, ...page } : p)));
  }, []);

  const countDescendants = useCallback(
    (pageId: number) => {
      let count = 0;
      let frontier = [pageId];
      while (frontier.length) {
        const next = pages.filter((p) => p.parent_id != null && frontier.includes(p.parent_id)).map((p) => p.id);
        count += next.length;
        frontier = next;
      }
      return count;
    },
    [pages],
  );

  const deletePage = useCallback(
    async (pageId: number) => {
      const total = 1 + countDescendants(pageId);
      await apiDelete(`/wiki/${pageId}`);
      await refresh();
      return total;
    },
    [countDescendants, refresh],
  );

  const value: WikiContextValue = {
    projectId,
    loading,
    pages,
    tree,
    byId,
    starredIds,
    recentIds,
    refresh,
    toggleStar,
    recordView,
    createPage,
    applySaved,
    deletePage,
    countDescendants,
    openCreate: (parentId = null) => setCreateFor({ parentId }),
  };

  const parentTitle = createFor?.parentId != null ? byId(createFor.parentId)?.title : undefined;

  return (
    <WikiContext.Provider value={value}>
      {children}
      <CreatePageDialog
        isOpen={createFor !== null}
        parentTitle={parentTitle}
        onClose={() => setCreateFor(null)}
        onCreate={async (title, template) => {
          try {
            const page = await createPage({ title, content: template.content(), parentId: createFor?.parentId });
            setCreateFor(null);
            toast.success(`Created “${page.title}”`);
            router.push(wikiPageHref(projectId, page));
          } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Could not create the page');
          }
        }}
      />
    </WikiContext.Provider>
  );
}
