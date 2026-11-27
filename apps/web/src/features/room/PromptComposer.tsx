import { useRef, type ChangeEvent, type ReactElement } from "react";
import { Button, Byline, Subline } from "../../design-system/index.ts";
import type { PromptComposerController } from "../../hooks/usePromptComposer.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { truncatePreview } from "../../state/message-vm.ts";
import {
  formatBytes,
  formatFileExtensionBadge,
} from "../../utils/format.ts";

export interface PromptComposerProps {
  readonly composer: PromptComposerController;
}

export function PromptComposer({ composer }: PromptComposerProps): ReactElement {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileInputChange = (ev: ChangeEvent<HTMLInputElement>): void => {
    const selected = ev.target.files ? Array.from(ev.target.files) : [];
    ev.target.value = "";
    if (selected.length > 0) {
      composer.stageFiles(selected);
    }
  };

  return (
    <form className="composer-dock" onSubmit={composer.handleSubmit}>
      {composer.replyTarget ? (
        <div className="composer-reply-bar">
          <Subline>
            <span className="msg-quote-author">
              {t("room.replyingTo", {
                username: composer.replyTarget.authorCert.payload.username,
              })}
            </span>
            <span>{truncatePreview(composer.replyTarget.body, 72)}</span>
          </Subline>
          <Button
            variant="ghost"
            size="sm"
            onClick={composer.clearReplyTarget}
          >
            {t("room.cancelReply")}
          </Button>
        </div>
      ) : null}

      {composer.stagedFiles.length > 0 ? (
        <div
          className="composer-staged-bar"
          data-testid="staged-attachments"
          aria-label={t("room.composer.stagedAria")}
        >
          {composer.stagedFiles.map((item) => (
            <div
              key={item.id}
              className="composer-staged-chip"
              data-testid="staged-attachment-item"
            >
              {item.previewUrl ? (
                <img
                  src={item.previewUrl}
                  alt={item.file.name}
                  className="composer-staged-thumb"
                />
              ) : (
                <span className="composer-staged-ext" aria-hidden="true">
                  {formatFileExtensionBadge(item.file.name)}
                </span>
              )}
              <div className="composer-staged-meta">
                <span className="composer-staged-name">{item.file.name}</span>
                <span className="composer-staged-size">
                  {formatBytes(item.file.size)}
                </span>
              </div>
              <button
                type="button"
                className="composer-staged-remove"
                data-testid="remove-staged-attachment"
                aria-label={t("room.composer.removeStagedAria", {
                  name: item.file.name,
                })}
                disabled={composer.sending}
                onClick={() => composer.removeStagedFile(item.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="composer-prompt-frame">
        <input
          ref={fileInputRef}
          data-testid="file-input"
          type="file"
          multiple
          className="sr-only"
          aria-label={t("room.attachAria")}
          onChange={handleFileInputChange}
        />

        <Button
          variant="secondary"
          size="sm"
          className="composer-attach-btn"
          testId="attach-file-button"
          aria-label={t("room.attachAria")}
          disabled={composer.sending}
          onClick={() => fileInputRef.current?.click()}
        >
          <span aria-hidden="true">＋</span>
          <span className="composer-attach-label">{t("room.attach")}</span>
        </Button>

        <textarea
          ref={composer.textareaRef}
          data-testid="chat-input"
          className="composer-textarea"
          rows={1}
          placeholder={t("room.inputPlaceholder")}
          aria-label={t("room.inputAria")}
          value={composer.draft}
          onChange={(ev) => composer.setDraft(ev.target.value)}
          onKeyDown={composer.handleKeyDown}
          onPaste={composer.handlePaste}
        />

        <Button
          type="submit"
          variant="primary"
          size="sm"
          testId="chat-send"
          disabled={!composer.canSend}
        >
          {t("room.send")}
        </Button>
      </div>

      <div className="composer-footer">
        <Byline>
          <span>{t("room.shortcutSend")}</span>
          <span>{t("room.shortcutNewline")}</span>
          <span>{t("room.composer.pasteHint")}</span>
        </Byline>
      </div>
    </form>
  );
}
