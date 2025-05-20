import Header from './components/Header';
import ScreenshotFramer from './components/ScreenshotFramer';
import Footer from './components/Footer';
import { useFrames } from './hooks/useFrames';
import { Toaster } from 'sonner';
import { FfmpegProvider } from './contexts/FfmpegProvider';

function App() {
  const { frames, isLoading, error } = useFrames();



  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-gray-50 to-gray-100 text-gray-900">
      <FfmpegProvider>
      <Header />
      <main className="flex-grow container mx-auto px-4 py-8 flex items-center justify-center">
        <ScreenshotFramer
          frames={frames}
          isLoading={isLoading}
          error={error}
        />
      </main>
      <Footer />
      <Toaster richColors position="bottom-right" />
      </FfmpegProvider>
    </div>
  );
}

export default App;