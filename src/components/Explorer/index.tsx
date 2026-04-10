import { useAppStore } from "../../store/appStore";
import { useEntityProperties } from "../../hooks/useEntityProperties";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { MessageGrid } from "./MessageGrid";
import { PropertiesPanel } from "./PropertiesPanel";
import { EventLog } from "./EventLog";
import { SendMessageModal } from "./SendMessageModal";
import { MoveMessagesModal } from "./MoveMessagesModal";
import { SettingsModal } from "./SettingsModal";
import { CreateEntityModal } from "./CreateEntityModal";
import { DeleteEntityDialog } from "./DeleteEntityDialog";
import { SubscriptionRulesModal } from "./SubscriptionRulesModal";
import { AboutModal } from "../Common/AboutModal";

export function Explorer() {
  useEntityProperties();

  const {
    isSendModalOpen,
    isMoveModalOpen,
    isSettingsModalOpen,
    isAboutModalOpen,
    setIsAboutModalOpen,
    isCreateEntityModalOpen,
    isSubscriptionRulesModalOpen,
    deleteEntityTarget,
    selectedMessage,
  } = useAppStore();

  return (
    <div className="fixed inset-0 flex flex-col">
      <Toolbar />

      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <MessageGrid />
        {selectedMessage ? <PropertiesPanel /> : null}
      </div>

      <EventLog />

      {isSendModalOpen && <SendMessageModal />}
      {isMoveModalOpen && <MoveMessagesModal />}
      {isSettingsModalOpen && <SettingsModal />}
      {isAboutModalOpen && <AboutModal onClose={() => setIsAboutModalOpen(false)} />}
      {isCreateEntityModalOpen && <CreateEntityModal />}
      {isSubscriptionRulesModalOpen && <SubscriptionRulesModal />}
      {deleteEntityTarget != null && <DeleteEntityDialog />}
    </div>
  );
}
