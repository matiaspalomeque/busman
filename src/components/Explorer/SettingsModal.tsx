import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { version as APP_VERSION } from "../../../package.json";
import { useAppStore } from "../../store/appStore";
import type { SettingsTab } from "../../store/appStore";
import { Icon } from "../Common/Icon";
import type { IconName } from "../Common/Icon";
import { ButtonGroup, ToggleSwitch } from "../Common/FormControls";
import type { ButtonGroupOption } from "../Common/FormControls";
import { ConnectionsPanel } from "./ConnectionsPanel";

// ─── Section constants ────────────────────────────────────────────────────────

const SECTION_HEADING =
  "text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-1.5";
const SECTION_CARD =
  "rounded border border-zinc-200 dark:border-zinc-700 p-2 space-y-2";
const ROW = "flex items-center justify-between";
const LABEL = "text-xs text-zinc-600 dark:text-zinc-300";

// ─── Tab definitions ──────────────────────────────────────────────────────────

const TABS: { id: SettingsTab; labelKey: string; icon: IconName }[] = [
  { id: "connections", labelKey: "explorer.settingsModal.tabs.connections", icon: "server" },
  { id: "appearance", labelKey: "explorer.settingsModal.tabs.appearance", icon: "sun" },
  { id: "autoRefresh", labelKey: "explorer.settingsModal.tabs.autoRefresh", icon: "refresh" },
  { id: "notifications", labelKey: "explorer.settingsModal.tabs.notifications", icon: "bell" },
];

// ─── Button group options ─────────────────────────────────────────────────────

const THEME_OPTIONS: ButtonGroupOption<"light" | "dark">[] = [
  { value: "light", label: <Icon name="sun" size={12} /> },
  { value: "dark", label: <Icon name="moon" size={12} /> },
];

const LANG_OPTIONS: ButtonGroupOption<"en" | "es">[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
];

const INTERVAL_OPTIONS: ButtonGroupOption<15 | 30 | 60>[] = [
  { value: 15, label: "15s" },
  { value: 30, label: "30s" },
  { value: 60, label: "60s" },
];

// ─── Panels ───────────────────────────────────────────────────────────────────

function AppearancePanel() {
  const { t } = useTranslation();
  const { isDark, toggleDark, language, setLanguage } = useAppStore();

  return (
    <div className="px-5 py-4 space-y-3">
      <div>
        <div className={SECTION_HEADING}>{t("explorer.settingsModal.tabs.appearance")}</div>
        <div className={SECTION_CARD}>
          <div className={ROW}>
            <span className={LABEL}>{t("explorer.settingsModal.theme")}</span>
            <ButtonGroup
              options={THEME_OPTIONS}
              value={isDark ? "dark" : "light"}
              onChange={(v) => {
                if ((v === "dark") !== isDark) toggleDark();
              }}
            />
          </div>
          <div className={ROW}>
            <span className={LABEL}>{t("explorer.settingsModal.language")}</span>
            <ButtonGroup options={LANG_OPTIONS} value={language} onChange={setLanguage} />
          </div>
        </div>
      </div>
    </div>
  );
}

