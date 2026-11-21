import { BRAND, CHAPTERS } from '../core/content.ts';

interface Props {
  chapter: number;
  onJump: (index: number) => void;
  railRef: (el: HTMLElement | null) => void;
}

export function DropMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 32" aria-hidden>
      <path d="M12 1.5C12 1.5 3 12.6 3 20a9 9 0 0 0 18 0C21 12.6 12 1.5 12 1.5Z" />
      <path className="mx-mark__shine" d="M8.2 20.5a4.2 4.2 0 0 0 3.4 4.4" />
      <circle className="mx-mark__sun" cx="12" cy="20" r="2.4" />
    </svg>
  );
}

/** Minimal chrome: the brand and the chapter rail. The film itself carries the rest. */
export function Hud({ chapter, onJump, railRef }: Props) {
  return (
    <div className="mx-hud">
      <div className="mx-brand">
        <DropMark className="mx-brand__mark" />
        <span className="mx-brand__text">
          <strong>{BRAND}</strong>
          <small>Water · Land · Sun</small>
        </span>
      </div>

      <nav className="mx-rail" ref={railRef} aria-label="Chapters">
        <span className="mx-rail__track" aria-hidden><span className="mx-rail__fill" /></span>
        <ol>
          {CHAPTERS.map((item, i) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onJump(i)}
                aria-label={item.short}
                data-active={i === chapter || undefined}
                data-done={i < chapter || undefined}
                aria-current={i === chapter ? 'step' : undefined}
              >
                <span className="mx-rail__dot" aria-hidden />
                <span className="mx-rail__label">{item.short}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}
