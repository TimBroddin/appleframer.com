import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import JSZip from 'jszip';
import { DeviceFrame } from '../hooks/useFrames';
import { useRenderQueue } from '../hooks/useRenderQueue';
import { findFrameByScreenshotSize, frameLabel, QueueItem } from '../lib/queue';
import { readImageSize } from '../lib/renderFrame';
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
  const [isDownloading, setIsDownloading] = useState(false);
  const addMoreInputRef = useRef<HTMLInputElement>(null);
  const lastClickedIdRef = useRef<string | null>(null);

  const { items, addFiles, setFrameFor, removeItems, doneCount, isRendering } =
    useRenderQueue(backgroundColor);

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
    const deviceCount = new Set(items.map((item) => item.frame.id)).size;
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

      // Detect each file's device independently — that is the whole point of
      // per-image frames, and a mixed batch is the common App Store case.
      const entries = await Promise.all(
        imageFiles.map(async (file) => {
          try {
            const { width, height } = await readImageSize(file);
            return { file, frame: findFrameByScreenshotSize(frames, width, height) };
          } catch {
            return { file, frame: undefined };
          }
        })
      );

      const matched = entries.filter(
        (entry): entry is { file: File; frame: DeviceFrame } => Boolean(entry.frame)
      );
      const unmatched = entries.filter((entry) => !entry.frame);

      if (matched.length > 0) {
        const newIds = addFiles(matched);
        setSelectedIds(new Set(newIds));

        const devices = new Set(matched.map((entry) => frameLabel(entry.frame)));
        toast.success(
          matched.length === 1
            ? `Matched ${frameLabel(matched[0].frame)}`
            : `Matched ${matched.length} shots across ${devices.size} device${
                devices.size === 1 ? '' : 's'
              }`
        );
      }

      if (unmatched.length > 0) {
        toast.warning(
          unmatched.length === 1
            ? `No device matches ${unmatched[0].file.name}`
            : `${unmatched.length} images had no matching device and were skipped`
        );
      }
    },
    [frames, addFiles]
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

  const handleToggleSelect = useCallback(
    (id: string, event: React.MouseEvent) => {
      setSelectedIds((prev) => {
        // Shift extends from the last click; plain click replaces the selection,
        // which is what a contact sheet is expected to do.
        if (event.shiftKey && lastClickedIdRef.current) {
          const from = items.findIndex((item) => item.id === lastClickedIdRef.current);
          const to = items.findIndex((item) => item.id === id);
          if (from !== -1 && to !== -1) {
            const [start, end] = from < to ? [from, to] : [to, from];
            const next = new Set(prev);
            items.slice(start, end + 1).forEach((item) => next.add(item.id));
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
    [items]
  );

  const handleSetFrame = useCallback(
    (frame: DeviceFrame) => {
      if (selectedIds.size === 0) return;
      setFrameFor(Array.from(selectedIds), frame);
    },
    [selectedIds, setFrameFor]
  );

  const handleSelectAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((item) => item.id))
    );
  }, [items]);

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

  /** Waits for a set of items to finish rendering before exporting them. */
  const awaitRendered = useCallback(
    (target: QueueItem[]): QueueItem[] => target.filter((item) => item.status === 'done'),
    []
  );

  const downloadZip = useCallback(
    async (target: QueueItem[], label: string) => {
      const ready = awaitRendered(target);
      if (ready.length === 0) {
        toast.error('Nothing has finished rendering yet');
        return;
      }
      if (ready.length < target.length) {
        toast.warning(
          `${target.length - ready.length} image${
            target.length - ready.length === 1 ? ' is' : 's are'
          } still rendering and will be skipped`
        );
      }

      setIsDownloading(true);
      try {
        const zip = new JSZip();
        const names = buildUniqueFilenames(
          tokens,
          ready.map((item) => ({ name: item.file.name, frame: item.frame }))
        );

        await Promise.all(
          ready.map(async (item, index) => {
            // The queue already rendered these; re-fetch the blob rather than
            // re-running the canvas pipeline.
            const blob = await fetch(item.blobUrl!).then((res) => res.blob());
            zip.file(`${names[index]}.png`, blob);
          })
        );

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
    [awaitRendered, tokens]
  );

  const handleCopyImage = useCallback(async () => {
    const item = selectedItems[0];
    if (!item?.blobUrl) {
      toast.error('That image has not finished rendering');
      return;
    }
    try {
      const blob = await fetch(item.blobUrl).then((res) => res.blob());
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast.success('Copied to the clipboard');
    } catch {
      toast.error('Could not copy the image');
    }
  }, [selectedItems]);

  const handleDownloadSingle = useCallback(
    (item: QueueItem) => {
      if (!item.blobUrl) return;
      const index = items.findIndex((entry) => entry.id === item.id);
      const link = document.createElement('a');
      link.href = item.blobUrl;
      link.download = `${buildFilename(
        tokens,
        item.file.name,
        item.frame,
        Math.max(index, 0)
      )}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    },
    [items, tokens]
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
      <div className="flex flex-1 flex-col">
        <UploadZone onFilesSelected={(files) => void handleFilesSelected(files)} />
      </div>
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
        isRendering={isRendering}
      />

      <div className="flex min-h-0 flex-1">
        {view === 'sheet' ? (
          <ContactSheet
            items={items}
            selectedIds={selectedIds}
            groupByDevice={groupByDevice}
            backgroundColor={backgroundColor}
            onToggleSelect={handleToggleSelect}
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
    </div>
  );
};

export default ScreenshotFramer;
