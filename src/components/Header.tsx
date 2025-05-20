import React from 'react';
import { Smartphone } from 'lucide-react';

const Header = () => {
  return (
    <header className="bg-white/80 backdrop-blur-md shadow-sm sticky top-0 z-10">
      <div className="container mx-auto px-4 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Smartphone className="h-6 w-6 text-blue-500" />
          <h1 className="text-xl font-medium">AppleFramer</h1>
        </div>
        <div className="text-sm text-gray-500">
          Process locally • No uploads
        </div>
      </div>
    </header>
  );
};

export default Header;