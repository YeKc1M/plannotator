/**
 * Published HtmlSurfaceControls (DOM-gated): the pen/eye/refresh markup
 * hosts share with Plannotator's header.
 *
 * Failures to catch: a control rendering without its handler (a read-only
 * document must show no pen), the pen losing its pressed state or its
 * pixel-stable border, the refresh going inert or dropping focus while in
 * flight, the compact shell rendering chrome, and the label overrides not
 * reaching the DOM. The default strings are pinned on purpose (see below).
 */
import React, { act } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_HTML_SURFACE_CONTROL_LABELS, HtmlSurfaceControls } from './HtmlSurfaceControls';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(props: Partial<React.ComponentProps<typeof HtmlSurfaceControls>> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <HtmlSurfaceControls
        armed
        onToggleArmed={() => {}}
        toolsHidden={false}
        onToggleTools={() => {}}
        canRefresh
        onRefresh={() => {}}
        isRefreshing={false}
        {...props}
      />,
    );
  });
  return container;
}

const pen = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-html-annotate-toggle]');
const eye = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-html-tools-toggle]');
const refresh = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-html-refresh]');

describe.if(hasDom)('HtmlSurfaceControls', () => {
  test('each control renders only with its handler; the eye renders even without refresh', () => {
    const full = render();
    expect(pen(full)).not.toBeNull();
    expect(eye(full)).not.toBeNull();
    expect(refresh(full)).not.toBeNull();
    // Order: eye group (refresh, eye) then the pen.
    const buttons = Array.from(full.querySelectorAll('button')).map((b) => b.dataset);
    expect(buttons.map((d) => Object.keys(d)[0])).toEqual(['htmlRefresh', 'htmlToolsToggle', 'htmlAnnotateToggle']);

    act(() => root?.unmount());
    const readOnly = render({ onToggleArmed: undefined, canRefresh: false });
    expect(pen(readOnly)).toBeNull();
    expect(refresh(readOnly)).toBeNull();
    expect(eye(readOnly)).not.toBeNull();

    // A host without the tools toggle still gets the refresh it asked for:
    // the documented contract is canRefresh + onRefresh, not the eye.
    act(() => root?.unmount());
    const noTools = render({ onToggleTools: undefined });
    expect(eye(noTools)).toBeNull();
    expect(refresh(noTools)).not.toBeNull();
    expect(pen(noTools)).not.toBeNull();

    act(() => root?.unmount());
    const refreshOnly = render({ onToggleTools: undefined, onToggleArmed: undefined });
    expect(refreshOnly.querySelectorAll('button').length).toBe(1);
    expect(refresh(refreshOnly)).not.toBeNull();

    act(() => root?.unmount());
    const nothing = render({ onToggleTools: undefined, onToggleArmed: undefined, canRefresh: false });
    expect(nothing.childElementCount).toBe(0);
  });

  test('the refresh fires its handler without the eye present', () => {
    let refreshes = 0;
    const el = render({ onToggleTools: undefined, onRefresh: () => { refreshes += 1; } });
    act(() => refresh(el)!.click());
    expect(refreshes).toBe(1);
  });

  test('compact renders nothing', () => {
    const el = render({ compact: true });
    expect(el.childElementCount).toBe(0);
  });

  test('the pen reports aria-pressed and keeps a border of the same width in both states', () => {
    let toggles = 0;
    const armed = render({ armed: true, onToggleArmed: () => { toggles += 1; } });
    const armedPen = pen(armed)!;
    expect(armedPen.getAttribute('aria-pressed')).toBe('true');
    expect(armedPen.className).toContain('border-primary/60');
    act(() => armedPen.click());
    expect(toggles).toBe(1);

    act(() => root?.unmount());
    const interact = render({ armed: false });
    const interactPen = pen(interact)!;
    expect(interactPen.getAttribute('aria-pressed')).toBe('false');
    // Transparent border, same width: the box is pixel-identical.
    expect(interactPen.className).toContain('border-transparent');
    expect(interactPen.className).toContain(' border ');
    expect(armedPen.className).toContain(' border ');
  });

  test('an in-flight refresh ignores clicks without dropping focus; the eye reports pressed when hidden', () => {
    let refreshes = 0;
    const el = render({ isRefreshing: true, toolsHidden: true, onRefresh: () => { refreshes += 1; } });
    const button = refresh(el)!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    button.focus();
    act(() => button.click());
    expect(refreshes).toBe(0);
    expect(document.activeElement).toBe(button);
    expect(eye(el)!.getAttribute('aria-pressed')).toBe('true');
  });

  test('default strings are Plannotator\'s (deliberate pin) and no pen aria-label is emitted', () => {
    // DELIBERATE PIN: these strings are the package defaults every host
    // inherits, and Plannotator's own header renders them verbatim. A drift
    // here changes shipped UI in two products; change it on purpose, with
    // the maintainer, and update this test in the same commit.
    const armed = render({ armed: true, toolsHidden: false, isRefreshing: false });
    expect(pen(armed)!.title).toBe('Annotate mode: click an element or select text to comment. Esc to interact');
    expect(pen(armed)!.hasAttribute('aria-label')).toBe(false);
    expect(eye(armed)!.title).toBe('Hide tools');
    expect(eye(armed)!.querySelector('.sr-only')!.textContent).toBe('Hide tools');
    expect(refresh(armed)!.title).toBe('Refresh document');
    expect(refresh(armed)!.getAttribute('aria-label')).toBe('Refresh document');
    expect(refresh(armed)!.textContent).toBe('Refresh');

    act(() => root?.unmount());
    const interact = render({ armed: false, toolsHidden: true, isRefreshing: true });
    expect(pen(interact)!.title).toBe('Interact mode: clicks reach the page (text selection still comments). Click to annotate');
    expect(eye(interact)!.title).toBe('Show tools');
    expect(refresh(interact)!.title).toBe('Refreshing document');
    expect(refresh(interact)!.textContent).toBe('Refreshing');
    expect(DEFAULT_HTML_SURFACE_CONTROL_LABELS.refreshTitle).toBe('Refresh document');
  });

  test('a label override applies to its key only; the pen aria-label appears only when supplied', () => {
    const labels = { hideTools: 'Hide viewer controls', annotateLabel: 'Annotate mode' };
    const el = render({ armed: true, toolsHidden: false, isRefreshing: true, labels });
    // The overridden key reaches both the title and the screen-reader text.
    expect(eye(el)!.title).toBe('Hide viewer controls');
    expect(eye(el)!.querySelector('.sr-only')!.textContent).toBe('Hide viewer controls');
    expect(pen(el)!.getAttribute('aria-label')).toBe('Annotate mode');
    // Keys not overridden keep the defaults.
    expect(pen(el)!.title).toBe(DEFAULT_HTML_SURFACE_CONTROL_LABELS.annotateTitle);
    expect(refresh(el)!.title).toBe(DEFAULT_HTML_SURFACE_CONTROL_LABELS.refreshingTitle);
    expect(refresh(el)!.textContent).toBe(DEFAULT_HTML_SURFACE_CONTROL_LABELS.refreshing);
  });
});
