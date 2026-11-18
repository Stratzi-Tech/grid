'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorStatus, apiPut } from '../../lib/api/client';
import type { WikiPage } from './wikiUrls';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

interface Pending {
  title?: string;
  content?: string;
}

interface Options {
  pageId: number;
  /** The page's `updated_at` (or `created_at`) as loaded; the server compares it to detect conflicts. */
  baseVersion: string;
  onSaved: (page: WikiPage) => void;
}

const DEBOUNCE_MS = 1000;

/**
 * Saves wiki edits as the user types.
 *
 * Edits are batched for a second, sent one request at a time, and anything typed while a
 * save is in flight goes out right after it. Each save carries the version it started
 * from; if someone else saved in the meantime the server answers 409 and this stops
 * saving (state "conflict", edits kept) until the user chooses to reload or overwrite,
 * so nobody's work is silently replaced.
 *
 * Use one instance per page (key the screen by page id): the page id is fixed for the
 * life of the hook, so a flush on leaving can never write to the next page.
 */
export function useWikiAutosave({ pageId, baseVersion, onSaved }: Options) {
  const [state, setState] = useState<SaveState>('saved');
  const baseRef = useRef(baseVersion);
  const pendingRef = useRef<Pending | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<number | null>(null);
  const forceRef = useRef(false);
  const conflictRef = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const run = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;

    const loop = async () => {
      while (pendingRef.current && !conflictRef.current) {
        const batch = pendingRef.current;
        pendingRef.current = null;
        setState('saving');
        try {
          const saved = await apiPut<unknown, WikiPage>(`/wiki/${pageId}`, {
            ...batch,
            base_version: baseRef.current,
            ...(forceRef.current ? { force: true } : {}),
          });
          forceRef.current = false;
          baseRef.current = saved.updated_at ?? saved.created_at;
          onSavedRef.current(saved);
        } catch (error) {
          // Keep what failed, under anything typed since, so a retry loses nothing.
          pendingRef.current = { ...batch, ...(pendingRef.current ?? {}) };
          if (apiErrorStatus(error) === 409) {
            conflictRef.current = true;
            setState('conflict');
          } else {
            setState('error');
          }
          return;
        }
      }
      setState(conflictRef.current ? 'conflict' : pendingRef.current ? 'dirty' : 'saved');
    };

    const promise = loop().finally(() => {
      inFlightRef.current = null;
    });
    inFlightRef.current = promise;
    return promise;
  }, [pageId]);

  const schedule = useCallback(
    (fields: Pending) => {
      pendingRef.current = { ...(pendingRef.current ?? {}), ...fields };
      if (conflictRef.current) return;
      setState((current) => (current === 'saving' ? 'saving' : 'dirty'));
      clearTimer();
      timerRef.current = window.setTimeout(() => void run(), DEBOUNCE_MS);
    },
    [run],
  );

  /** Send anything waiting right now and resolve once it has landed (or failed). */
  const flushNow = useCallback(async () => {
    clearTimer();
    if (inFlightRef.current) await inFlightRef.current;
    await run();
  }, [run]);

  /** Try again after a failed save. */
  const retry = useCallback(() => {
    clearTimer();
    void run();
  }, [run]);

  /** After a conflict: save my version over theirs. */
  const overwrite = useCallback(() => {
    conflictRef.current = false;
    forceRef.current = true;
    void run();
  }, [run]);

  /** Start clean from a freshly loaded page (after a reload or a restore). */
  const reset = useCallback((version: string) => {
    clearTimer();
    baseRef.current = version;
    pendingRef.current = null;
    conflictRef.current = false;
    forceRef.current = false;
    setState('saved');
  }, []);

  // Leaving the page (or the app) with edits waiting: send them now.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void run();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      clearTimer();
      void run();
    };
  }, [run]);

  // Closing the tab mid-save: let the browser ask first.
  useEffect(() => {
    if (state === 'saved') return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [state]);

  return { state, schedule, flushNow, retry, overwrite, reset };
}
