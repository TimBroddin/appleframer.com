import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { QueueItem, frameLabelDetailed } from '../lib/queue';

interface SinglePreviewProps {
  item: QueueItem | undefined;
  backgroundColor: string | null;
  onDownload: (item: QueueItem) => void;
}

/**
 * Large preview of one image. Unlike the old FramePreview this does no
 * compositing of its own — the render queue has already produced a PNG, so
 * this just displays it. That keeps a single rendering code path.
 */
const SinglePreview = ({ item, backgroundColor, onDownload }: SinglePreviewProps) => {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!zoomed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoomed(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomed]);

  // Reset zoom when switching images so it doesn't linger on the wrong one.
  useEffect(() => setZoomed(false), [item?.id]);

  if (!item) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="font-mono text-[12.5px] text-ink-soft">Select an image</p>
      </div>
    );
  }

  const ready = item.status === 'done' && item.blobUrl;

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 overflow-auto p-8">
      <div
        className={`flex max-h-full items-center justify-center rounded-2xl p-4 ${
          backgroundColor ? '' : 'bg-checker'
        }`}
        style={backgroundColor ? { background: backgroundColor } : undefined}
      >
        {ready ? (
          <img
            src={item.blobUrl}
            alt={item.file.name}
            onClick={() => setZoomed(true)}
            className="max-h-[60vh] w-auto max-w-full cursor-zoom-in object-contain"
          />
        ) : (
          <img
            src={item.sourceUrl}
            alt={item.file.name}
            className="max-h-[60vh] w-auto max-w-full object-contain opacity-40"
          />
        )}
      </div>

      <div className="flex flex-col items-center gap-2">
        <div className="font-mono text-xs-plus text-ink-soft">
          {item.file.name} · {frameLabelDetailed(item.frame)}
          {item.status !== 'done' && ` · ${item.status}`}
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setZoomed(false)}
          role="dialog"
          aria-modal="true"
          aria-label={`${item.file.name} enlarged`}
        >
          <button
            type="button"
            onClick={() => setZoomed(false)}
            aria-label="Close"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 transition-colors hover:bg-white/20"
          >
            <X className="h-6 w-6 text-white" />
          </button>
          <img
            src={item.blobUrl}
            alt={item.file.name}
            className="max-h-full max-w-full object-contain"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
};

export default SinglePreview;
