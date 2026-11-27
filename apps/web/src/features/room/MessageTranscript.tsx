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
import type { ChatMessageEnvelope } from "@simpleim/contracts";
import type { ChatDeliveryStatus } from "@simpleim/peer-core";
import { Byline, StatusIcon, Subline } from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { MessageViewModel } from "../../state/message-vm.ts";
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

const FLOATING_DATE_HIDE_DELAY_MS = 1400;
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

export interface MessageTranscriptProps {
  readonly roomId?: string | null;
  readonly messages: readonly ChatMessageEnvelope[];
  readonly deliveryStates?: ReadonlyMap<string, ChatDeliveryStatus>;
  readonly localPeerId: string;
  readonly currentUserId: string;
  readonly onReply: (msg: ChatMessageEnvelope) => void;
  readonly onRetryMessage?: (msgId: string) => void;
  readonly nowMs?: number;
}

export function MessageTranscript({
  roomId = null,
  messages,
  deliveryStates,
  localPeerId,
  currentUserId,
  onReply,
  onRetryMessage,
  nowMs,
}: MessageTranscriptProps): ReactElement {
  const { t } = useI18n();
  const streamRef = useRef<HTMLDivElement | null>(null);
  const expandedEntryRef = useRef<HTMLElement | null>(null);
  const isNearBottomRef = useRef(true);
  const lastClientHeightRef = useRef(0);
  const prevRoomIdRef = useRef<string | null>(roomId);
  const prevLastMsgIdRef = useRef<string | null>(null);
  const programmaticScrollTopRef = useRef<number | null>(null);
  const hideDatePillTimerRef = useRef<number | null>(null);

  const [liveNowMs, setLiveNowMs] = useState<number>(() => nowMs ?? Date.now());
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [expandedMsgId, setExpandedMsgId] = useState<string | null>(null);
  const [floatingDateCreatedAt, setFloatingDateCreatedAt] = useState<
    number | null
  >(null);
  const [floatingDateVisible, setFloatingDateVisible] = useState(false);

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

  useEffect(() => {
    return () => {
      clearHideDatePillTimer();
    };
  }, [clearHideDatePillTimer]);

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
        localPeerId,
        currentUserId,
        deliveryStates,
        nowMs: effectiveNowMs,
        dateLabels,
      }),
    [
      currentUserId,
      dateLabels,
      deliveryStates,
      effectiveNowMs,
      localPeerId,
      messages,
    ],
  );

  const latestMessage =
    messages.length > 0 ? messages[messages.length - 1] : undefined;
  const latestMsgId = latestMessage?.msgId ?? null;
  const latestMessageIsSelf =
    latestMessage !== undefined &&
    (latestMessage.authorCert.payload.userId === currentUserId ||
      latestMessage.authorCert.payload.peerId === localPeerId);

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
    const previousLastMsgId = prevLastMsgIdRef.current;
    const shouldScroll = shouldAutoScrollTranscript({
      roomChanged,
      previousLastMsgId,
      nextLastMsgId: latestMsgId,
      wasNearBottom: isNearBottomRef.current,
      latestMessageIsSelf,
    });

    prevRoomIdRef.current = roomId;
    prevLastMsgIdRef.current = latestMsgId;

    if (roomChanged) {
      setExpandedMsgId(null);
      clearHideDatePillTimer();
      setFloatingDateVisible(false);
      setFloatingDateCreatedAt(null);
    }

    if (roomChanged && latestMsgId === null) {
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
      latestMsgId !== null &&
      previousLastMsgId !== null &&
      latestMsgId !== previousLastMsgId
    ) {
      setShowJumpToLatest(true);
    }
  }, [
    clearHideDatePillTimer,
    latestMessageIsSelf,
    latestMsgId,
    messages.length,
    roomId,
    scrollToBottom,
    setProgrammaticScrollTop,
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

  // When tapping a message near the bottom edge to inspect its full timestamp,
  // gently reveal the expanded timestamp drawer within .message-stream without scrollIntoView().
  useEffect(() => {
    if (!expandedMsgId) {
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
  }, [expandedMsgId, setProgrammaticScrollTop]);

  const toggleExpandedMsg = useCallback((msgId: string): void => {
    setExpandedMsgId((prev) => (prev === msgId ? null : msgId));
  }, []);

  const handleMessageClick = useCallback(
    (ev: MouseEvent<HTMLElement>, msgId: string): void => {
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
      toggleExpandedMsg(msgId);
    },
    [toggleExpandedMsg],
  );

  const renderDeliveryBadge = (vm: MessageViewModel): ReactElement | null => {
    if (!vm.isSelf || !vm.deliveryLabelKey) {
      return null;
    }
    if (vm.deliveryStatus === "failed" && onRetryMessage) {
      return (
        <button
          type="button"
          className="msg-delivery-tag msg-delivery-failed"
          data-testid="msg-retry-button"
          onClick={() => onRetryMessage(vm.msgId)}
        >
          {t(vm.deliveryLabelKey)}
        </button>
      );
    }
    return (
      <span
        className={`msg-delivery-tag msg-delivery-${vm.deliveryStatus}`}
        data-testid="msg-delivery-status"
      >
        {t(vm.deliveryLabelKey)}
      </span>
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

      <div
        ref={streamRef}
        className="message-stream"
        role="log"
        aria-live="polite"
        aria-label={t("room.streamAria")}
        onScroll={handleScroll}
      >
        {timeline.length === 0 ? (
          <div className="empty-transcript">{t("room.empty")}</div>
        ) : (
          timeline.map((item) => {
            const { vm } = item;
            const isExpanded = expandedMsgId === vm.msgId;
            const deliveryBadge = renderDeliveryBadge(vm);
            const toggleTimeAria = t("room.msg.toggleTimeAria", {
              time: vm.formattedDateTime,
            });

            return (
              <Fragment key={vm.msgId}>
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
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-delivery-status={vm.deliveryStatus ?? undefined}
                  data-day-key={item.dayKey}
                  data-created-at={String(vm.createdAtMs)}
                  data-compact={item.isCompact ? "true" : "false"}
                  data-time-expanded={isExpanded ? "true" : "false"}
                  onClick={(ev) => handleMessageClick(ev, vm.msgId)}
                >
                  {item.isCompact ? (
                    <>
                      {!isExpanded ? (
                        <div
                          className="msg-compact-hover-bar"
                          data-testid="msg-compact-hover-bar"
                        >
                          <button
                            type="button"
                            className="msg-time-toggle"
                            data-testid="msg-time-toggle"
                            aria-expanded={false}
                            aria-label={toggleTimeAria}
                            title={vm.formattedDateTime}
                            onClick={() => toggleExpandedMsg(vm.msgId)}
                          >
                            <time dateTime={vm.createdAtIso}>
                              {vm.formattedTime}
                            </time>
                          </button>
                          <button
                            type="button"
                            className="msg-reply-trigger"
                            onClick={() => onReply(vm.envelope)}
                          >
                            {t("room.reply")}
                          </button>
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
                              <span
                                className="msg-sigil-self"
                                aria-hidden="true"
                              >
                                ❯
                              </span>
                              <span className="msg-author-name">
                                {t("room.you")}
                              </span>
                            </>
                          ) : (
                            <>
                              <StatusIcon status="online" />
                              <span className="msg-author-name">
                                {vm.authorDisplayName}
                              </span>
                            </>
                          )}

                          <span className="msg-author-meta">
                            <Byline>
                              <span>@{vm.authorUsername}</span>
                              <span className="msg-runtime-tag">
                                {vm.runtimeTag}
                              </span>
                            </Byline>
                          </span>
                        </div>

                        <div className="msg-tools">
                          {deliveryBadge}
                          {!isExpanded ? (
                            <button
                              type="button"
                              className="msg-time-toggle msg-header-time-toggle"
                              data-testid="msg-time-toggle"
                              aria-expanded={false}
                              aria-label={toggleTimeAria}
                              title={vm.formattedDateTime}
                              onClick={() => toggleExpandedMsg(vm.msgId)}
                            >
                              <time dateTime={vm.createdAtIso}>
                                {vm.formattedTime}
                              </time>
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="msg-reply-trigger"
                            onClick={() => onReply(vm.envelope)}
                          >
                            {t("room.reply")}
                          </button>
                        </div>
                      </div>

                      {vm.quote ? (
                        <Subline>
                          <span className="msg-quote-author">
                            {vm.quote.resolvedAuthorHandle ??
                              t("room.quotedFallback")}
                          </span>
                          <span>{vm.quote.previewText}</span>
                        </Subline>
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
                      <button
                        type="button"
                        className="msg-time-drawer-btn"
                        data-testid="msg-time-toggle"
                        aria-expanded={true}
                        aria-label={toggleTimeAria}
                        onClick={() => toggleExpandedMsg(vm.msgId)}
                      >
                        <time dateTime={vm.createdAtIso}>
                          {vm.formattedDateTime}
                        </time>
                      </button>
                      {item.isCompact ? (
                        <button
                          type="button"
                          className="msg-reply-trigger"
                          onClick={() => onReply(vm.envelope)}
                        >
                          {t("room.reply")}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              </Fragment>
            );
          })
        )}
      </div>

      {showJumpToLatest ? (
        <button
          type="button"
          className="jump-to-latest-btn"
          data-testid="jump-to-latest-button"
          onClick={scrollToBottom}
        >
          ↓ {t("room.jumpToLatest")}
        </button>
      ) : null}
    </div>
  );
}
