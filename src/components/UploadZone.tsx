import React, { useState, useRef } from 'react';
import { Upload, Image as ImageIcon } from 'lucide-react';

interface UploadZoneProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
}

const UploadZone = ({ onFilesSelected, accept = "image/*" }: UploadZoneProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFilesSelected(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(Array.from(e.target.files));
    }
  };

  const handleButtonClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div 
      className={`flex flex-col items-center justify-center p-12 transition-all duration-300 min-h-[500px] 
      ${isDragging ? 'bg-blue-50 border-blue-300' : 'bg-gray-50 border-gray-200'} 
      border-2 border-dashed rounded-lg`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={`mb-6 p-6 rounded-full ${isDragging ? 'bg-blue-100' : 'bg-gray-100'} transition-colors duration-300`}>
        <Upload className={`h-12 w-12 ${isDragging ? 'text-blue-500' : 'text-gray-400'}`} />
      </div>
      
      <h2 className="text-xl font-medium mb-2">Upload Apple Device Screenshots</h2>
      <p className="text-gray-500 text-center max-w-md mb-6">
        Drag and drop your Apple device screenshots here, or click to browse your files. 
        All processing happens locally - your images never leave your device.
      </p>
      
      <div className="flex flex-wrap justify-center gap-3">
        <button
          className="py-2 px-6 bg-blue-500 hover:bg-blue-600 text-white rounded-lg flex items-center transition-colors"
          onClick={handleButtonClick}
        >
          <ImageIcon className="h-4 w-4 mr-2" />
          Browse files
        </button>
      </div>
      
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={handleFileInputChange}
      />
      
      <div className="mt-10 text-sm text-gray-400 max-w-sm text-center">
        <p>Supported formats: PNG, JPG, JPEG, WebP</p>
        <p className="mt-1">Max file size: 10MB per image</p>
      </div>
    </div>
  );
};

export default UploadZone;