'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle, BookOpen, ChevronRight, Cloud, CloudCheck, Copy, Download, History, Link2, LoaderCircle, MoreHorizontal, Star, Trash2,
} from 'lucide-react';
import { apiGet } from '../../../../../../lib/api/client';
import { tokens } from '../../../../../../design-system/tokens';
import { ButtonCore, ConfirmDialog, useToast } from '../../../../../../components/ui';
import WikiFileManager from '../../../../../../components/WikiFileManager';
import { RichEditor, RichEditorHandle, OutlineItem } from '../../../../../../components/editor/RichEditor';
import { VersionHistoryDialog } from '../../../../../../components/wiki/VersionHistoryDialog';
import { SaveState, useWikiAutosave } from '../../../../../../components/wiki/useWikiAutosave';
import { useWiki } from '../../../../../../components/wiki/WikiContext';
import { wikiPageHref, parseWikiPageParam, WikiPage } from '../../../../../../components/wiki/wikiUrls';
import { useProjectContext } from '../../../../../../hooks/useProjectContext';
import { useAuth } from '../../../../../../hooks/useAuth';

const versionOf = (page: WikiPage) => page.updated_at ?? page.created_at;

/**
 * Title for a duplicate: "X (Copy)", then "X (Copy 2)", "X (Copy 3)"... — the first one
 * not already taken among `siblingTitles`. Duplicating a copy counts from the original's
 * name rather than stacking "(Copy) (Copy)".
 */
