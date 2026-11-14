export const LOCALE_CODES = [
  "zh-CN",
  "zh-TW",
  "en",
  "ja",
  "ko",
  "es",
] as const;

export type LocaleCode = (typeof LOCALE_CODES)[number];

export const LOCALE_STORAGE_KEY = "simpleim.locale";

export interface LocaleOption {
  readonly code: LocaleCode;
  readonly nativeLabel: string;
}

export interface TranslationSchema {
  // App & Preferences
  "app.title": string;
  "app.loading": string;
  "prefs.themeAria": string;
  "prefs.theme.system": string;
  "prefs.theme.dark": string;
  "prefs.theme.light": string;
  "prefs.languageAria": string;

  // Auth Screen
  "auth.tabAria": string;
  "auth.tab.login": string;
  "auth.tab.register": string;
  "auth.title.login": string;
  "auth.title.register": string;
  "auth.field.username": string;
  "auth.field.usernamePlaceholder": string;
  "auth.field.displayName": string;
  "auth.field.displayNameHint": string;
  "auth.field.displayNamePlaceholder": string;
  "auth.field.password": string;
  "auth.submit.login": string;
  "auth.submit.loginBusy": string;
  "auth.submit.register": string;
  "auth.submit.registerBusy": string;
  "auth.notice.crossTabLogout": string;
  "auth.notice.reauthRequired": string;

  // Lobby / Join Room Screen
  "lobby.title": string;
  "lobby.subtitle": string;
  "lobby.field.passphrase": string;
  "lobby.field.passphrasePlaceholder": string;
  "lobby.passphrase.show": string;
  "lobby.passphrase.hide": string;
  "lobby.passphrase.showAria": string;
  "lobby.passphrase.hideAria": string;
  "lobby.phase.deriving": string;
  "lobby.phase.connecting": string;
  "lobby.submit.idle": string;
  "lobby.signOut": string;

  // Room Workspace
  "room.status.online": string;
  "room.status.detached": string;
  "room.status.onlineHint": string;
  "room.status.detachedHint": string;
  "room.drawerToggle": string;
  "room.leave": string;
  "room.signOut": string;
  "room.dismiss": string;
  "room.dropFiles": string;
  "room.streamAria": string;
  "room.empty": string;
  "room.you": string;
  "room.reply": string;
  "room.quotedFallback": string;
  "room.replyingTo": string;
  "room.cancelReply": string;
  "room.attach": string;
  "room.attachAria": string;
  "room.inputPlaceholder": string;
  "room.inputAria": string;
  "room.send": string;
  "room.shortcutSend": string;
  "room.shortcutNewline": string;

  // Side Pane (Members & Files)
  "room.sidebarAria": string;
  "room.peers.heading": string;
  "room.peers.empty": string;
  "room.files.heading": string;
  "room.files.empty": string;
  "room.files.srSummary": string;
  "room.files.progressAria": string;
  "room.files.peersRatio": string;
  "room.files.status.announced": string;
  "room.files.status.downloading": string;
  "room.files.status.seeding": string;
  "room.files.status.paused": string;
  "room.files.status.error": string;
  "room.files.action.download": string;
  "room.files.action.cancel": string;
  "room.files.action.save": string;

  // Security & Validation / Error Catalog
  "security.peerRejected": string;
  "validation.username": string;
  "validation.passwordRequired": string;
  "validation.passwordLength": string;
  "validation.displayNameLength": string;
  "validation.passphraseLength": string;
  "error.invalid_arguments": string;
  "error.invalid_credentials": string;
  "error.username_taken": string;
  "error.unauthorized": string;
  "error.csrf_invalid": string;
  "error.invalid_pop": string;
  "error.room_full": string;
  "error.room_limit_exceeded": string;
  "error.rate_limited": string;
  "error.invalid_frame": string;
  "error.payload_too_large": string;
  "error.not_found": string;
  "error.internal_error": string;
  "error.hello_auth_failed": string;
  "error.cert_expired": string;
  "error.channel_binding_mismatch": string;
  "error.chunk_hash_mismatch": string;
  "error.network": string;
  "error.room_inactive": string;
}

export type TranslationKey = keyof TranslationSchema;

export type InterpolationParams = Record<string, string | number>;

export type TranslateFn = (
  key: TranslationKey,
  params?: InterpolationParams,
) => string;
