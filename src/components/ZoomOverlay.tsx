import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { QueueItem, frameLabelDetailed, isVideoFile } from '../lib/queue';
import { renderFrameToBlob } from '../lib/renderFrame';

interface ZoomOverlayProps {
  item: QueueItem;
  backgroundColor: string | null;
  onClose: () => void;
  /**
   * The images to step through, in the order they appear on screen. Grouping
   * reorders the sheet, so this must be the display order rather than the raw
   * queue, otherwise the arrows jump around unpredictably.
   */
  siblings?: QueueItem[];
  onNavigate?: (id: string) => void;
}

/**
 * Full-screen look at one framed image, shared by the sheet and the single
 * view.
 *
 * The queue only keeps a downscaled preview, so this renders the image at full
 * resolution on open rather than upscaling a thumbnail. The preview stands in
 * until that finishes, which keeps the overlay instant.
 */
const ZoomOverlay = ({
  item,
  backgroundColor,
  onClose,
  siblings,
  onNavigate,
}: ZoomOverlayProps) => {
  const [fullUrl, setFullUrl] = useState<string | null>(null);

  // Memoised so the fallback array doesn't get a new identity each render,
  // which would rebuild the step callback and its key listener every time.
  const list = useMemo(() => siblings ?? [], [siblings]);
  const position = list.findIndex((entry) => entry.id === item.id);
  // Wrap around: with a batch open, stepping past the last image should return
  // to the first rather than dead-ending.
  const canNavigate = Boolean(onNavigate) && list.length > 1 && position !== -1;

  const step = useCallback(
    (delta: number) => {
      if (!canNavigate || !onNavigate) return;
      const next = (position + delta + list.length) % list.length;
      onNavigate(list[next].id);
    },
    [canNavigate, onNavigate, position, list]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight') step(1);
      else if (event.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, step]);

  useEffect(() => {
    if (!item.frame) return;
    // A video has no full-resolution still to render: decodeFile would be
    // handed an MP4 and reject. Its previewUrl — the first composited frame —
    // is already the best still there is, so show that.
    if (isVideoFile(item.file)) return;
    let cancelled = false;
    let url: string | null = null;

    renderFrameToBlob(item.file, item.frame, { backgroundColor })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setFullUrl(url);
      })
      .catch(() => {
        /* Fall back to the preview. */
      });

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setFullUrl(null);
    };
  }, [item.id, item.file, item.frame, backgroundColor]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/90 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${item.file.name} enlarged`}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 transition-colors hover:bg-white/20"
      >
        <X className="h-6 w-6 text-white" />
      </button>

      {canNavigate && (
        <>
          <button
            type="button"
            aria-label="Previous image"
            onClick={(event) => {
              event.stopPropagation();
              step(-1);
            }}
            className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 transition-colors hover:bg-white/20"
          >
            <ChevronLeft className="h-6 w-6 text-white" />
          </button>
          <button
            type="button"
            aria-label="Next image"
            onClick={(event) => {
              event.stopPropagation();
              step(1);
            }}
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 transition-colors hover:bg-white/20"
          >
            <ChevronRight className="h-6 w-6 text-white" />
          </button>
        </>
      )}

      <img
        src={fullUrl ?? item.previewUrl}
        alt={item.file.name}
        className="max-h-[calc(100%-3rem)] max-w-full object-contain"
        onClick={(event) => event.stopPropagation()}
      />

      <div className="flex items-center gap-2.5 font-mono text-xs-plus text-white/60">
        {canNavigate && (
          <span className="text-white/40">
            {position + 1} / {list.length}
          </span>
        )}
        <span>
          {item.file.name} · {frameLabelDetailed(item.frame)}
        </span>
      </div>
    </div>
  );
};

export default ZoomOverlay;
