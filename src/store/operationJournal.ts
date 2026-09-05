import { z } from "zod";
import { OperationCountsSchema, OperationOutcomeSchema } from "../schemas/operation";
import type { EventLogEntry } from "../types";

export const JOURNAL_KEY = "busman:operation-journal:v1";
export const JOURNAL_MAX_ENTRIES = 500;
export const JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Deliberately allowlist metadata. Bodies, raw parameters, credentials and free-form
// error text never enter the journal, including nested worker outcomes.
const Entry = z.object({
  id: z.string().max(128), time: z.string(), namespace: z.string().max(512), entity: z.string().max(1024),
  entityType: z.enum(["Queue", "Subscription", "Topic"]),
  operation: z.enum(["Browse", "Send", "Receive", "Replay", "Republish", "Move", "Create", "Delete", "DeleteMessage", "ReplayMessage", "MoveMessage"]),
  status: z.enum(["running", "success", "error", "stopped", "unknown"]),
  checkpoint: z.object({ at: z.string(), counts: OperationCountsSchema }).optional(),
  reconciledAt: z.string().optional(),
  scope: z.object({ connectionId: z.string().max(128), mode: z.string().max(32), destination: z.string().max(512), replaySource: z.string().max(2048).optional() }).optional(),
  replayReturn: z.object({ observedAt: z.string(), sequenceNumber: z.string().regex(/^[0-9]+$/).max(19) }).optional(),
  outcome: OperationOutcomeSchema.omit({ errorMessage: true }).optional(),
});
const Journal = z.object({ version: z.literal(1), entries: z.array(Entry).max(JOURNAL_MAX_ENTRIES) });

export function journalMetadata(entries: EventLogEntry[], now = Date.now()): EventLogEntry[] {
  return entries.filter((entry) => Date.parse(entry.time) >= now - JOURNAL_RETENTION_MS)
    .slice(0, JOURNAL_MAX_ENTRIES).flatMap((entry) => {
      const parsed = Entry.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
}

export function loadOperationJournal(): { entries: EventLogEntry[]; error: string | null } {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (!raw) return { entries: [], error: null };
    if (raw.length > 2_000_000) throw new Error("Journal exceeds its size limit");
    const journal = Journal.parse(JSON.parse(raw));
    return { entries: journalMetadata(journal.entries).map((entry) => entry.status === "running"
      ? entry.operation === "Browse"
        ? { ...entry, status: "error", errorMessage: "Browse was interrupted. Retry the read to load messages." }
        : { ...entry, status: "unknown", errorMessage: "Interrupted before a terminal result was recorded. Reconcile with the broker before retrying." }
      : entry), error: null };
  } catch {
    return { entries: [], error: "The saved operation journal could not be read." };
  }
}

export function saveOperationJournal(entries: EventLogEntry[]): string | null {
  try {
    const raw = JSON.stringify({ version: 1, entries: journalMetadata(entries) });
    if (raw.length > 2_000_000) throw new Error("Journal exceeds its size limit");
    localStorage.setItem(JOURNAL_KEY, raw);
    return null;
  } catch {
    return "Operation history could not be saved. Export it before closing Busman.";
  }
}
