import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from "react";
import type { ChatMessageEnvelope, FileManifest } from "@simpleim/contracts";
import type {
  ChatDeliveryStatus,
  SwarmTransferProgress,
} from "@simpleim/peer-core";
import {
  BrandMark,
  Button,
  Byline,
  StatusDot,
  Subline,
  Tag,
  Toast,
  ToastRegion,
} from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  truncatePreview,
  type MessageViewModel,
} from "../../state/message-vm.ts";
import {
  isTranscriptNearBottom,
  shouldAutoScrollTranscript,
} from "../../state/transcript-scroll.ts";
import { buildTranscriptTimeline } from "../../state/transcript-timeline.ts";
import {
  formatDatePillLabel,
  msUntilNextLocalMidnight,
} from "../../utils/format.ts";
import { SafeMarkdown } from "../../utils/markdown.tsx";
import { FileMessageCard } from "./FileMessageCard.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";

const FLOATING_DATE_HIDE_DELAY_MS = 1400;
const LOCATE_HIGHLIGHT_DURATION_MS = 1600;
const TRANSCRIPT_TOAST_DURATION_MS = 2200;
const INTERACTIVE_TARGET_SELECTOR =
  'a, button, input, textarea, select, label, summary, [role="button"], [role="link"]';

function findTopVisibleMessageCreatedAt(streamEl: HTMLElement): number | null {
  const entries = streamEl.querySelectorAll<HTMLElement>(
    ".msg-entry[data-created-at]",
  );
  if (entries.length === 0) {
    return null;
  }
  const thresholdTop = streamEl.getBoundingClientRect().top + 8;
  let lo = 0;
  let hi = entries.length - 1;
  let found = entries.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const rect = entries[mid]!.getBoundingClientRect();
    if (rect.bottom > thresholdTop) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  const raw = entries[found]?.dataset.createdAt;
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export interface TranscriptLocateRequest {
  readonly itemKey: string;
  readonly nonce: number;
}

export interface MessageTranscriptProps {
  readonly roomId?: string | null;
  readonly messages: readonly ChatMessageEnvelope[];
  readonly files?: readonly FileManifest[];
  readonly transfers?: ReadonlyMap<string, SwarmTransferProgress>;
  readonly canSaveFile?: (fileId: string) => boolean;
  readonly onDownloadFile?: (fileId: string) => Promise<void>;
  readonly onCancelDownload?: (fileId: string) => Promise<void>;
  readonly onSaveFile?: (manifest: FileManifest) => Promise<void>;
  readonly onReadFileBlob?: (
    fileId: string,
    mimeType: string,
  ) => Promise<Blob | null>;
  readonly onActionError?: (err: unknown) => void;
  readonly deliveryStates?: ReadonlyMap<string, ChatDeliveryStatus>;
  readonly onlinePeerUserIds?: ReadonlySet<string>;
  readonly localPeerId: string;
  readonly currentUserId: string;
  readonly onReply: (msg: ChatMessageEnvelope) => void;
  readonly onRetryMessage?: (msgId: string) => void;
  readonly locateRequest?: TranscriptLocateRequest | null;
  readonly nowMs?: number;
}

export function MessageTranscript({
  roomId = null,
  messages,
  files = [],
  transfers,
  canSaveFile,
  onDownloadFile,
  onCancelDownload,
  onSaveFile,
  onReadFileBlob,
  onActionError,
  deliveryStates,
  onlinePeerUserIds,
  localPeerId,
  currentUserId,
  onReply,
  onRetryMessage,
  locateRequest = null,
  nowMs,
}: MessageTranscriptProps): ReactElement {
  const { t } = useI18n();
  const streamRef = useRef<HTMLDivElement | null>(null);
  const expandedEntryRef = useRef<HTMLElement | null>(null);
  const isNearBottomRef = useRef(true);
  const lastClientHeightRef = useRef(0);
  const prevRoomIdRef = useRef<string | null>(roomId);
  const prevLastItemKeyRef = useRef<string | null>(null);
  const hasInitializedRoomRef = useRef(false);
  const programmaticScrollTopRef = useRef<number | null>(null);
  const hideDatePillTimerRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const liveAnnounceTimerRef = useRef<number | null>(null);
  const liveAnnounceSeqRef = useRef(0);

  const [liveNowMs, setLiveNowMs] = useState<number>(() => nowMs ?? Date.now());
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [expandedItemKey, setExpandedItemKey] = useState<string | null>(null);
  const [highlightedItemKey, setHighlightedItemKey] = useState<string | null>(
    null,
  );
  const [toastState, setToastState] = useState<{
    readonly seq: number;
    readonly message: string;
  } | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState<{
    readonly seq: number;
    readonly text: string;
  }>({ seq: 0, text: "" });
  const [floatingDateCreatedAt, setFloatingDateCreatedAt] = useState<
    number | null
  >(null);
  const [floatingDateVisible, setFloatingDateVisible] = useState(false);
  const [lightbox, setLightbox] = useState<{
    readonly imageUrl: string;
    readonly manifest: FileManifest;
  } | null>(null);

  const effectiveNowMs = nowMs ?? liveNowMs;

  // Refresh relative date labels ("Today" / "Yesterday") at local midnight and on tab wake.
  useEffect(() => {
    if (nowMs !== undefined) {
      return;
    }
    const timer = window.setTimeout(() => {
      setLiveNowMs(Date.now());
    }, msUntilNextLocalMidnight(liveNowMs));

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        setLiveNowMs(Date.now());
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [liveNowMs, nowMs]);

  const clearHideDatePillTimer = useCallback((): void => {
    if (hideDatePillTimerRef.current !== null) {
      window.clearTimeout(hideDatePillTimerRef.current);
      hideDatePillTimerRef.current = null;
    }
  }, []);

  const clearHighlightTimer = useCallback((): void => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
  }, []);

  const clearLiveAnnounceTimer = useCallback((): void => {
    if (liveAnnounceTimerRef.current !== null) {
      window.clearTimeout(liveAnnounceTimerRef.current);
      liveAnnounceTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearHideDatePillTimer();
      clearHighlightTimer();
      clearLiveAnnounceTimer();
    };
  }, [
    clearHideDatePillTimer,
    clearHighlightTimer,
    clearLiveAnnounceTimer,
  ]);

  // Close lightbox automatically if the referenced file is no longer in the active room.
  useEffect(() => {
    if (!lightbox) return;
    const stillPresent = files.some(
      (f) => f.fileId === lightbox.manifest.fileId,
    );
    if (!stillPresent) {
      setLightbox(null);
    }
  }, [files, lightbox]);

  const dateLabels = useMemo(
    () => ({
      today: t("room.date.today"),
      yesterday: t("room.date.yesterday"),
    }),
    [t],
  );

  const timeline = useMemo(
    () =>
      buildTranscriptTimeline({
        messages,
        files,
        transfers,
        canSaveFile,
        localPeerId,
        currentUserId,
        deliveryStates,
        nowMs: effectiveNowMs,
        dateLabels,
      }),
    [
      canSaveFile,
      currentUserId,
      dateLabels,
      deliveryStates,
      effectiveNowMs,
      files,
      localPeerId,
      messages,
      transfers,
    ],
  );

  const latestItem =
    timeline.length > 0 ? timeline[timeline.length - 1] : undefined;
  const latestItemKey = latestItem?.itemKey ?? null;
  const latestItemIsSelf = latestItem?.isSelf ?? false;

  const setProgrammaticScrollTop = useCallback(
    (el: HTMLElement, nextScrollTop: number): void => {
      const prevScrollTop = el.scrollTop;
      el.scrollTop = nextScrollTop;
      if (el.scrollTop !== prevScrollTop) {
        programmaticScrollTopRef.current = el.scrollTop;
      }
    },
    [],
  );

  const scrollToBottom = useCallback((): void => {
    const el = streamRef.current;
    if (!el) return;
    setProgrammaticScrollTop(el, el.scrollHeight);
    lastClientHeightRef.current = el.clientHeight;
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
    clearHideDatePillTimer();
    setFloatingDateVisible(false);
  }, [clearHideDatePillTimer, setProgrammaticScrollTop]);

  const scrollToItemKey = useCallback(
    (targetItemKey: string): boolean => {
      const el = streamRef.current;
      if (!el) return false;
      const entries = el.querySelectorAll<HTMLElement>(
        ".msg-entry[data-item-key]",
      );
      let targetEl: HTMLElement | null = null;
      for (let i = 0; i < entries.length; i++) {
        if (entries[i]!.dataset.itemKey === targetItemKey) {
          targetEl = entries[i]!;
          break;
        }
      }
      if (!targetEl) {
        return false;
      }

      // Container-local scroll without scrollIntoView() so iOS Safari never shifts .room-shell.
      const streamRect = el.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();
      const targetOffsetWithinStream =
        targetRect.top - streamRect.top + el.scrollTop;
      const centeredTop = Math.max(
        0,
        Math.min(
          el.scrollHeight - el.clientHeight,
          targetOffsetWithinStream -
            Math.max(0, (el.clientHeight - targetRect.height) / 2),
        ),
      );
      setProgrammaticScrollTop(el, centeredTop);
      const nearBottom = isTranscriptNearBottom({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
      isNearBottomRef.current = nearBottom;
      setShowJumpToLatest(!nearBottom && el.scrollHeight - el.clientHeight > 120);

      clearHighlightTimer();
      setHighlightedItemKey(targetItemKey);
      highlightTimerRef.current = window.setTimeout(() => {
        highlightTimerRef.current = null;
        setHighlightedItemKey(null);
      }, LOCATE_HIGHLIGHT_DURATION_MS);
      return true;
    },
    [clearHighlightTimer, setProgrammaticScrollTop],
  );

  useEffect(() => {
    if (!locateRequest) return;
    scrollToItemKey(locateRequest.itemKey);
  }, [locateRequest, scrollToItemKey]);

  const handleScroll = useCallback((): void => {
    const el = streamRef.current;
    if (!el) return;
    // On iOS Safari, opening the keyboard shrinks clientHeight and may emit a
    // scroll event before ResizeObserver fires; preserve bottom lock in that case.
    if (
      lastClientHeightRef.current > 0 &&
      el.clientHeight < lastClientHeightRef.current &&
      isNearBottomRef.current
    ) {
      lastClientHeightRef.current = el.clientHeight;
      setProgrammaticScrollTop(el, el.scrollHeight);
      return;
    }
    lastClientHeightRef.current = el.clientHeight;
    const nearBottom = isTranscriptNearBottom({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    isNearBottomRef.current = nearBottom;
    if (nearBottom) {
      setShowJumpToLatest(false);
    } else if (el.scrollHeight - el.clientHeight > 120) {
      setShowJumpToLatest(true);
    }

    if (
      programmaticScrollTopRef.current !== null &&
      Math.abs(el.scrollTop - programmaticScrollTopRef.current) <= 2
    ) {
      programmaticScrollTopRef.current = null;
      return;
    }
    programmaticScrollTopRef.current = null;

    if (el.scrollHeight - el.clientHeight > 40) {
      const topCreatedAt = findTopVisibleMessageCreatedAt(el);
      if (topCreatedAt !== null) {
        setFloatingDateCreatedAt(topCreatedAt);
        setFloatingDateVisible(true);
        clearHideDatePillTimer();
        hideDatePillTimerRef.current = window.setTimeout(() => {
          hideDatePillTimerRef.current = null;
          setFloatingDateVisible(false);
        }, FLOATING_DATE_HIDE_DELAY_MS);
      }
    } else {
      clearHideDatePillTimer();
      setFloatingDateVisible(false);
    }
  }, [clearHideDatePillTimer, setProgrammaticScrollTop]);

  // Container-local smart auto-scroll: never uses scrollIntoView() so iOS Safari
  // cannot scroll ancestor overflow:hidden shells or yank users reading history.
  useEffect(() => {
    const roomChanged = prevRoomIdRef.current !== roomId;
    const previousLastItemKey = prevLastItemKeyRef.current;
    const wasInitialized = hasInitializedRoomRef.current;
    const shouldScroll = shouldAutoScrollTranscript({
      roomChanged,
      previousLastMsgId: previousLastItemKey,
      nextLastMsgId: latestItemKey,
      wasNearBottom: isNearBottomRef.current,
      latestMessageIsSelf: latestItemIsSelf,
    });

    prevRoomIdRef.current = roomId;
    prevLastItemKeyRef.current = latestItemKey;
    hasInitializedRoomRef.current = true;

    if (roomChanged) {
      setExpandedItemKey(null);
      setHighlightedItemKey(null);
      setToastState(null);
      clearLiveAnnounceTimer();
      setLiveAnnouncement({ seq: 0, text: "" });
      setLightbox(null);
      clearHideDatePillTimer();
      clearHighlightTimer();
      setFloatingDateVisible(false);
      setFloatingDateCreatedAt(null);
    }

    if (
      !roomChanged &&
      wasInitialized &&
      latestItemKey !== null &&
      latestItemKey !== previousLastItemKey &&
      latestItem &&
      !latestItem.isSelf
    ) {
      const nextText =
        latestItem.kind === "message"
          ? t("room.srNewMessage", {
              author: latestItem.vm.authorDisplayName,
              preview: truncatePreview(latestItem.vm.body, 80),
            })
          : t("room.srNewFile", {
              author: latestItem.authorDisplayName,
              name: latestItem.manifest.fileName,
            });
      const nextSeq = ++liveAnnounceSeqRef.current;
      clearLiveAnnounceTimer();
      // Clear first, then repopulate on the next task so repeated identical summaries
      // still mutate the static aria-live region and trigger a screen-reader announcement.
      setLiveAnnouncement({ seq: nextSeq, text: "" });
      liveAnnounceTimerRef.current = window.setTimeout(() => {
        liveAnnounceTimerRef.current = null;
        setLiveAnnouncement({ seq: nextSeq, text: nextText });
      }, 0);
    }

    if (roomChanged && latestItemKey === null) {
      isNearBottomRef.current = true;
      setShowJumpToLatest(false);
      if (streamRef.current) {
        setProgrammaticScrollTop(streamRef.current, 0);
      }
      return;
    }

    if (shouldScroll) {
      scrollToBottom();
    } else if (
      !roomChanged &&
      latestItemKey !== null &&
      previousLastItemKey !== null &&
      latestItemKey !== previousLastItemKey
    ) {
      setShowJumpToLatest(true);
    }
  }, [
    clearHideDatePillTimer,
    clearHighlightTimer,
    clearLiveAnnounceTimer,
    latestItem,
    latestItemIsSelf,
    latestItemKey,
    roomId,
    scrollToBottom,
    setProgrammaticScrollTop,
    t,
    timeline.length,
  ]);

  // Keep transcript anchored at bottom when mobile viewport shrinks (e.g. iOS keyboard opens)
  // ONLY if the user was already at the bottom.
  useEffect(() => {
    const el = streamRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      lastClientHeightRef.current = el.clientHeight;
      if (isNearBottomRef.current) {
        setProgrammaticScrollTop(el, el.scrollHeight);
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [setProgrammaticScrollTop]);

  // When tapping a message/file near the bottom edge to inspect its full timestamp,
  // gently reveal the expanded timestamp drawer within .message-stream without scrollIntoView().
  useEffect(() => {
    if (!expandedItemKey) {
      return;
    }
    const streamEl = streamRef.current;
    const entryEl = expandedEntryRef.current;
    if (!streamEl || !entryEl || !entryEl.isConnected) {
      return;
    }
    const streamRect = streamEl.getBoundingClientRect();
    const entryRect = entryEl.getBoundingClientRect();
    if (entryRect.bottom > streamRect.bottom) {
      const delta = entryRect.bottom - streamRect.bottom + 8;
      setProgrammaticScrollTop(streamEl, streamEl.scrollTop + delta);
    }
  }, [expandedItemKey, setProgrammaticScrollTop]);

  const toggleExpandedItem = useCallback((itemKey: string): void => {
    setExpandedItemKey((prev) => (prev === itemKey ? null : itemKey));
  }, []);

  const handleEntryClick = useCallback(
    (ev: MouseEvent<HTMLElement>, itemKey: string): void => {
      if (ev.defaultPrevented || ev.detail > 1) {
        return;
      }
      const target = ev.target as HTMLElement | null;
      if (target?.closest(INTERACTIVE_TARGET_SELECTOR)) {
        return;
      }
      const selection =
        typeof window !== "undefined" ? window.getSelection() : null;
      if (selection && selection.toString().trim().length > 0) {
        return;
      }
      toggleExpandedItem(itemKey);
    },
    [toggleExpandedItem],
  );

  const handleMediaLayoutChange = useCallback((): void => {
    const el = streamRef.current;
    if (!el || !isNearBottomRef.current) {
      return;
    }
    setProgrammaticScrollTop(el, el.scrollHeight);
  }, [setProgrammaticScrollTop]);

  const dismissToast = useCallback((): void => {
    setToastState(null);
  }, []);

  const handleQuoteJump = useCallback(
    (replyToMsgId: string): void => {
      const found = scrollToItemKey(`msg:${replyToMsgId}`);
      if (!found) {
        setToastState((prev) => ({
          seq: (prev?.seq ?? 0) + 1,
          message: t("room.quoteUnavailable"),
        }));
      }
    },
    [scrollToItemKey, t],
  );

  const handleOpenLightbox = useCallback(
    (imageUrl: string, manifest: FileManifest): void => {
      setLightbox({ imageUrl, manifest });
    },
    [],
  );

  const handleLightboxSave = useCallback(
    (manifest: FileManifest): void => {
      if (!onSaveFile) return;
      void onSaveFile(manifest).catch((err) => {
        onActionError?.(err);
      });
    },
    [onActionError, onSaveFile],
  );

  const renderDeliveryBadge = (vm: MessageViewModel): ReactElement | null => {
    if (!vm.isSelf || !vm.deliveryLabelKey) {
      return null;
    }
    if (vm.deliveryStatus === "failed" && onRetryMessage) {
      return (
        <Tag
          tone="danger"
          icon="rotate-ccw"
          testId="msg-retry-button"
          onClick={() => onRetryMessage(vm.msgId)}
        >
          {t(vm.deliveryLabelKey)}
        </Tag>
      );
    }
    const tone =
      vm.deliveryStatus === "pending"
        ? "accent"
        : vm.deliveryStatus === "relayed"
          ? "success"
          : vm.deliveryStatus === "failed"
            ? "danger"
            : "neutral";
    const icon =
      vm.deliveryStatus === "relayed"
        ? "check"
        : vm.deliveryStatus === "failed"
          ? "triangle-alert"
          : undefined;
    return (
      <Tag tone={tone} icon={icon} testId="msg-delivery-status">
        {t(vm.deliveryLabelKey)}
      </Tag>
    );
  };

  const floatingDateLabel =
    floatingDateCreatedAt !== null
      ? formatDatePillLabel(floatingDateCreatedAt, effectiveNowMs, dateLabels)
      : "";

  return (
    <div className="transcript-scroll-host">
      {floatingDateLabel ? (
        <div
          className={`floating-date-pill ${floatingDateVisible ? "floating-date-pill-visible" : ""}`}
          data-testid="floating-date-pill"
          data-visible={floatingDateVisible ? "true" : "false"}
          aria-hidden="true"
        >
          {floatingDateLabel}
        </div>
      ) : null}

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement.text ? (
          <span key={liveAnnouncement.seq}>{liveAnnouncement.text}</span>
        ) : null}
      </div>

      <div
        ref={streamRef}
        className="message-stream"
        role="log"
        aria-live="off"
        aria-label={t("room.streamAria")}
        onScroll={handleScroll}
      >
        <div className="message-stream-inner" data-testid="message-stream-inner">
          {timeline.length === 0 ? (
          <div className="empty-transcript">{t("room.empty")}</div>
        ) : (
          timeline.map((item) => {
            const isExpanded = expandedItemKey === item.itemKey;
            const isHighlighted = highlightedItemKey === item.itemKey;

            if (item.kind === "file") {
              const toggleTimeAria = t("room.msg.toggleTimeAria", {
                time: item.formattedDateTime,
              });

              return (
                <Fragment key={item.itemKey}>
                  {item.showDivider && item.dividerLabel ? (
                    <div
                      className={`msg-time-divider ${item.isDayBoundary ? "msg-time-divider-day" : ""}`}
                      data-testid="msg-time-divider"
                      data-day-key={item.dayKey}
                      data-divider-kind={item.isDayBoundary ? "day" : "gap"}
                    >
                      <time
                        dateTime={item.createdAtIso}
                        title={item.formattedDateTime}
                      >
                        {item.dividerLabel}
                      </time>
                    </div>
                  ) : null}

                  <article
                    ref={isExpanded ? expandedEntryRef : undefined}
                    className={[
                      "msg-entry",
                      "msg-entry-file",
                      item.isSelf ? "msg-entry-self" : "msg-entry-peer",
                      isExpanded ? "msg-entry-expanded" : "",
                      isHighlighted ? "msg-entry-highlighted" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    data-item-key={item.itemKey}
                    data-file-id={item.manifest.fileId}
                    data-day-key={item.dayKey}
                    data-created-at={String(item.createdAtMs)}
                    data-compact="false"
                    data-time-expanded={isExpanded ? "true" : "false"}
                    data-highlighted={isHighlighted ? "true" : "false"}
                    onClick={(ev) => handleEntryClick(ev, item.itemKey)}
                  >
                    <div className="msg-header">
                      <div className="msg-author-line">
                        {item.isSelf ? (
                          <>
                            <BrandMark className="msg-sigil-self" />
                            <span className="msg-author-name">
                              {t("room.you")}
                            </span>
                          </>
                        ) : (
                          <>
                            <StatusDot
                              status={
                                onlinePeerUserIds?.has(
                                  item.manifest.senderCert.payload.userId,
                                )
                                  ? "online"
                                  : "offline"
                              }
                            />
                            <span className="msg-author-name">
                              {item.authorDisplayName}
                            </span>
                          </>
                        )}

                        <span className="msg-author-meta">
                          <Byline>
                            <span>@{item.authorUsername}</span>
                            <Tag tone="neutral">{item.runtimeTag}</Tag>
                          </Byline>
                        </span>
                      </div>

                      <div className="msg-tools">
                        {!isExpanded ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="msg-time-toggle msg-header-time-toggle"
                            testId="msg-time-toggle"
                            aria-expanded={false}
                            aria-label={toggleTimeAria}
                            title={item.formattedDateTime}
                            onClick={() => toggleExpandedItem(item.itemKey)}
                          >
                            <time dateTime={item.createdAtIso}>
                              {item.formattedTime}
                            </time>
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    <div className="msg-body">
                      <FileMessageCard
                        manifest={item.manifest}
                        transfer={item.transfer}
                        onDownloadFile={onDownloadFile}
                        onCancelDownload={onCancelDownload}
                        onSaveFile={onSaveFile}
                        onReadFileBlob={onReadFileBlob}
                        onOpenLightbox={handleOpenLightbox}
                        onMediaLayoutChange={handleMediaLayoutChange}
                        onActionError={onActionError}
                      />
                    </div>

                    {isExpanded ? (
                      <div
                        className="msg-time-drawer"
                        data-testid="msg-time-drawer"
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          className="msg-time-drawer-btn"
                          testId="msg-time-toggle"
                          aria-expanded={true}
                          aria-label={toggleTimeAria}
                          onClick={() => toggleExpandedItem(item.itemKey)}
                        >
                          <time dateTime={item.createdAtIso}>
                            {item.formattedDateTime}
                          </time>
                        </Button>
                      </div>
                    ) : null}
                  </article>
                </Fragment>
              );
            }

            const { vm } = item;
            const deliveryBadge = renderDeliveryBadge(vm);
            const toggleTimeAria = t("room.msg.toggleTimeAria", {
              time: vm.formattedDateTime,
            });

            return (
              <Fragment key={item.itemKey}>
                {item.showDivider && item.dividerLabel ? (
                  <div
                    className={`msg-time-divider ${item.isDayBoundary ? "msg-time-divider-day" : ""}`}
                    data-testid="msg-time-divider"
                    data-day-key={item.dayKey}
                    data-divider-kind={item.isDayBoundary ? "day" : "gap"}
                  >
                    <time
                      dateTime={vm.createdAtIso}
                      title={vm.formattedDateTime}
                    >
                      {item.dividerLabel}
                    </time>
                  </div>
                ) : null}

                <article
                  ref={isExpanded ? expandedEntryRef : undefined}
                  className={[
                    "msg-entry",
                    vm.isSelf ? "msg-entry-self" : "msg-entry-peer",
                    item.isCompact ? "msg-entry-compact" : "",
                    isExpanded ? "msg-entry-expanded" : "",
                    isHighlighted ? "msg-entry-highlighted" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-item-key={item.itemKey}
                  data-delivery-status={vm.deliveryStatus ?? undefined}
                  data-day-key={item.dayKey}
                  data-created-at={String(vm.createdAtMs)}
                  data-compact={item.isCompact ? "true" : "false"}
                  data-time-expanded={isExpanded ? "true" : "false"}
                  data-highlighted={isHighlighted ? "true" : "false"}
                  onClick={(ev) => handleEntryClick(ev, item.itemKey)}
                >
                  {item.isCompact ? (
                    <>
                      {!isExpanded ? (
                        <div
                          className="msg-compact-hover-bar"
                          data-testid="msg-compact-hover-bar"
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            className="msg-time-toggle"
                            testId="msg-time-toggle"
                            aria-expanded={false}
                            aria-label={toggleTimeAria}
                            title={vm.formattedDateTime}
                            onClick={() => toggleExpandedItem(item.itemKey)}
                          >
                            <time dateTime={vm.createdAtIso}>
                              {vm.formattedTime}
                            </time>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            leadingIcon="reply"
                            className="msg-reply-trigger"
                            onClick={() => onReply(vm.envelope)}
                          >
                            {t("room.reply")}
                          </Button>
                        </div>
                      ) : null}

                      <div className="msg-compact-body-row">
                        <div className="msg-body">
                          <SafeMarkdown content={vm.body} />
                        </div>
                        {deliveryBadge ? (
                          <div className="msg-compact-meta">
                            {deliveryBadge}
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="msg-header">
                        <div className="msg-author-line">
                          {vm.isSelf ? (
                            <>
                              <BrandMark className="msg-sigil-self" />
                              <span className="msg-author-name">
                                {t("room.you")}
                              </span>
                            </>
                          ) : (
                            <>
                              <StatusDot
                                status={
                                  onlinePeerUserIds?.has(
                                    vm.envelope.authorCert.payload.userId,
                                  )
                                    ? "online"
                                    : "offline"
                                }
                              />
                              <span className="msg-author-name">
                                {vm.authorDisplayName}
                              </span>
                            </>
                          )}

                          <span className="msg-author-meta">
                            <Byline>
                              <span>@{vm.authorUsername}</span>
                              <Tag tone="neutral">{vm.runtimeTag}</Tag>
                            </Byline>
                          </span>
                        </div>

                        <div className="msg-tools">
                          {deliveryBadge}
                          {!isExpanded ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="msg-time-toggle msg-header-time-toggle"
                              testId="msg-time-toggle"
                              aria-expanded={false}
                              aria-label={toggleTimeAria}
                              title={vm.formattedDateTime}
                              onClick={() => toggleExpandedItem(item.itemKey)}
                            >
                              <time dateTime={vm.createdAtIso}>
                                {vm.formattedTime}
                              </time>
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="sm"
                            leadingIcon="reply"
                            className="msg-reply-trigger"
                            onClick={() => onReply(vm.envelope)}
                          >
                            {t("room.reply")}
                          </Button>
                        </div>
                      </div>

                      {vm.quote ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="msg-quote-jump-btn"
                          testId="msg-quote-jump"
                          aria-label={t("room.quoteJumpAria")}
                          onClick={() => handleQuoteJump(vm.quote!.replyToMsgId)}
                        >
                          <Subline>
                            <span className="msg-quote-author">
                              {vm.quote.resolvedAuthorHandle ??
                                t("room.quotedFallback")}
                            </span>
                            <span>{vm.quote.previewText}</span>
                          </Subline>
                        </Button>
                      ) : null}

                      <div className="msg-body">
                        <SafeMarkdown content={vm.body} />
                      </div>
                    </>
                  )}

                  {isExpanded ? (
                    <div
                      className="msg-time-drawer"
                      data-testid="msg-time-drawer"
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        className="msg-time-drawer-btn"
                        testId="msg-time-toggle"
                        aria-expanded={true}
                        aria-label={toggleTimeAria}
                        onClick={() => toggleExpandedItem(item.itemKey)}
                      >
                        <time dateTime={vm.createdAtIso}>
                          {vm.formattedDateTime}
                        </time>
                      </Button>
                      {item.isCompact ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          leadingIcon="reply"
                          className="msg-reply-trigger"
                          onClick={() => onReply(vm.envelope)}
                        >
                          {t("room.reply")}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              </Fragment>
            );
          })
        )}
        </div>
      </div>

      {toastState ? (
        <ToastRegion placement="bottom-center" className="transcript-toast-region">
          <Toast
            key={toastState.seq}
            tone="info"
            message={toastState.message}
            durationMs={TRANSCRIPT_TOAST_DURATION_MS}
            onDismiss={dismissToast}
            testId="transcript-toast"
          />
        </ToastRegion>
      ) : null}

      {showJumpToLatest ? (
        <Button
          variant="ghost"
          size="sm"
          leadingIcon="arrow-down"
          className="jump-to-latest-btn"
          testId="jump-to-latest-button"
          onClick={scrollToBottom}
        >
          {t("room.jumpToLatest")}
        </Button>
      ) : null}

      {lightbox ? (
        <ImageLightbox
          imageUrl={lightbox.imageUrl}
          manifest={lightbox.manifest}
          onSave={handleLightboxSave}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}
