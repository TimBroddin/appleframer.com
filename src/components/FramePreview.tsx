import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { DeviceFrame } from '../hooks/useFrames';

interface FramePreviewProps {
  image: File;
  frame: DeviceFrame;
}

const FramePreview = ({ image, frame }: FramePreviewProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imageUrl, setImageUrl] = useState<string>('');

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

  const drawImageWithFrame = useCallback(async (forDownload = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    try {
      // Use the name directly from coordinates as it already includes orientation
      const frameName = frame.coordinates.name;
      const framePath = `/frames/${frameName}.png`;
      const maskPath = `/frames/${frameName}_mask.png`;
      console.log(`Frame path = ${framePath}`)
      console.log(`Mask path = ${maskPath}`)
      // Load all required images
      const [screenImg, frameImg] = await Promise.all([
        loadImage(imageUrl),
        loadImage(framePath)
      ]);

      console.log(`Screen image = ${screenImg}`)
      console.log(`Frame image = ${frameImg}`)

      // Try to load mask if it exists
      let maskImg: HTMLImageElement | null = null;
      try {
        maskImg = await loadImage(maskPath);
      } catch {
        // Mask doesn't exist, continue without it
        console.log('No mask found for this frame: ', maskPath);
      }

      // Set canvas dimensions based on the frame image
      const maxWidth = forDownload ? frameImg.width : Math.min(800, window.innerWidth - 64);
      const scale = maxWidth / frameImg.width;
      
      canvas.width = frameImg.width * scale;
      canvas.height = frameImg.height * scale;
      
      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      

      // Create a temporary canvas for the masked screenshot
      const tempCanvas = document.createElement('canvas');
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) return;

      // Set temp canvas size to match the main canvas
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;

      // Calculate screenshot position based on frame coordinates
      const { x, y } = frame.coordinates;
      const screenshotX = parseInt(x) * scale;
      const screenshotY = parseInt(y) * scale;

      // Draw and mask the screenshot
      if (maskImg) {
        // Clear the temp canvas first
        tempCtx.clearRect(0, 0, canvas.width, canvas.height);

        // Create a canvas for the mask to read its pixels
        const maskCanvas = document.createElement('canvas');
        const maskCtx = maskCanvas.getContext('2d');
        if (!maskCtx) return;

        // Set mask canvas size to match the screenshot dimensions
        maskCanvas.width = screenImg.width * scale;
        maskCanvas.height = screenImg.height * scale;

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

        // Draw the screenshot onto the temp canvas
        tempCtx.drawImage(
          screenImg,
          screenshotX,
          screenshotY,
          screenImg.width * scale,
          screenImg.height * scale
        );

        // Get screenshot pixel data
        const imageData = tempCtx.getImageData(
          screenshotX,
          screenshotY,
          screenImg.width * scale,
          screenImg.height * scale
        );

        // Apply mask - make pixels transparent where mask is black
        for (let i = 0; i < maskData.data.length; i += 4) {
          // If mask pixel is black (R=0, G=0, B=0)
          if (maskData.data[i] === 0 && maskData.data[i + 1] === 0 && maskData.data[i + 2] === 0) {
            // Make the corresponding screenshot pixel transparent
            imageData.data[i + 3] = 0;
          }
        }

        // Put the masked image data back
        tempCtx.putImageData(imageData, screenshotX, screenshotY);

        // Draw the result to main canvas
        ctx.drawImage(tempCanvas, 0, 0);
      } else {
        // If no mask, draw the screenshot directly
        console.log(`Drawing screenshot directly`)
        ctx.drawImage(
          screenImg,
          screenshotX,
          screenshotY,
          screenImg.width * scale,
          screenImg.height * scale
        );
      }
      console.log(`Drawing frame image`)
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
    }
  }, [imageUrl, frame]);

  useEffect(() => {
    if (!canvasRef.current || !imageUrl) return;
    drawImageWithFrame();
  }, [imageUrl, frame, drawImageWithFrame]);


  const handleDownload = () => {
    if (!canvasRef.current) return;
    
    // Create a temporary canvas for the download version
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return;
    
    // Store the original canvas reference
    const originalCanvas = canvasRef.current;
    
    // Create a new ref for the temporary canvas
    const tempCanvasRef = { current: tempCanvas };
    Object.defineProperty(canvasRef, 'current', {
      configurable: true,
      get() { return tempCanvasRef.current; }
    });
    
    // Draw with transparency for download
    drawImageWithFrame(true);
    
    // Wait for the image to be drawn
    setTimeout(() => {
      const link = document.createElement('a');
      link.download = `framed-${image.name.replace(/\.[^/.]+$/, '')}.png`;
      link.href = tempCanvas.toDataURL('image/png');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      // Restore the original canvas
      Object.defineProperty(canvasRef, 'current', {
        configurable: true,
        get() { return originalCanvas; }
      });
      drawImageWithFrame(false);
    }, 100);
  };

  return (
    <div className="flex flex-col items-center">
      <div className="relative transition-all duration-300 transform hover:scale-[1.01]">
        <canvas 
          ref={canvasRef} 
          className="max-w-full h-auto shadow-xl rounded-3xl"
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
  );
};

export default FramePreview;