import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { QueueItem, frameLabelDetailed } from '../lib/queue';
import ZoomOverlay from './ZoomOverlay';

interface SinglePreviewProps {
  item: QueueItem | undefined;
  backgroundColor: string | null;
  onDownload: (item: QueueItem) => void;
}

/**
 * Large preview of one image. Unlike the old FramePreview this does no
 * compositing of its own — the render queue has already produced the preview,
 * so this just displays it. That keeps a single rendering code path.
 */
const SinglePreview = ({ item, backgroundColor, onDownload }: SinglePreviewProps) => {
  const [zoomed, setZoomed] = useState(false);

  // Reset zoom when switching images so it doesn't linger on the wrong one.
  useEffect(() => setZoomed(false), [item?.id]);

  if (!item) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="font-mono text-[12.5px] text-ink-soft">Select an image</p>
      </div>
    );
  }

  const ready = item.status === 'done' && item.previewUrl;

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 overflow-auto p-8">
      <div
        className={`flex max-h-full items-center justify-center rounded-2xl p-4 ${
          backgroundColor ? '' : 'bg-checker'
        }`}
        style={backgroundColor ? { background: backgroundColor } : undefined}
      >
        <img
          src={ready ? item.previewUrl : item.sourceUrl}
          alt={item.file.name}
          onClick={() => ready && setZoomed(true)}
          className={`max-h-[60vh] w-auto max-w-full object-contain ${
            ready ? 'cursor-zoom-in' : 'opacity-40'
          }`}
        />
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
        <ZoomOverlay
          item={item}
          backgroundColor={backgroundColor}
          onClose={() => setZoomed(false)}
        />
      )}
    </div>
  );
};

export default SinglePreview;
