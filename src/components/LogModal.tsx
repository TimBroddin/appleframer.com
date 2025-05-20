import React, { useEffect, useRef } from 'react';

interface LogModalProps {
  isOpen: boolean;
  onClose: () => void;
  logs: string;
}

const LogModal = ({ isOpen, onClose, logs }: LogModalProps) => {
  const logsRef = useRef<HTMLPreElement>(null);

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-lg max-w-lg w-full p-6 relative">
        <button
          className="absolute top-2 right-2 text-gray-400 hover:text-red-500"
          onClick={onClose}
        >
          ×
        </button>
        <h2 className="text-lg font-semibold mb-2">ffmpeg logs</h2>
        <pre 
          ref={logsRef}
          className="bg-gray-100 rounded p-2 text-xs max-h-96 overflow-y-auto whitespace-pre-wrap"
        >
          {logs || 'No logs yet.'}
        </pre>
      </div>
    </div>
  );
};

export default LogModal; 