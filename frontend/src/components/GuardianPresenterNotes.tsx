import { useRef, useState } from 'react';

const maxNotesLength = 4000;
export type NotesLanguage = 'en' | 'ja' | 'aeb' | 'fr';

export default function GuardianPresenterNotes({ saved, savedLanguage, disabled, connectedModel, apply }: {
  saved: string; savedLanguage: NotesLanguage; disabled: boolean; connectedModel: boolean;
  apply: (notes: string, language: NotesLanguage) => void;
}) {
  const [draft, setDraft] = useState(saved);
  const [language, setLanguage] = useState(savedLanguage);
  const [error, setError] = useState('');
  const fileRead = useRef(0);

  async function loadFile(file?: File) {
    const revision = ++fileRead.current;
    if (!file) return;
    setError('');
    const invalid = 'Choose a plain text or Markdown file with up to 4,000 characters.';
    if (!/\.(?:txt|md)$/i.test(file.name) || file.size > maxNotesLength * 4 + 3) {
      setError(invalid);
      return;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (revision !== fileRead.current) return;
      if (text.length > maxNotesLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) setError(invalid);
      else setDraft(text);
    } catch {
      if (revision === fileRead.current) setError(invalid);
    }
  }

  return <details className="guardian-review"><summary>Presenter notes</summary>
    <form onSubmit={event => { event.preventDefault(); apply(draft.trim(), language); }}>
      <p className="guardian-note">The project briefing is ready. To personalize it, share your audience, talking points or closing line with the voice model for this session.</p>
      <label className="field"><span>Your speaking notes</span>
        <textarea rows={3} maxLength={maxNotesLength} dir="auto" value={draft} disabled={disabled}
          onChange={event => { fileRead.current++; setError(''); setDraft(event.target.value); }} /></label>
      <label className="field"><span>Import notes (.txt or .md)</span>
        <input type="file" accept=".txt,.md,text/plain,text/markdown" disabled={disabled} onChange={event => {
          void loadFile(event.target.files?.[0]); event.target.value = '';
        }} /></label>
      <label className="field"><span>Language of your notes</span>
        <select value={language} disabled={disabled} onChange={event => setLanguage(event.target.value as NotesLanguage)}>
          <option value="en" lang="en" translate="no">English</option><option value="ja" lang="ja" translate="no">日本語</option>
          <option value="aeb" lang="aeb-TN" translate="no">تونسي</option><option value="fr" lang="fr" translate="no">Français</option>
        </select></label>
      {error && <p className="guardian-note" role="alert">{error}</p>}
      {!connectedModel && <p className="guardian-note">The project briefing and your original script are available offline. Translation and personalized wording need the connected model.</p>}
      <button type="submit" className="button button-secondary" disabled={disabled || !draft.trim() || (draft.trim() === saved && language === savedLanguage)}>Use these notes</button>
      {saved && <><small className="guardian-note" role="status">Notes attached to this session</small>
        <small className="guardian-note">Say “Read my notes” to present your own script. Say “Continue” for the next passage.</small>
        <button type="button" className="text-button" disabled={disabled} onClick={() => {
          fileRead.current++; setError(''); setDraft(''); apply('', language);
        }}>Remove notes</button></>}
    </form>
  </details>;
}
