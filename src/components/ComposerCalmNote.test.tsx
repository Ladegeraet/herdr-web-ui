import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Composer, type ComposerProps } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { addAnnotation, clearAnnotations } from "../lib/chatAnnotations.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";

const pane = "calm-note-pane", draftKey = `ovis:composer-draft:${pane}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0 },
    window: { ...listen, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout },
    document: { ...listen, querySelector: () => null },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue([]);
  spyOn(usageModule, "useUsage").mockReturnValue({ report: null } as ReturnType<typeof usageModule.useUsage>);
  spyOn(facesModule, "useFacesArrived").mockReturnValue(0);
  spyOn(voiceModule, "useDictation").mockReturnValue({ shown: false, voice: { state: "idle" }, forget() {} } as unknown as ReturnType<typeof voiceModule.useDictation>);
  composerDrafts.set(draftKey, "");
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  composerDrafts.set(draftKey, "");
  clearAnnotations(pane);
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

const noteText = (): string | null => {
  const notes = renderer!.root.findAll((node) => typeof node.props.className === "string" && node.props.className.split(" ").includes("composer-note"));
  return notes.length === 0 ? null : notes[0]!.findAll((node) => typeof node.children?.[0] === "string").map((node) => node.children[0]).join("");
};

// a queued message goes without the notes, and Edit puts it back in the box: the line about that send goes then
it("drops the held-back line once the box holds text again", async () => {
  addAnnotation(pane, { source: "agent", kind: "approve", quote: "Reset it in didUpdateWidget", comment: "" });
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "working", connected: true, autoFocus: false, onSend: () => true, onAbort() {}, onUploadImage: async () => "" };
  await act(async () => { renderer = create(<Composer {...props} />); });
  await act(async () => { composerDrafts.set(draftKey, "Queued while it works"); });
  await act(async () => { renderer!.root.findByProps({ "aria-label": "Send message" }).props.onClick(); });
  expect(composerDrafts.read(draftKey).text).toBe("");
  expect(noteText()).toContain("Sent without your notes");
  await act(async () => { composerDrafts.set(draftKey, "Queued while it works"); });
  expect(noteText()).toBeNull();
});
