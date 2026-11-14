import { useRef, type ReactElement } from "react";
import { NoticeBanner } from "./design-system/index.ts";
import { AuthScreen } from "./features/auth/AuthScreen.tsx";
import { JoinRoomScreen } from "./features/lobby/JoinRoomScreen.tsx";
import { RoomScreen } from "./features/room/RoomScreen.tsx";
import { useAuthSession } from "./hooks/useAuthSession.ts";
import { useRoomSession } from "./hooks/useRoomSession.ts";
import { I18nProvider, useI18n } from "./i18n/I18nProvider.tsx";
import { ThemeProvider } from "./theme/ThemeProvider.tsx";

export { RoomRuntimeSlot } from "./state/runtime-slot.ts";

function AppShell(): ReactElement {
  const { t } = useI18n();
  const leaveRoomRef = useRef<() => Promise<void>>(async () => {});

  const auth = useAuthSession({
    onBeforeSessionReset: () => leaveRoomRef.current(),
  });

  const room = useRoomSession({
    user: auth.user,
    authClient: auth.authClient,
    onSessionExpired: auth.expireToReauth,
  });

  leaveRoomRef.current = room.leaveRoom;

  if (auth.bootstrapping) {
    return (
      <div className="screen-shell">
        <main className="centered-stage">
          <div className="dialog-column">
            <NoticeBanner tone="info" loading>
              {t("app.loading")}
            </NoticeBanner>
          </div>
        </main>
      </div>
    );
  }

  if (!auth.user) {
    return (
      <AuthScreen
        onLogin={auth.login}
        onRegister={auth.register}
        externalNoticeKey={auth.authNoticeKey}
      />
    );
  }

  if (!room.inRoom) {
    return (
      <JoinRoomScreen
        user={auth.user}
        joinPhase={room.joinPhase}
        joinFailure={room.joinFailure}
        onClearJoinFailure={room.clearJoinFailure}
        onJoinRoom={room.joinRoom}
        onSignOut={auth.signOut}
      />
    );
  }

  return (
    <RoomScreen
      user={auth.user}
      localPeerId={room.localPeerId}
      roomIdPrefix={room.roomIdPrefix}
      centerConnected={room.centerConnected}
      peers={room.peers}
      messages={room.messages}
      files={room.files}
      transfers={room.transfers}
      securityEvent={room.securityEvent}
      onDismissSecurityEvent={room.dismissSecurityEvent}
      onSendMessage={room.sendMessage}
      onShareFiles={room.shareFiles}
      onDownloadFile={room.downloadFile}
      onCancelDownload={room.cancelDownload}
      onSaveFile={room.saveFile}
      canSaveFile={room.canSaveFile}
      onLeaveRoom={room.leaveRoom}
      onSignOut={auth.signOut}
    />
  );
}

export function App(): ReactElement {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AppShell />
      </I18nProvider>
    </ThemeProvider>
  );
}
