'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Highlighter, Type } from 'lucide-react';
import { tokens } from '../../design-system/tokens';
import { ButtonCore } from '../ui';
import { HIGHLIGHT_COLORS, TEXT_COLORS } from './coloredText';

interface ColorPickerProps {
  /** The colour of the current selection, or null for the default. */
  textColor: string | null;
  highlightColor: string | null;
  disabled?: boolean;
  onTextColor: (color: string | null) => void;
  onHighlightColor: (color: string | null) => void;
  /** Hovering a swatch shows the colour on the selection without applying it; null ends the preview. */
  onPreview: (preview: { kind: 'text' | 'highlight'; color: string } | null) => void;
}

function Swatch({
  color,
  name,
  selected,
  onPick,
  onPreview,
  kind,
}: {
  color: string;
  name: string;
  selected: boolean;
  onPick: () => void;
  onPreview: (on: boolean) => void;
  kind: 'text' | 'highlight';
}) {
  return (
    <button
      type="button"
      title={name}
      aria-label={`${kind === 'text' ? 'Text' : 'Highlight'} ${name}`}
      aria-pressed={selected}
      onMouseDown={(event) => event.preventDefault()} // keep the text selected
      onMouseEnter={() => onPreview(true)}
      onMouseLeave={() => onPreview(false)}
      onClick={onPick}
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        cursor: 'pointer',
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `${selected ? 2 : 1}px solid ${selected ? tokens.colors.primary[500] : 'rgba(9,30,66,0.14)'}`,
        // A text swatch is the letter in that colour, a highlight swatch is the fill.
        background: kind === 'highlight' ? color : '#FFFFFF',
        color: kind === 'text' ? color : '#172B4D',
        fontSize: 14,
        fontWeight: 700,
        fontFamily: 'inherit',
      }}
    >
      {selected ? <Check size={13} /> : 'A'}
    </button>
  );
}

/** One toolbar button that opens text-colour and highlight palettes for the selection. */
export function ColorPicker({ textColor, highlightColor, disabled, onTextColor, onHighlightColor, onPreview }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Where the palette sits: above the button when there is no room below, nudged sideways
  // (dx) to stay inside the window, and made shorter (it scrolls) when neither side has room.
  // Measured when it opens and again when the window is resized.
  const [fit, setFit] = useState<{ above: boolean; dx: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setFit(null);
      return;
    }
    const measure = () => {
      const button = wrapRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!button || !panel) return;
      const margin = 8;
      const gap = 6;
      const height = panel.scrollHeight; // full height, even when already capped
      const spaceBelow = window.innerHeight - button.bottom - gap - margin;
      const spaceAbove = button.top - gap - margin;
      const above = height > spaceBelow && spaceAbove > spaceBelow;
      const left = Math.max(margin, Math.min(button.left, window.innerWidth - panel.offsetWidth - margin));
      setFit({ above, dx: left - button.left, maxHeight: Math.max(0, above ? spaceAbove : spaceBelow) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      onPreview(null); // never leave a preview showing once the palette is gone
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const sectionTitle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: tokens.colors.neutral[600],
    margin: '0 0 6px',
  };

  const resetButton = (label: string, onClick: () => void) => (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      style={{
        marginTop: 6,
        padding: '2px 0',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        fontSize: 12,
        color: tokens.colors.primary[600],
        fontFamily: 'inherit',
        textDecoration: 'underline',
      }}
    >
      {label}
    </button>
  );

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <ButtonCore
        size="sm"
        variant={open ? 'secondary' : 'ghost'}
        title={disabled ? 'Colour is not available inside inline code' : 'Text colour and highlight'}
        aria-label="Text colour and highlight"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        style={{ padding: '0 6px', gap: 2 }}
      >
        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1 }}>
          <Type size={15} />
          <span
            style={{
              width: 14,
              height: 3,
              borderRadius: 1,
              marginTop: 1,
              background: highlightColor ?? textColor ?? 'transparent',
              border: highlightColor || textColor ? 'none' : `1px solid ${tokens.colors.neutral[300]}`,
            }}
          />
        </span>
        <ChevronDown size={12} />
      </ButtonCore>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Colours"
          onMouseDown={(event) => event.stopPropagation()}
          style={{
            position: 'absolute',
            ...(fit?.above ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }),
            left: fit?.dx ?? 0,
            visibility: fit ? 'visible' : 'hidden', // measured before it is shown, so it never jumps
            maxWidth: 'calc(100vw - 16px)',
            maxHeight: fit?.maxHeight,
            overflowY: 'auto',
            zIndex: 1100,
            width: 244,
            padding: 12,
            background: '#FFFFFF',
            border: `1px solid ${tokens.colors.neutral[200]}`,
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(9,30,66,0.18)',
            fontFamily: tokens.fontFamily.sans,
          }}
        >
          <p style={sectionTitle}>Text colour</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {TEXT_COLORS.map((c) => (
              <Swatch
                key={c.value}
                kind="text"
                color={c.value}
                name={c.name}
                selected={textColor?.toLowerCase() === c.value.toLowerCase()}
                onPreview={(on) => onPreview(on ? { kind: 'text', color: c.value } : null)}
                onPick={() => {
                  onPreview(null);
                  onTextColor(c.value);
                }}
              />
            ))}
          </div>
          {resetButton('Default text colour', () => onTextColor(null))}

          <p style={{ ...sectionTitle, marginTop: 12 }}>
            <Highlighter size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
            Highlight
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {HIGHLIGHT_COLORS.map((c) => (
              <Swatch
                key={c.value}
                kind="highlight"
                color={c.value}
                name={c.name}
                selected={highlightColor?.toLowerCase() === c.value.toLowerCase()}
                onPreview={(on) => onPreview(on ? { kind: 'highlight', color: c.value } : null)}
                onPick={() => {
                  onPreview(null);
                  onHighlightColor(c.value);
                }}
              />
            ))}
          </div>
          {resetButton('No highlight', () => onHighlightColor(null))}
        </div>
      )}
    </div>
  );
}
