import { useCallback, useState } from 'react';
import { Toaster } from 'sonner';
import Header, { ViewMode } from './components/Header';
import ScreenshotFramer from './components/ScreenshotFramer';
import Footer from './components/Footer';
import { useFrames } from './hooks/useFrames';
import { useTheme } from './hooks/useTheme';

function App() {
  const { frames, isLoading, error } = useFrames();
  const { theme, toggleTheme } = useTheme();
  const [view, setView] = useState<ViewMode>('sheet');
  const [summary, setSummary] = useState<string | undefined>(undefined);
  const [hasItems, setHasItems] = useState(false);

  // Stable identities keep the child's summary effect from re-firing.
  const handleSummaryChange = useCallback((next: string | undefined) => {
    setSummary(next);
  }, []);
  const handleHasItemsChange = useCallback((next: boolean) => {
    setHasItems(next);
  }, []);

  return (
    // A fixed app shell in both states: with images the panes scroll
    // independently, and the landing page is laid out to fit one screen with
    // its copy column scrolling on its own if it needs to. min-h-screen on
    // small viewports so a stacked landing page can still grow.
    <div
      className={`flex flex-col bg-canvas text-ink ${
        hasItems ? 'h-screen' : 'min-h-screen lg:h-screen'
      }`}
    >
      <Header
        summary={summary}
        view={view}
        onViewChange={setView}
        showViewToggle={hasItems}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <main className="flex min-h-0 flex-1 flex-col">
        <ScreenshotFramer
          frames={frames}
          isLoading={isLoading}
          error={error}
          view={view}
          onSummaryChange={handleSummaryChange}
          onHasItemsChange={handleHasItemsChange}
        />
      </main>
      <Footer />
      <Toaster
        richColors
        position="bottom-right"
        theme={theme}
        toastOptions={{ style: { fontFamily: 'Archivo, system-ui, sans-serif' } }}
      />
    </div>
  );
}

export default App;
