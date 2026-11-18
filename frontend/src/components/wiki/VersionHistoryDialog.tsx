'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { History } from 'lucide-react';
import { apiGet, apiPost } from '../../lib/api/client';
import { tokens } from '../../design-system/tokens';
import { ButtonCore, ConfirmDialog, useToast } from '../ui';
import { RichEditor } from '../editor/RichEditor';
import type { WikiPage } from './wikiUrls';

interface VersionSummary {
  id: number;
  saved_at: string;
  saved_by_name: string | null;
  title: string;
}

interface VersionDetail extends VersionSummary {
  content: string;
}

interface VersionHistoryDialogProps {
  pageId: number;
  isOpen: boolean;
  onClose: () => void;
  onRestored: (page: WikiPage) => void;
}

/** Browse a page's earlier versions, preview one, and restore it. */
export function VersionHistoryDialog({ pageId, isOpen, onClose, onRestored }: VersionHistoryDialogProps) {
  const toast = useToast();
  const [mounted, setMounted] = useState(false);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<VersionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setVersions(null);
    setDetail(null);
    setSelectedId(null);
    apiGet<VersionSummary[]>(`/wiki/${pageId}/versions`)
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
        if (list.length) setSelectedId(list[0].id);
      })
      .catch(() => {
        if (!cancelled) {
          setVersions([]);
          toast.error('Could not load the version history');
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, pageId]);

  useEffect(() => {
    if (!isOpen || selectedId == null) return;
    let cancelled = false;
    setLoadingDetail(true);
    apiGet<VersionDetail>(`/wiki/${pageId}/versions/${selectedId}`)
      .then((loaded) => {
        if (!cancelled) setDetail(loaded);
      })
      .catch(() => {
        if (!cancelled) toast.error('Could not load that version');
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, pageId, selectedId]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !confirmRestore && !restoring) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, confirmRestore, restoring, onClose]);

  if (!mounted || !isOpen) return null;

  const restore = async () => {
    if (selectedId == null) return;
    setRestoring(true);
    try {
      const page = await apiPost<unknown, WikiPage>(`/wiki/${pageId}/versions/${selectedId}/restore`, {});
      setConfirmRestore(false);
      toast.success('Version restored');
      onRestored(page);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not restore that version');
    } finally {
      setRestoring(false);
    }
  };

  const isLatest = versions != null && versions.length > 0 && selectedId === versions[0].id;

  return createPortal(
    <>
      <div
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !restoring) onClose();
        }}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 100010,
          background: 'rgba(9,30,66,0.54)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Version history"
          style={{
            width: 960,
            maxWidth: '100%',
            height: '80vh',
            display: 'flex',
            flexDirection: 'column',
            background: '#FFFFFF',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(9,30,66,0.35)',
            fontFamily: tokens.fontFamily.sans,
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '16px 20px 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <History size={18} color={tokens.colors.neutral[700]} />
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: tokens.colors.neutral[900] }}>Version history</h2>
          </div>
          <div style={{ padding: '0 20px 12px', borderBottom: `1px solid ${tokens.colors.neutral[200]}`, fontSize: 13, color: tokens.colors.neutral[600] }}>
            {/* Keep "2 minutes" in step with COALESCE_WINDOW in backend/app/routes/wiki.py. */}
            Changes you make within 2 minutes are saved together as one version. The last 50 versions are kept.
          </div>

          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <div style={{ width: 260, flexShrink: 0, borderRight: `1px solid ${tokens.colors.neutral[200]}`, overflowY: 'auto', padding: 8 }}>
              {versions === null ? (
                <p style={{ padding: 12, fontSize: 13, color: tokens.colors.neutral[600] }}>Loading…</p>
              ) : versions.length === 0 ? (
                <p style={{ padding: 12, fontSize: 13, color: tokens.colors.neutral[600] }}>
                  No earlier versions yet. They appear once the page has been edited.
                </p>
              ) : (
                versions.map((version, index) => {
                  const selected = version.id === selectedId;
                  return (
                    <button
                      key={version.id}
                      type="button"
                      onClick={() => setSelectedId(version.id)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        marginBottom: 2,
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        background: selected ? tokens.colors.primary[50] : 'transparent',
                        border: `1px solid ${selected ? tokens.colors.primary[200] : 'transparent'}`,
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.neutral[900] }}>
                        {new Date(version.saved_at).toLocaleString()}
                        {index === 0 && (
                          <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: tokens.colors.primary[700] }}>Current</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: tokens.colors.neutral[600] }}>{version.saved_by_name || 'Unknown'}</div>
                    </button>
                  );
                })
              )}
            </div>

            <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '24px 32px' }}>
              {loadingDetail && !detail ? (
                <p style={{ fontSize: 13, color: tokens.colors.neutral[600] }}>Loading…</p>
              ) : detail ? (
                <>
                  <h1 style={{ margin: '0 0 20px', fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', color: tokens.colors.neutral[900] }}>
                    {detail.title}
                  </h1>
                  <RichEditor key={`${detail.id}`} value={detail.content} editable={false} />
                </>
              ) : null}
            </div>
          </div>

          <div style={{ padding: '12px 20px', borderTop: `1px solid ${tokens.colors.neutral[200]}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <ButtonCore variant="secondary" onClick={onClose} disabled={restoring}>Close</ButtonCore>
            <ButtonCore variant="primary" onClick={() => setConfirmRestore(true)} disabled={!detail || isLatest || restoring}>
              Restore this version
            </ButtonCore>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmRestore}
        title="Restore this version?"
        confirmLabel="Restore"
        busy={restoring}
        onConfirm={() => void restore()}
        onCancel={() => !restoring && setConfirmRestore(false)}
      >
        The page will go back to how it looked on {detail ? new Date(detail.saved_at).toLocaleString() : 'that date'}. What is
        there now is kept in the history, so you can switch back.
      </ConfirmDialog>
    </>,
    document.body,
  );
}
