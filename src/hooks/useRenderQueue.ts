import { useCallback, useEffect, useRef, useState } from 'react';
import { QueueItem, createItemId } from '../lib/queue';
import {
  closeBitmap,
  ImageSource,
  isAbortError,
  renderFramePreview,
} from '../lib/renderFrame';
import { DeviceFrame } from './useFrames';

/**
 * Owns the batch of screenshots and renders them one at a time.
 *
 * Rendering is sequential on purpose: each render is synchronous canvas work on
 * the main thread, so running them concurrently would not be faster and would
 * make the UI janky for a large batch.
 *
 * The queue produces downscaled previews for the sheet; the full-resolution
 * render is deferred to export, so a large batch does not pay to encode pixels
 * that are only ever shown at thumbnail size.
 *
 * This hook owns the source object URLs it creates and revokes them on removal
 * and unmount.
 */
export function useRenderQueue(backgroundColor: string | null) {
  const [items, setItems] = useState<QueueItem[]>([]);

  // The worker reads live state through refs so it never restarts mid-batch.
  const itemsRef = useRef<QueueItem[]>([]);
  const backgroundRef = useRef(backgroundColor);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Which item `abortRef` belongs to. Aborting is only safe when that same item
   * is being re-queued — otherwise the in-flight render is cancelled and never
   * restarted, stranding it in 'rendering' forever.
   */
  const renderingIdRef = useRef<string | null>(null);
  /**
   * Bitmaps decoded during detection, waiting to be consumed by the render.
   * Detection already decodes every file to read its dimensions; reusing that
   * result halves the decode work, which dominates a large batch. Entries are
   * released as soon as they are used, and on removal or unmount.
   */
  const bitmapsRef = useRef(new Map<string, ImageSource>());

  itemsRef.current = items;

  /**
   * Every mutation goes through here so itemsRef tracks the latest list
   * synchronously. Detection callbacks resolve between renders and need to see
   * removals and manual frame changes that happened moments earlier; reading a
   * ref that only updates on render would miss them.
   */
  const updateItems = useCallback(
    (updater: (prev: QueueItem[]) => QueueItem[]) => {
      const next = updater(itemsRef.current);
      itemsRef.current = next;
      setItems(next);
    },
    []
  );

  const patchItem = useCallback(
    (id: string, patch: Partial<QueueItem>) => {
      // Previews are data URLs, which the GC reclaims — no revocation needed.
      updateItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
      );
    },
    [updateItems]
  );

  const drain = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;

    try {
      // Re-read from the ref each pass so items added or re-queued while the
      // loop is running get picked up without restarting the worker.
      for (;;) {
        const next = itemsRef.current.find(
          (item) => item.status === 'queued' && item.frame
        );
        if (!next?.frame) break;
        const frame = next.frame;

        const controller = new AbortController();
        abortRef.current = controller;
        renderingIdRef.current = next.id;
        patchItem(next.id, { status: 'rendering' });

        // Reuse detection's bitmap on the first render of an item; a device
        // change later has nothing cached and decodes again, which is fine
        // because it is a single image rather than the whole batch.
        const cached = bitmapsRef.current.get(next.id);
        bitmapsRef.current.delete(next.id);

        try {
          // Only a thumbnail is needed to fill a card; the full-resolution
          // render happens at export, so upload does not pay for pixels nobody
          // looks at.
          const previewUrl = await renderFramePreview(next.file, frame, {
            backgroundColor: backgroundRef.current,
            signal: controller.signal,
            source: cached,
          });
          patchItem(next.id, {
            status: 'done',
            previewUrl,
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
        } finally {
          closeBitmap(cached);
          if (renderingIdRef.current === next.id) renderingIdRef.current = null;
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

    // Safe to abort unconditionally here: every item with a frame is re-queued
    // below, including whichever one was mid-render.
    abortRef.current?.abort();
    updateItems((prev) =>
      prev.map((item) => {
        // Items still detecting, or with no matching device, have nothing to
        // re-render — forcing them to 'queued' would strand the progress bar.
        if (!item.frame) return item;
        return { ...item, status: 'queued', previewUrl: undefined, error: undefined };
      })
    );
  }, [backgroundColor, updateItems]);

  /**
   * Adds files as 'detecting' straight away so the sheet appears on the first
   * frame. Device detection has to decode each image, which is slow for large
   * screenshots — waiting for all of them before showing anything left the user
   * staring at the empty drop target.
   */
  const addFiles = useCallback(
    (files: File[]) => {
      const added = files.map((file) => ({
        id: createItemId(),
        file,
        status: 'detecting' as const,
        sourceUrl: URL.createObjectURL(file),
      }));
      updateItems((prev) => [...prev, ...added]);
      return added;
    },
    [updateItems]
  );

  /**
   * Records the outcome of detection for one item, handing over the bitmap it
   * decoded so the render does not decode the same file again.
   *
   * Detection is asynchronous, so by the time it finishes the item may have
   * been removed, or the user may have picked a device by hand. In both cases
   * the result is stale: applying it would resurrect a removed item's bitmap
   * (leaking its decoded pixels) or silently replace the manual choice with
   * the detected one.
   */
  const resolveDetection = useCallback(
    (id: string, frame: DeviceFrame | undefined, source?: ImageSource) => {
      const current = itemsRef.current.find((item) => item.id === id);
      if (!current || current.status !== 'detecting') {
        closeBitmap(source);
        return;
      }

      if (frame && source) {
        bitmapsRef.current.set(id, source);
      } else {
        // Nothing will consume it.
        closeBitmap(source);
      }
      patchItem(id, frame ? { frame, status: 'queued' } : { status: 'unmatched' });
    },
    [patchItem]
  );

  /** Reassigns the device for a set of items and re-queues them. */
  const setFrameFor = useCallback((ids: string[], frame: DeviceFrame) => {
    const idSet = new Set(ids);

    // Only abort when the in-flight render is itself being re-queued. Aborting
    // unconditionally cancels an unrelated item that nothing then restarts,
    // leaving it stuck in 'rendering'.
    const active = renderingIdRef.current;
    const activeItem = active
      ? itemsRef.current.find((item) => item.id === active)
      : undefined;
    if (activeItem && idSet.has(activeItem.id) && activeItem.frame?.id !== frame.id) {
      abortRef.current?.abort();
    }

    updateItems((prev) =>
      prev.map((item) => {
        if (!idSet.has(item.id) || item.frame?.id === frame.id) return item;
        return { ...item, frame, status: 'queued', previewUrl: undefined, error: undefined };
      })
    );
  }, [updateItems]);

  const removeItems = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids);
      ids.forEach((id) => {
        closeBitmap(bitmapsRef.current.get(id));
        bitmapsRef.current.delete(id);
      });
      updateItems((prev) =>
        prev.filter((item) => {
          if (!idSet.has(item.id)) return true;
          URL.revokeObjectURL(item.sourceUrl);
          return false;
        })
      );
    },
    [updateItems]
  );

  // Revoke everything still outstanding on unmount.
  useEffect(() => {
    const bitmaps = bitmapsRef.current;
    return () => {
      abortRef.current?.abort();
      itemsRef.current.forEach((item) => {
        URL.revokeObjectURL(item.sourceUrl);
      });
      bitmaps.forEach(closeBitmap);
      bitmaps.clear();
    };
  }, []);

  const doneCount = items.filter((item) => item.status === 'done').length;
  // 'unmatched' items never render, so they must not keep the progress bar
  // spinning forever.
  const isRendering = items.some(
    (item) =>
      item.status === 'detecting' ||
      item.status === 'queued' ||
      item.status === 'rendering'
  );
  /** Items that will eventually produce output, for the progress denominator. */
  const renderableCount = items.filter((item) => item.status !== 'unmatched').length;

  return {
    items,
    addFiles,
    resolveDetection,
    setFrameFor,
    removeItems,
    doneCount,
    renderableCount,
    isRendering,
  };
}
