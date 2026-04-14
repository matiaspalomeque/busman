import { describe, it, expect } from "vitest";
import {
  formatJsonPrimitiveMap,
  parseJsonPrimitiveMap,
  summarizeSubscriptionRule,
  buildRuleDraft,
  draftToManageRule,
  type RuleDraft,
} from "./subscriptionRules";
import type { SubscriptionRule } from "../types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SQL_RULE: SubscriptionRule = {
  name: "sql-rule",
  filter: { kind: "sql", expression: "color = 'red'", parameters: {} },
  action: null,
};

const CORR_RULE: SubscriptionRule = {
  name: "corr-rule",
  filter: {
    kind: "correlation",
    correlationId: "cid-1",
    subject: "orders",
    sessionId: null,
    contentType: "application/json",
    messageId: null,
    replyTo: null,
    replyToSessionId: null,
    to: null,
    applicationProperties: {},
  },
  action: null,
};

const BASE_DRAFT: RuleDraft = {
  name: "my-rule",
  filterKind: "sql",
  sqlExpression: "color = 'red'",
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

// ─── formatJsonPrimitiveMap ───────────────────────────────────────────────────

describe("formatJsonPrimitiveMap", () => {
  it("serializes an empty map to '{}'", () => {
    expect(formatJsonPrimitiveMap({})).toBe("{}");
  });

  it("serializes primitive values to indented JSON", () => {
    const result = formatJsonPrimitiveMap({ key: "value", num: 42, flag: true });
    expect(JSON.parse(result)).toEqual({ key: "value", num: 42, flag: true });
    expect(result).toContain("\n"); // pretty-printed
  });
});

// ─── parseJsonPrimitiveMap ────────────────────────────────────────────────────

describe("parseJsonPrimitiveMap", () => {
  it("returns an empty object for empty or whitespace-only input", () => {
    expect(parseJsonPrimitiveMap("")).toEqual({});
    expect(parseJsonPrimitiveMap("   ")).toEqual({});
    expect(parseJsonPrimitiveMap("\n\t")).toEqual({});
  });

  it("parses a valid JSON object with mixed primitive values", () => {
    expect(parseJsonPrimitiveMap('{ "a": "hello", "b": 99, "c": true }')).toEqual({
      a: "hello",
      b: 99,
      c: true,
    });
  });

  it("throws INVALID_JSON_OBJECT for malformed JSON", () => {
    expect(() => parseJsonPrimitiveMap("{not json}")).toThrow("INVALID_JSON_OBJECT");
  });

  it("throws INVALID_JSON_OBJECT for JSON null", () => {
    expect(() => parseJsonPrimitiveMap("null")).toThrow("INVALID_JSON_OBJECT");
  });

  it("throws INVALID_JSON_OBJECT for JSON arrays", () => {
    expect(() => parseJsonPrimitiveMap('["a", "b"]')).toThrow("INVALID_JSON_OBJECT");
  });

  it("throws INVALID_JSON_OBJECT for plain JSON scalars", () => {
    expect(() => parseJsonPrimitiveMap('"hello"')).toThrow("INVALID_JSON_OBJECT");
    expect(() => parseJsonPrimitiveMap("42")).toThrow("INVALID_JSON_OBJECT");
  });

  it("throws INVALID_JSON_PRIMITIVE_MAP when a value is a nested object", () => {
    expect(() => parseJsonPrimitiveMap('{ "nested": { "x": 1 } }')).toThrow(
      "INVALID_JSON_PRIMITIVE_MAP"
    );
  });

  it("throws INVALID_JSON_PRIMITIVE_MAP when a value is an array", () => {
    expect(() => parseJsonPrimitiveMap('{ "arr": [1, 2] }')).toThrow("INVALID_JSON_PRIMITIVE_MAP");
  });

  it("throws INVALID_JSON_PRIMITIVE_MAP when a value is null", () => {
    expect(() => parseJsonPrimitiveMap('{ "n": null }')).toThrow("INVALID_JSON_PRIMITIVE_MAP");
  });
});

// ─── summarizeSubscriptionRule ────────────────────────────────────────────────

describe("summarizeSubscriptionRule", () => {
  it("shows the SQL expression for sql filters", () => {
    expect(summarizeSubscriptionRule(SQL_RULE)).toBe("color = 'red'");
  });

  it("shows 'SQL' when the sql expression is empty", () => {
    const rule: SubscriptionRule = {
      ...SQL_RULE,
      filter: { kind: "sql", expression: "", parameters: {} },
    };
    expect(summarizeSubscriptionRule(rule)).toBe("SQL");
  });

  it("builds a pipe-separated field summary for correlation filters", () => {
    expect(summarizeSubscriptionRule(CORR_RULE)).toBe("CorrelationId=cid-1 | Subject=orders");
  });

  it("includes app property count in correlation summary", () => {
    const rule: SubscriptionRule = {
      ...CORR_RULE,
      filter: {
        ...CORR_RULE.filter as Extract<typeof CORR_RULE.filter, { kind: "correlation" }>,
        correlationId: null,
        subject: null,
        applicationProperties: { env: "prod", region: "us-east" },
      },
    };
    expect(summarizeSubscriptionRule(rule)).toBe("2 app props");
  });

  it("returns 'Correlation filter' when no fields are set", () => {
    const rule: SubscriptionRule = {
      name: "r",
      filter: {
        kind: "correlation",
        correlationId: null,
        subject: null,
        sessionId: null,
        contentType: null,
        messageId: null,
        replyTo: null,
        replyToSessionId: null,
        to: null,
        applicationProperties: {},
      },
      action: null,
    };
    expect(summarizeSubscriptionRule(rule)).toBe("Correlation filter");
  });

  it("returns 'Matches all messages' for true filters", () => {
    const rule: SubscriptionRule = { name: "r", filter: { kind: "true" }, action: null };
    expect(summarizeSubscriptionRule(rule)).toBe("Matches all messages");
  });

  it("returns 'Matches no messages' for false filters", () => {
    const rule: SubscriptionRule = { name: "r", filter: { kind: "false" }, action: null };
    expect(summarizeSubscriptionRule(rule)).toBe("Matches no messages");
  });
});

// ─── buildRuleDraft ───────────────────────────────────────────────────────────

describe("buildRuleDraft", () => {
  it("returns a blank default draft when called with no argument", () => {
    const draft = buildRuleDraft(undefined);
    expect(draft.name).toBe("");
    expect(draft.filterKind).toBe("sql");
    expect(draft.sqlExpression).toBe("");
    expect(draft.sqlParametersText).toBe("{}");
    expect(draft.hasAction).toBe(false);
    expect(draft.actionExpression).toBe("");
    expect(draft.actionParametersText).toBe("{}");
    expect(draft.correlation.applicationPropertiesText).toBe("{}");
  });

  it("maps a sql filter rule to draft fields", () => {
    const rule: SubscriptionRule = {
      name: "sql-rule",
      filter: { kind: "sql", expression: "color = 'blue'", parameters: { limit: 10 } },
      action: null,
    };
    const draft = buildRuleDraft(rule);
    expect(draft.name).toBe("sql-rule");
    expect(draft.filterKind).toBe("sql");
    expect(draft.sqlExpression).toBe("color = 'blue'");
    expect(JSON.parse(draft.sqlParametersText)).toEqual({ limit: 10 });
    expect(draft.hasAction).toBe(false);
    // correlation fields should be empty since filter is sql
    expect(draft.correlation.correlationId).toBe("");
  });

  it("maps a correlation filter rule to draft fields (null → empty string)", () => {
    const draft = buildRuleDraft(CORR_RULE);
    expect(draft.filterKind).toBe("correlation");
    expect(draft.correlation.correlationId).toBe("cid-1");
    expect(draft.correlation.subject).toBe("orders");
    expect(draft.correlation.contentType).toBe("application/json");
    expect(draft.correlation.sessionId).toBe(""); // null → ""
    expect(JSON.parse(draft.correlation.applicationPropertiesText)).toEqual({});
  });

  it("sets hasAction and populates action fields when rule has an action", () => {
    const rule: SubscriptionRule = {
      name: "action-rule",
      filter: { kind: "true" },
      action: { expression: "SET color = 'red'", parameters: { x: 1 } },
    };
    const draft = buildRuleDraft(rule);
    expect(draft.hasAction).toBe(true);
    expect(draft.actionExpression).toBe("SET color = 'red'");
    expect(JSON.parse(draft.actionParametersText)).toEqual({ x: 1 });
  });

  it("sets hasAction=false and clears action fields when rule has no action", () => {
    const rule: SubscriptionRule = { name: "no-action", filter: { kind: "false" }, action: null };
    const draft = buildRuleDraft(rule);
    expect(draft.hasAction).toBe(false);
    expect(draft.actionExpression).toBe("");
    expect(draft.actionParametersText).toBe("{}");
  });
});

// ─── draftToManageRule ────────────────────────────────────────────────────────

describe("draftToManageRule", () => {
  it("converts a sql draft", () => {
    const rule = draftToManageRule(BASE_DRAFT);
    expect(rule.name).toBe("my-rule");
    expect(rule.filter.kind).toBe("sql");
    if (rule.filter.kind === "sql") {
      expect(rule.filter.expression).toBe("color = 'red'");
      expect(rule.filter.parameters).toEqual({});
    }
    expect(rule.action).toBeNull();
  });

  it("trims whitespace from the rule name", () => {
    const rule = draftToManageRule({ ...BASE_DRAFT, name: "  trimmed  " });
    expect(rule.name).toBe("trimmed");
  });

  it("converts a correlation draft, mapping empty/whitespace strings to null", () => {
    const draft: RuleDraft = {
      ...BASE_DRAFT,
      filterKind: "correlation",
      correlation: {
        contentType: "application/json",
        correlationId: "  ", // whitespace only → null
        messageId: "m-1",
        replyTo: "",
        replyToSessionId: "",
        sessionId: "sess-1",
        subject: "",
        to: "",
        applicationPropertiesText: '{ "env": "prod" }',
      },
    };
    const rule = draftToManageRule(draft);
    expect(rule.filter.kind).toBe("correlation");
    if (rule.filter.kind === "correlation") {
      expect(rule.filter.contentType).toBe("application/json");
      expect(rule.filter.correlationId).toBeNull();
      expect(rule.filter.messageId).toBe("m-1");
      expect(rule.filter.replyTo).toBeNull();
      expect(rule.filter.sessionId).toBe("sess-1");
      expect(rule.filter.applicationProperties).toEqual({ env: "prod" });
    }
  });

  it("converts a 'true' draft", () => {
    const rule = draftToManageRule({ ...BASE_DRAFT, filterKind: "true" });
    expect(rule.filter).toEqual({ kind: "true" });
    expect(rule.action).toBeNull();
  });

  it("converts a 'false' draft", () => {
    const rule = draftToManageRule({ ...BASE_DRAFT, filterKind: "false" });
    expect(rule.filter).toEqual({ kind: "false" });
  });

  it("includes a parsed action when hasAction is true", () => {
    const draft: RuleDraft = {
      ...BASE_DRAFT,
      hasAction: true,
      actionExpression: "SET color = 'blue'",
      actionParametersText: '{ "x": 1 }',
    };
    const rule = draftToManageRule(draft);
    expect(rule.action).toEqual({ expression: "SET color = 'blue'", parameters: { x: 1 } });
  });
});
