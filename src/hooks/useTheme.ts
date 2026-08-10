import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem('theme');
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Light/dark theme, persisted to localStorage. The initial class is applied by
 * an inline script in index.html to avoid a flash of the wrong palette; this
 * hook keeps React in sync with that and handles toggling.
 *
 * An explicit choice is stored separately from the resolved theme. Persisting
 * the inferred system value would turn a first visit into a permanent
 * preference and stop the app following the OS from then on.
 */
export function useTheme() {
  const [explicit, setExplicit] = useState<Theme | null>(() => readStoredTheme());
  const [system, setSystem] = useState<Theme>(systemTheme);

  const theme = explicit ?? system;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // Only an explicit choice is written; nothing is stored until the user acts.
  useEffect(() => {
    if (!explicit) return;
    try {
      localStorage.setItem('theme', explicit);
    } catch {
      // Private browsing — the theme still applies for this session.
    }
  }, [explicit]);

  // Track the OS for as long as there is no explicit choice, so a system
  // change mid-session (or between visits) is still picked up.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) =>
      setSystem(event.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((next: Theme) => setExplicit(next), []);
  const toggleTheme = useCallback(
    () => setExplicit((prev) => ((prev ?? systemTheme()) === 'dark' ? 'light' : 'dark')),
    []
  );

  return { theme, setTheme, toggleTheme };
}
