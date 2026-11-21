function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function explanationPanel(getSnapshot) {
  const panel = make('article', '', 'card output-card full-card explanation-panel');
  const heading = make('div', '', 'item-title');
  const title = make('h2', 'Results explained');
  const button = make('button', 'Explain metrics', 'secondary');
  button.type = 'button';
  heading.append(title, button);
  const details = make('p', 'Uses calculated evidence from this result.', 'caption');
  const output = make('div');
  output.setAttribute('role', 'status');
  panel.append(heading, details, output);

  button.addEventListener('click', async () => {
    const { id, context } = getSnapshot();
    if (!id) return;
    button.disabled = true;
    output.replaceChildren(make('p', 'Preparing explanation…', 'hint'));
    try {
      const response = await fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ explanation_id: id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not explain this result.');
      const label = result.mode === 'nvidia' ? `NVIDIA · ${result.model}` : 'Local explanation';
      const items = make('ul', '', 'explain-facts');
      for (const evidence of result.evidence) items.append(make('li', evidence));
      output.replaceChildren(make('p', context ? `${label} · ${context}` : label, 'explain-source'),
        make('p', result.summary), items);
      if (result.note) output.append(make('p', result.note, 'hint'));
    } catch (error) {
      output.replaceChildren(make('p', error.message, 'hint'));
    } finally {
      button.disabled = false;
    }
  });
  return panel;
}
