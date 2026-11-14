import { useEffect, useMemo, useRef, type ReactElement } from "react";
import type { ChatMessageEnvelope } from "@simpleim/contracts";
import { Byline, StatusIcon, Subline } from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { deriveMessageViewModel } from "../../state/message-vm.ts";
import { SafeMarkdown } from "../../utils/markdown.tsx";

export interface MessageTranscriptProps {
  readonly messages: readonly ChatMessageEnvelope[];
  readonly localPeerId: string;
  readonly onReply: (msg: ChatMessageEnvelope) => void;
}

export function MessageTranscript({
  messages,
  localPeerId,
  onReply,
}: MessageTranscriptProps): ReactElement {
  const { t } = useI18n();
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  const viewModels = useMemo(() => {
    const byId = new Map<string, ChatMessageEnvelope>();
    for (const msg of messages) {
      byId.set(msg.msgId, msg);
    }
    return messages.map((msg) => deriveMessageViewModel(msg, localPeerId, byId));
  }, [localPeerId, messages]);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div
      className="message-stream"
      role="log"
      aria-live="polite"
      aria-label={t("room.streamAria")}
    >
      {viewModels.length === 0 ? (
        <div className="empty-transcript">{t("room.empty")}</div>
      ) : (
        viewModels.map((vm) => (
          <article
            key={vm.msgId}
            className={`msg-entry ${vm.isSelf ? "msg-entry-self" : "msg-entry-peer"}`}
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
      <div ref={streamEndRef} />
    </div>
  );
}
