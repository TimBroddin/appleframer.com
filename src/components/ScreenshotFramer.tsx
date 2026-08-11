import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import JSZip from 'jszip';
import { DeviceFrame } from '../hooks/useFrames';
import { useRenderQueue } from '../hooks/useRenderQueue';
import {
  displayOrder,
  findFrameByScreenshotSize,
  frameLabel,
  isFramableFile,
  isUnsupportedVideoFile,
  isVideoFile,
  FILE_ACCEPT_ATTRIBUTE,
  QueueItem,
  VIDEO_CONTAINER_UNSUPPORTED_MESSAGE,
} from '../lib/queue';
import { decodeFile, renderFrameToBlob } from '../lib/renderFrame';
import { probeVideo } from '../lib/renderVideo';
import { VIDEO_UNSUPPORTED_MESSAGE } from '../lib/videoSupport';
import {
  buildFilename,
  buildUniqueFilenames,
  deserializeTokens,
  NameToken,
  serializeTokens,
} from '../lib/filename';
import UploadZone from './UploadZone';
import ContactSheet from './ContactSheet';
import Inspector from './Inspector';
import SelectionBar from './SelectionBar';
import SinglePreview from './SinglePreview';
import ZoomOverlay from './ZoomOverlay';
import { ViewMode } from './Header';

interface ScreenshotFramerProps {
  frames: DeviceFrame[];
  isLoading: boolean;
  error: string | null;
  view: ViewMode;
  onSummaryChange: (summary: string | undefined) => void;
  onHasItemsChange: (hasItems: boolean) => void;
}

