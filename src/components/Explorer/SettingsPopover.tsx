import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../Common/Icon";
import { version as APP_VERSION } from "../../../package.json";

// ─── Static class strings ────────────────────────────────────────────────────

const SECTION_HEADING =
  "text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-1.5";
const SECTION_CARD =
  "rounded border border-zinc-200 dark:border-zinc-700 p-2 space-y-2";
const ROW = "flex items-center justify-between";
const LABEL = "text-xs text-zinc-600 dark:text-zinc-300";

// ─── Reusable local components ───────────────────────────────────────────────

function ToggleSwitch({ enabled, onToggle, ariaLabel }: { enabled: boolean; onToggle: () => void; ariaLabel: string }) {
  return (
    <button
      onClick={onToggle}
      className={[
        "relative w-8 h-[18px] rounded-full transition-colors",
        enabled ? "bg-azure-primary" : "bg-zinc-300 dark:bg-zinc-600",
      ].join(" ")}
      aria-label={ariaLabel}
    >
      <span
        className={[
          "absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform",
          enabled ? "translate-x-3.5" : "",
        ].join(" ")}
      />
    </button>
  );
}

interface ButtonGroupOption<T extends string | number> {
  value: T;
  label: string | React.ReactNode;
  title?: string;
}

function ButtonGroup<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  options: ButtonGroupOption<T>[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={[
      "flex items-center border border-zinc-300 dark:border-zinc-600 rounded overflow-hidden",
      disabled ? "opacity-40 pointer-events-none" : "",
      className ?? "",
    ].join(" ")}>
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          onClick={() => { if (opt.value !== value) onChange(opt.value); }}
          className={[
            "px-1.5 py-1 text-[10px] transition-colors font-medium",
            value === opt.value
              ? "bg-azure-primary text-white"
              : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700",
          ].join(" ")}
          title={opt.title}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── Settings popover ────────────────────────────────────────────────────────

interface SettingsPopoverProps {
  isDark: boolean;
  toggleDark: () => void;
  language: "en" | "es";
  setLanguage: (lang: "en" | "es") => void;
  autoRefreshEnabled: boolean;
  setAutoRefreshEnabled: (v: boolean) => void;
  autoRefreshInterval: 15 | 30 | 60;
  setAutoRefreshInterval: (v: 15 | 30 | 60) => void;
  dlqNotificationsEnabled: boolean;
  setDlqNotificationsEnabled: (v: boolean) => void;
  setIsAboutModalOpen: (v: boolean) => void;
  hasEntities: boolean;
}

const THEME_OPTIONS: ButtonGroupOption<"light" | "dark">[] = [
  { value: "light", label: <Icon name="sun" size={12} /> },
  { value: "dark", label: <Icon name="moon" size={12} /> },
];

const LANG_OPTIONS: ButtonGroupOption<"en" | "es">[] = [
  { value: "en", label: "EN" },
  { value: "es", label: "ES" },
];

const INTERVAL_OPTIONS: ButtonGroupOption<15 | 30 | 60>[] = [
  { value: 15, label: "15s" },
  { value: 30, label: "30s" },
  { value: 60, label: "60s" },
];

export function SettingsPopover({
  isDark,
  toggleDark,
  language,
  setLanguage,
  autoRefreshEnabled,
  setAutoRefreshEnabled,
  autoRefreshInterval,
  setAutoRefreshInterval,
  dlqNotificationsEnabled,
  setDlqNotificationsEnabled,
  setIsAboutModalOpen,
  hasEntities,
}: SettingsPopoverProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-1 rounded text-zinc-400 hover:text-azure-primary hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        title={t("explorer.sidebar.settings")}
        aria-label={t("explorer.sidebar.settings")}
      >
        <Icon name="settings" size={13} />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-[220px] bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg z-30 p-3 space-y-3">
          <div>
            <div className={SECTION_HEADING}>{t("explorer.sidebar.appearance")}</div>
            <div className={SECTION_CARD}>
              <div className={ROW}>
                <span className={LABEL}>{t("explorer.sidebar.theme")}</span>
                <ButtonGroup
                  options={THEME_OPTIONS}
                  value={isDark ? "dark" : "light"}
                  onChange={(v) => { if ((v === "dark") !== isDark) toggleDark(); }}
                />
              </div>
              <div className={ROW}>
                <span className={LABEL}>{t("explorer.sidebar.language")}</span>
                <ButtonGroup options={LANG_OPTIONS} value={language} onChange={setLanguage} />
              </div>
            </div>
          </div>

          {hasEntities && (
            <div>
              <div className={SECTION_HEADING}>{t("explorer.sidebar.autoRefresh")}</div>
              <div className={SECTION_CARD}>
                <div className={ROW}>
                  <span className={LABEL}>{t("explorer.sidebar.enabled")}</span>
                  <ToggleSwitch
                    enabled={autoRefreshEnabled}
                    onToggle={() => setAutoRefreshEnabled(!autoRefreshEnabled)}
                    ariaLabel={autoRefreshEnabled ? t("explorer.sidebar.autoRefreshEnabled") : t("explorer.sidebar.autoRefreshDisabled")}
                  />
                </div>
                <div className={ROW}>
                  <span className={LABEL}>{t("explorer.sidebar.interval")}</span>
                  <ButtonGroup
                    options={INTERVAL_OPTIONS}
                    value={autoRefreshInterval}
                    onChange={setAutoRefreshInterval}
                    disabled={!autoRefreshEnabled}
                    className="transition-opacity"
                  />
                </div>
              </div>
            </div>
          )}

          <div>
            <div className={SECTION_HEADING}>{t("explorer.sidebar.notifications")}</div>
            <div className={SECTION_CARD}>
              <div className={ROW}>
                <span className={LABEL}>{t("explorer.sidebar.dlqAlerts")}</span>
                <ToggleSwitch
                  enabled={dlqNotificationsEnabled}
                  onToggle={() => setDlqNotificationsEnabled(!dlqNotificationsEnabled)}
                  ariaLabel={dlqNotificationsEnabled ? t("explorer.sidebar.dlqNotificationsEnabled") : t("explorer.sidebar.dlqNotificationsDisabled")}
                />
              </div>
            </div>
          </div>

          <button
            onClick={() => { setIsAboutModalOpen(true); setOpen(false); }}
            className="flex items-center justify-between w-full text-xs text-zinc-600 dark:text-zinc-300 hover:text-azure-primary transition-colors py-1"
          >
            <span>{t("about.title")}</span>
            <span className="text-[10px] text-zinc-400">v{APP_VERSION}</span>
          </button>
        </div>
      )}
    </div>
  );
}