function AutoRefreshPanel() {
  const { t } = useTranslation();
  const {
    autoRefreshEnabled, setAutoRefreshEnabled,
    autoRefreshInterval, setAutoRefreshInterval,
    sparklineEnabled, setSparklineEnabled,
  } = useAppStore();

  return (
    <div className="px-5 py-4 space-y-3">
      <div>
        <div className={SECTION_HEADING}>{t("explorer.settingsModal.tabs.autoRefresh")}</div>
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mb-1.5">
          {t("explorer.settingsModal.autoRefreshDescription")}
        </p>
        <div className={SECTION_CARD}>
          <div className={ROW}>
            <span className={LABEL}>{t("explorer.settingsModal.enabled")}</span>
            <ToggleSwitch
              enabled={autoRefreshEnabled}
              onToggle={() => setAutoRefreshEnabled(!autoRefreshEnabled)}
              ariaLabel={
                autoRefreshEnabled
                  ? t("explorer.settingsModal.autoRefreshEnabledAria")
                  : t("explorer.settingsModal.autoRefreshDisabledAria")
              }
            />
          </div>
          <div className={ROW}>
            <span className={LABEL}>{t("explorer.settingsModal.interval")}</span>
            <ButtonGroup
              options={INTERVAL_OPTIONS}
              value={autoRefreshInterval}
              onChange={setAutoRefreshInterval}
              disabled={!autoRefreshEnabled}
              className="transition-opacity"
            />
          </div>
          <div className={ROW}>
            <span className={LABEL}>{t("explorer.settingsModal.sparklineEnabled")}</span>
            <ToggleSwitch
              enabled={sparklineEnabled}
              onToggle={() => setSparklineEnabled(!sparklineEnabled)}
              ariaLabel={
                sparklineEnabled
                  ? t("explorer.settingsModal.sparklineEnabledAria")
                  : t("explorer.settingsModal.sparklineDisabledAria")
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function NotificationsPanel() {
  const { t } = useTranslation();
  const { dlqNotificationsEnabled, setDlqNotificationsEnabled } = useAppStore();

  return (
    <div className="px-5 py-4 space-y-3">
      <div>
        <div className={SECTION_HEADING}>{t("explorer.settingsModal.tabs.notifications")}</div>
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mb-1.5">
          {t("explorer.settingsModal.dlqAlertsDescription")}
        </p>
        <div className={SECTION_CARD}>
          <div className={ROW}>
            <span className={LABEL}>{t("explorer.settingsModal.dlqAlerts")}</span>
            <ToggleSwitch
              enabled={dlqNotificationsEnabled}
              onToggle={() => setDlqNotificationsEnabled(!dlqNotificationsEnabled)}
              ariaLabel={
                dlqNotificationsEnabled
                  ? t("explorer.settingsModal.dlqNotificationsEnabledAria")
                  : t("explorer.settingsModal.dlqNotificationsDisabledAria")
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Settings modal ───────────────────────────────────────────────────────────

export function SettingsModal() {
  const { t } = useTranslation();
  const { settingsTab, setSettingsTab, setIsSettingsModalOpen, setIsAboutModalOpen } = useAppStore();
  const overlayRef = useRef<HTMLDivElement>(null);

  const close = () => setIsSettingsModalOpen(false);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-3xl h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-700 shrink-0">
          <h2 className="text-sm font-semibold text-azure-dark dark:text-azure-light flex items-center gap-2">
            <Icon name="settings" size={14} className="text-azure-primary" />
            {t("explorer.settingsModal.title")}
          </h2>
          <button
            onClick={close}
            className="p-1 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left rail */}
          <div
            role="tablist"
            aria-label={t("explorer.settingsModal.title")}
            className="w-44 border-r border-zinc-200 dark:border-zinc-700 py-2 shrink-0"
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={settingsTab === tab.id}
                onClick={() => setSettingsTab(tab.id)}
                className={[
                  "w-full flex items-center gap-2 px-4 py-2 text-xs text-left transition-colors",
                  settingsTab === tab.id
                    ? "bg-azure-primary/10 text-azure-primary font-medium"
                    : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800",
                ].join(" ")}
              >
                <Icon name={tab.icon} size={13} />
                {t(tab.labelKey)}
              </button>
            ))}
          </div>

          {/* Tab panel */}
          <div
            role="tabpanel"
            className="flex-1 flex flex-col min-h-0"
          >
            {settingsTab === "connections" && <ConnectionsPanel />}
            {settingsTab === "appearance" && <AppearancePanel />}
            {settingsTab === "autoRefresh" && <AutoRefreshPanel />}
            {settingsTab === "notifications" && <NotificationsPanel />}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-zinc-200 dark:border-zinc-700 shrink-0">
          <button
            onClick={() => setIsAboutModalOpen(true)}
            className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 hover:text-azure-primary transition-colors"
          >
            <span>{t("about.title")}</span>
            <span className="text-[10px] text-zinc-400">v{APP_VERSION}</span>
          </button>
          <button
            onClick={close}
            className="text-xs px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
          >
            {t("explorer.settingsModal.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