function nextCopyTitle(title: string, siblingTitles: string[]): string {
  const base = title.replace(/ \(Copy(?: \d+)?\)$/, '');
  const taken = new Set(siblingTitles);
  let candidate = `${base} (Copy)`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base} (Copy ${n})`;
  return candidate;
}

/** Route entry: one editor per page id, so unsaved edits can never be written to the next page. */
export default function WikiPageRoute() {
  const params = useParams();
  const pageId = parseWikiPageParam(params.page);
  return <WikiPageLoader key={pageId ?? 'none'} pageId={pageId} />;
}

function Message({ title, text, projectId }: { title: string; text: string; projectId: number }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        fontFamily: tokens.fontFamily.sans,
        color: tokens.colors.neutral[600],
      }}
    >
      <BookOpen size={48} style={{ opacity: 0.3 }} />
      <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: tokens.colors.neutral[900] }}>{title}</h3>
      <p style={{ margin: 0, fontSize: 14 }}>{text}</p>
      <Link href={`/projects/${projectId}/wiki`}>
        <ButtonCore variant="secondary">Back to the wiki</ButtonCore>
      </Link>
    </div>
  );
}

function WikiPageLoader({ pageId }: { pageId: number | null }) {
  const { projectId, recordView } = useWiki();
  const [page, setPage] = useState<WikiPage | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>(pageId == null ? 'missing' : 'loading');

  useEffect(() => {
    if (pageId == null) return;
    let cancelled = false;
    apiGet<WikiPage>(`/wiki/${pageId}`)
      .then((loaded) => {
        if (cancelled) return;
        if (loaded.project_id !== projectId) {
          setStatus('missing');
          return;
        }
        setPage(loaded);
        setStatus('ready');
        recordView(loaded.id);
      })
      .catch(() => {
        if (!cancelled) setStatus('missing');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, projectId]);

  if (status === 'loading') {
    return <div style={{ padding: 32, color: tokens.colors.neutral[600], fontSize: 14 }}>Loading…</div>;
  }
  if (status === 'missing' || !page) {
    return <Message title="This page isn’t here" text="It may have been deleted, or you may not have access to it." projectId={projectId} />;
  }
  return <WikiPageEditor initialPage={page} />;
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const base: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: tokens.colors.neutral[600] };
  if (state === 'saved') {
    return (
      <span style={base} role="status" aria-label="Saved" title="Saved">
        <CloudCheck size={18} color={tokens.colors.success[600]} />
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span style={{ ...base, color: tokens.colors.error[600] }} role="alert">
        Couldn’t save
        <button
          type="button"
          onClick={onRetry}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: tokens.colors.primary[600], fontSize: 12, fontFamily: 'inherit', textDecoration: 'underline' }}
        >
          Retry
        </button>
      </span>
    );
  }
  if (state === 'conflict') {
    return (
      <span style={{ ...base, color: tokens.colors.warning[700] }} role="alert">
        <AlertTriangle size={14} /> Not saved
      </span>
    );
  }
  if (state === 'saving') {
    return (
      <span style={base} role="status" aria-label="Saving…" title="Saving…">
        <LoaderCircle size={18} color={tokens.colors.primary[600]} style={{ animation: 'btn-spin 0.8s linear infinite' }} />
      </span>
    );
  }
  return (
    <span style={base} role="status" aria-label="Unsaved changes" title="Unsaved changes">
      <Cloud size={18} color={tokens.colors.neutral[500]} />
    </span>
  );
}

function WikiPageEditor({ initialPage }: { initialPage: WikiPage }) {
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();
  const { projects } = useProjectContext();
  const { projectId, pages, byId, applySaved, toggleStar, starredIds, deletePage, countDescendants, createPage } = useWiki();

  const [page, setPage] = useState(initialPage);
  const [title, setTitle] = useState(initialPage.title);
  // Bumped when the document is replaced from outside (reload after a conflict, restore),
  // which remounts the editor onto the new content.
  const [reloadToken, setReloadToken] = useState(0);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const editorRef = useRef<RichEditorHandle>(null);

  // The latest text, for actions (duplicate, export) that must not use a stale copy.
  const titleRef = useRef(initialPage.title);
  const contentRef = useRef(initialPage.content);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);

  const autosave = useWikiAutosave({
    pageId: initialPage.id,
    baseVersion: versionOf(initialPage),
    onSaved: (saved) => {
      setPage(saved);
      applySaved(saved);
    },
  });

  // Close the "more" menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Ctrl/Cmd+S: save right now instead of waiting for the pause.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void autosave.flushNow();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [autosave]);

  const onTitleChange = (value: string) => {
    setTitle(value);
    if (value.trim()) {
      titleRef.current = value.trim();
      autosave.schedule({ title: value.trim() });
    }
  };

  const onContentChange = (markdown: string) => {
    contentRef.current = markdown;
    autosave.schedule({ content: markdown });
  };

  /** Replace what is on screen with a version of the page that came from the server. */
  const adoptServerPage = (fresh: WikiPage) => {
    setPage(fresh);
    setTitle(fresh.title);
    titleRef.current = fresh.title;
    contentRef.current = fresh.content;
    applySaved(fresh);
    autosave.reset(versionOf(fresh));
    setReloadToken((n) => n + 1);
  };

  const reloadLatest = async () => {
    try {
      adoptServerPage(await apiGet<WikiPage>(`/wiki/${initialPage.id}`));
    } catch {
      toast.error('Could not reload the page');
    }
  };

  const openHistory = async () => {
    // Make sure the newest edits are in the history before showing it.
    await autosave.flushNow();
    setHistoryOpen(true);
  };

  const isStarred = starredIds.has(page.id);
  const myRole = projects.find((p) => p.id === projectId)?.my_role;
  const canDelete = myRole === 'admin' || (!!user?.email && page.author_email === user.email);
  const descendantCount = countDescendants(page.id);

  const ancestors = useMemo(() => {
    const chain: WikiPage[] = [];
    let parentId = page.parent_id;
    while (parentId != null) {
      const parent = byId(parentId);
      if (!parent) break;
      chain.unshift(parent);
      parentId = parent.parent_id;
    }
    return chain;
  }, [page.parent_id, byId]);

  const copyLink = async () => {
    const url = `${window.location.origin}${wikiPageHref(projectId, page)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy the link. Copy it from the address bar instead.');
    }
  };

  const duplicate = async () => {
    try {
      await autosave.flushNow();
      const copy = await createPage({
        title: nextCopyTitle(titleRef.current, pages.filter((p) => p.parent_id === page.parent_id).map((p) => p.title)),
        content: contentRef.current,
        parentId: page.parent_id,
      });
      toast.success('Page duplicated (attachments are not copied)');
      router.push(wikiPageHref(projectId, copy));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not duplicate the page');
    }
  };

  const exportMarkdown = () => {
    const blob = new Blob([`# ${titleRef.current}\n\n${contentRef.current}\n`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${page.slug || 'page'}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.success('Exported as Markdown');
  };

  const confirmAndDelete = async () => {
    setDeleting(true);
    try {
      // Edits to a page that is about to disappear must not be sent after it is gone.
      autosave.reset(versionOf(page));
      const total = await deletePage(page.id);
      setConfirmDelete(false);
      toast.success(
        total > 1 ? `Deleted “${page.title}” and ${total - 1} sub-page${total - 1 === 1 ? '' : 's'}` : `Deleted “${page.title}”`,
      );
      router.push(`/projects/${projectId}/wiki`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete the page');
    } finally {
      setDeleting(false);
    }
  };

  const menuItems = [
    { icon: Link2, label: 'Copy link', run: copyLink },
    { icon: Copy, label: 'Duplicate', run: duplicate },
    { icon: Download, label: 'Export as Markdown', run: exportMarkdown },
    ...(canDelete ? [{ icon: Trash2, label: 'Delete', run: () => setConfirmDelete(true), danger: true }] : []),
  ];

  return (
    <>
      {/* Top bar */}
      <div
        style={{
          height: 56,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '0 24px',
          borderBottom: `1px solid ${tokens.colors.neutral[200]}`,
          fontFamily: tokens.fontFamily.sans,
        }}
      >
        <nav aria-label="Breadcrumb" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: tokens.colors.neutral[600], minWidth: 0 }}>
          <Link href={`/projects/${projectId}/wiki`} style={{ color: 'inherit', display: 'flex' }} aria-label="Wiki home">
            <BookOpen size={16} />
          </Link>
          {ancestors.map((ancestor) => (
            <React.Fragment key={ancestor.id}>
              <ChevronRight size={13} />
              <Link href={wikiPageHref(projectId, ancestor)} style={{ color: 'inherit', textDecoration: 'none', whiteSpace: 'nowrap' }}>
                {ancestor.title}
              </Link>
            </React.Fragment>
          ))}
          <ChevronRight size={13} />
          <span style={{ color: tokens.colors.neutral[900], fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title || 'Untitled'}
          </span>
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <SaveIndicator state={autosave.state} onRetry={autosave.retry} />
          <ButtonCore
            variant="secondary"
            aria-pressed={isStarred}
            aria-label={isStarred ? 'Unstar page' : 'Star page'}
            title={isStarred ? 'Unstar page' : 'Star page'}
            onClick={() => void toggleStar(page.id)}
            style={{ padding: '0 8px' }}
          >
            <Star size={16} color={tokens.colors.warning[500]} fill={isStarred ? tokens.colors.warning[500] : 'none'} />
          </ButtonCore>
          <ButtonCore variant="secondary" aria-label="Version history" title="Version history" onClick={() => void openHistory()} style={{ padding: '0 8px' }}>
            <History size={16} />
          </ButtonCore>
          <div ref={menuRef} style={{ position: 'relative' }}>
            <ButtonCore variant="secondary" aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)} style={{ padding: '0 8px' }}>
              <MoreHorizontal size={16} />
            </ButtonCore>
            {menuOpen && (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 'calc(100% + 4px)',
                  minWidth: 200,
                  zIndex: 100,
                  background: '#FFFFFF',
                  border: `1px solid ${tokens.colors.neutral[200]}`,
                  borderRadius: 8,
                  boxShadow: '0 8px 24px rgba(9,30,66,0.18)',
                  padding: 4,
                }}
              >
                {menuItems.map((item) => {
                  const danger = 'danger' in item && item.danger;
                  return (
                    <button
                      key={item.label}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void item.run();
                      }}
                      onMouseEnter={(event) => (event.currentTarget.style.background = danger ? tokens.colors.error[50] : tokens.colors.neutral[100])}
                      onMouseLeave={(event) => (event.currentTarget.style.background = 'transparent')}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 10px',
                        border: 'none',
                        borderRadius: 6,
                        background: 'transparent',
                        cursor: 'pointer',
                        fontSize: 13,
                        fontFamily: 'inherit',
                        textAlign: 'left',
                        color: danger ? tokens.colors.error[600] : tokens.colors.neutral[900],
                      }}
                    >
                      <item.icon size={15} />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* The editor's formatting toolbar is rendered into this bar, above the scrolling area
          rather than inside it. That way it never covers the text, and the top edge of the
          scrolling area is exactly where "no more room above" starts for the selection popup. */}
      <div ref={setToolbarSlot} style={{ flexShrink: 0 }} />

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, fontFamily: tokens.fontFamily.sans }}>
        {/* scrollbarGutter keeps the column the same width whether or not the page is long
            enough to scroll, so growing past one screen does not nudge the text sideways. */}
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', scrollbarGutter: 'stable' }}>
          <div style={{ maxWidth: 820, margin: '0 auto', padding: '32px 32px 64px' }}>
            {autosave.state === 'conflict' && (
              <div
                role="alert"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '10px 14px',
                  marginBottom: 20,
                  borderRadius: 8,
                  background: tokens.colors.warning[50],
                  border: `1px solid ${tokens.colors.warning[200]}`,
                  fontSize: 13,
                  color: tokens.colors.neutral[900],
                }}
              >
                <span>
                  <strong>Someone else changed this page</strong> while you were editing, so your latest changes are not saved yet.
                </span>
                <span style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <ButtonCore size="sm" variant="secondary" onClick={autosave.overwrite}>Keep my version</ButtonCore>
                  <ButtonCore size="sm" variant="primary" onClick={() => void reloadLatest()}>Load their version</ButtonCore>
                </span>
              </div>
            )}

            <input
              type="text"
              value={title}
              maxLength={120}
              placeholder="Untitled"
              aria-label="Page title"
              onChange={(event) => onTitleChange(event.target.value)}
              onBlur={() => {
                if (!title.trim()) {
                  setTitle(page.title);
                  titleRef.current = page.title;
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  editorRef.current?.focus();
                }
              }}
              style={{
                width: '100%',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                padding: '0 0 4px',
                fontSize: 34,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: tokens.colors.neutral[900],
                fontFamily: 'inherit',
              }}
            />
            <div style={{ fontSize: 13, color: tokens.colors.neutral[600], margin: '0 0 24px' }}>
              Created by {page.author_name}
              {page.updated_at ? ` · Updated ${new Date(page.updated_at).toLocaleString()}${page.updated_by_name ? ` by ${page.updated_by_name}` : ''}` : ''}
            </div>

            <RichEditor
              key={`${page.id}-${reloadToken}`}
              ref={editorRef}
              value={reloadToken === 0 ? initialPage.content : contentRef.current}
              editable
              toolbarContainer={toolbarSlot}
              onChange={onContentChange}
              onOutline={setOutline}
            />

            <WikiFileManager pageSlug={page.slug} projectId={page.project_id} readOnly={false} />
          </div>
        </div>

        {/* On this page. Always rendered, even with no headings: if it came and went with
            the first and last heading, adding or removing one would resize the whole
            canvas and shift the text the user is typing in. */}
        <aside
            aria-label="On this page"
            style={{
              width: 240,
              flexShrink: 0,
              borderLeft: `1px solid ${tokens.colors.neutral[200]}`,
              background: tokens.colors.neutral[50],
              padding: 16,
              overflowY: 'auto',
            }}
          >
            <h3 style={{ margin: '0 0 12px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: tokens.colors.neutral[900] }}>
              On this page
            </h3>
            {outline.length === 0 && (
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: tokens.colors.neutral[500] }}>
                Headings you add will show up here.
              </p>
            )}
            {outline.map((item, index) => (
              <button
                key={`${index}-${item.text}`}
                type="button"
                onClick={() => editorRef.current?.scrollToHeading(index)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px 0',
                  paddingLeft: (item.level - 1) * 12,
                  fontSize: 13,
                  color: tokens.colors.neutral[700],
                  fontFamily: 'inherit',
                }}
              >
                {item.text || 'Untitled heading'}
              </button>
            ))}
        </aside>
      </div>

      <VersionHistoryDialog
        pageId={page.id}
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestored={adoptServerPage}
      />

      <ConfirmDialog
        isOpen={confirmDelete}
        title={`Delete “${page.title}”?`}
        confirmLabel={descendantCount > 0 ? `Delete ${descendantCount + 1} pages` : 'Delete page'}
        destructive
        busy={deleting}
        onConfirm={() => void confirmAndDelete()}
        onCancel={() => !deleting && setConfirmDelete(false)}
      >
        {descendantCount > 0 ? (
          <>
            This will also delete its {descendantCount} sub-page{descendantCount === 1 ? '' : 's'}, along with every attached file.
            This can’t be undone.
          </>
        ) : (
          <>This will permanently delete the page and its attached files. This can’t be undone.</>
        )}
      </ConfirmDialog>
    </>
  );
}
