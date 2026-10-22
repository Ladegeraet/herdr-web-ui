import { describe, expect, test } from "bun:test";

import { enterSubmits, enterSubmitShortcut, type EnterKey } from "./enterSubmits.ts";

const key = (over: Partial<EnterKey> = {}): EnterKey => ({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, keyCode: 13, ...over });

describe("enterSubmits", () => {
  test("with Enter sends on, Enter submits and Shift+Enter is a new line", () => {
    expect(enterSubmits(key(), true)).toBe(true);
    expect(enterSubmits(key({ shiftKey: true }), true)).toBe(false);
    expect(enterSubmits(key({ metaKey: true }), true)).toBe(false);
    expect(enterSubmits(key({ ctrlKey: true }), true)).toBe(false);
  });

  test("with Enter sends off, Cmd/Ctrl+Enter submits and Enter is a new line", () => {
    expect(enterSubmits(key(), false)).toBe(false);
    expect(enterSubmits(key({ metaKey: true }), false)).toBe(true);
    expect(enterSubmits(key({ ctrlKey: true }), false)).toBe(true);
    expect(enterSubmits(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  test("an IME's Enter never submits, nor does another key", () => {
    for (const enterSends of [true, false]) {
      expect(enterSubmits(key({ isComposing: true, ctrlKey: !enterSends }), enterSends)).toBe(false);
      expect(enterSubmits(key({ keyCode: 229, ctrlKey: !enterSends }), enterSends)).toBe(false);
      expect(enterSubmits(key({ key: "a", ctrlKey: !enterSends }), enterSends)).toBe(false);
    }
  });

  test("names the shortcut for the setting", () => {
    expect(enterSubmitShortcut(true)).toBe("Enter");
    expect(enterSubmitShortcut(false)).toBe("Control+Enter Meta+Enter");
  });
});
