import { jsxDEV as createNode } from 'react/jsx-dev-runtime';
import { localizedType } from './render.ts';
export { Fragment } from 'react/jsx-dev-runtime';
export type { JSX } from 'react/jsx-dev-runtime';

export const jsxDEV: typeof createNode = (type, ...args) => createNode(localizedType(type), ...args);
