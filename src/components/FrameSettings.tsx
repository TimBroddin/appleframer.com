import React, { useState, useEffect, useCallback } from 'react';
import { X, Smartphone, RotateCcw } from 'lucide-react';
import { DeviceFrame, useFrames } from '../hooks/useFrames';

interface FrameSettingsProps {
  selectedFrame: DeviceFrame;
  setSelectedFrame: (frame: DeviceFrame) => void;
  onClose: () => void;
}

const FrameSettings = ({ 
  selectedFrame,
  setSelectedFrame,
  onClose 
}: FrameSettingsProps) => {
  const { frames, isLoading, error } = useFrames();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<string | null>(null);

  // Get unique categories
  const categories = Array.from(new Set(frames.map(frame => frame.category)));

  // Get models for selected category
  const modelsByCategory = React.useMemo(() => {
    return Array.from(new Set(
      frames
        .filter(frame => frame.category === selectedCategory)
        .map(frame => frame.model)
    ));
  }, [frames, selectedCategory]);

  // Get versions for selected model
  const versionsByModel = React.useMemo(() => {
    return Array.from(new Set(
      frames
        .filter(frame => 
          frame.category === selectedCategory && 
          frame.model === selectedModel
        )
        .map(frame => frame.version)
        .filter((version): version is string => version !== undefined)
    ));
  }, [frames, selectedCategory, selectedModel]);

  // Get variants for selected version
  const variantsByVersion = React.useMemo(() => {
    return Array.from(new Set(
      frames
        .filter(frame => 
          frame.category === selectedCategory && 
          frame.model === selectedModel &&
          (versionsByModel.length === 0 || frame.version === selectedVersion)
        )
        .map(frame => frame.variant)
        .filter((variant): variant is string => variant !== undefined)
    ));
  }, [frames, selectedCategory, selectedModel, selectedVersion, versionsByModel]);

  // Get orientations for selected variant
  const orientationsByVariant = React.useMemo(() => {
    return frames.filter(frame => 
      frame.category === selectedCategory && 
      frame.model === selectedModel &&
      (versionsByModel.length === 0 || frame.version === selectedVersion) &&
      frame.variant === selectedVariant &&
      frame.orientation
    );
  }, [frames, selectedCategory, selectedModel, selectedVersion, selectedVariant, versionsByModel]);


  const handleModelSelect = useCallback((model: string) => {
    setSelectedModel(model);
    setSelectedVersion(null);
    setSelectedVariant(null);
    
    // If there's only one version, select it automatically
    const versions = frames
      .filter(frame => frame.category === selectedCategory && frame.model === model)
      .map(frame => frame.version)
      .filter((version): version is string => version !== undefined);
    
    if (versions.length === 1) {
      setSelectedVersion(versions[0]);
    }
  }, [frames, selectedCategory]);

  const handleVersionSelect = useCallback((version: string) => {
    setSelectedVersion(version);
    setSelectedVariant(null);
    
    // If there's only one variant, select it automatically
    const variants = frames
      .filter(frame => 
        frame.category === selectedCategory && 
        frame.model === selectedModel &&
        frame.version === version
      )
      .map(frame => frame.variant)
      .filter((variant): variant is string => variant !== undefined);
    
    if (variants.length === 1) {
      setSelectedVariant(variants[0]);
    }
  }, [frames, selectedCategory, selectedModel]);

  const handleVariantSelect = useCallback((variant: string) => {
    setSelectedVariant(variant);
    
    // If there's only one orientation or no orientation needed, select the frame
    const matchingFrames = frames.filter(frame => 
      frame.category === selectedCategory && 
      frame.model === selectedModel &&
      (versionsByModel.length === 0 || frame.version === selectedVersion) &&
      frame.variant === variant
    );
    
    if (matchingFrames.length === 1) {
      setSelectedFrame(matchingFrames[0]);
    } else if (matchingFrames.length > 1) {
      // Prefer Portrait orientation if available
      const portraitFrame = matchingFrames.find(frame => frame.orientation === 'Portrait');
      if (portraitFrame) {
        setSelectedFrame(portraitFrame);
      } else {
        setSelectedFrame(matchingFrames[0]);
      }
    }
  }, [frames, selectedCategory, selectedModel, selectedVersion, versionsByModel, setSelectedFrame]);

  // Auto-select first options
  useEffect(() => {
    if (isLoading || error) return;

    // Auto-select first model if none selected
    if (modelsByCategory.length > 0 && !selectedModel) {
      handleModelSelect(modelsByCategory[0]);
    }
  }, [modelsByCategory, isLoading, error, selectedModel, handleModelSelect]);

  useEffect(() => {
    if (isLoading || error) return;

    // Auto-select first version if available
    if (versionsByModel.length > 0 && !selectedVersion) {
      handleVersionSelect(versionsByModel[0]);
    }
  }, [versionsByModel, isLoading, error, selectedVersion, handleVersionSelect]);

  useEffect(() => {
    if (isLoading || error) return;

    // Auto-select first variant if available
    if (variantsByVersion.length > 0 && !selectedVariant) {
      handleVariantSelect(variantsByVersion[0]);
    }
  }, [variantsByVersion, isLoading, error, selectedVariant, handleVariantSelect]);

  useEffect(() => {
    if (isLoading || error) return;

    // Auto-select first orientation if available
    if (orientationsByVariant.length === 1) {
      setSelectedFrame(orientationsByVariant[0]);
    } else if (orientationsByVariant.length > 1) {
      const portraitOption = orientationsByVariant.find(frame => frame.orientation === 'Portrait');
      if (portraitOption) {
        setSelectedFrame(portraitOption);
      } else {
        setSelectedFrame(orientationsByVariant[0]);
      }
    }
  }, [orientationsByVariant, isLoading, error, setSelectedFrame]);

  // Sync state with selectedFrame when modal opens or selectedFrame changes
  useEffect(() => {
    if (selectedFrame) {
      setSelectedCategory(selectedFrame.category || null);
      setSelectedModel(selectedFrame.model || null);
      setSelectedVersion(selectedFrame.version || null);
      setSelectedVariant(selectedFrame.variant || null);
    }
  }, [selectedFrame]);

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-20 animate-fadeIn">
        <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-8 mx-4 animate-slideUp">
          <p className="text-center text-gray-500">Loading available frames...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-20 animate-fadeIn">
        <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-8 mx-4 animate-slideUp">
          <p className="text-center text-red-500">Error loading frames: {error}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-20 animate-fadeIn">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-8 mx-4 animate-slideUp">
        <div className="flex justify-between items-center mb-8">
          <h3 className="text-xl font-medium">Frame Settings</h3>
          <button 
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-full transition-colors"
          >
            <X className="h-6 w-6 text-gray-500" />
          </button>
        </div>
        
        <div className="space-y-8">
          {/* Device Category Selection */}
          <div>
            <h4 className="font-medium mb-4 text-lg">Device Type</h4>
            <div className="grid grid-cols-4 gap-4">
              {categories.map((category) => (
                <button
                  key={category}
                  className={`p-4 rounded-lg border ${
                    selectedCategory === category 
                      ? 'border-blue-500 bg-blue-50' 
                      : 'border-gray-200 hover:bg-gray-50'
                  } transition-colors text-base`}
                  onClick={() => {
                    setSelectedCategory(category);
                    setSelectedModel(null);
                    setSelectedVersion(null);
                    setSelectedVariant(null);
                  }}
                >
                  {category}
                </button>
              ))}
            </div>
          </div>

          {/* Device Model Selection */}
          {modelsByCategory.length > 0 && (
            <div>
              <h4 className="font-medium mb-4 text-lg">Device Model</h4>
              <div className="grid grid-cols-2 gap-4 max-h-56 overflow-y-auto pr-2">
                {modelsByCategory.map((model) => (
                  <button
                    key={model}
                    className={`p-4 rounded-lg border text-left ${
                      selectedModel === model
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:bg-gray-50'
                    } transition-colors`}
                    onClick={() => handleModelSelect(model)}
                  >
                    {model}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Version Selection */}
          {selectedModel && versionsByModel.length > 0 && (
            <div>
              <h4 className="font-medium mb-4 text-lg">Version</h4>
              <div className="grid grid-cols-2 gap-4">
                {versionsByModel.map((version) => (
                  <button
                    key={version}
                    className={`p-4 rounded-lg border text-left ${
                      selectedVersion === version
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:bg-gray-50'
                    } transition-colors`}
                    onClick={() => handleVersionSelect(version)}
                  >
                    {version}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Variant Selection */}
          {variantsByVersion.length > 0 && (
            <div>
              <h4 className="font-medium mb-4 text-lg">Model</h4>
              <div className="grid grid-cols-2 gap-4">
                {variantsByVersion.map((variant) => (
                  <button
                    key={variant}
                    className={`p-4 rounded-lg border text-left ${
                      selectedVariant === variant
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:bg-gray-50'
                    } transition-colors`}
                    onClick={() => handleVariantSelect(variant)}
                  >
                    {variant}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Orientation Selection */}
          {selectedVariant && orientationsByVariant.length > 1 && (
            <div>
              <h4 className="font-medium mb-4 text-lg">Orientation</h4>
              <div className="grid grid-cols-2 gap-4">
                {orientationsByVariant.map((frame) => (
                  <button
                    key={frame.id}
                    className={`flex items-center justify-center p-4 rounded-lg ${
                      selectedFrame.id === frame.id
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                    } transition-colors`}
                    onClick={() => setSelectedFrame(frame)}
                  >
                    {frame.orientation === 'Portrait' ? (
                      <Smartphone className="h-5 w-5 mr-2" />
                    ) : (
                      <RotateCcw className="h-5 w-5 mr-2" />
                    )}
                    <span className="text-base">{frame.orientation}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        
        <div className="mt-8 pt-6 border-t border-gray-200 flex gap-4">
          <button
            onClick={onClose}
            className="w-full py-3 px-4 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors text-base font-medium"
          >
            Apply Settings
          </button>
        </div>
      </div>
    </div>
  );
};

export default FrameSettings;