/**
 * Test harness for the extension's webviews: loads a webview document into
 * happy-dom, runs its inline <script>s in this Node realm against the happy-dom
 * window, and fakes acquireVsCodeApi() so every postMessage is recorded.
 *
 * Tests drive a page the way VS Code and the user would: send() delivers a
 * message from the extension, click() / type() / key() act on elements, and
 * `posted` holds what the page sent back.
 *
 * Scripts run through `new Function` inside `with (window)`, not through
 * happy-dom's own evaluator, so objects the page posts belong to this realm
 * and compare cleanly with assert.deepStrictEqual.
 */
import { Window, HTMLElement as DomElement } from "happy-dom";

export type Posted = Record<string, unknown> & { type?: string };

export interface WebviewHarness {
  window: Window;
  /** Every message the page posted to the extension, oldest first. */
  posted: Posted[];
  /** Deliver a message from the extension to the page. */
  send(message: Posted): void;
  $(selector: string): DomElement | null;
  $$(selector: string): DomElement[];
  /** Click an element (selector or element); throws when the selector matches nothing. */
  click(target: string | DomElement): void;
  /** Set an input's value and fire `input` (and `change`). */
  type(target: string | DomElement, value: string): void;
  /** Fire a keydown (default key "Enter") on an element. */
  key(target: string | DomElement, key?: string, init?: Record<string, unknown>): void;
  /** Visible text of an element (or of the body), whitespace collapsed. */
  text(target?: string | DomElement): string;
  /** The last posted message of a type. */
  lastPosted(type: string): Posted | undefined;
  close(): Promise<void>;
}

export function loadWebview(html: string): WebviewHarness {
  const window = new Window({ url: "https://webview.test/" });
  const document = window.document;
  const posted: Posted[] = [];
  const state: { value: unknown } = { value: undefined };
  const api = {
    postMessage: (message: Posted) => {
      // Round-trip through JSON like the real webview channel does.
      posted.push(JSON.parse(JSON.stringify(message)) as Posted);
    },
    getState: () => state.value,
    setState: (value: unknown) => {
      state.value = value;
      return value;
    },
  };
  (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => api;

  const scripts: string[] = [];
  const markup = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_all, code: string) => {
    scripts.push(code);
    return "";
  });
  document.write(markup);

  for (const code of scripts) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function("window", `with (window) {\n${code}\n}`);
    run(window);
  }

  const resolve = (target: string | DomElement): DomElement => {
    if (typeof target !== "string") return target;
    const found = document.querySelector(target) as DomElement | null;
    if (!found) throw new Error(`No element matches ${target}`);
    return found;
  };

  return {
    window,
    posted,
    send(message) {
      window.dispatchEvent(new window.MessageEvent("message", { data: message }));
    },
    $: (selector) => document.querySelector(selector) as DomElement | null,
    $$: (selector) => [...document.querySelectorAll(selector)] as DomElement[],
    click(target) {
      resolve(target).click();
    },
    type(target, value) {
      const element = resolve(target) as unknown as { value: string; dispatchEvent(event: unknown): boolean };
      element.value = value;
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    key(target, key = "Enter", init = {}) {
      resolve(target).dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
    },
    text(target) {
      const element = target === undefined ? document.body : resolve(target);
      return String(element.textContent ?? "").replace(/\s+/g, " ").trim();
    },
    lastPosted(type) {
      return [...posted].reverse().find((m) => m.type === type);
    },
    close: () => window.happyDOM.close(),
  };
}
