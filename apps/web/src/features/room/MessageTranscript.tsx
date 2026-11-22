import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { ChatMessageEnvelope } from "@simpleim/contracts";
import type { ChatDeliveryStatus } from "@simpleim/peer-core";
import { Byline, StatusIcon, Subline } from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { deriveMessageViewModel } from "../../state/message-vm.ts";
import {
  isTranscriptNearBottom,
  shouldAutoScrollTranscript,
} from "../../state/transcript-scroll.ts";
import { SafeMarkdown } from "../../utils/markdown.tsx";

export interface MessageTranscriptProps {
  readonly roomId?: string | null;
  readonly messages: readonly ChatMessageEnvelope[];
  readonly deliveryStates?: ReadonlyMap<string, ChatDeliveryStatus>;
  readonly localPeerId: string;
  readonly currentUserId: string;
  readonly onReply: (msg: ChatMessageEnvelope) => void;
  readonly onRetryMessage?: (msgId: string) => void;
}

export function MessageTranscript({
  roomId = null,
  messages,
  deliveryStates,
  localPeerId,
  currentUserId,
  onReply,
  onRetryMessage,
}: MessageTranscriptProps): ReactElement {
  const { t } = useI18n();
  const streamRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const lastClientHeightRef = useRef(0);
  const prevRoomIdRef = useRef<string | null>(roomId);
  const prevLastMsgIdRef = useRef<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const viewModels = useMemo(() => {
    const byId = new Map<string, ChatMessageEnvelope>();
    for (const msg of messages) {
      byId.set(msg.msgId, msg);
    }
    return messages.map((msg) =>
      deriveMessageViewModel(
        msg,
        localPeerId,
        byId,
        currentUserId,
        deliveryStates,
      ),
    );
  }, [currentUserId, deliveryStates, localPeerId, messages]);

  const latestMessage =
    messages.length > 0 ? messages[messages.length - 1] : undefined;
  const latestMsgId = latestMessage?.msgId ?? null;
  const latestMessageIsSelf =
    latestMessage !== undefined &&
    (latestMessage.authorCert.payload.userId === currentUserId ||
      latestMessage.authorCert.payload.peerId === localPeerId);

  const scrollToBottom = useCallback((): void => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastClientHeightRef.current = el.clientHeight;
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
  }, []);

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
      el.scrollTop = el.scrollHeight;
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
  }, []);

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

    if (roomChanged && latestMsgId === null) {
      isNearBottomRef.current = true;
      setShowJumpToLatest(false);
      if (streamRef.current) {
        streamRef.current.scrollTop = 0;
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
  }, [latestMessageIsSelf, latestMsgId, messages.length, roomId, scrollToBottom]);

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
        el.scrollTop = el.scrollHeight;
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div className="transcript-scroll-host">
      <div
        ref={streamRef}
        className="message-stream"
        role="log"
        aria-live="polite"
        aria-label={t("room.streamAria")}
        onScroll={handleScroll}
      >
        {viewModels.length === 0 ? (
          <div className="empty-transcript">{t("room.empty")}</div>
        ) : (
          viewModels.map((vm) => (
            <article
              key={vm.msgId}
              className={`msg-entry ${vm.isSelf ? "msg-entry-self" : "msg-entry-peer"}`}
              data-delivery-status={vm.deliveryStatus ?? undefined}
            >
              <div className="msg-header">
                <div className="msg-author-line">
                  {vm.isSelf ? (
                    <>
                      <span className="msg-sigil-self" aria-hidden="true">
                        ❯
                      </span>
                      <span className="msg-author-name">{t("room.you")}</span>
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
                      <span className="msg-runtime-tag">{vm.runtimeTag}</span>
                    </Byline>
                  </span>
                </div>

                <div className="msg-tools">
                  {vm.isSelf && vm.deliveryLabelKey ? (
                    vm.deliveryStatus === "failed" && onRetryMessage ? (
                      <button
                        type="button"
                        className="msg-delivery-tag msg-delivery-failed"
                        data-testid="msg-retry-button"
                        onClick={() => onRetryMessage(vm.msgId)}
                      >
                        {t(vm.deliveryLabelKey)}
                      </button>
                    ) : (
                      <span
                        className={`msg-delivery-tag msg-delivery-${vm.deliveryStatus}`}
                        data-testid="msg-delivery-status"
                      >
                        {t(vm.deliveryLabelKey)}
                      </span>
                    )
                  ) : null}
                  <time dateTime={vm.createdAtIso}>{vm.formattedTime}</time>
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
                    {vm.quote.resolvedAuthorHandle ?? t("room.quotedFallback")}
                  </span>
                  <span>{vm.quote.previewText}</span>
                </Subline>
              ) : null}

              <div className="msg-body">
                <SafeMarkdown content={vm.body} />
              </div>
            </article>
          ))
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
