import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { DeviceFrame, getFramePath } from '../hooks/useFrames';

interface FramePreviewProps {
  image: File;
  frame: DeviceFrame;
  downloadFilename?: string;
}

const FramePreview = ({ image, frame, downloadFilename }: FramePreviewProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRenderSeqRef = useRef<number>(0);
  const [imageUrl, setImageUrl] = useState<string>('');
  const [showZoom, setShowZoom] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(image);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  const loadImage = (src: string): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  };

  const drawImageWithFrame = useCallback(async (targetCanvas?: HTMLCanvasElement, renderSeq?: number) => {
    const canvas = targetCanvas || canvasRef.current;
    if (!canvas) return;

    // Ignore stale preview renders (latest request wins)
    if (renderSeq !== undefined && renderSeq !== previewRenderSeqRef.current) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    try {
      // Use the name directly from coordinates as it already includes orientation
      const frameName = frame.coordinates.name;
      const frameDir = getFramePath(frame);
      const framePath = `/frames/${frameDir}/${frameName}.png`;
      const maskPath = `/frames/${frameDir}/${frameName}_mask.png`;

      // Load all required images
      const [screenImg, frameImg] = await Promise.all([
        loadImage(imageUrl),
        loadImage(framePath)
      ]);

      // Re-check staleness after async boundary
      const isStalePreview =
        !targetCanvas &&
        renderSeq !== undefined &&
        renderSeq !== previewRenderSeqRef.current;
      if (isStalePreview) {
        return;
      }

      // Try to load mask if it exists
      let maskImg: HTMLImageElement | null = null;
      try {
        maskImg = await loadImage(maskPath);
      } catch {
        // Mask doesn't exist, continue without it
      }

      // Re-check staleness after async boundary
      if (!targetCanvas && renderSeq !== undefined && renderSeq !== previewRenderSeqRef.current) {
        return;
      }

      // Set canvas dimensions based on the frame image
      canvas.width = frameImg.width;
      canvas.height = frameImg.height;

      // Disable image smoothing after resize (setting width/height resets context state)
      ctx.imageSmoothingEnabled = false;

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Create a temporary canvas for the masked screenshot
      const tempCanvas = document.createElement('canvas');
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) return;

      // Set temp canvas size to match the main canvas
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;

      // Disable image smoothing after resize (setting width/height resets context state)
      tempCtx.imageSmoothingEnabled = false;

      // Calculate screenshot position based on frame coordinates
      const { x, y, screenshotWidth, screenshotHeight } = frame.coordinates;
      const screenshotX = parseInt(x);
      const screenshotY = parseInt(y);
      // Use frame's specified dimensions to ensure exact fit
      const targetWidth = screenshotWidth || screenImg.width;
      const targetHeight = screenshotHeight || screenImg.height;

      // Only apply inset if there's NO mask (mask handles corner clipping)
      // For frames without masks, inset prevents bleeding at corners
      const EDGE_INSET = maskImg ? 0 : 3;
      const adjustedWidth = targetWidth - (EDGE_INSET * 2);
      const adjustedHeight = targetHeight - (EDGE_INSET * 2);
      const adjustedX = screenshotX + EDGE_INSET;
      const adjustedY = screenshotY + EDGE_INSET;

      // Draw and mask the screenshot
      if (maskImg) {
        // Clear the temp canvas first
        tempCtx.clearRect(0, 0, canvas.width, canvas.height);

        // Create a canvas for the mask to read its pixels
        const maskCanvas = document.createElement('canvas');
        const maskCtx = maskCanvas.getContext('2d');
        if (!maskCtx) return;

        // Set mask canvas size to match the frame's specified dimensions (no inset)
        maskCanvas.width = adjustedWidth;
        maskCanvas.height = adjustedHeight;

        // Disable image smoothing after resize (setting width/height resets context state)
        maskCtx.imageSmoothingEnabled = false;

        // Draw mask at the right size
        maskCtx.drawImage(
          maskImg,
          0,
          0,
          maskCanvas.width,
          maskCanvas.height
        );

        // Get mask pixel data
        const maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);

        // Draw the screenshot onto the temp canvas at exact frame dimensions
        tempCtx.drawImage(
          screenImg,
          adjustedX,
          adjustedY,
          adjustedWidth,
          adjustedHeight
        );
        // Get screenshot pixel data
        const imageData = tempCtx.getImageData(
          adjustedX,
          adjustedY,
          adjustedWidth,
          adjustedHeight
        );

        // Apply mask - make pixels transparent where mask is dark
        for (let i = 0; i < maskData.data.length; i += 4) {
          // If mask pixel is dark (below threshold) - handles (0,0,1) and similar near-black values
          const r = maskData.data[i];
          const g = maskData.data[i + 1];
          const b = maskData.data[i + 2];
          const threshold = 10; // Any pixel with all channels below 10 is considered "black"
          if (r < threshold && g < threshold && b < threshold) {
            // Make the corresponding screenshot pixel transparent
            imageData.data[i + 3] = 0;
          }
        }

        // Put the masked image data back
        tempCtx.putImageData(imageData, adjustedX, adjustedY);

        // Draw the result to main canvas
        ctx.drawImage(tempCanvas, 0, 0);
      } else {
        // If no mask, draw the screenshot directly with inset to prevent bleeding
        ctx.drawImage(
          screenImg,
          adjustedX,
          adjustedY,
          adjustedWidth,
          adjustedHeight
        );
      }
      // Draw the frame image
      ctx.drawImage(
        frameImg,
        0,
        0,
        canvas.width,
        canvas.height
      );
    } catch (error) {
      console.error('Error loading images:', error);
      throw error instanceof Error
        ? error
        : new Error('Failed to render framed image');
    }
  }, [imageUrl, frame]);

  useEffect(() => {
    if (!canvasRef.current || !imageUrl) return;
    const renderSeq = ++previewRenderSeqRef.current;
    void drawImageWithFrame(undefined, renderSeq).catch((error) => {
      console.error('Error rendering frame preview:', error);
    });
  }, [imageUrl, frame, drawImageWithFrame]);


  const handleDownload = async () => {
    if (!canvasRef.current) return;

    // Create a temporary canvas for the download version
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return;

    // Draw to the temporary canvas and await completion
    try {
      await drawImageWithFrame(tempCanvas);
    } catch {
      return;
    }

    // Download the rendered image
    const link = document.createElement('a');
    link.download = downloadFilename || `framed-${image.name.replace(/\.[^/.]+$/, '')}.png`;
    link.href = tempCanvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <>
      <div className="flex flex-col items-center">
        <div className="relative transition-all duration-300 transform hover:scale-[1.01] flex items-center justify-center">
          <canvas
            ref={canvasRef}
            onClick={() => setShowZoom(true)}
            className="max-w-full w-auto max-h-[80vh] md:max-h-[calc(100vh-128px)] h-auto shadow-xl rounded-3xl cursor-pointer"
          />
        </div>

        <button
          id="download-button"
          onClick={handleDownload}
          className="mt-6 py-2 px-4 bg-blue-500 hover:bg-blue-600 text-white rounded-lg flex items-center transition-colors"
        >
          <Download className="h-4 w-4 mr-2" />
          Download Framed Image
        </button>
      </div>

      {showZoom && (
        <div 
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
          onClick={() => setShowZoom(false)}
        >
          <button
            onClick={() => setShowZoom(false)}
            className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors"
          >
            <X className="h-6 w-6 text-white" />
          </button>
          <canvas
            ref={(node) => {
              if (node && showZoom) {
                const tempCanvas = document.createElement('canvas');
                drawImageWithFrame(tempCanvas).then(() => {
                  node.width = tempCanvas.width;
                  node.height = tempCanvas.height;
                  const ctx = node.getContext('2d');
                  if (ctx) {
                    ctx.drawImage(tempCanvas, 0, 0);
                  }
                }).catch(console.error);
              }
            }}
            className="max-w-full max-h-full"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
};

export default FramePreview;