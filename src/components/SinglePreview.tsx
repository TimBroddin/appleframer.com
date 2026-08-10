import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { QueueItem, frameLabelDetailed } from '../lib/queue';
import { renderFramePreview } from '../lib/renderFrame';
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
  const [largeUrl, setLargeUrl] = useState<string | null>(null);

  // Reset zoom when switching images so it doesn't linger on the wrong one.
  useEffect(() => setZoomed(false), [item?.id]);

  // The sheet's preview is only ~420px tall, which goes soft when stretched to
  // fill this pane. Render one sized to the viewport instead; the thumbnail
  // shows immediately and is swapped out when this lands.
  useEffect(() => {
    if (!item?.frame || item.status !== 'done') return;
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
        className={`flex min-h-0 w-full flex-1 items-center justify-center rounded-2xl p-4 ${
          backgroundColor ? '' : 'bg-checker'
        }`}
        style={backgroundColor ? { background: backgroundColor } : undefined}
      >
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
