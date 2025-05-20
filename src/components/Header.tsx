import { Smartphone } from 'lucide-react';

const Header = () => {
  return (
    <header className="bg-white/80 backdrop-blur-md shadow-sm sticky top-0 z-10">
      <div className="container mx-auto px-4 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <h1 className="text-xl font-medium">
          <a href="/" className="flex items-center gap-2">          
            <Smartphone className="h-6 w-6 text-blue-500" />

            AppleFramer
            </a>  
            </h1>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">Process locally • No uploads • Download as zip • <a href="https://github.com/timbroddin/appleframer.com" target="_blank" className="text-blue-500 hover:text-blue-600">Open source</a></span>
           
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;