const ScreenshotFramer = ({
  frames,
  isLoading,
  error,
  view,
  onSummaryChange,
  onHasItemsChange,
}: ScreenshotFramerProps) => {
  const [backgroundColor, setBackgroundColor] = useState<string | null>(() => {
    const saved = localStorage.getItem('backgroundColor');
    return !saved || saved === 'transparent' ? null : saved;
  });
  const [tokens, setTokens] = useState<NameToken[]>(() =>
    deserializeTokens(localStorage.getItem('nameTokens'))
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupByDevice, setGroupByDevice] = useState(false);
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const addMoreInputRef = useRef<HTMLInputElement>(null);
  const lastClickedIdRef = useRef<string | null>(null);

  /**
   * A video whose audio could not be carried into the export.
   *
   * Surfaced rather than swallowed: a screen recording's narration disappearing
   * without a word is the data loss renderVideoToBlob reports this in order to
   * prevent. A warning rather than an error, because the framed video itself is
   * fine and still worth having.
   */
  const handleAudioDropped = useCallback((item: QueueItem, reason: Error) => {
    toast.warning(`${item.file.name}: ${reason.message}`);
  }, []);

  const {
    items,
    addFiles,
    resolveDetection,
    setFrameFor,
    removeItems,
    doneCount,
    renderableCount,
    isRendering,
  } = useRenderQueue(backgroundColor, handleAudioDropped);

  useEffect(() => {
    localStorage.setItem('backgroundColor', backgroundColor ?? 'transparent');
  }, [backgroundColor]);

  useEffect(() => {
    localStorage.setItem('nameTokens', serializeTokens(tokens));
  }, [tokens]);

  // Keep the header in sync without it needing to know about the queue.
  useEffect(() => {
    if (items.length === 0) {
      onSummaryChange(undefined);
      return;
    }
    const deviceCount = new Set(
      items.map((item) => item.frame?.id).filter(Boolean)
    ).size;
    onSummaryChange(
      `${items.length} shot${items.length === 1 ? '' : 's'} · ${deviceCount} device${
        deviceCount === 1 ? '' : 's'
      }`
    );
  }, [items, onSummaryChange]);

  useEffect(() => {
    onHasItemsChange(items.length > 0);
  }, [items.length, onHasItemsChange]);

  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      const usableFiles = files.filter(isFramableFile);

      // A video in a container this pipeline cannot demux — .webm above all —
      // is called out by name rather than being swept in with the .DS_Store and
      // PDFs the filter also drops. It looks like a perfectly good video to the
      // user, and until it was rejected here it would probe, match a device and
      // sit in the queue looking accepted before dying at encode.
      const unsupportedVideos = files.filter(isUnsupportedVideoFile);
      if (unsupportedVideos.length > 0) {
        toast.error(
          unsupportedVideos.length === 1
            ? VIDEO_CONTAINER_UNSUPPORTED_MESSAGE
            : `${unsupportedVideos.length} videos were skipped. ${VIDEO_CONTAINER_UNSUPPORTED_MESSAGE}`
        );
      }

      if (usableFiles.length === 0) {
        // Already explained above if the whole drop was unsupported video;
        // repeating a vaguer version of it would only muddy the first message.
        if (unsupportedVideos.length === 0) {
          toast.error('No image or video files found in that selection');
        }
        return;
      }
      if (frames.length === 0) return;

      // Show the cards immediately, then detect. Detection has to decode each
      // image, which is slow for large screenshots, so waiting for the whole
      // batch before rendering anything left the drop target on screen.
      const added = addFiles(usableFiles);
      setSelectedIds(new Set(added.map((item) => item.id)));

      // A video with no WebCodecs was refused at the door and is already in
      // 'error'; resolving detection for it would be answering a question the
      // queue has stopped asking.
      const pending = added.filter((item) => item.status === 'detecting');
      const refused = added.length - pending.length;
      if (refused > 0) {
        toast.error(
          refused === 1
            ? VIDEO_UNSUPPORTED_MESSAGE
            : `${refused} videos were skipped. ${VIDEO_UNSUPPORTED_MESSAGE}`
        );
      }

      // Decoding every file at once spikes memory and slows each decode down.
      const CONCURRENCY = 4;
      let cursor = 0;
      let matched = 0;
      const devices = new Set<string>();
      const unmatchedNames: string[] = [];

      const worker = async () => {
        for (;;) {
          const index = cursor++;
          if (index >= pending.length) return;
          const entry = pending[index];
          try {
            // A video's dimensions come from its metadata rather than a decode,
            // then feed the SAME size matching — an unmatched video lands in
            // 'unmatched' like an unmatched screenshot, and the user picks a
            // device in the inspector.
            //
            // Probing shares the image worker pool rather than running
            // serially: probeVideo only reads metadata through a <video>
            // element, so unlike a decode it holds no full-size bitmap, and
            // four of them in flight cost roughly nothing. Serialising them
            // would instead stall the whole pool behind one slow file.
            if (isVideoFile(entry.file)) {
              const info = await probeVideo(entry.file);
              const frame = findFrameByScreenshotSize(frames, info.width, info.height);
              // No bitmap: nothing was decoded, so there is nothing to hand
              // over and nothing for the queue to close.
              resolveDetection(entry.id, frame, undefined, {
                duration: info.duration,
                frameCount: info.frameCount,
              });
              if (frame) {
                matched++;
                devices.add(frameLabel(frame));
              } else {
                unmatchedNames.push(entry.file.name);
              }
              continue;
            }

            // The bitmap is handed to the queue rather than discarded, so the
            // render does not decode the same file a second time.
            const source = await decodeFile(entry.file);
            const frame = findFrameByScreenshotSize(frames, source.width, source.height);
            resolveDetection(entry.id, frame, source);
            if (frame) {
              matched++;
              devices.add(frameLabel(frame));
            } else {
              unmatchedNames.push(entry.file.name);
            }
          } catch {
            resolveDetection(entry.id, undefined);
            unmatchedNames.push(entry.file.name);
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker)
      );

      if (matched > 0) {
        toast.success(
          matched === 1
            ? `Matched ${Array.from(devices)[0]}`
            : `Matched ${matched} shots across ${devices.size} device${
                devices.size === 1 ? '' : 's'
              }`
        );
      }

      if (unmatchedNames.length > 0) {
        toast.warning(
          unmatchedNames.length === 1
            ? `No device matches ${unmatchedNames[0]}`
            : `${unmatchedNames.length} images had no matching device`
        );
      }
    },
    [frames, addFiles, resolveDetection]
  );

  // The empty state advertises clipboard paste, so it has to work.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void handleFilesSelected(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFilesSelected]);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds]
  );

  // Resolved from the live list so the overlay closes if its item is removed.
  const zoomedItem = useMemo(
    () => items.find((item) => item.id === zoomedId),
    [items, zoomedId]
  );

  /**
   * Items in the order they appear on screen. Grouping reorders the sheet, so
   * using the raw queue would make the arrows jump between groups.
   */
  const orderedItems = useMemo(
    () => displayOrder(items, groupByDevice),
    [items, groupByDevice]
  );

  // The zoom overlay only shows rendered images, so it skips the rest.
  const zoomableItems = useMemo(
    () => orderedItems.filter((item) => item.status === 'done' && item.previewUrl),
    [orderedItems]
  );

  // Read through a ref so the handler identity is stable: it is passed to every
  // memoised Card, and a new function each render would defeat the memo.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Read through a ref for the same reason as items: keeping the handler
  // identity stable is what lets the memoised cards skip re-rendering.
  const groupByDeviceRef = useRef(groupByDevice);
  groupByDeviceRef.current = groupByDevice;

  const handleToggleSelect = useCallback(
    (id: string, event: React.MouseEvent) => {
      // Range selection has to follow the order cards are displayed in, which
      // grouping changes. Slicing the raw array while grouped would select
      // cards from other groups and skip ones lying between the endpoints.
      const current = displayOrder(itemsRef.current, groupByDeviceRef.current);
      setSelectedIds((prev) => {
        // Shift extends from the last click; plain click replaces the selection,
        // which is what a contact sheet is expected to do.
        if (event.shiftKey && lastClickedIdRef.current) {
          const from = current.findIndex((item) => item.id === lastClickedIdRef.current);
          const to = current.findIndex((item) => item.id === id);
          if (from !== -1 && to !== -1) {
            const [start, end] = from < to ? [from, to] : [to, from];
            const next = new Set(prev);
            current.slice(start, end + 1).forEach((item) => next.add(item.id));
            return next;
          }
        }
        if (event.metaKey || event.ctrlKey) {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          lastClickedIdRef.current = id;
          return next;
        }
        lastClickedIdRef.current = id;
        // A plain click always selects. Toggling off here would leave nothing
        // selected and silently disable the whole inspector; use ⌘/Ctrl-click
        // to remove an image from a multi-selection.
        return new Set([id]);
      });
    },
    []
  );

  const handleSetFrame = useCallback(
    (frame: DeviceFrame) => {
      if (selectedIds.size === 0) return;
      setFrameFor(Array.from(selectedIds), frame);
    },
    [selectedIds, setFrameFor]
  );

  const handleSelectAll = useCallback(() => {
    const current = itemsRef.current;
    setSelectedIds((prev) =>
      prev.size === current.length ? new Set() : new Set(current.map((item) => item.id))
    );
  }, []);

  const handleRemoveSelected = useCallback(() => {
    removeItems(Array.from(selectedIds));
    setSelectedIds(new Set());
  }, [removeItems, selectedIds]);

  const namePreview = useMemo(() => {
    const sample = selectedItems[0] ?? items[0];
    if (!sample) return 'framed-screenshot';
    const index = items.findIndex((item) => item.id === sample.id);
    return buildFilename(tokens, sample.file.name, sample.frame, Math.max(index, 0));
  }, [tokens, selectedItems, items]);

  /**
   * Resolves once none of the given items are still detecting.
   *
   * Detection is what assigns the device, and it runs concurrently with the
   * user clicking Download. Polling the ref is enough here: detection always
   * terminates, either with a frame or as 'unmatched'.
   *
   * That termination guarantee is real but it is NOT local — it is bought by
   * every detection path being bounded. decodeFile settles on its own, and
   * probeVideo is bounded by PROBE_TIMEOUT_MS precisely because a <video>
   * element that stalls fires no event at all. Adding a deadline here as well
   * would be a second, weaker guard over the same property: it could only give
   * up and export an item whose device is still unknown, silently dropping it
   * from the archive the button already counted. Anything that could hang this
   * loop is a detection bug, and it belongs where detection is.
   */
  const waitForDetection = useCallback(async (ids: Set<string>) => {
    const stillDetecting = () =>
      itemsRef.current.some((item) => ids.has(item.id) && item.status === 'detecting');
    while (stillDetecting()) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }, []);

  const downloadZip = useCallback(
    async (target: QueueItem[], label: string) => {
      setIsDownloading(true);
      try {
        // Detection assigns the device, so an item still detecting has no frame
        // and would be dropped from the archive the button already counted.
        // Wait for it to settle, then re-read the items rather than using the
        // snapshot taken before the await.
        const targetIds = new Set(target.map((item) => item.id));
        await waitForDetection(targetIds);

        const settled = itemsRef.current.filter((item) => targetIds.has(item.id));

        // Export re-renders at full resolution, so anything with a device is
        // exportable regardless of where it sits in the render queue.
        const ready = settled.filter((item) => item.frame);
        if (ready.length === 0) {
          toast.error(
            settled.length > 0
              ? 'None of those images matched a device'
              : 'Nothing to download yet'
          );
          return;
        }

        const skipped = settled.length - ready.length;
        if (skipped > 0) {
          toast.warning(
            `${skipped} image${skipped === 1 ? '' : 's'} had no matching device and ${
              skipped === 1 ? 'was' : 'were'
            } skipped`
          );
        }

        const zip = new JSZip();
        // Number from each item's position in the full queue, so {index} matches
        // the naming preview and the single-image download. Numbering the
        // filtered subset would renumber an item shown as 03 down to 01.
        const names = buildUniqueFilenames(
          tokens,
          ready.map((item) => ({
            name: item.file.name,
            frame: item.frame,
            index: itemsRef.current.findIndex((entry) => entry.id === item.id),
          }))
        );

        // Render at full resolution here rather than on upload. Sequentially,
        // because each render is main-thread canvas work.
        let packed = 0;
        const unfinished: string[] = [];
        const failed: string[] = [];
        for (let index = 0; index < ready.length; index++) {
          const item = ready[index];
          // A video cannot be re-rendered on demand the way a still can — the
          // encode is the expensive step and it already ran. Take the finished
          // MP4 rather than handing decodeFile a video file, which rejects and
          // would fail the WHOLE archive over one item.
          if (isVideoFile(item.file)) {
            if (!item.videoUrl) {
              // A failed encode also has a frame and no videoUrl, so the two
              // are indistinguishable by videoUrl alone — and calling a failure
              // "still encoding" tells the user to wait for something that will
              // never finish. The card already says it failed; the toast has to
              // agree with it.
              if (item.status === 'error') failed.push(item.file.name);
              else unfinished.push(item.file.name);
              continue;
            }
            const encoded = await fetch(item.videoUrl).then((res) => res.blob());
            zip.file(`${names[index]}.mp4`, encoded);
            packed++;
            continue;
          }
          const blob = await renderFrameToBlob(item.file, item.frame!, {
            backgroundColor,
          });
          zip.file(`${names[index]}.png`, blob);
          packed++;
        }

        if (unfinished.length > 0) {
          toast.warning(
            unfinished.length === 1
              ? `${unfinished[0]} is still encoding and was left out`
              : `${unfinished.length} videos were still encoding and were left out`
          );
        }
        if (failed.length > 0) {
          // error, not warning: a still-encoding video is a matter of waiting,
          // whereas this one is not coming back without the user doing
          // something, and the two should not read the same.
          toast.error(
            failed.length === 1
              ? `${failed[0]} failed to encode and was left out`
              : `${failed.length} videos failed to encode and were left out`
          );
        }
        if (packed === 0) {
          toast.error('Nothing finished rendering yet');
          return;
        }

        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${label}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast.success(`Downloaded ${packed} file${packed === 1 ? '' : 's'}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to create the zip');
      } finally {
        setIsDownloading(false);
      }
    },
    [tokens, backgroundColor, waitForDetection]
  );

  const handleCopyImage = useCallback(async () => {
    const item = selectedItems[0];
    if (!item?.frame || item.status !== 'done') {
      toast.error('That image has not finished rendering');
      return;
    }
    // The clipboard takes an image/png; there is no still to write for a video,
    // and renderFrameToBlob would reject on the file anyway.
    if (isVideoFile(item.file)) {
      toast.error('Videos cannot be copied to the clipboard — download it instead');
      return;
    }
    try {
      // Safari requires the ClipboardItem to be constructed synchronously with
      // a promise, or it rejects the write as not user-initiated.
      const blob = renderFrameToBlob(item.file, item.frame, { backgroundColor });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast.success('Copied to the clipboard');
    } catch {
      toast.error('Could not copy the image');
    }
  }, [selectedItems, backgroundColor]);

  const handleDownloadSingle = useCallback(
    async (item: QueueItem) => {
      if (!item.frame || item.status !== 'done') return;
      const index = items.findIndex((entry) => entry.id === item.id);
      const name = buildFilename(
        tokens,
        item.file.name,
        item.frame,
        Math.max(index, 0)
      );

      const link = document.createElement('a');
      // The encoded MP4 already exists and is what the user is looking at; the
      // queue owns its URL, so this one is neither created nor revoked here.
      // Re-rendering instead would hand decodeFile a video file and throw.
      if (isVideoFile(item.file)) {
        // Unreachable today — 'done' and a video implies videoUrl was set by
        // the encode. Kept as a message rather than a bare return because a
        // button that does nothing at all is indistinguishable from a bug, and
        // this is the branch that would be wrong if that invariant ever slips.
        if (!item.videoUrl) {
          toast.error('That video has not finished encoding');
          return;
        }
        link.href = item.videoUrl;
        link.download = `${name}.mp4`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return;
      }

      const blob = await renderFrameToBlob(item.file, item.frame, { backgroundColor });
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = `${name}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    [items, tokens, backgroundColor]
  );

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="font-mono text-[12.5px] text-ink-soft">Loading device frames…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="font-mono text-[12.5px] text-danger">
          Could not load device frames: {error}
        </p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      // No wrapper: UploadZone is already a flex column, and an extra
      // unconstrained div here let the landing page grow past the viewport.
      <UploadZone onFilesSelected={(files) => void handleFilesSelected(files)} />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SelectionBar
        selectedCount={selectedIds.size}
        totalCount={items.length}
        groupByDevice={groupByDevice}
        onToggleGroupByDevice={() => setGroupByDevice((value) => !value)}
        onSelectAll={handleSelectAll}
        onRemoveSelected={handleRemoveSelected}
        doneCount={doneCount}
        renderableCount={renderableCount}
        isRendering={isRendering}
      />

      {/* Stacked below lg: the inspector is a fixed 316px, which squeezed the
          sheet to ~59px on a 375px phone and made cards unusable. */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {view === 'sheet' ? (
          <ContactSheet
            items={items}
            selectedIds={selectedIds}
            groupByDevice={groupByDevice}
            backgroundColor={backgroundColor}
            onToggleSelect={handleToggleSelect}
            onZoom={setZoomedId}
            onAddMore={() => addMoreInputRef.current?.click()}
          />
        ) : (
          <SinglePreview
            item={selectedItems[0] ?? items[0]}
            backgroundColor={backgroundColor}
            onDownload={handleDownloadSingle}
            siblings={orderedItems}
            onNavigate={(id) => setSelectedIds(new Set([id]))}
          />
        )}

        <Inspector
          frames={frames}
          items={items}
          selectedItems={selectedItems}
          onSetFrame={handleSetFrame}
          backgroundColor={backgroundColor}
          onSetBackgroundColor={setBackgroundColor}
          tokens={tokens}
          onSetTokens={setTokens}
          namePreview={namePreview}
          onDownloadAll={() => void downloadZip(items, 'framed-screenshots')}
          onDownloadSelected={() => void downloadZip(selectedItems, 'framed-selection')}
          onCopyImage={() => void handleCopyImage()}
          isDownloading={isDownloading}
        />
      </div>

      <input
        ref={addMoreInputRef}
        type="file"
        multiple
        // Videos are framed too, so an image-only filter would let them be
        // dropped but not chosen through the picker. See
        // FILE_ACCEPT_ATTRIBUTE for why this is not simply `video/*`.
        accept={FILE_ACCEPT_ATTRIBUTE}
        className="hidden"
        onChange={(event) => {
          if (event.target.files?.length) {
            void handleFilesSelected(Array.from(event.target.files));
          }
          event.target.value = '';
        }}
      />

      {zoomedItem && (
        <ZoomOverlay
          item={zoomedItem}
          backgroundColor={backgroundColor}
          siblings={zoomableItems}
          onNavigate={setZoomedId}
          onClose={() => setZoomedId(null)}
        />
      )}
    </div>
  );
};

export default ScreenshotFramer;
