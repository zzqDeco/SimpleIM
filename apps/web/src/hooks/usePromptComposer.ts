import {
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { ChatMessageEnvelope } from "@simpleim/contracts";
import { toAppFailure, type AppFailure } from "../i18n/error-catalog.ts";

export interface UsePromptComposerParams {
  readonly onSendMessage: (
    body: string,
    replyToMsgId: string | null,
  ) => Promise<void>;
}

export interface PromptComposerController {
  readonly draft: string;
  readonly setDraft: (next: string) => void;
  readonly replyTarget: ChatMessageEnvelope | null;
  readonly selectReplyTarget: (msg: ChatMessageEnvelope) => void;
  readonly clearReplyTarget: () => void;
  readonly sending: boolean;
  readonly actionFailure: AppFailure | null;
  readonly setActionFailure: (failure: AppFailure | null) => void;
  readonly reportActionError: (err: unknown) => void;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly handleSubmit: (ev: FormEvent<HTMLFormElement>) => void;
  readonly handleKeyDown: (ev: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function usePromptComposer({
  onSendMessage,
}: UsePromptComposerParams): PromptComposerController {
  const [draft, setDraft] = useState("");
  const [replyTarget, setReplyTarget] = useState<ChatMessageEnvelope | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [actionFailure, setActionFailure] = useState<AppFailure | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const submitChat = useCallback(async (): Promise<void> => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || sending) {
      return;
    }
    setSending(true);
    setActionFailure(null);
    const replyId = replyTarget?.msgId ?? null;
    try {
      await onSendMessage(trimmed, replyId);
      setDraft("");
      setReplyTarget(null);
    } catch (err) {
      setActionFailure(toAppFailure(err));
    } finally {
      setSending(false);
    }
  }, [draft, onSendMessage, replyTarget, sending]);

  const handleSubmit = useCallback(
    (ev: FormEvent<HTMLFormElement>): void => {
      ev.preventDefault();
      void submitChat();
    },
    [submitChat],
  );

  const handleKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (ev.key === "Escape" && replyTarget !== null) {
        ev.preventDefault();
        setReplyTarget(null);
        return;
      }
      if (ev.key === "Enter" && !ev.shiftKey && !ev.nativeEvent.isComposing) {
        ev.preventDefault();
        void submitChat();
      }
    },
    [replyTarget, submitChat],
  );

  const selectReplyTarget = useCallback((msg: ChatMessageEnvelope): void => {
    setReplyTarget(msg);
    textareaRef.current?.focus();
  }, []);

  const clearReplyTarget = useCallback((): void => {
    setReplyTarget(null);
  }, []);

  const reportActionError = useCallback((err: unknown): void => {
    setActionFailure(toAppFailure(err));
  }, []);

  return {
    draft,
    setDraft,
    replyTarget,
    selectReplyTarget,
    clearReplyTarget,
    sending,
    actionFailure,
    setActionFailure,
    reportActionError,
    textareaRef,
    handleSubmit,
    handleKeyDown,
  };
}
