'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { BookOpen, ChevronDown, ChevronRight, Clock, FileText, Plus, Search, Star } from 'lucide-react';
import { tokens } from '../../design-system/tokens';
import { ButtonCore } from '../ui';
import { useWiki } from './WikiContext';
import { wikiPageHref, WikiPage } from './wikiUrls';

type Tab = 'pages' | 'recent' | 'starred';

interface WikiSidebarProps {
  activeId: number | null;
  onCreate: (parentId?: number) => void;
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div style={{ padding: 32, textAlign: 'center', color: tokens.colors.neutral[600] }}>
      <div style={{ opacity: 0.5, marginBottom: 12, display: 'flex', justifyContent: 'center' }}>{icon}</div>
      <p style={{ fontSize: 13, margin: 0 }}>{text}</p>
    </div>
  );
}

export function WikiSidebar({ activeId, onCreate }: WikiSidebarProps) {
  const { projectId, tree, pages, byId, starredIds, recentIds, toggleStar, loading } = useWiki();
  const [tab, setTab] = useState<Tab>('pages');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hoverId, setHoverId] = useState<number | null>(null);

  // Open the branch that holds the page being read, so it is visible in the tree.
  useEffect(() => {
    if (activeId == null) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let parentId = byId(activeId)?.parent_id ?? null;
      while (parentId != null) {
        next.add(parentId);
        parentId = byId(parentId)?.parent_id ?? null;
      }
      return next;
    });
  }, [activeId, byId]);

  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const trimmed = query.trim().toLowerCase();
  const searchHits = useMemo(
    () => (trimmed ? pages.filter((p) => p.title.toLowerCase().includes(trimmed)) : []),
    [pages, trimmed],
  );

  const row = (page: WikiPage, level: number, opts: { hasChildren: boolean; isExpanded: boolean }) => {
    const selected = page.id === activeId;
    const starred = starredIds.has(page.id);
    const hovered = hoverId === page.id;
    return (
      <div
        key={page.id}
        onMouseEnter={() => setHoverId(page.id)}
        onMouseLeave={() => setHoverId(null)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          paddingLeft: 8 + level * 16,
          paddingRight: 4,
          height: 32,
          borderRadius: 6,
          background: selected ? tokens.colors.primary[50] : hovered ? tokens.colors.neutral[100] : 'transparent',
        }}
      >
        {opts.hasChildren ? (
          <button
            type="button"
            aria-label={opts.isExpanded ? 'Collapse' : 'Expand'}
            onClick={() => toggleExpanded(page.id)}
            style={{ background: 'none', border: 'none', padding: 0, width: 18, cursor: 'pointer', display: 'flex', color: tokens.colors.neutral[600] }}
          >
            {opts.isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ) : (
          <span style={{ width: 18 }} />
        )}
        <Link
          href={wikiPageHref(projectId, page)}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            textDecoration: 'none',
            color: selected ? tokens.colors.primary[700] : tokens.colors.neutral[900],
            fontSize: 13,
            fontWeight: selected ? 600 : 500,
          }}
        >
          <FileText size={15} color={selected ? tokens.colors.primary[600] : tokens.colors.neutral[600]} style={{ flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{page.title}</span>
        </Link>
        <button
          type="button"
          title="Add sub-page"
          aria-label={`Add a sub-page under ${page.title}`}
          onClick={() => onCreate(page.id)}
          style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', display: 'flex', opacity: hovered ? 1 : 0, color: tokens.colors.neutral[600] }}
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          title={starred ? 'Remove star' : 'Star this page'}
          aria-label={starred ? `Unstar ${page.title}` : `Star ${page.title}`}
          aria-pressed={starred}
          onClick={() => void toggleStar(page.id)}
          style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', display: 'flex', opacity: starred || hovered ? 1 : 0 }}
        >
          <Star size={14} color={tokens.colors.warning[500]} fill={starred ? tokens.colors.warning[500] : 'none'} />
        </button>
      </div>
    );
  };

  const renderTree = (list: WikiPage[], level = 0): React.ReactNode =>
    list.map((page) => {
      const hasChildren = !!page.children?.length;
      const isExpanded = expanded.has(page.id);
      return (
        <div key={page.id}>
          {row(page, level, { hasChildren, isExpanded })}
          {hasChildren && isExpanded && renderTree(page.children!, level + 1)}
        </div>
      );
    });

  const flatList = (list: WikiPage[], icon: React.ReactNode) =>
    list.map((page) => (
      <Link
        key={page.id}
        href={wikiPageHref(projectId, page)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 32,
          padding: '0 10px',
          borderRadius: 6,
          textDecoration: 'none',
          fontSize: 13,
          fontWeight: page.id === activeId ? 600 : 500,
          color: page.id === activeId ? tokens.colors.primary[700] : tokens.colors.neutral[900],
          background: page.id === activeId ? tokens.colors.primary[50] : 'transparent',
        }}
      >
        {icon}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{page.title}</span>
      </Link>
    ));

  const recentPages = recentIds.map((id) => byId(id)).filter((p): p is WikiPage => !!p);
  const starredPages = pages.filter((p) => starredIds.has(p.id)).sort((a, b) => a.title.localeCompare(b.title));

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'pages', label: 'Pages', icon: FileText },
    { id: 'recent', label: 'Recent', icon: Clock },
    { id: 'starred', label: 'Starred', icon: Star },
  ];

  return (
    <aside
      style={{
        width: 280,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: tokens.colors.neutral[50],
        borderRight: `1px solid ${tokens.colors.neutral[200]}`,
        fontFamily: tokens.fontFamily.sans,
      }}
    >
      <div style={{ padding: 16, borderBottom: `1px solid ${tokens.colors.neutral[200]}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BookOpen size={20} color={tokens.colors.primary[500]} />
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: tokens.colors.neutral[900] }}>Wiki</h2>
          </div>
          <ButtonCore size="sm" variant="primary" leftIcon={<Plus size={14} />} onClick={() => onCreate()}>
            New page
          </ButtonCore>
        </div>
        <div style={{ position: 'relative' }}>
          <Search size={15} color={tokens.colors.neutral[500]} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }} />
          <input
            type="text"
            value={query}
            placeholder="Search pages…"
            onChange={(event) => setQuery(event.target.value)}
            style={{
              width: '100%',
              height: 32,
              padding: '0 10px 0 32px',
              fontSize: 13,
              borderRadius: 6,
              border: `1px solid ${tokens.colors.neutral[200]}`,
              background: '#FFFFFF',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>
      </div>

      {!trimmed && (
        // Same look as the top navigation: a filled pill, blue when active, grey on hover.
        <div role="tablist" aria-label="Wiki views" style={{ display: 'flex', gap: 2, padding: '8px', borderBottom: `1px solid ${tokens.colors.neutral[200]}` }}>
          {tabs.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(id)}
                onMouseEnter={(event) => {
                  if (!active) event.currentTarget.style.background = '#F1F2F4';
                }}
                onMouseLeave={(event) => {
                  if (!active) event.currentTarget.style.background = 'transparent';
                }}
                style={{
                  flex: 1,
                  height: 32,
                  padding: '0 10px',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  fontSize: 14,
                  fontWeight: active ? 600 : 500,
                  color: active ? '#0C66E4' : '#44546F',
                  background: active ? '#E9F2FF' : 'transparent',
                  transition: 'background-color 0.15s, color 0.15s',
                  fontFamily: 'inherit',
                }}
              >
                <Icon size={14} />
                {label}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {loading ? (
          <EmptyState icon={<FileText size={32} />} text="Loading pages…" />
        ) : trimmed ? (
          searchHits.length > 0 ? (
            flatList(searchHits, <FileText size={15} color={tokens.colors.neutral[600]} style={{ flexShrink: 0 }} />)
          ) : (
            <EmptyState icon={<Search size={32} />} text={`No pages match “${query.trim()}”`} />
          )
        ) : tab === 'pages' ? (
          tree.length > 0 ? (
            renderTree(tree)
          ) : (
            <EmptyState icon={<FileText size={32} />} text="No pages yet" />
          )
        ) : tab === 'recent' ? (
          recentPages.length > 0 ? (
            flatList(recentPages, <Clock size={14} color={tokens.colors.neutral[600]} style={{ flexShrink: 0 }} />)
          ) : (
            <EmptyState icon={<Clock size={32} />} text="Pages you open will show up here" />
          )
        ) : starredPages.length > 0 ? (
          flatList(starredPages, <Star size={14} color={tokens.colors.warning[500]} fill={tokens.colors.warning[500]} style={{ flexShrink: 0 }} />)
        ) : (
          <EmptyState icon={<Star size={32} />} text="Star a page to pin it here" />
        )}
      </div>
    </aside>
  );
}
