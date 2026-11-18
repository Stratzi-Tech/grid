'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Upload, File, Trash2, Download, Paperclip } from 'lucide-react';
import { tokens } from '../design-system/tokens';
import { ButtonCore, ConfirmDialog, useToast } from './ui';
import { wikiAPI, WikiAttachment } from '../lib/api/wiki';

interface WikiFileManagerProps {
  pageSlug: string;
  projectId: number;
  readOnly?: boolean;
}

const WikiFileManager: React.FC<WikiFileManagerProps> = ({ pageSlug, projectId, readOnly = false }) => {
  const [attachments, setAttachments] = useState<WikiAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WikiAttachment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchAttachments();
  }, [pageSlug, projectId]);

  const fetchAttachments = async () => {
    try {
      setLoading(true);
      const data = await wikiAPI.listAttachments(pageSlug, projectId);
      setAttachments(data);
    } catch (err) {
      console.error('Failed to fetch attachments:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    await uploadFile(file);
  };

  const uploadFile = async (file: File) => {
    try {
      setUploading(true);
      setError(null);

      const attachment = await wikiAPI.uploadAttachment(file, pageSlug, projectId);
      setAttachments([...attachments, attachment]);

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (err: any) {
      console.error('Failed to upload file:', err);
      setError(err.message || 'Failed to upload file');
    } finally {
      setUploading(false);
    }
  };

  const confirmAndDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await wikiAPI.deleteAttachment(pendingDelete.id);
      setAttachments((current) => current.filter((a) => a.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the file');
    } finally {
      setDeleting(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${tokens.colors.neutral[200]}`,
        borderRadius: 8,
        padding: 16,
        marginTop: 16,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Paperclip size={18} color={tokens.colors.neutral[600]} />
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: tokens.colors.neutral[900] }}>
            Attachments
          </h3>
          <span style={{ fontSize: 12, color: tokens.colors.neutral[500] }}>
            ({attachments.length})
          </span>
        </div>

        {!readOnly && (
          <ButtonCore
            variant="primary"
            size="sm"
            leftIcon={<Upload size={14} />}
            loading={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? 'Uploading...' : 'Upload file'}
          </ButtonCore>
        )}

        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
      </div>

      {error && (
        <div
          style={{
            padding: 12,
            background: tokens.colors.error[50],
            border: `1px solid ${tokens.colors.error[200]}`,
            borderRadius: 6,
            marginBottom: 12,
            fontSize: 13,
            color: tokens.colors.error[700],
          }}
        >
          {error}
        </div>
      )}

      {/* Attachments List */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 20, color: tokens.colors.neutral[500] }}>
          Loading attachments...
        </div>
      ) : attachments.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 20, color: tokens.colors.neutral[500], fontSize: 13 }}>
          No files attached yet
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: 12,
                background: tokens.colors.neutral[50],
                border: `1px solid ${tokens.colors.neutral[200]}`,
                borderRadius: 6,
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = tokens.colors.neutral[100];
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = tokens.colors.neutral[50];
              }}
            >
              <File size={18} color={tokens.colors.neutral[600]} />

              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: tokens.colors.neutral[900] }}>
                  {attachment.filename}
                </div>
                <div style={{ fontSize: 12, color: tokens.colors.neutral[500], marginTop: 2 }}>
                  {formatFileSize(attachment.file_size)} • Uploaded by {attachment.uploaded_by_name}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <a
                  href={wikiAPI.attachmentDownloadUrl(attachment.id)}
                  download={attachment.filename}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: 6,
                    color: tokens.colors.primary[600],
                    textDecoration: 'none',
                  }}
                  title="Download"
                  aria-label={`Download ${attachment.filename}`}
                >
                  <Download size={16} />
                </a>

                {!readOnly && (
                  <ButtonCore
                    variant="ghost"
                    size="sm"
                    title="Delete file"
                    aria-label={`Delete ${attachment.filename}`}
                    onClick={() => setPendingDelete(attachment)}
                    style={{ padding: '0 8px', color: tokens.colors.error[600] }}
                  >
                    <Trash2 size={16} />
                  </ButtonCore>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title={`Delete “${pendingDelete?.filename ?? ''}”?`}
        confirmLabel="Delete file"
        destructive
        busy={deleting}
        onConfirm={() => void confirmAndDelete()}
        onCancel={() => !deleting && setPendingDelete(null)}
      >
        This will permanently delete the file. This can’t be undone.
      </ConfirmDialog>
    </div>
  );
};

export default WikiFileManager;
