'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { tokens } from '../../design-system/tokens';
import { ButtonCore, Input } from '../ui';
import { BLANK_TEMPLATE, WIKI_TEMPLATES, WikiTemplate } from './wikiTemplates';

interface CreatePageDialogProps {
  isOpen: boolean;
  /** Set when the page is being created under another page. */
  parentTitle?: string;
  onClose: () => void;
  onCreate: (title: string, template: WikiTemplate) => Promise<void>;
}

/** One step: name the page, optionally pick a starting point, create. */
export function CreatePageDialog({ isOpen, parentTitle, onClose, onCreate }: CreatePageDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState<WikiTemplate>(BLANK_TEMPLATE);
  const [busy, setBusy] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setTemplate(BLANK_TEMPLATE);
      setBusy(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, busy, onClose]);

  if (!mounted || !isOpen) return null;

  const canCreate = !busy;

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      await onCreate(title.trim(), template);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100020,
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
        aria-labelledby="create-wiki-page-title"
        style={{
          width: 560,
          maxWidth: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: '#FFFFFF',
          borderRadius: 8,
          boxShadow: '0 8px 24px rgba(9,30,66,0.35)',
          padding: 24,
          fontFamily: tokens.fontFamily.sans,
        }}
      >
        <h2 id="create-wiki-page-title" style={{ margin: 0, fontSize: 20, fontWeight: 600, color: tokens.colors.neutral[900] }}>
          {parentTitle ? 'Add a sub-page' : 'Create a page'}
        </h2>
        {parentTitle && (
          <p style={{ margin: '4px 0 0', fontSize: 13, color: tokens.colors.neutral[600] }}>
            It will sit under “{parentTitle}”.
          </p>
        )}

        <div style={{ marginTop: 20 }}>
          <Input
            label="Title (optional)"
            autoFocus
            value={title}
            placeholder="Untitled"
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>

        <div style={{ marginTop: 20, fontSize: 13, fontWeight: 600, color: tokens.colors.neutral[700] }}>Start from</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 8 }}>
          {WIKI_TEMPLATES.map((item) => {
            const Icon = item.icon;
            const selected = item.id === template.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTemplate(item)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  textAlign: 'left',
                  padding: 12,
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: selected ? tokens.colors.primary[50] : '#FFFFFF',
                  border: `1.5px solid ${selected ? tokens.colors.primary[500] : tokens.colors.neutral[200]}`,
                  fontFamily: 'inherit',
                }}
              >
                <Icon size={18} color={selected ? tokens.colors.primary[600] : tokens.colors.neutral[600]} style={{ marginTop: 1, flexShrink: 0 }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.neutral[900] }}>{item.title}</span>
                  <span style={{ fontSize: 12, color: tokens.colors.neutral[600] }}>{item.description}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 24 }}>
          <ButtonCore variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </ButtonCore>
          <ButtonCore variant="primary" onClick={() => void submit()} disabled={!canCreate} loading={busy}>
            Create page
          </ButtonCore>
        </div>
      </div>
    </div>,
    document.body,
  );
}
