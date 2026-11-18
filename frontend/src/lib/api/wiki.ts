import { API_BASE_URL, apiDelete, apiGet, apiPost } from './client';

export interface WikiAttachment {
  id: number;
  page_slug: string;
  project_id: number;
  filename: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  uploaded_by: number;
  uploaded_by_name: string;
  created_at: string;
}

export const wikiAPI = {
  /** Upload a file to a wiki page. Stored in the configured storage backend (local or cloud). */
  uploadAttachment(file: File, pageSlug: string, projectId: number): Promise<WikiAttachment> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('page_slug', pageSlug);
    formData.append('project_id', projectId.toString());
    return apiPost<FormData, WikiAttachment>('/wiki/attachments/upload', formData);
  },

  listAttachments(pageSlug: string, projectId: number): Promise<WikiAttachment[]> {
    return apiGet<WikiAttachment[]>(
      `/wiki/attachments/${encodeURIComponent(pageSlug)}?project_id=${projectId}`,
    );
  },

  deleteAttachment(attachmentId: number): Promise<void> {
    return apiDelete(`/wiki/attachments/${attachmentId}`);
  },

  /** URL that streams the file as a download; the session cookie authorises it. */
  attachmentDownloadUrl(attachmentId: number): string {
    return `${API_BASE_URL}/wiki/attachments/${attachmentId}/download`;
  },
};
