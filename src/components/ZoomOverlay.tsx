import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { QueueItem, frameLabelDetailed } from '../lib/queue';
import { renderFrameToBlob } from '../lib/renderFrame';

interface ZoomOverlayProps {
  item: QueueItem;
  backgroundColor: string | null;
  onClose: () => void;
}

/**
 * Full-screen look at one framed image, shared by the sheet and the single
 * view.
 *
 * The queue only keeps a downscaled preview, so this renders the image at full
 * resolution on open rather than upscaling a thumbnail. The preview stands in
 * until that finishes, which keeps the overlay instant.
 */
const ZoomOverlay = ({ item, backgroundColor, onClose }: ZoomOverlayProps) => {
  const [fullUrl, setFullUrl] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!item.frame) return;
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

      <img
        src={fullUrl ?? item.previewUrl}
        alt={item.file.name}
        className="max-h-[calc(100%-3rem)] max-w-full object-contain"
        onClick={(event) => event.stopPropagation()}
      />

      <div className="font-mono text-xs-plus text-white/60">
        {item.file.name} · {frameLabelDetailed(item.frame)}
      </div>
    </div>
  );
};

export default ZoomOverlay;
