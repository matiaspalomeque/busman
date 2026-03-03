import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { Explorer } from "./components/Explorer";
import { WorkerNotFoundBanner } from "./components/Common/WorkerNotFoundBanner";
import { useConnections } from "./hooks/useConnections";
import { useAppStore } from "./store/appStore";
import i18n from "./i18n/index";

export function App() {
  const { loadConnections } = useConnections();
  const { workerAvailable, setWorkerAvailable, isDark, setIsDark, language, setLanguage } = useAppStore();

  // Initialise theme and language from localStorage / system preference.
  useEffect(() => {
    const checkForUpdates = async () => {
      if (!import.meta.env.PROD) {
        return;
      }

      try {
        const isPortable = await invoke<boolean>("is_portable");

        const update = await check({
          timeout: 15_000,
          ...(isPortable ? { target: "windows-x86_64-portable" } : {}),
        });
        if (!update) return;

        if (isPortable) {
          await message(i18n.t("updater.portableAvailableMessage", { version: update.version }), {
            title: i18n.t("updater.portableAvailableTitle"),
            kind: "info",
            okLabel: i18n.t("updater.ok"),
          });
          return;
        }

        const confirmed = await ask(
          i18n.t("updater.availableMessage", { version: update.version }),
          {
            title: i18n.t("updater.availableTitle"),
            kind: "info",
            okLabel: i18n.t("updater.install"),
            cancelLabel: i18n.t("updater.later"),
          }
        );
        if (!confirmed) return;

        await update.downloadAndInstall();
        await message(i18n.t("updater.installedMessage"), {
          title: i18n.t("updater.installedTitle"),
          kind: "info",
          okLabel: i18n.t("updater.ok"),
        });
      } catch (error) {
        console.error("Failed to check for updates", error);
      }
    };

    const stored = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    setIsDark(stored === "dark" || (!stored && prefersDark));

    const storedLang = localStorage.getItem("language") as "en" | "es" | null;
    setLanguage(storedLang ?? "en");

    // Check worker availability and ensure it responds.
    invoke<boolean>("check_worker").then((available) => {
      setWorkerAvailable(available);
      if (available) {
        invoke("ensure_scripts_ready").catch(console.error);
      }
    });

    // Check for a newer app release.
    void checkForUpdates();

    // Load persisted connections.
    loadConnections().catch((err) => console.error("Failed to load connections:", err));
  }, [setIsDark, setWorkerAvailable, loadConnections, setLanguage]);

  // Sync the document class and localStorage whenever isDark changes.
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [isDark]);

  // Sync language to localStorage and i18next whenever it changes.
  useEffect(() => {
    localStorage.setItem("language", language);
    void i18n.changeLanguage(language);
  }, [language]);

  return (
    <div className="h-screen overflow-hidden bg-azure-light dark:bg-azure-dark text-azure-dark dark:text-azure-light">
      {workerAvailable === false && <WorkerNotFoundBanner />}
      <Explorer />
    </div>
  );
}
