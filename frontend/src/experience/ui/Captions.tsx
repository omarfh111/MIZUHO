import type { CSSProperties } from 'react';
import { CHAPTERS } from '../core/content.ts';

interface Props {
  chapter: number;
  onEnter: () => void;
}

const state = (index: number, current: number) => (index === current ? 'active' : index < current ? 'past' : 'future');

/** Chapter copy. Lines reveal through masks; the frame keeps the copy's side quiet. */
export function Captions({ chapter, onEnter }: Props) {
  return (
    <div className="mx-captions" aria-live="polite">
      {CHAPTERS.map((item, index) => {
        const finale = index === CHAPTERS.length - 1;
        let word = 0;
        return (
          <section
            key={item.id}
            className={`mx-caption mx-caption--${item.side} ${item.tone === 'sun' ? 'mx-caption--sun' : ''} ${finale ? 'mx-caption--finale' : ''}`}
            data-state={state(index, chapter)}
            aria-hidden={index !== chapter}
          >
            <p className="mx-caption__eyebrow">
              <span className="mx-caption__index">{String(index + 1).padStart(2, '0')}</span>
              {item.eyebrow}
            </p>
            <h2 className="mx-caption__title">
              {item.title.map((line, l) => (
                <span key={l} className="mx-caption__line">
                  {(finale ? line.split('') : line.split(' ')).map((w, i) => (
                    <span key={i} className="mx-word">
                      <span style={{ '--i': word++ } as CSSProperties}>{w}</span>
                    </span>
                  ))}
                </span>
              ))}
            </h2>
            <p className="mx-caption__body">{item.body}</p>
            {finale ? (
              <button type="button" className="mx-enter" onClick={onEnter} tabIndex={index === chapter ? 0 : -1}>
                <span>Enter the observatory</span>
                <svg viewBox="0 0 24 24" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
