import React, { useState } from 'react';
import { ImagePlus, Download, Trash2, Settings } from 'lucide-react';
import UploadZone from './UploadZone';
import FramePreview from './FramePreview';
import FrameSettings from './FrameSettings';
import { useFrames, DeviceFrame } from '../hooks/useFrames';
import { toast } from 'sonner';

const ScreenshotFramer = () => {
  const { frames, isLoading, error } = useFrames();
  const [images, setImages] = useState<File[]>([]);
  const [selectedFrame, setSelectedFrame] = useState<DeviceFrame | undefined>(undefined);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(null);
  


  // Update selectedFrame when frames are loaded
  React.useEffect(() => {
    if (frames.length > 0 && !selectedFrame) {
      setSelectedFrame(frames[0]);
    }
  }, [frames]);

  const findFrameByScreenshotWidth = (frames: DeviceFrame[], width: number): DeviceFrame | undefined => {
    console.log('DEBUG: Uploaded image width:', width);
    const allWidths = frames.map(f => f.coordinates.screenshotWidth);
    console.log('DEBUG: All frame screenshot widths:', allWidths);
    const found = frames.find((frame: DeviceFrame) => frame.coordinates.screenshotWidth === width);
    console.log('DEBUG: Detected frame:', found);
    return found;
  };

  const handleFilesSelected = (files: File[]) => {
    // Only accept image files
    const imageFiles = files.filter(file => file.type.startsWith('image/'));
    if (imageFiles.length > 0) {
      const img = new window.Image();
      img.onload = () => {
        console.log('DEBUG: Loaded image naturalWidth:', img.naturalWidth, 'width:', img.width);
        const detectedFrame = findFrameByScreenshotWidth(frames, img.width);
        if (detectedFrame) {
          setSelectedFrame(detectedFrame);
          toast.success(`Auto-detected: ${detectedFrame.coordinates.name} (${img.width}px)`);
        } else {
          toast.warning(`No matching device found for width ${img.width}px`);
        }
        setImages(prev => {
          const newImages = [...prev, ...imageFiles];
          // Always select the last added image
          setSelectedImageIndex(newImages.length - 1);
          return newImages;
        });
      };
      img.src = URL.createObjectURL(imageFiles[0]);
    } else {
      setImages(prev => {
        const newImages = [...prev, ...imageFiles];
        if (imageFiles.length > 0 && selectedImageIndex === null) {
          setSelectedImageIndex(newImages.length - 1);
        }
        return newImages;
      });
    }
  };

  const handleRemoveImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
    if (selectedImageIndex === index) {
      setSelectedImageIndex(images.length > 1 ? 0 : null);
    } else if (selectedImageIndex !== null && index < selectedImageIndex) {
      setSelectedImageIndex(selectedImageIndex - 1);
    }
  };

  const handleSelectImage = (index: number) => {
    setSelectedImageIndex(index);
  };
  
  const toggleSettings = () => {
    setShowSettings(!showSettings);
  };

  console.log(selectedFrame);

  if (isLoading) {
    return (
      <div className="w-full max-w-6xl">
        <div className="bg-white rounded-xl shadow-xl p-8 text-center">
          <p className="text-gray-500">Loading available frames...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full max-w-6xl">
        <div className="bg-white rounded-xl shadow-xl p-8 text-center">
          <p className="text-red-500">Error loading frames: {error}</p>
        </div>
      </div>
    );
  }

  if (!selectedFrame) {
    return (
      <div className="w-full max-w-6xl">
        <div className="bg-white rounded-xl shadow-xl p-8 text-center">
          <p className="text-gray-500">No frames available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-6xl">
      <div className="bg-white rounded-xl shadow-xl overflow-hidden transition-all duration-300">
        {images.length === 0 ? (
          <UploadZone onFilesSelected={handleFilesSelected} />
        ) : (
          <div className="flex flex-col md:flex-row min-h-[500px]">
            <div className="w-full md:w-3/4 p-6 flex items-center justify-center relative">
              {selectedImageIndex !== null && (
                <FramePreview 
                  image={images[selectedImageIndex]} 
                  frame={selectedFrame}
                />
              )}
              
              <button 
                className="absolute top-4 right-4 p-2 bg-gray-100 hover:bg-gray-200 rounded-full transition-colors"
                onClick={toggleSettings}
              >
                <Settings className="h-5 w-5 text-gray-600" />
              </button>
            </div>
            
            <div className="w-full md:w-1/4 bg-gray-50 p-4 border-t md:border-t-0 md:border-l border-gray-200">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-medium">Screenshots</h3>
                <button
                  className="flex items-center text-sm text-blue-500 hover:text-blue-600"
                  onClick={() => document.getElementById('file-input')?.click()}
                >
                  <ImagePlus className="h-4 w-4 mr-1" />
                  Add more
                </button>
                <input
                  id="file-input"
                  type="file"
                  multiple
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) {
                      handleFilesSelected(Array.from(e.target.files));
                    }
                  }}
                />
              </div>
              
              <div className="overflow-y-auto max-h-[400px] space-y-3">
                {images.map((image, index) => (
                  <div 
                    key={index}
                    className={`flex items-center p-2 rounded-lg cursor-pointer transition-colors ${
                      selectedImageIndex === index ? 'bg-blue-50 border border-blue-200' : 'hover:bg-gray-100'
                    }`}
                    onClick={() => handleSelectImage(index)}
                  >
                    <div className="w-12 h-12 bg-gray-200 rounded-md overflow-hidden mr-3 flex-shrink-0">
                      <img 
                        src={URL.createObjectURL(image)} 
                        alt={`Preview ${index}`}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="flex-grow min-w-0">
                      <p className="text-sm truncate">{image.name}</p>
                      <p className="text-xs text-gray-500">
                        {Math.round(image.size / 1024)} KB
                      </p>
                    </div>
                    <button 
                      className="ml-2 p-1 text-gray-400 hover:text-red-500 rounded-full hover:bg-gray-200 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveImage(index);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              
              {selectedImageIndex !== null && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <button 
                    className="w-full py-2 px-4 bg-blue-500 hover:bg-blue-600 text-white rounded-lg flex items-center justify-center transition-colors"
                    onClick={() => {
                      document.getElementById('download-button')?.click();
                    }}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download Framed Image
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      
      {showSettings && (
        <FrameSettings 
          selectedFrame={selectedFrame}
          setSelectedFrame={setSelectedFrame}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
};

export default ScreenshotFramer;