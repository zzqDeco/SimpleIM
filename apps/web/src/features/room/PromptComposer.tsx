import { useRef, type ChangeEvent, type ReactElement } from "react";
import { Button, Byline, Subline } from "../../design-system/index.ts";
import type { PromptComposerController } from "../../hooks/usePromptComposer.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { truncatePreview } from "../../state/message-vm.ts";

export interface PromptComposerProps {
  readonly composer: PromptComposerController;
  readonly onAttachFiles: (files: File[]) => void;
}

export function PromptComposer({
  composer,
  onAttachFiles,
}: PromptComposerProps): ReactElement {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileInputChange = (ev: ChangeEvent<HTMLInputElement>): void => {
    const selected = ev.target.files ? Array.from(ev.target.files) : [];
    ev.target.value = "";
    if (selected.length > 0) {
      onAttachFiles(selected);
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

      <div className="composer-prompt-frame">
        <span className="composer-prompt-glyph" aria-hidden="true">
          ❯
        </span>

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
        />

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
          onClick={() => fileInputRef.current?.click()}
        >
          {t("room.attach")}
        </Button>

        <Button
          type="submit"
          variant="primary"
          size="sm"
          testId="chat-send"
          disabled={composer.sending || composer.draft.trim().length === 0}
        >
          {t("room.send")}
        </Button>
      </div>

      <div className="composer-footer">
        <Byline>
          <span>{t("room.shortcutSend")}</span>
          <span>{t("room.shortcutNewline")}</span>
        </Byline>
      </div>
    </form>
  );
}
