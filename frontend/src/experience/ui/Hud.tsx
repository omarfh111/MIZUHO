import { BRAND, CHAPTERS, HONESTY_NOTE } from '../core/content.ts';

interface Props {
  chapter: number;
  autoplay: boolean;
  touch: boolean;
  onJump: (index: number) => void;
  onToggleAutoplay: () => void;
  railRef: (el: HTMLElement | null) => void;
  coordinatesRef: (el: HTMLElement | null) => void;
  showCoordinates: boolean;
}

export function DropMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 32" aria-hidden>
      <path d="M12 1.5C12 1.5 3 12.6 3 20a9 9 0 0 0 18 0C21 12.6 12 1.5 12 1.5Z" />
      <path className="mx-mark__shine" d="M8.2 20.5a4.2 4.2 0 0 0 3.4 4.4" />
    </svg>
  );
}

export function Hud({ chapter, autoplay, touch, onJump, onToggleAutoplay, railRef, coordinatesRef, showCoordinates }: Props) {
  const last = CHAPTERS.length - 1;
  return (
    <div className="mx-hud">
      <div className="mx-brand">
        <DropMark className="mx-brand__mark" />
        <span className="mx-brand__text">
          <strong>{BRAND}</strong>
          <small>Tunisia · Water &amp; agriculture</small>
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

      <div className="mx-controls">
        <button type="button" className="mx-play" onClick={onToggleAutoplay} aria-pressed={autoplay}>
          {autoplay ? (
            <svg viewBox="0 0 24 24" aria-hidden><path d="M8 5v14M16 5v14" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden><path d="M7 4.5v15l12-7.5z" /></svg>
          )}
          <span>{autoplay ? 'Pause' : 'Play'}</span>
        </button>
        <p className="mx-hint" data-hidden={chapter >= last || undefined}>
          {touch ? 'Swipe to follow the drop' : 'Scroll to follow the drop'}
          <span className="mx-hint__wheel" aria-hidden />
        </p>
        <p className="mx-hint mx-hint--lamp" data-show={(chapter === 4 || chapter === 5) && !touch ? true : undefined}>
          Move your cursor to water the fields
        </p>
      </div>

      <div className="mx-readout">
        {showCoordinates ? (
          <p className="mx-readout__coords">
            <span>Camera target</span>
            <output ref={coordinatesRef}>—</output>
          </p>
        ) : null}
        <p className="mx-readout__note">{HONESTY_NOTE}</p>
      </div>
    </div>
  );
}
