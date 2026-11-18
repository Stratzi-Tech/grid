export interface WikiPage {
  id: number;
  slug: string;
  title: string;
  content: string;
  project_id: number;
  parent_id: number | null;
  author_email?: string | null;
  author_name: string;
  updated_by_name: string | null;
  created_at: string;
  updated_at: string | null;
  children?: WikiPage[];
}

/**
 * A page lives at /projects/9/wiki/12-meeting-notes. The id is what identifies it; the
 * slug is only there so the link reads well, so a renamed page keeps working at the old URL.
 */
export function wikiPageHref(projectId: number | string, page: Pick<WikiPage, 'id' | 'slug'>): string {
  return `/projects/${projectId}/wiki/${page.id}-${page.slug}`;
}

/** The page id from the [page] route segment ("12-meeting-notes" or "12"), or null. */
export function parseWikiPageParam(param: string | string[] | undefined): number | null {
  const raw = Array.isArray(param) ? param[0] : param;
  const match = raw?.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}
