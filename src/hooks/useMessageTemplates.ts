import { useState, useCallback } from "react";

export interface MessageTemplate {
  id: string;
  name: string;
  createdAt: string;
  /** The entity (queue or topic) this template was saved from, if any. */
  entityName?: string;
  body: string;
  contentType?: string;
  subject?: string;
  correlationId?: string;
  sessionId?: string;
  applicationProperties?: Record<string, unknown>;
}

const STORAGE_KEY = "busman_message_templates";

function loadTemplates(): MessageTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessageTemplate[]) : [];
  } catch {
    return [];
  }
}

function persistTemplates(templates: MessageTemplate[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

export function useMessageTemplates() {
  const [templates, setTemplates] = useState<MessageTemplate[]>(loadTemplates);

  const saveTemplate = useCallback(
    (
      name: string,
      draft: {
        body: string;
        contentType?: string;
        subject?: string;
        correlationId?: string;
        sessionId?: string;
        applicationProperties?: Record<string, unknown>;
      },
      entityName?: string,
    ): MessageTemplate => {
      const template: MessageTemplate = {
        id: crypto.randomUUID(),
        name: name.trim(),
        createdAt: new Date().toISOString(),
        entityName: entityName || undefined,
        body: draft.body,
        contentType: draft.contentType || undefined,
        subject: draft.subject || undefined,
        correlationId: draft.correlationId || undefined,
        sessionId: draft.sessionId || undefined,
        applicationProperties: draft.applicationProperties,
      };
      const updated = [template, ...templates];
      persistTemplates(updated);
      setTemplates(updated);
      return template;
    },
    [templates],
  );

  const deleteTemplate = useCallback(
    (id: string) => {
      const updated = templates.filter((t) => t.id !== id);
      persistTemplates(updated);
      setTemplates(updated);
    },
    [templates],
  );

  return { templates, saveTemplate, deleteTemplate };
}
