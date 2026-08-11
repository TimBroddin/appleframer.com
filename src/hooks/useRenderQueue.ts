import { useCallback, useEffect, useRef, useState } from 'react';
import { QueueItem, createItemId, isVideoFile } from '../lib/queue';
import {
  closeBitmap,
  ImageSource,
  isAbortError,
  renderFramePreview,
} from '../lib/renderFrame';
import { renderVideoToBlob } from '../lib/renderVideo';
import { isVideoSupported, VIDEO_UNSUPPORTED_MESSAGE } from '../lib/videoSupport';
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
 * Videos take the same path with one branch: they are encoded rather than
 * composited to a still, which takes orders of magnitude longer. Sequential
 * processing is what already limits this to one encode at a time, so no
 * separate scheduler is needed.
 *
 * This hook owns the source object URLs it creates and revokes them on removal
 * and unmount, and the same for the encoded video URLs it produces.
 *
 * @param onAudioDropped told when a video's audio could not be carried into the
 *   export, so the UI can say so — silently losing narration is exactly the
 *   data loss renderVideoToBlob reports in order to prevent.
 */
export function useRenderQueue(
  backgroundColor: string | null,
  onAudioDropped?: (item: QueueItem, reason: Error) => void
) {
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
  // Read through a ref for the same reason the background colour is: the drain
  // loop closes over it and must not restart mid-batch when the caller passes a
  // new function identity.
  const audioDroppedRef = useRef(onAudioDropped);
  audioDroppedRef.current = onAudioDropped;

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

  /**
   * Releases an item's encoded video, if it has one.
   *
   * videoUrl is an object URL, so the blob behind it — a whole encoded MP4,
   * which for a minute of 1080p is tens of megabytes — stays alive for the
   * lifetime of the document until this is called. Unlike previewUrl, which is
   * a data URL the GC reclaims, dropping the reference is not enough.
   */
  const revokeVideo = useCallback((item: QueueItem | undefined) => {
    if (item?.videoUrl) URL.revokeObjectURL(item.videoUrl);
  }, []);

  /**
   * Every re-queue and every re-encode goes through here, so revoking a
   * superseded videoUrl in this one place covers all of them: a background
   * change, a device change, an encode failure, and a second encode replacing
   * the first. Doing it at each call site instead would need every future
   * caller to remember, and the leak is invisible until the tab runs out of
   * memory.
   */
  const patchItem = useCallback(
    (id: string, patch: Partial<QueueItem>) => {
      // Previews are data URLs, which the GC reclaims — no revocation needed.
      updateItems((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item;
          // Only when the patch actually replaces or clears it. A progress
          // patch during an encode leaves videoUrl untouched and must not
          // revoke the URL an earlier encode is still displaying.
          if ('videoUrl' in patch && patch.videoUrl !== item.videoUrl) {
            revokeVideo(item);
          }
          return { ...item, ...patch };
        })
      );
    },
    [updateItems, revokeVideo]
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

        // A video is encoded rather than composited to a still. The branch is
        // all that is needed for "one video at a time": this loop already
        // processes a single item before looking for the next.
        if (isVideoFile(next.file)) {
          // Clearing videoUrl here rather than only on success is what releases
          // a previous encode's blob at the moment it stops being displayable.
          // Waiting until the new one lands would hold both for the length of
          // an encode, which for a long video is the whole point of revoking.
          patchItem(next.id, { status: 'encoding', videoUrl: undefined });
          try {
            const blob = await renderVideoToBlob(next.file, frame, {
              backgroundColor: backgroundRef.current,
              signal: controller.signal,
              onProgress: (progress) => {
                // Re-read the item rather than closing over `next`: the video
                // metadata was written by detection and `next` is a snapshot
                // that may predate a later patch.
                const live = itemsRef.current.find((item) => item.id === next.id);
                patchItem(next.id, {
                  video: {
                    duration: live?.video?.duration ?? 0,
                    frameCount: live?.video?.frameCount ?? 0,
                    progress,
                  },
                });
              },
              // The framed still stands in for the video everywhere a card,
              // the inspector and the zoom overlay expect a previewUrl, so
              // none of them need to know a video is being encoded.
              onFirstFrame: (previewUrl) => patchItem(next.id, { previewUrl }),
              onAudioDropped: (reason) => {
                const live = itemsRef.current.find((item) => item.id === next.id);
                if (live) audioDroppedRef.current?.(live, reason);
              },
            });
            // Removal and re-queue both abort the encode, but aborting is
            // cooperative: an encode that resolves in the same turn as either
            // one still lands here with a Blob nobody asked for any more. If
            // the item is gone, patchItem is a no-op on a list that no longer
            // contains it, and the object URL — a whole encoded MP4 — is
            // stranded with nothing left to revoke it. If it was re-queued,
            // writing 'done' would both strand it out of the queue and publish
            // a video rendered at the previous background or device.
            //
            // So the URL is only minted once there is an owner for it. The
            // re-queued case needs no cleanup here: the queue will encode it
            // again with the settings it now has.
            const settled = itemsRef.current.find((item) => item.id === next.id);
            if (!settled || settled.status !== 'encoding') continue;
            patchItem(next.id, {
              status: 'done',
              videoUrl: URL.createObjectURL(blob),
              error: undefined,
            });
          } catch (error) {
            // An abort means the item was already re-queued or removed; either
            // way there is nothing to report. The status check covers the same
            // same-turn race as the success path: a failure that arrives just
            // after a re-queue must not overwrite 'queued' with 'error' and
            // strand an item the queue was about to retry.
            const settled = itemsRef.current.find((item) => item.id === next.id);
            if (!isAbortError(error) && settled?.status === 'encoding') {
              patchItem(next.id, {
                status: 'error',
                error: error instanceof Error ? error.message : 'Encode failed',
              });
            }
          } finally {
            if (renderingIdRef.current === next.id) renderingIdRef.current = null;
          }
          continue;
        }

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
        // The encode about to be redone at the new background colour makes the
        // old MP4 unreachable, and nothing else will ever revoke it.
        revokeVideo(item);
        return {
          ...item,
          status: 'queued',
          previewUrl: undefined,
          videoUrl: undefined,
          error: undefined,
        };
      })
    );
  }, [backgroundColor, updateItems, revokeVideo]);

  /**
   * Adds files as 'detecting' straight away so the sheet appears on the first
   * frame. Device detection has to decode each image, which is slow for large
   * screenshots — waiting for all of them before showing anything left the user
   * staring at the empty drop target.
   *
   * A video on a browser without WebCodecs is added as 'error' instead. It
   * cannot be detected (probing is fine, but nothing could ever encode it), and
   * leaving it 'detecting' or 'queued' would park it in a state the drain loop
   * never picks up, showing a spinner that never resolves.
   */
  const addFiles = useCallback(
    (files: File[]) => {
      // Asked once per drop rather than per file: it is a property of the
      // browser, and the answer cannot change mid-batch.
      const videoUsable = isVideoSupported();
      const added: QueueItem[] = files.map((file) => {
        const unsupported = isVideoFile(file) && !videoUsable;
        return {
          id: createItemId(),
          file,
          status: unsupported ? ('error' as const) : ('detecting' as const),
          error: unsupported ? VIDEO_UNSUPPORTED_MESSAGE : undefined,
          sourceUrl: URL.createObjectURL(file),
        };
      });
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
   *
   * A video passes no bitmap — there is nothing decoded to hand over — and
   * carries its duration and frame count instead, which is what gives the
   * encode's progress bar a denominator.
   */
  const resolveDetection = useCallback(
    (
      id: string,
      frame: DeviceFrame | undefined,
      source?: ImageSource,
      video?: { duration: number; frameCount: number }
    ) => {
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
      // Attached even when nothing matched, so a video the user then assigns a
      // device to by hand already has its progress denominator rather than
      // having to be probed a second time.
      const videoPatch = video ? { video: { ...video, progress: 0 } } : {};
      patchItem(
        id,
        frame
          ? { frame, status: 'queued', ...videoPatch }
          : { status: 'unmatched', ...videoPatch }
      );
    },
    [patchItem]
  );

  /**
   * Records that detection could not read the file at all.
   *
   * Separate from resolveDetection because the two are different answers, not
   * degrees of the same one. 'unmatched' means the file was read and its
   * dimensions matched no device — the remedy is to pick one in the inspector.
   * A file that could not be read has no dimensions to match, so offering that
   * remedy sends the user to assign a device that only queues another failed
   * read. Landing in 'error' with the reason says what actually happened.
   *
   * Same staleness guard as resolveDetection: the item may have been removed or
   * had a device picked by hand while the probe or decode was in flight, and a
   * late failure must not overwrite either.
   */
  const failDetection = useCallback(
    (id: string, message: string) => {
      const current = itemsRef.current.find((item) => item.id === id);
      if (!current || current.status !== 'detecting') return;
      patchItem(id, { status: 'error', error: message });
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
        // Re-encoding into a different bezel discards the old MP4; revoked here
        // because this path re-queues without going through patchItem.
        revokeVideo(item);
        return {
          ...item,
          frame,
          status: 'queued',
          previewUrl: undefined,
          videoUrl: undefined,
          error: undefined,
        };
      })
    );
  }, [updateItems, revokeVideo]);

  const removeItems = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids);
      ids.forEach((id) => {
        closeBitmap(bitmapsRef.current.get(id));
        bitmapsRef.current.delete(id);
      });
      // Removing the item mid-encode must actually stop it, or the encoder runs
      // on holding hardware resources for output nothing will ever display.
      // Only when the removed item is the one in flight: aborting otherwise
      // cancels an unrelated render that nothing restarts.
      const active = renderingIdRef.current;
      if (active && idSet.has(active)) abortRef.current?.abort();

      updateItems((prev) =>
        prev.filter((item) => {
          if (!idSet.has(item.id)) return true;
          URL.revokeObjectURL(item.sourceUrl);
          revokeVideo(item);
          return false;
        })
      );
    },
    [updateItems, revokeVideo]
  );

  // Revoke everything still outstanding on unmount.
  useEffect(() => {
    const bitmaps = bitmapsRef.current;
    return () => {
      abortRef.current?.abort();
      itemsRef.current.forEach((item) => {
        URL.revokeObjectURL(item.sourceUrl);
        if (item.videoUrl) URL.revokeObjectURL(item.videoUrl);
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
      item.status === 'rendering' ||
      // An encode is the longest-running state there is; omitting it would drop
      // the progress bar the moment a video starts, which is exactly when it
      // matters most.
      item.status === 'encoding'
  );
  /** Items that will eventually produce output, for the progress denominator. */
  const renderableCount = items.filter((item) => item.status !== 'unmatched').length;

  return {
    items,
    addFiles,
    resolveDetection,
    failDetection,
    setFrameFor,
    removeItems,
    doneCount,
    renderableCount,
    isRendering,
  };
}
