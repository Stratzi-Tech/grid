'use client';

import React, { useMemo } from 'react';
import { sanitizeHtml } from '../../lib/sanitize';
import { renderMentionText } from '../MentionTextarea';
import { highlightMentionsInHtml, looksLikeHtml } from './richText';
import './rich-editor.css';

interface RichContentProps {
  /** A saved description or comment: HTML from the editor, or older plain text. */
  value: string | null | undefined;
  className?: string;
  style?: React.CSSProperties;
  compact?: boolean;
}

/**
 * Shows saved ticket text without an editor behind it. HTML is cleaned first and drawn with
 * the same styles the editor uses, so what was written looks the same afterwards. Plain text
 * from before the rich editor keeps its line breaks, with @names and links as they were.
 */
export function RichContent({ value, className, style, compact }: RichContentProps) {
  const html = useMemo(
    () => (value && looksLikeHtml(value) ? highlightMentionsInHtml(sanitizeHtml(value)) : ''),
    [value],
  );

  if (!value) return null;
  const classes = `rich-prose${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`;

  if (!looksLikeHtml(value)) {
    return (
      <div className={classes} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...style }}>
        {renderMentionText(value)}
      </div>
    );
  }
  return <div className={classes} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}
