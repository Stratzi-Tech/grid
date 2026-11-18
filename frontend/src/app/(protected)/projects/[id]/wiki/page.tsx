'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, Plus } from 'lucide-react';
import { tokens } from '../../../../../design-system/tokens';
import { ButtonCore } from '../../../../../components/ui';
import { useWiki } from '../../../../../components/wiki/WikiContext';
import { wikiPageHref } from '../../../../../components/wiki/wikiUrls';

/** /wiki itself: jump to the project's overview (or first) page, or invite the user to write one. */
export default function WikiIndexPage() {
  const router = useRouter();
  const { projectId, loading, tree, pages, openCreate } = useWiki();

  const landing = pages.find((p) => p.slug === 'project-overview') ?? tree[0];

  useEffect(() => {
    if (!loading && landing) router.replace(wikiPageHref(projectId, landing));
  }, [loading, landing, projectId, router]);

  if (loading || landing) {
    return <div style={{ padding: 32, color: tokens.colors.neutral[600], fontSize: 14 }}>Loading…</div>;
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        color: tokens.colors.neutral[600],
        fontFamily: tokens.fontFamily.sans,
      }}
    >
      <BookOpen size={56} style={{ opacity: 0.3 }} />
      <h3 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: tokens.colors.neutral[900] }}>Your wiki is empty</h3>
      <p style={{ margin: 0, fontSize: 14, maxWidth: 380, textAlign: 'center' }}>
        Write down how your team works: meeting notes, plans, requirements. Start with a blank page or a template.
      </p>
      <ButtonCore variant="primary" leftIcon={<Plus size={16} />} onClick={() => openCreate()}>
        Create the first page
      </ButtonCore>
    </div>
  );
}
