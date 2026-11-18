'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { tokens } from '../../../../../design-system/tokens';
import { WikiProvider, useWiki } from '../../../../../components/wiki/WikiContext';
import { WikiSidebar } from '../../../../../components/wiki/WikiSidebar';
import { parseWikiPageParam } from '../../../../../components/wiki/wikiUrls';

function WikiShell({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const { openCreate } = useWiki();
  const activeId = parseWikiPageParam(params.page);

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#FFFFFF', color: tokens.colors.neutral[900] }}>
      <WikiSidebar activeId={activeId} onCreate={(parentId) => openCreate(parentId)} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  );
}

/**
 * The wiki's frame: sidebar plus the page. The sidebar and page data live here, above the
 * [page] route, so moving from one page to the next does not reload or flash them.
 */
export default function WikiLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const projectId = parseInt(params.id as string, 10);

  return (
    <WikiProvider projectId={projectId}>
      <WikiShell>{children}</WikiShell>
    </WikiProvider>
  );
}
