import type { JsonPrimitiveMap, ManageSubscriptionRule, SubscriptionRule } from "../types";

export interface RuleDraft {
  name: string;
  filterKind: "sql" | "correlation" | "true" | "false";
  sqlExpression: string;
  sqlParametersText: string;
  correlation: {
    contentType: string;
    correlationId: string;
    messageId: string;
    replyTo: string;
    replyToSessionId: string;
    sessionId: string;
    subject: string;
    to: string;
    applicationPropertiesText: string;
  };
  hasAction: boolean;
  actionExpression: string;
  actionParametersText: string;
}

export function formatJsonPrimitiveMap(value: JsonPrimitiveMap): string {
  return JSON.stringify(value, null, 2);
}

export function parseJsonPrimitiveMap(input: string): JsonPrimitiveMap {
  const trimmed = input.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("INVALID_JSON_OBJECT");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("INVALID_JSON_OBJECT");
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [, value] of entries) {
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error("INVALID_JSON_PRIMITIVE_MAP");
    }
  }

  return parsed as JsonPrimitiveMap;
}

export function summarizeSubscriptionRule(rule: SubscriptionRule): string {
  switch (rule.filter.kind) {
    case "sql":
      return rule.filter.expression || "SQL";
    case "correlation": {
      const tokens = [
        rule.filter.correlationId ? `CorrelationId=${rule.filter.correlationId}` : null,
        rule.filter.subject ? `Subject=${rule.filter.subject}` : null,
        rule.filter.sessionId ? `SessionId=${rule.filter.sessionId}` : null,
        Object.keys(rule.filter.applicationProperties).length > 0
          ? `${Object.keys(rule.filter.applicationProperties).length} app props`
          : null,
      ].filter(Boolean);
      return tokens.length > 0 ? tokens.join(" | ") : "Correlation filter";
    }
    case "true":
      return "Matches all messages";
    case "false":
      return "Matches no messages";
  }
}

export function buildRuleDraft(rule?: SubscriptionRule): RuleDraft {
  if (!rule) {
    return {
      name: "",
      filterKind: "sql",
      sqlExpression: "",
      sqlParametersText: "{}",
      correlation: {
        contentType: "",
        correlationId: "",
        messageId: "",
        replyTo: "",
        replyToSessionId: "",
        sessionId: "",
        subject: "",
        to: "",
        applicationPropertiesText: "{}",
      },
      hasAction: false,
      actionExpression: "",
      actionParametersText: "{}",
    };
  }

  return {
    name: rule.name,
    filterKind: rule.filter.kind,
    sqlExpression: rule.filter.kind === "sql" ? rule.filter.expression : "",
    sqlParametersText: rule.filter.kind === "sql" ? formatJsonPrimitiveMap(rule.filter.parameters) : "{}",
    correlation: (() => {
      const cf = rule.filter.kind === "correlation" ? rule.filter : null;
      return {
        contentType: cf?.contentType ?? "",
        correlationId: cf?.correlationId ?? "",
        messageId: cf?.messageId ?? "",
        replyTo: cf?.replyTo ?? "",
        replyToSessionId: cf?.replyToSessionId ?? "",
        sessionId: cf?.sessionId ?? "",
        subject: cf?.subject ?? "",
        to: cf?.to ?? "",
        applicationPropertiesText: cf ? formatJsonPrimitiveMap(cf.applicationProperties) : "{}",
      };
    })(),
    hasAction: rule.action != null,
    actionExpression: rule.action?.expression ?? "",
    actionParametersText: formatJsonPrimitiveMap(rule.action?.parameters ?? {}),
  };
}

export function draftToManageRule(draft: RuleDraft): ManageSubscriptionRule {
  const name = draft.name.trim();
  const action = draft.hasAction
    ? {
        expression: draft.actionExpression.trim(),
        parameters: parseJsonPrimitiveMap(draft.actionParametersText),
      }
    : null;

  switch (draft.filterKind) {
    case "sql":
      return {
        name,
        filter: {
          kind: "sql",
          expression: draft.sqlExpression.trim(),
          parameters: parseJsonPrimitiveMap(draft.sqlParametersText),
        },
        action,
      };
    case "correlation":
      return {
        name,
        filter: {
          kind: "correlation",
          contentType: draft.correlation.contentType.trim() || null,
          correlationId: draft.correlation.correlationId.trim() || null,
          messageId: draft.correlation.messageId.trim() || null,
          replyTo: draft.correlation.replyTo.trim() || null,
          replyToSessionId: draft.correlation.replyToSessionId.trim() || null,
          sessionId: draft.correlation.sessionId.trim() || null,
          subject: draft.correlation.subject.trim() || null,
          to: draft.correlation.to.trim() || null,
          applicationProperties: parseJsonPrimitiveMap(draft.correlation.applicationPropertiesText),
        },
        action,
      };
    case "true":
      return {
        name,
        filter: { kind: "true" },
        action,
      };
    case "false":
      return {
        name,
        filter: { kind: "false" },
        action,
      };
  }
}
