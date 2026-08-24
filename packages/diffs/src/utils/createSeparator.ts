import type { ElementContent, Element as HASTElement } from 'hast';

import type { ExpansionDirections, HunkSeparators } from '../types';
import {
  createHastElement,
  createIconElement,
  createTextNodeElement,
} from './hast_utils';

interface CreateSeparatorProps {
  type: HunkSeparators;
  content?: string;
  expandIndex?: number;
  chunked?: boolean;
  slotName?: string;
  isFirstHunk: boolean;
  isLastHunk: boolean;
}

function createExpandButton(type: ExpansionDirections) {
  return createHastElement({
    tagName: 'div',
    children: [
      createIconElement({
        name: type === 'both' ? 'diffs-icon-expand-all' : 'diffs-icon-expand',
        properties: { 'data-icon': '' },
      }),
    ],
    properties: {
      role: 'button',
      'data-expand-button': '',
      'data-expand-both': type === 'both' ? '' : undefined,
      'data-expand-up': type === 'up' ? '' : undefined,
      'data-expand-down': type === 'down' ? '' : undefined,
    },
  });
}

export function createSeparator({
  type,
  content,
  expandIndex,
  chunked = false,
  slotName,
  isFirstHunk,
  isLastHunk,
}: CreateSeparatorProps): HASTElement {
  let buttonCount = 0;
  const children = [];
  if (type === 'metadata' && content != null) {
    children.push(
      createHastElement({
        tagName: 'div',
        children: [createTextNodeElement(content)],
        properties: { 'data-separator-wrapper': '' },
      })
    );
  }
  if ((type === 'line-info' || type === 'line-info-basic') && content != null) {
    const contentChildren: ElementContent[] = [];
    if (expandIndex != null) {
      if (!chunked) {
        contentChildren.push(
          createExpandButton(
            !isFirstHunk && !isLastHunk ? 'both' : isFirstHunk ? 'down' : 'up'
          )
        );
        buttonCount++;
      } else {
        if (!isFirstHunk) {
          contentChildren.push(createExpandButton('up'));
          buttonCount++;
        }
        if (!isLastHunk) {
          contentChildren.push(createExpandButton('down'));
          buttonCount++;
        }
      }
    }
    contentChildren.push(
      createHastElement({
        tagName: 'div',
        children: [
          createHastElement({
            tagName: 'span',
            children: [createTextNodeElement(content)],
            properties: { 'data-unmodified-lines': '' },
          }),
        ],
        properties: { 'data-separator-content': '' },
      })
    );
    if (chunked && expandIndex != null) {
      contentChildren.push(
        createHastElement({
          tagName: 'div',
          children: [createTextNodeElement('Expand all')],
          properties: {
            role: 'button',
            'data-expand-button': '',
            'data-expand-all-button': '',
          },
        })
      );
    }
    children.push(
      createHastElement({
        tagName: 'div',
        children: contentChildren,
        properties: {
          'data-separator-wrapper': '',
          'data-separator-multi-button': buttonCount > 1 ? '' : undefined,
        },
      })
    );
  }
  if (type === 'custom' && slotName != null) {
    const slot = createHastElement({
      tagName: 'slot',
      properties: { name: slotName },
    });
    if (expandIndex != null) {
      // The host owns the separator's appearance via the slotted element, but
      // Pierre still routes the click: wrap the slot in an expand-button region
      // so a click anywhere on the host's element resolves to this fold's
      // expand action (the outer wrapper already carries `data-expand-index`).
      // Direction is derived from the fold's position exactly as the built-in
      // button does — above→down, below→up, interior→both.
      const direction: ExpansionDirections =
        !isFirstHunk && !isLastHunk ? 'both' : isFirstHunk ? 'down' : 'up';
      children.push(
        createHastElement({
          tagName: 'div',
          children: [slot],
          properties: {
            role: 'button',
            'data-expand-button': '',
            'data-expand-up': direction === 'up' ? '' : undefined,
            'data-expand-down': direction === 'down' ? '' : undefined,
            'data-expand-both': direction === 'both' ? '' : undefined,
          },
        })
      );
    } else {
      children.push(slot);
    }
  }
  return createHastElement({
    tagName: 'div',
    children,
    properties: {
      'data-separator': children.length === 0 ? 'simple' : type,
      'data-expand-index': expandIndex,
      'data-separator-first': isFirstHunk ? '' : undefined,
      'data-separator-last': isLastHunk ? '' : undefined,
    },
  });
}
