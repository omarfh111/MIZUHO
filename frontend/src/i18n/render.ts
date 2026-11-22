import { Fragment, type ElementType, type ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';
import { translate, useLanguage } from './language.ts';

// Only DOM elements that can carry interface text or accessible descriptions participate.
// Three.js objects, SVG geometry, input values, IDs and user records pass through unchanged.
const elements = new Set(('a article aside b button caption code dd details div dl dt em fieldset figcaption figure footer form ' +
  'g h1 h2 h3 h4 h5 header i img input label legend li main nav ol optgroup option output p progress section select ' +
  'small span strong summary svg table tbody td text textarea th thead time title tr ul').split(' '));
const attributes = ['aria-label', 'aria-description', 'aria-valuetext', 'placeholder', 'alt', 'title', 'label'];
type HostProps = Record<string, unknown> & { children?: ReactNode };
const localized = new Map<ElementType, ElementType>();

function japaneseChildren(children: ReactNode): ReactNode {
  if (typeof children === 'string') return translate(children, 'ja');
  if (!Array.isArray(children)) return children;
  const output: ReactNode[] = [...children];
  // React uses the slot of an unkeyed child to preserve its component state. Combining
  // translated text must never shift the position of a form, a scene or a result panel.
  for (let start = 0; start < children.length;) {
    if (typeof children[start] !== 'string' && typeof children[start] !== 'number') {
      output[start] = japaneseChildren(children[start]);
      start++;
      continue;
    }
    let end = start + 1;
    while (end < children.length && (typeof children[end] === 'string' || typeof children[end] === 'number')) end++;
    const fragments = children.slice(start, end);
    const sentence = fragments.join('');
    const translated = translate(sentence, 'ja');
    const result = translated !== sentence ? translated : fragments.map(fragment => typeof fragment === 'string' ? translate(fragment, 'ja') : fragment).join('');
    if (start === 0 && end === children.length) return result;
    output[start] = result;
    output.fill(null, start + 1, end);
    start = end;
  }
  return output;
}

export function localizedType(type: ElementType): ElementType {
  if (type !== Fragment && (typeof type !== 'string' || !elements.has(type))) return type;
  let component = localized.get(type);
  if (!component) {
    function LocalizedElement(props: HostProps) {
      const language = useLanguage();
      if (language === 'en' || props.translate === 'no') return jsx(type, props);
      const translated: HostProps = { ...props, children: japaneseChildren(props.children) };
      for (const name of attributes) {
        if (typeof props[name] === 'string') translated[name] = translate(props[name], language);
      }
      if (type === 'option' && props.value === undefined && typeof props.children === 'string') {
        translated.value = props.children;
      }
      return jsx(type, translated);
    }
    component = LocalizedElement;
    localized.set(type, component);
  }
  return component;
}
