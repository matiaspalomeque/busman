import { useAppStore } from "../../store/appStore";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { MessageGrid } from "./MessageGrid";
import { PropertiesPanel } from "./PropertiesPanel";
import { EventLog } from "./EventLog";
import { SendMessageModal } from "./SendMessageModal";
import { MoveMessagesModal } from "./MoveMessagesModal";
import { ConnectionsModal } from "./ConnectionsModal";
import { AboutModal } from "../Common/AboutModal";

export function Explorer() {
  const { isSendModalOpen, isMoveModalOpen, isConnectionsModalOpen, isAboutModalOpen, setIsAboutModalOpen } = useAppStore();

  return (
    <div className="fixed inset-0 flex flex-col">
      <Toolbar />

      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <MessageGrid />
        <PropertiesPanel />
      </div>

      <EventLog />

      {isSendModalOpen && <SendMessageModal />}
      {isMoveModalOpen && <MoveMessagesModal />}
      {isConnectionsModalOpen && <ConnectionsModal />}
      {isAboutModalOpen && <AboutModal onClose={() => setIsAboutModalOpen(false)} />}
    </div>
  );
}
