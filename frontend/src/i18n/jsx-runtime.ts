import { jsx as createNode, jsxs as createNodes } from 'react/jsx-runtime';
import { localizedType } from './render.ts';
export { Fragment } from 'react/jsx-runtime';
export type { JSX } from 'react/jsx-runtime';

export const jsx: typeof createNode = (type, props, key) => createNode(localizedType(type), props, key);
export const jsxs: typeof createNodes = (type, props, key) => createNodes(localizedType(type), props, key);
