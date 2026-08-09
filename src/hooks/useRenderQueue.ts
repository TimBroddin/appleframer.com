import { useCallback, useEffect, useRef, useState } from 'react';
import { QueueItem, createItemId } from '../lib/queue';
import { isAbortError, renderFrameToBlob } from '../lib/renderFrame';
import { DeviceFrame } from './useFrames';

/**
 * Owns the batch of screenshots and renders them one at a time.
 *
 * Rendering is sequential on purpose: each render is synchronous canvas work on
 * the main thread, so running them concurrently would not be faster and would
 * make the UI janky for a large batch.
 *
 * This hook owns every object URL it creates and revokes them on replace and on
 * unmount.
 */
export function useRenderQueue(backgroundColor: string | null) {
  const [items, setItems] = useState<QueueItem[]>([]);

  // The worker reads live state through refs so it never restarts mid-batch.
  const itemsRef = useRef<QueueItem[]>([]);
  const backgroundRef = useRef(backgroundColor);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  itemsRef.current = items;

  const patchItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        // Replacing a rendered blob means the old URL leaks unless revoked.
        if (patch.blobUrl !== undefined && item.blobUrl && item.blobUrl !== patch.blobUrl) {
          URL.revokeObjectURL(item.blobUrl);
        }
        return { ...item, ...patch };
      })
    );
  }, []);

  const drain = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;

    try {
      // Re-read from the ref each pass so items added or re-queued while the
      // loop is running get picked up without restarting the worker.
      for (;;) {
        const next = itemsRef.current.find((item) => item.status === 'queued');
        if (!next) break;

        const controller = new AbortController();
        abortRef.current = controller;
        patchItem(next.id, { status: 'rendering' });

        try {
          const blob = await renderFrameToBlob(next.file, next.frame, {
            backgroundColor: backgroundRef.current,
            signal: controller.signal,
          });
          patchItem(next.id, {
            status: 'done',
            blobUrl: URL.createObjectURL(blob),
            error: undefined,
          });
        } catch (error) {
          if (isAbortError(error)) {
            // Superseded by a settings change; it was already re-queued.
            continue;
          }
          patchItem(next.id, {
            status: 'error',
            error: error instanceof Error ? error.message : 'Render failed',
          });
        }
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
    }
  }, [patchItem]);

  // Kick the worker whenever something is waiting.
  useEffect(() => {
    if (items.some((item) => item.status === 'queued')) {
      void drain();
    }
  }, [items, drain]);

  /** Re-render everything when the shared background colour changes. */
  useEffect(() => {
    const previous = backgroundRef.current;
    backgroundRef.current = backgroundColor;
    if (previous === backgroundColor) return;

    abortRef.current?.abort();
    setItems((prev) =>
      prev.map((item) => {
        if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
        return { ...item, status: 'queued', blobUrl: undefined, error: undefined };
      })
    );
  }, [backgroundColor]);

  const addFiles = useCallback((entries: Array<{ file: File; frame: DeviceFrame }>) => {
    const added = entries.map(({ file, frame }) => ({
      id: createItemId(),
      file,
      frame,
      status: 'queued' as const,
      sourceUrl: URL.createObjectURL(file),
    }));
    setItems((prev) => [...prev, ...added]);
    return added.map((item) => item.id);
  }, []);

  /** Reassigns the device for a set of items and re-queues them. */
  const setFrameFor = useCallback((ids: string[], frame: DeviceFrame) => {
    const idSet = new Set(ids);
    abortRef.current?.abort();
    setItems((prev) =>
      prev.map((item) => {
        if (!idSet.has(item.id) || item.frame.id === frame.id) return item;
        if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
        return { ...item, frame, status: 'queued', blobUrl: undefined, error: undefined };
      })
    );
  }, []);

  const removeItems = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setItems((prev) =>
      prev.filter((item) => {
        if (!idSet.has(item.id)) return true;
        if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
        URL.revokeObjectURL(item.sourceUrl);
        return false;
      })
    );
  }, []);

  // Revoke everything still outstanding on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      itemsRef.current.forEach((item) => {
        if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
        URL.revokeObjectURL(item.sourceUrl);
      });
    };
  }, []);

  const doneCount = items.filter((item) => item.status === 'done').length;
  const isRendering = items.some(
    (item) => item.status === 'queued' || item.status === 'rendering'
  );

  return { items, addFiles, setFrameFor, removeItems, doneCount, isRendering };
}
