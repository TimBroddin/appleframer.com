import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import JSZip from 'jszip';
import { DeviceFrame } from '../hooks/useFrames';
import { useRenderQueue } from '../hooks/useRenderQueue';
import {
  displayOrder,
  findFrameByScreenshotSize,
  frameLabel,
  QueueItem,
} from '../lib/queue';
import { decodeFile, renderFrameToBlob } from '../lib/renderFrame';
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

  const {
    items,
    addFiles,
    resolveDetection,
    setFrameFor,
    removeItems,
    doneCount,
    renderableCount,
    isRendering,
  } = useRenderQueue(backgroundColor);

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
      const imageFiles = files.filter((file) => file.type.startsWith('image/'));
      if (imageFiles.length === 0) {
        toast.error('No image files found in that selection');
        return;
      }
      if (frames.length === 0) return;

      // Show the cards immediately, then detect. Detection has to decode each
      // image, which is slow for large screenshots, so waiting for the whole
      // batch before rendering anything left the drop target on screen.
      const added = addFiles(imageFiles);
      setSelectedIds(new Set(added.map((item) => item.id)));

      // Decoding every file at once spikes memory and slows each decode down.
      const CONCURRENCY = 4;
      let cursor = 0;
      let matched = 0;
      const devices = new Set<string>();
      const unmatchedNames: string[] = [];

      const worker = async () => {
        for (;;) {
          const index = cursor++;
          if (index >= added.length) return;
          const entry = added[index];
          try {
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
        Array.from({ length: Math.min(CONCURRENCY, added.length) }, worker)
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

  const downloadZip = useCallback(
    async (target: QueueItem[], label: string) => {
      // Export renders every image at full resolution regardless, so a queued
      // or mid-render item is exportable as soon as it has a device. Filtering
      // to 'done' used to silently drop images the button had already counted,
      // producing an archive smaller than promised.
      const ready = target.filter((item) => item.frame);
      if (ready.length === 0) {
        toast.error(
          target.length > 0
            ? 'None of those images matched a device'
            : 'Nothing to download yet'
        );
        return;
      }

      const skipped = target.length - ready.length;
      if (skipped > 0) {
        toast.warning(
          `${skipped} image${skipped === 1 ? '' : 's'} had no matching device and ${
            skipped === 1 ? 'was' : 'were'
          } skipped`
        );
      }

      setIsDownloading(true);
      try {
        const zip = new JSZip();
        const names = buildUniqueFilenames(
          tokens,
          ready.map((item) => ({ name: item.file.name, frame: item.frame }))
        );

        // Render at full resolution here rather than on upload. Sequentially,
        // because each render is main-thread canvas work.
        for (let index = 0; index < ready.length; index++) {
          const item = ready[index];
          const blob = await renderFrameToBlob(item.file, item.frame!, {
            backgroundColor,
          });
          zip.file(`${names[index]}.png`, blob);
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
        toast.success(`Downloaded ${ready.length} image${ready.length === 1 ? '' : 's'}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to create the zip');
      } finally {
        setIsDownloading(false);
      }
    },
    [tokens, backgroundColor]
  );

  const handleCopyImage = useCallback(async () => {
    const item = selectedItems[0];
    if (!item?.frame || item.status !== 'done') {
      toast.error('That image has not finished rendering');
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
      const blob = await renderFrameToBlob(item.file, item.frame, { backgroundColor });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${buildFilename(
        tokens,
        item.file.name,
        item.frame,
        Math.max(index, 0)
      )}.png`;
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
        accept="image/*"
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
          onClose={() => setZoomedId(null)}
        />
      )}
    </div>
  );
};

export default ScreenshotFramer;
