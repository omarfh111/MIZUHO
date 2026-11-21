export function ReplayButton({ onReplay }: { onReplay: () => void }) {
  return (
    <button type="button" className="mx-replay" onClick={onReplay} aria-label="Replay the intro">
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M4 12a8 8 0 1 0 2.4-5.7" />
        <path d="M4 4v4.5h4.5" />
      </svg>
      <span>Replay intro</span>
    </button>
  );
}
