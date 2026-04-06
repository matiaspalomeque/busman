import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { ZodError } from "zod";
import { ListSubscriptionRulesResultSchema, ManageSubscriptionRuleSchema, safeInvoke } from "../../schemas/ipc";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import type { SubscriptionRule } from "../../types";
import { buildRuleDraft, draftToManageRule, summarizeSubscriptionRule } from "../../utils/subscriptionRules";
import type { RuleDraft } from "../../utils/subscriptionRules";
import { Icon } from "../Common/Icon";

const NEW_RULE_KEY = "__new__";

function FilterBadge({ kind }: { kind: SubscriptionRule["filter"]["kind"] }) {
  return (
    <span className="shrink-0 rounded border border-zinc-300 dark:border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {kind}
    </span>
  );
}

export function SubscriptionRulesModal() {
  const { t } = useTranslation();
  const conn = useAppStore(selectActiveConnection);
  const explorerSelection = useAppStore((s) => s.explorerSelection);
  const setIsSubscriptionRulesModalOpen = useAppStore((s) => s.setIsSubscriptionRulesModalOpen);

  const [rules, setRules] = useState<SubscriptionRule[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(() => buildRuleDraft());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const canRender = conn != null && explorerSelection.kind === "subscription";
  const currentRule = useMemo(
    () => rules.find((rule) => rule.name === selectedKey) ?? null,
    [rules, selectedKey],
  );
  const isNewRule = selectedKey === NEW_RULE_KEY;

  const close = useCallback(() => setIsSubscriptionRulesModalOpen(false), [setIsSubscriptionRulesModalOpen]);
  const formatMutationError = (error: unknown): string => {
    if (error instanceof ZodError) {
      return error.issues[0]?.message ?? String(error);
    }
    if (error instanceof Error) {
      if (error.message === "INVALID_JSON_OBJECT") {
        return t("explorer.rules.invalidJsonObject");
      }
      if (error.message === "INVALID_JSON_PRIMITIVE_MAP") {
        return t("explorer.rules.invalidJsonPrimitiveMap");
      }
      return error.message;
    }
    return String(error);
  };

  const syncDraftFromSelection = (nextKey: string | null, nextRules: SubscriptionRule[]) => {
    if (nextKey === NEW_RULE_KEY) {
      setDraft(buildRuleDraft());
      return;
    }
    const rule = nextRules.find((item) => item.name === nextKey);
    setDraft(buildRuleDraft(rule));
  };

  const loadRules = async (preferredSelection?: string | null) => {
    if (!conn || explorerSelection.kind !== "subscription") return;

    setLoading(true);
    setLoadError(null);
    setMutationError(null);
    try {
      const result = await safeInvoke("list_subscription_rules", ListSubscriptionRulesResultSchema, {
        args: {
          connectionId: conn.id,
          topicName: explorerSelection.topicName,
          subscriptionName: explorerSelection.subscriptionName,
        },
      });
      setRules(result.rules);
      const nextKey =
        preferredSelection === NEW_RULE_KEY
          ? NEW_RULE_KEY
          : result.rules.some((rule) => rule.name === preferredSelection)
            ? preferredSelection ?? result.rules[0]?.name ?? null
            : result.rules[0]?.name ?? null;
      setSelectedKey(nextKey);
      syncDraftFromSelection(nextKey, result.rules);
    } catch (error) {
      setLoadError(String(error));
      setRules([]);
      setSelectedKey(null);
      setDraft(buildRuleDraft());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!canRender) {
      close();
      return;
    }
    void loadRules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id, explorerSelection.kind, explorerSelection.topicName, explorerSelection.subscriptionName]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  if (!canRender) return null;

  const saveRule = async () => {
    if (!conn || explorerSelection.kind !== "subscription") return;

    setSaving(true);
    setMutationError(null);
    try {
      const parsed = ManageSubscriptionRuleSchema.parse(draftToManageRule(draft));
      const command = isNewRule ? "create_subscription_rule" : "update_subscription_rule";
      await invoke(command, {
        args: {
          connectionId: conn.id,
          topicName: explorerSelection.topicName,
          subscriptionName: explorerSelection.subscriptionName,
          rule: parsed,
        },
      });
      await loadRules(parsed.name);
    } catch (error) {
      setMutationError(formatMutationError(error));
    } finally {
      setSaving(false);
    }
  };

  const deleteRule = async () => {
    if (!conn || explorerSelection.kind !== "subscription" || isNewRule || !currentRule) return;
    if (!window.confirm(t("explorer.rules.deleteConfirm", { name: currentRule.name }))) return;

    setDeleting(true);
    setMutationError(null);
    try {
      await invoke("delete_subscription_rule", {
        args: {
          connectionId: conn.id,
          topicName: explorerSelection.topicName,
          subscriptionName: explorerSelection.subscriptionName,
          ruleName: currentRule.name,
        },
      });
      await loadRules(null);
    } catch (error) {
      setMutationError(formatMutationError(error));
    } finally {
      setDeleting(false);
    }
  };

  const onSelectRule = (key: string) => {
    setSelectedKey(key);
    syncDraftFromSelection(key, rules);
    setMutationError(null);
  };

  const onNewRule = () => {
    setSelectedKey(NEW_RULE_KEY);
    setDraft(buildRuleDraft());
    setMutationError(null);
  };

  const inputClass =
    "w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-azure-primary";
  const labelClass = "mb-1 block text-[11px] font-medium text-zinc-600 dark:text-zinc-300";
  const textAreaClass = `${inputClass} min-h-24 font-mono`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div role="dialog" aria-modal="true" className="flex h-[min(80vh,720px)] w-full max-w-6xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-950">
        <aside className="flex w-80 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-700">
          <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t("explorer.rules.title")}</h2>
              <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                {explorerSelection.topicName} / {explorerSelection.subscriptionName}
              </p>
            </div>
            <button onClick={close} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200" aria-label={t("explorer.rules.close")}>
              <Icon name="close" size={16} />
            </button>
          </div>

          <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
            <button onClick={onNewRule} className="flex items-center gap-1 rounded border border-azure-primary px-2.5 py-1.5 text-xs text-azure-primary hover:bg-azure-primary/10">
              <Icon name="plus" size={12} />
              {t("explorer.rules.newRule")}
            </button>
            <button onClick={() => { void loadRules(selectedKey); }} className="rounded border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
              {t("explorer.rules.refresh")}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-xs text-zinc-500 dark:text-zinc-400">{t("explorer.rules.loading")}</div>
            ) : loadError ? (
              <div className="space-y-2 p-4 text-xs">
                <p className="text-red-600 dark:text-red-400">{t("explorer.rules.loadError")}</p>
                <p className="break-all text-zinc-500 dark:text-zinc-400">{loadError}</p>
              </div>
            ) : rules.length === 0 ? (
              <div className="p-4 text-xs text-zinc-500 dark:text-zinc-400">{t("explorer.rules.empty")}</div>
            ) : (
              rules.map((rule) => {
                const selected = selectedKey === rule.name;
                return (
                  <button
                    key={rule.name}
                    onClick={() => onSelectRule(rule.name)}
                    className={[
                      "block w-full border-b border-zinc-100 px-4 py-3 text-left transition-colors dark:border-zinc-800",
                      selected ? "bg-azure-primary/10" : "hover:bg-zinc-50 dark:hover:bg-zinc-900",
                    ].join(" ")}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">{rule.name}</span>
                      {rule.name === "$Default" && (
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          $Default
                        </span>
                      )}
                      <FilterBadge kind={rule.filter.kind} />
                    </div>
                    <div className="mt-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400">{summarizeSubscriptionRule(rule)}</div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-azure-primary dark:border-zinc-600 dark:border-t-azure-primary" />
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("explorer.rules.loading")}</p>
              </div>
            </div>
          ) : loadError ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="space-y-2 text-center text-xs">
                <p className="text-red-600 dark:text-red-400">{t("explorer.rules.loadError")}</p>
                <p className="break-all text-zinc-500 dark:text-zinc-400">{loadError}</p>
              </div>
            </div>
          ) : (
          <>
          <div className="border-b border-zinc-200 px-5 py-4 dark:border-zinc-700">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {isNewRule ? t("explorer.rules.newRule") : draft.name || t("explorer.rules.editor")}
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("explorer.rules.editorHint")}</p>
              </div>
              {!isNewRule && (
                <button
                  onClick={() => void deleteRule()}
                  disabled={deleting || currentRule?.name === "$Default"}
                  className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
                >
                  {deleting ? t("explorer.rules.deleting") : t("explorer.rules.delete")}
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div>
              <label className={labelClass}>{t("explorer.rules.ruleName")}</label>
              <input
                aria-label={t("explorer.rules.ruleName")}
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                disabled={!isNewRule}
                className={`${inputClass} disabled:cursor-not-allowed disabled:bg-zinc-100 dark:disabled:bg-zinc-800`}
              />
              {!isNewRule && (
                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{t("explorer.rules.ruleNameLocked")}</p>
              )}
            </div>

            <div>
              <label className={labelClass}>{t("explorer.rules.filterType")}</label>
              <select
                aria-label={t("explorer.rules.filterType")}
                value={draft.filterKind}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    filterKind: event.target.value as RuleDraft["filterKind"],
                  }))
                }
                className={inputClass}
              >
                <option value="sql">{t("explorer.rules.filterSql")}</option>
                <option value="correlation">{t("explorer.rules.filterCorrelation")}</option>
                <option value="true">{t("explorer.rules.filterTrue")}</option>
                <option value="false">{t("explorer.rules.filterFalse")}</option>
              </select>
            </div>

            {draft.filterKind === "sql" && (
              <>
                <div>
                  <label className={labelClass}>{t("explorer.rules.sqlExpression")}</label>
                  <textarea
                    aria-label={t("explorer.rules.sqlExpression")}
                    value={draft.sqlExpression}
                    onChange={(event) => setDraft((current) => ({ ...current, sqlExpression: event.target.value }))}
                    className={textAreaClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>{t("explorer.rules.sqlParameters")}</label>
                  <textarea
                    aria-label={t("explorer.rules.sqlParameters")}
                    value={draft.sqlParametersText}
                    onChange={(event) => setDraft((current) => ({ ...current, sqlParametersText: event.target.value }))}
                    className={textAreaClass}
                  />
                </div>
              </>
            )}

            {draft.filterKind === "correlation" && (
              <>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {(
                    [
                      ["contentType", t("explorer.rules.contentType")],
                      ["correlationId", t("explorer.rules.correlationId")],
                      ["messageId", t("explorer.rules.messageId")],
                      ["replyTo", t("explorer.rules.replyTo")],
                      ["replyToSessionId", t("explorer.rules.replyToSessionId")],
                      ["sessionId", t("explorer.rules.sessionId")],
                      ["subject", t("explorer.rules.subject")],
                      ["to", t("explorer.rules.to")],
                    ] as const
                  ).map(([field, label]) => (
                    <div key={field}>
                      <label className={labelClass}>{label}</label>
                      <input
                        aria-label={label}
                        value={draft.correlation[field]}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            correlation: { ...current.correlation, [field]: event.target.value },
                          }))
                        }
                        className={inputClass}
                      />
                    </div>
                  ))}
                </div>
                <div>
                  <label className={labelClass}>{t("explorer.rules.applicationProperties")}</label>
                  <textarea
                    aria-label={t("explorer.rules.applicationProperties")}
                    value={draft.correlation.applicationPropertiesText}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        correlation: { ...current.correlation, applicationPropertiesText: event.target.value },
                      }))
                    }
                    className={textAreaClass}
                  />
                </div>
              </>
            )}

            {(draft.filterKind === "true" || draft.filterKind === "false") && (
              <p className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                {draft.filterKind === "true" ? t("explorer.rules.trueDescription") : t("explorer.rules.falseDescription")}
              </p>
            )}

            <div className="rounded border border-zinc-200 p-4 dark:border-zinc-800">
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-200">
                <input
                  type="checkbox"
                  checked={draft.hasAction}
                  onChange={(event) => setDraft((current) => ({ ...current, hasAction: event.target.checked }))}
                />
                {t("explorer.rules.enableAction")}
              </label>

              {draft.hasAction && (
                <div className="mt-3 space-y-3">
                  <div>
                    <label className={labelClass}>{t("explorer.rules.actionExpression")}</label>
                    <textarea
                      aria-label={t("explorer.rules.actionExpression")}
                      value={draft.actionExpression}
                      onChange={(event) => setDraft((current) => ({ ...current, actionExpression: event.target.value }))}
                      className={textAreaClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>{t("explorer.rules.actionParameters")}</label>
                    <textarea
                      aria-label={t("explorer.rules.actionParameters")}
                      value={draft.actionParametersText}
                      onChange={(event) => setDraft((current) => ({ ...current, actionParametersText: event.target.value }))}
                      className={textAreaClass}
                    />
                  </div>
                </div>
              )}
            </div>

            {mutationError && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                {mutationError}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-5 py-4 dark:border-zinc-700">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{t("explorer.rules.footerHint")}</span>
            <div className="flex items-center gap-2">
              <button onClick={close} className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
                {t("explorer.rules.close")}
              </button>
              <button
                onClick={() => void saveRule()}
                disabled={saving}
                className="rounded bg-azure-primary px-3 py-1.5 text-xs text-white hover:bg-azure-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? t("explorer.rules.saving") : t("explorer.rules.save")}
              </button>
            </div>
          </div>
          </>
          )}
        </section>
      </div>
    </div>
  );
}
