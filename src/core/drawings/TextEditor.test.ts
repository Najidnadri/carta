// Phase 13 Cycle D — TextEditor DOM-overlay tests. Runs in jsdom; we stub
// `queueMicrotask` only for tests that need to assert focus behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextEditor } from "./TextEditor.js";
import { asDrawingId } from "./types.js";

describe("TextEditor — Cycle D DOM overlay", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.parentElement?.removeChild(host);
  });

  it("mounts an <input> in the host with the initial text pre-filled", () => {
    const editor = new TextEditor({ onCommit: () => undefined, onCancel: () => undefined });
    editor.mount({ id: asDrawingId("d1"), initialText: "hello", host, x: 100, y: 50 });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-carta-editor]");
    expect(input).not.toBeNull();
    expect(input?.value).toBe("hello");
    expect(editor.isMounted()).toBe(true);
    expect(editor.isEditing(asDrawingId("d1"))).toBe(true);
    editor.unmount();
  });

  it("commits via Enter and invokes onCommit with current text", () => {
    let committed: { id: string; text: string } | null = null;
    const editor = new TextEditor({
      onCommit: (id, text): void => { committed = { id: String(id), text }; },
      onCancel: () => undefined,
    });
    editor.mount({ id: asDrawingId("d1"), initialText: "", host, x: 0, y: 0 });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-carta-editor]");
    expect(input).not.toBeNull();
    if (input === null) {
      return;
    }
    input.value = "BREAKOUT";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(committed).toEqual({ id: "d1", text: "BREAKOUT" });
    expect(editor.isMounted()).toBe(false);
  });

  it("cancels via Escape and invokes onCancel", () => {
    let cancelled: string | null = null;
    const editor = new TextEditor({
      onCommit: () => undefined,
      onCancel: (id): void => { cancelled = String(id); },
    });
    editor.mount({ id: asDrawingId("d1"), initialText: "draft", host, x: 0, y: 0 });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-carta-editor]");
    if (input === null) {
      throw new Error("input missing");
    }
    input.value = "I changed my mind";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(cancelled).toBe("d1");
    expect(editor.isMounted()).toBe(false);
  });

  it("ignores Enter during IME composition (isComposing=true)", () => {
    let committed = false;
    const editor = new TextEditor({
      onCommit: (): void => { committed = true; },
      onCancel: () => undefined,
    });
    editor.mount({ id: asDrawingId("d1"), initialText: "", host, x: 0, y: 0 });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-carta-editor]");
    if (input === null) {
      throw new Error("input missing");
    }
    // Construct a KeyboardEvent and force `isComposing` true (jsdom's
    // KeyboardEvent ignores the option but defines a getter we can spy on).
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    Object.defineProperty(ev, "isComposing", { value: true });
    input.dispatchEvent(ev);
    expect(committed).toBe(false);
    editor.unmount();
  });

  it("commits on blur", () => {
    let committed: string | null = null;
    const editor = new TextEditor({
      onCommit: (_id, text): void => { committed = text; },
      onCancel: () => undefined,
    });
    editor.mount({ id: asDrawingId("d1"), initialText: "", host, x: 0, y: 0 });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-carta-editor]");
    if (input === null) {
      throw new Error("input missing");
    }
    input.value = "via-blur";
    input.dispatchEvent(new Event("blur"));
    expect(committed).toBe("via-blur");
  });

  it("repositionTo updates transform to GPU-composited translate3d", () => {
    const editor = new TextEditor({ onCommit: () => undefined, onCancel: () => undefined });
    editor.mount({ id: asDrawingId("d1"), initialText: "", host, x: 0, y: 0 });
    editor.repositionTo(123, 456);
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-carta-editor]");
    expect(input?.style.transform).toContain("translate3d");
    expect(input?.style.transform).toContain("123");
    expect(input?.style.transform).toContain("456");
    editor.unmount();
  });

  it("mounting a different id while editing first commits the prior", () => {
    const commits: { id: string; text: string }[] = [];
    const editor = new TextEditor({
      onCommit: (id, text): void => { commits.push({ id: String(id), text }); },
      onCancel: () => undefined,
    });
    editor.mount({ id: asDrawingId("d1"), initialText: "first", host, x: 0, y: 0 });
    const input1 = host.querySelector<HTMLTextAreaElement>("textarea[data-carta-editor]");
    if (input1 === null) {
      throw new Error("input missing");
    }
    input1.value = "first-typed";
    editor.mount({ id: asDrawingId("d2"), initialText: "second", host, x: 0, y: 0 });
    expect(commits).toEqual([{ id: "d1", text: "first-typed" }]);
    expect(editor.isEditing(asDrawingId("d2"))).toBe(true);
    editor.unmount();
  });

  it("unmount is idempotent", () => {
    const editor = new TextEditor({ onCommit: () => undefined, onCancel: () => undefined });
    editor.mount({ id: asDrawingId("d1"), initialText: "", host, x: 0, y: 0 });
    editor.unmount();
    expect(() => { editor.unmount(); }).not.toThrow();
    expect(editor.isMounted()).toBe(false);
  });

  it("destroy unmounts the editor", () => {
    const editor = new TextEditor({ onCommit: () => undefined, onCancel: () => undefined });
    editor.mount({ id: asDrawingId("d1"), initialText: "", host, x: 0, y: 0 });
    editor.destroy();
    expect(editor.isMounted()).toBe(false);
    expect(host.querySelector("textarea[data-carta-editor]")).toBeNull();
  });

  it("element carries the data-carta-editor attribute (so isEditableTarget matches)", () => {
    const editor = new TextEditor({ onCommit: () => undefined, onCancel: () => undefined });
    editor.mount({ id: asDrawingId("d1"), initialText: "", host, x: 0, y: 0 });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-carta-editor]");
    expect(input?.hasAttribute("data-carta-editor")).toBe(true);
    editor.unmount();
  });

  it("focuses the input after mount (microtask)", async () => {
    vi.useFakeTimers();
    try {
      const editor = new TextEditor({ onCommit: () => undefined, onCancel: () => undefined });
      editor.mount({ id: asDrawingId("d1"), initialText: "hi", host, x: 0, y: 0 });
      // Drain the microtask queue.
      await Promise.resolve();
      const input = host.querySelector<HTMLTextAreaElement>("textarea[data-carta-editor]");
      expect(document.activeElement).toBe(input);
      editor.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
