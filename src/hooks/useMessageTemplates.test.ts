import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMessageTemplates } from "./useMessageTemplates";

const STORAGE_KEY = "busman_message_templates";

beforeEach(() => {
  localStorage.clear();
});

describe("useMessageTemplates", () => {
  it("starts with an empty list when localStorage is empty", () => {
    const { result } = renderHook(() => useMessageTemplates());
    expect(result.current.templates).toEqual([]);
  });

  it("loads persisted templates from localStorage on mount", () => {
    const stored = [
      { id: "1", name: "hello", createdAt: "2024-01-01T00:00:00Z", body: "hi" },
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const { result } = renderHook(() => useMessageTemplates());
    expect(result.current.templates).toHaveLength(1);
    expect(result.current.templates[0].name).toBe("hello");
  });

  it("returns an empty list when localStorage contains malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not valid json");
    const { result } = renderHook(() => useMessageTemplates());
    expect(result.current.templates).toEqual([]);
  });

  it("returns an empty list when localStorage contains a non-array value", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: "an array" }));
    const { result } = renderHook(() => useMessageTemplates());
    expect(result.current.templates).toEqual([]);
  });

  describe("saveTemplate", () => {
    it("prepends the new template to the list", () => {
      const { result } = renderHook(() => useMessageTemplates());

      act(() => { result.current.saveTemplate("First", { body: "body1" }); });
      expect(result.current.templates[0].name).toBe("First");

      act(() => { result.current.saveTemplate("Second", { body: "body2" }); });
      expect(result.current.templates[0].name).toBe("Second");
      expect(result.current.templates[1].name).toBe("First");
    });

    it("trims whitespace from the template name", () => {
      const { result } = renderHook(() => useMessageTemplates());
      act(() => { result.current.saveTemplate("  trimmed  ", { body: "b" }); });
      expect(result.current.templates[0].name).toBe("trimmed");
    });

    it("persists the new template to localStorage", () => {
      const { result } = renderHook(() => useMessageTemplates());
      act(() => { result.current.saveTemplate("T1", { body: "payload" }); });

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored).toHaveLength(1);
      expect(stored[0].name).toBe("T1");
    });

    it("assigns a unique id to each saved template", () => {
      const { result } = renderHook(() => useMessageTemplates());
      act(() => { result.current.saveTemplate("A", { body: "a" }); });
      act(() => { result.current.saveTemplate("B", { body: "b" }); });

      const ids = result.current.templates.map((t) => t.id);
      expect(new Set(ids).size).toBe(2);
    });

    it("stores optional fields when provided", () => {
      const { result } = renderHook(() => useMessageTemplates());
      act(() => {
        result.current.saveTemplate(
          "Full",
          { body: "payload", contentType: "application/json", subject: "my-subject" },
          "my-queue",
        );
      });
      const t = result.current.templates[0];
      expect(t.contentType).toBe("application/json");
      expect(t.subject).toBe("my-subject");
      expect(t.entityName).toBe("my-queue");
    });

    it("omits optional fields when they are empty strings or absent", () => {
      const { result } = renderHook(() => useMessageTemplates());
      act(() => {
        result.current.saveTemplate("Minimal", { body: "b", contentType: "" });
      });
      const t = result.current.templates[0];
      expect(t.contentType).toBeUndefined();
      expect(t.entityName).toBeUndefined();
    });
  });

  describe("deleteTemplate", () => {
    it("removes the template with the given id", () => {
      const { result } = renderHook(() => useMessageTemplates());
      let savedId: string;
      act(() => { savedId = result.current.saveTemplate("ToDelete", { body: "b" }).id; });

      act(() => { result.current.deleteTemplate(savedId!); });
      expect(result.current.templates).toHaveLength(0);
    });

    it("persists the deletion to localStorage", () => {
      const { result } = renderHook(() => useMessageTemplates());
      let savedId: string;
      act(() => { savedId = result.current.saveTemplate("X", { body: "b" }).id; });

      act(() => { result.current.deleteTemplate(savedId!); });
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored).toHaveLength(0);
    });

    it("is a no-op when the id does not exist", () => {
      const { result } = renderHook(() => useMessageTemplates());
      act(() => { result.current.saveTemplate("Y", { body: "b" }); });

      act(() => { result.current.deleteTemplate("non-existent-id"); });
      expect(result.current.templates).toHaveLength(1);
    });
  });
});
