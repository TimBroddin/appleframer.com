import React from 'react';
import Header from './components/Header';
import ScreenshotFramer from './components/ScreenshotFramer';
import Footer from './components/Footer';

function App() {
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-gray-50 to-gray-100 text-gray-900">
      <Header />
      <main className="flex-grow container mx-auto px-4 py-8 flex items-center justify-center">
        <ScreenshotFramer />
      </main>
      <Footer />
    </div>
  );
}

export default App;