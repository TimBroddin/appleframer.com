import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';
import {
  FIELD_TOKENS,
  NameToken,
  SEPARATOR_TOKENS,
  TokenKind,
} from '../lib/filename';

interface NamingComposerProps {
  tokens: NameToken[];
  onChange: (tokens: NameToken[]) => void;
  /** Rendered filename for the first image, shown beneath the composer. */
  preview: string;
}

const isLiteral = (kind: TokenKind) => kind === 'separator' || kind === 'text';

/**
 * Filename tokens as removable chips, replacing the previous wall of
 * append-only buttons. Chips can be removed individually, which the old
 * free-text field could only do by editing the raw pattern string.
 */
const NamingComposer = ({ tokens, onChange, preview }: NamingComposerProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [literal, setLiteral] = useState('');

  const menuRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const MENU_WIDTH = 176;

  // Portaled for the same reason as the device popover: the inspector column
  // scrolls, which would clip a menu positioned inside it.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const place = () => {
      const trigger = menuRef.current?.getBoundingClientRect();
      if (!trigger) return;
      setPosition({
        top: Math.max(8, trigger.top - 6),
        left: Math.max(
          8,
          Math.min(trigger.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)
        ),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [menuOpen]);

  // Close on Escape or on a pointer press outside. A full-screen click-away
  // overlay would be simpler but sits in the same stacking context as the
  // menu, where it intercepts clicks on the menu's own options.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The menu is portaled, so it is not inside menuRef.
      if (menuRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuOpen]);

  const addToken = (token: NameToken) => {
    onChange([...tokens, token]);
    setMenuOpen(false);
  };

  const removeToken = (index: number) => {
    onChange(tokens.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
        naming
      </div>

      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-hairline p-2.5">
        {tokens.map((token, index) => (
          <span
            key={`${token.kind}-${index}`}
            className={
              isLiteral(token.kind)
                ? 'font-mono text-xs-plus text-ink-faint'
                : 'group inline-flex items-center gap-1 rounded-md bg-accent-wash px-2 py-0.5 font-mono text-xs-plus text-accent-deep'
            }
          >
            {isLiteral(token.kind) ? (
              <button
                type="button"
                onClick={() => removeToken(index)}
                title="Remove"
                className="rounded px-0.5 hover:text-danger"
              >
                {token.value === ' ' ? '␣' : token.value}
              </button>
            ) : (
              <>
                {token.kind}
                <button
                  type="button"
                  onClick={() => removeToken(index)}
                  title={`Remove ${token.kind}`}
                  className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </>
            )}
          </span>
        ))}

        <span className="h-3 w-px animate-af-pulse bg-accent" aria-hidden="true" />

        <div className="relative ml-auto" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-hairline px-2 py-0.5 font-mono text-xs-plus text-ink-soft transition-colors hover:border-accent hover:text-accent"
          >
            <Plus className="h-3 w-3" />
            add
          </button>

          {menuOpen &&
            createPortal(
              <div
                ref={panelRef}
                style={{
                  top: position.top,
                  left: position.left,
                  width: MENU_WIDTH,
                  transform: 'translateY(-100%)',
                }}
                className="fixed z-50 animate-fadeIn rounded-lg border border-hairline bg-surface p-1.5 shadow-panel"
              >
                <div className="px-1.5 pb-1 font-mono text-2xs uppercase tracking-[0.12em] text-ink-faint">
                  field
                </div>
                {FIELD_TOKENS.map((token) => (
                  <button
                    key={token.kind}
                    type="button"
                    onClick={() => addToken({ kind: token.kind })}
                    className="block w-full rounded px-1.5 py-1 text-left font-mono text-xs-plus text-ink hover:bg-accent-wash hover:text-accent-deep"
                  >
                    {token.label}
                  </button>
                ))}
                <div className="mt-1 border-t border-hairline px-1.5 pb-1 pt-1.5 font-mono text-2xs uppercase tracking-[0.12em] text-ink-faint">
                  separator
                </div>
                <div className="flex flex-wrap gap-1 px-0.5">
                  {SEPARATOR_TOKENS.map((sep) => (
                    <button
                      key={sep.label}
                      type="button"
                      title={sep.label}
                      onClick={() => addToken({ kind: 'separator', value: sep.value })}
                      className="rounded border border-hairline px-2 py-0.5 font-mono text-xs-plus text-ink-soft hover:border-accent hover:text-accent"
                    >
                      {sep.value === ' ' ? '␣' : sep.value}
                    </button>
                  ))}
                </div>

                {/* Without this the default "framed" prefix is unrecoverable
                    once removed: the token list persists immediately, so the
                    only way back was clearing localStorage. */}
                <div className="mt-1 border-t border-hairline px-1.5 pb-1 pt-1.5 font-mono text-2xs uppercase tracking-[0.12em] text-ink-faint">
                  text
                </div>
                <form
                  className="flex gap-1 px-0.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const value = literal.trim();
                    if (!value) return;
                    addToken({ kind: 'text', value });
                    setLiteral('');
                  }}
                >
                  <input
                    value={literal}
                    onChange={(event) => setLiteral(event.target.value)}
                    placeholder="e.g. framed"
                    aria-label="Custom text"
                    className="w-full min-w-0 rounded border border-hairline bg-transparent px-1.5 py-1 font-mono text-xs-plus text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!literal.trim()}
                    className="flex-none rounded border border-hairline px-2 font-mono text-xs-plus text-ink-soft hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    add
                  </button>
                </form>
              </div>,
              document.body
            )}
        </div>
      </div>

      <div className="truncate font-mono text-xs-plus text-ink-soft" title={`${preview}.png`}>
        {preview}.png
      </div>
    </div>
  );
};

export default NamingComposer;
