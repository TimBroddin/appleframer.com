import { Moon, Sun } from 'lucide-react';
import { Theme } from '../hooks/useTheme';

export type ViewMode = 'sheet' | 'single';

interface HeaderProps {
  /** Batch summary shown beside the wordmark, e.g. "8 shots · 3 devices". */
  summary?: string;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  /** View toggle only makes sense once there is something to look at. */
  showViewToggle: boolean;
  theme: Theme;
  onToggleTheme: () => void;
}

const Header = ({
  summary,
  view,
  onViewChange,
  showViewToggle,
  theme,
  onToggleTheme,
}: HeaderProps) => (
  <header className="flex h-[54px] flex-none items-center justify-between border-b border-hairline bg-surface px-5">
    <div className="flex min-w-0 items-center gap-2.5">
      <a href="/" className="flex items-center gap-2.5">
        <img
          src="/icon.svg"
          alt=""
          width={22}
          height={22}
          className="h-[22px] w-[22px] flex-none rounded-md"
        />
        <span className="text-[15.5px] font-bold tracking-[-0.02em] text-ink">
          AppleFramer
        </span>
      </a>
      {summary && (
        <span className="ml-1.5 truncate pt-px font-mono text-[11.5px] leading-none text-ink-soft">
          {summary}
        </span>
      )}
    </div>

    <div className="flex flex-none items-center gap-2.5">
      {showViewToggle && (
        <span className="inline-flex gap-[3px] rounded-lg bg-surface-muted p-[3px] text-sm-minus">
          {(['sheet', 'single'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onViewChange(mode)}
              aria-pressed={view === mode}
              className={`rounded-md px-3 py-1.5 capitalize transition-colors ${
                view === mode
                  ? 'bg-surface font-semibold text-ink shadow-sm'
                  : 'text-ink-soft hover:text-ink'
              }`}
            >
              {mode}
            </button>
          ))}
        </span>
      )}

      <button
        type="button"
        onClick={onToggleTheme}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        className="rounded-lg bg-surface-muted p-2 text-ink-soft transition-colors hover:text-ink"
      >
        {theme === 'dark' ? (
          <Moon className="h-3.5 w-3.5" />
        ) : (
          <Sun className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  </header>
);

export default Header;
