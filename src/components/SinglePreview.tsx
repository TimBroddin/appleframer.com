import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { QueueItem, frameLabelDetailed, isVideoFile } from '../lib/queue';
import { renderFramePreview } from '../lib/renderFrame';
import ZoomOverlay from './ZoomOverlay';

interface SinglePreviewProps {
  item: QueueItem | undefined;
  backgroundColor: string | null;
  onDownload: (item: QueueItem) => void;
  /** Every image, in display order, for stepping through the batch. */
  siblings: QueueItem[];
  /** Moves the selection, since this view shows whatever is selected. */
  onNavigate: (id: string) => void;
}

/**
 * Large preview of one image. Unlike the old FramePreview this does no
 * compositing of its own — the render queue has already produced the preview,
 * so this just displays it. That keeps a single rendering code path.
 */
const SinglePreview = ({
  item,
  backgroundColor,
  onDownload,
  siblings,
  onNavigate,
}: SinglePreviewProps) => {
  const [zoomed, setZoomed] = useState(false);
  const [largeUrl, setLargeUrl] = useState<string | null>(null);

  const position = siblings.findIndex((entry) => entry.id === item?.id);
  const canNavigate = siblings.length > 1 && position !== -1;

  const step = useCallback(
    (delta: number) => {
      if (!canNavigate) return;
      const next = (position + delta + siblings.length) % siblings.length;
      onNavigate(siblings[next].id);
    },
    [canNavigate, position, siblings, onNavigate]
  );

  // Arrow keys move through the batch, but not while the zoom overlay is open —
  // it binds the same keys and would otherwise advance two images at once.
  useEffect(() => {
    if (zoomed || !canNavigate) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Don't hijack arrows while typing in the inspector's fields.
      if (target && (target.tagName === 'INPUT' || target.isContentEditable)) return;
      if (event.key === 'ArrowRight') step(1);
      else if (event.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomed, canNavigate, step]);

  // Reset zoom when switching images so it doesn't linger on the wrong one.
  useEffect(() => setZoomed(false), [item?.id]);

  // The sheet's preview is only ~420px tall, which goes soft when stretched to
  // fill this pane. Render one sized to the viewport instead; the thumbnail
  // shows immediately and is swapped out when this lands.
  useEffect(() => {
    if (!item?.frame || item.status !== 'done') return;
    // A video's preview is the first composited frame the encode already
    // produced. Re-rendering it here would hand decodeFile an MP4, which
    // createImageBitmap rejects — caught below, but only after wasting a
    // full-resolution render's worth of work on every selection change.
    if (isVideoFile(item.file)) return;
    let cancelled = false;

    void renderFramePreview(item.file, item.frame, {
      backgroundColor,
      maxHeight: Math.round(Math.min(window.innerHeight * 2, 2400)),
    })
      .then((url) => {
        if (!cancelled) setLargeUrl(url);
      })
      .catch(() => {
        /* Keep showing the thumbnail. */
      });

    return () => {
      cancelled = true;
      setLargeUrl(null);
    };
  }, [item?.id, item?.file, item?.frame, item?.status, backgroundColor]);

  const displayUrl = largeUrl ?? item?.previewUrl;

  if (!item) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="font-mono text-[12.5px] text-ink-soft">Select an image</p>
      </div>
    );
  }

  const ready = item.status === 'done' && item.previewUrl;

  return (
    // min-h-0 lets the image region actually shrink to the pane, so the
    // preview can grow into the available height instead of being pinned to a
    // fraction of the viewport.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center gap-4 p-6">
      <div
        className={`relative flex min-h-0 w-full flex-1 items-center justify-center rounded-2xl p-4 ${
          backgroundColor ? '' : 'bg-checker'
        }`}
        style={backgroundColor ? { background: backgroundColor } : undefined}
      >
        {canNavigate && (
          <>
            <button
              type="button"
              aria-label="Previous image"
              onClick={() => step(-1)}
              className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full border border-hairline bg-surface/90 p-2 text-ink-soft shadow-card backdrop-blur transition-colors hover:text-accent"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label="Next image"
              onClick={() => step(1)}
              className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full border border-hairline bg-surface/90 p-2 text-ink-soft shadow-card backdrop-blur transition-colors hover:text-accent"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}

        <img
          src={ready ? displayUrl : item.sourceUrl}
          alt={item.file.name}
          onClick={() => ready && setZoomed(true)}
          className={`max-h-full w-auto max-w-full object-contain ${
            ready ? 'cursor-zoom-in' : 'opacity-40'
          }`}
        />
      </div>

      <div className="flex flex-none flex-col items-center gap-2">
        <div className="flex items-center gap-2.5 font-mono text-xs-plus text-ink-soft">
          {canNavigate && (
            <span className="text-ink-faint">
              {position + 1} / {siblings.length}
            </span>
          )}
          <span>
            {item.file.name} · {frameLabelDetailed(item.frame)}
            {/* An encode runs for minutes, so the bare word "encoding" would
                sit there looking stuck. The percentage is the only signal that
                anything is still happening. */}
            {item.status === 'encoding'
              ? ` · encoding ${Math.round((item.video?.progress ?? 0) * 100)}%`
              : item.status !== 'done' && ` · ${item.status}`}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onDownload(item)}
          disabled={!ready}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download className="h-4 w-4" />
          Download
        </button>
      </div>

      {zoomed && ready && (
        <ZoomOverlay
          item={item}
          backgroundColor={backgroundColor}
          // Zooming can only show rendered images, and navigating here moves
          // the selection so the view behind the overlay stays in step.
          siblings={siblings.filter(
            (entry) => entry.status === 'done' && entry.previewUrl
          )}
          onNavigate={onNavigate}
          onClose={() => setZoomed(false)}
        />
      )}
    </div>
  );
};

export default SinglePreview;
