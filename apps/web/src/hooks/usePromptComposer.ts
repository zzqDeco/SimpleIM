import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { ChatMessageEnvelope } from "@simpleim/contracts";
import { toAppFailure, type AppFailure } from "../i18n/error-catalog.ts";
import { extractFilesFromClipboard } from "../state/composer-attachments.ts";
import { isSafePreviewImage } from "../utils/format.ts";

export interface StagedAttachment {
  readonly id: string;
  readonly file: File;
  readonly previewUrl: string | null;
}

export interface UsePromptComposerParams {
  readonly roomKey?: string | null;
  readonly roomInactive?: boolean;
  readonly onSendMessage: (
    body: string,
    replyToMsgId: string | null,
  ) => Promise<void>;
  readonly onShareFiles: (files: File[]) => Promise<void>;
}

export interface PromptComposerController {
  readonly draft: string;
  readonly setDraft: (next: string) => void;
  readonly stagedFiles: readonly StagedAttachment[];
  readonly stageFiles: (files: readonly File[]) => void;
  readonly removeStagedFile: (id: string) => void;
  readonly clearStagedFiles: () => void;
  readonly canSend: boolean;
  readonly roomInactive: boolean;
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
  readonly handlePaste: (ev: ClipboardEvent<HTMLTextAreaElement>) => void;
}

function revokeAttachmentPreview(item: StagedAttachment): void {
  if (
    item.previewUrl &&
    typeof URL !== "undefined" &&
    typeof URL.revokeObjectURL === "function"
  ) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

export function usePromptComposer({
  roomKey = null,
  roomInactive = false,
  onSendMessage,
  onShareFiles,
}: UsePromptComposerParams): PromptComposerController {
  const [draft, setDraftState] = useState("");
  const [stagedFiles, setStagedFiles] = useState<readonly StagedAttachment[]>(
    [],
  );
  const [replyTarget, setReplyTarget] = useState<ChatMessageEnvelope | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [actionFailure, setActionFailure] = useState<AppFailure | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const draftsByRoomRef = useRef<Map<string, string>>(new Map());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const stagedFilesRef = useRef<readonly StagedAttachment[]>(stagedFiles);
  stagedFilesRef.current = stagedFiles;
  const roomKeyRef = useRef<string | null>(roomKey);
  const prevRoomKeyRef = useRef<string | null>(roomKey);
  const nextStagedIdRef = useRef(1);

  const revokeAllStaged = useCallback((): void => {
    for (const item of stagedFilesRef.current) {
      revokeAttachmentPreview(item);
    }
    stagedFilesRef.current = [];
    setStagedFiles([]);
  }, []);

  // Preserve per-room drafts in memory, while clearing staged attachments across
  // room switches so files queued for one room are never sent to another.
  useEffect(() => {
    roomKeyRef.current = roomKey;
    if (prevRoomKeyRef.current !== roomKey) {
      const prevKey = prevRoomKeyRef.current;
      if (prevKey) {
        if (draftRef.current.length > 0) {
          draftsByRoomRef.current.set(prevKey, draftRef.current);
        } else {
          draftsByRoomRef.current.delete(prevKey);
        }
      }
      prevRoomKeyRef.current = roomKey;
      const restored = roomKey
        ? (draftsByRoomRef.current.get(roomKey) ?? "")
        : "";
      draftRef.current = restored;
      setDraftState(restored);
      setReplyTarget(null);
      setActionFailure(null);
      revokeAllStaged();
    }
  }, [revokeAllStaged, roomKey]);

  // Revoke any remaining staged ObjectURLs on unmount.
  useEffect(() => {
    return () => {
      for (const item of stagedFilesRef.current) {
        revokeAttachmentPreview(item);
      }
      stagedFilesRef.current = [];
    };
  }, []);

  // Auto-grow textarea between 1 and ~5 lines as the user types.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [draft]);

  const setDraft = useCallback((next: string): void => {
    draftRef.current = next;
    setDraftState(next);
    const activeRoom = roomKeyRef.current;
    if (activeRoom) {
      if (next.length > 0) {
        draftsByRoomRef.current.set(activeRoom, next);
      } else {
        draftsByRoomRef.current.delete(activeRoom);
      }
    }
  }, []);

  const stageFiles = useCallback((files: readonly File[]): void => {
    if (files.length === 0) {
      return;
    }
    const created: StagedAttachment[] = files.map((file) => {
      let previewUrl: string | null = null;
      if (
        isSafePreviewImage(file.type, file.size) &&
        typeof URL !== "undefined" &&
        typeof URL.createObjectURL === "function"
      ) {
        previewUrl = URL.createObjectURL(file);
      }
      return {
        id: `staged-${nextStagedIdRef.current++}`,
        file,
        previewUrl,
      };
    });
    setActionFailure(null);
    setStagedFiles((prev) => {
      const next = [...prev, ...created];
      stagedFilesRef.current = next;
      return next;
    });
    textareaRef.current?.focus();
  }, []);

  const removeStagedFile = useCallback((id: string): void => {
    setStagedFiles((prev) => {
      const removed = prev.find((item) => item.id === id);
      if (removed) {
        revokeAttachmentPreview(removed);
      }
      const next = prev.filter((item) => item.id !== id);
      stagedFilesRef.current = next;
      return next;
    });
  }, []);

  const submitAll = useCallback(async (): Promise<void> => {
    const trimmed = draftRef.current.trim();
    const filesSnapshot = [...stagedFilesRef.current];
    if (
      (trimmed.length === 0 && filesSnapshot.length === 0) ||
      sending ||
      roomInactive
    ) {
      return;
    }

    const sendRoomKey = roomKeyRef.current;
    const replyId = replyTarget?.msgId ?? null;
    setSending(true);
    setActionFailure(null);

    try {
      if (trimmed.length > 0) {
        await onSendMessage(trimmed, replyId);
        if (sendRoomKey) {
          const cached = draftsByRoomRef.current.get(sendRoomKey);
          if (cached !== undefined && cached.trim() === trimmed) {
            draftsByRoomRef.current.delete(sendRoomKey);
          }
        }
        if (roomKeyRef.current === sendRoomKey) {
          if (draftRef.current.trim() === trimmed) {
            draftRef.current = "";
            setDraftState("");
          }
          setReplyTarget(null);
        } else {
          return;
        }
      }

      for (const item of filesSnapshot) {
        if (roomKeyRef.current !== sendRoomKey) {
          return;
        }
        await onShareFiles([item.file]);
        if (roomKeyRef.current === sendRoomKey) {
          removeStagedFile(item.id);
        }
      }
    } catch (err) {
      if (roomKeyRef.current === sendRoomKey) {
        setActionFailure(toAppFailure(err));
      }
    } finally {
      setSending(false);
    }
  }, [
    onSendMessage,
    onShareFiles,
    removeStagedFile,
    replyTarget,
    roomInactive,
    sending,
  ]);

  const handleSubmit = useCallback(
    (ev: FormEvent<HTMLFormElement>): void => {
      ev.preventDefault();
      void submitAll();
    },
    [submitAll],
  );

  const handleKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (ev.key === "Escape" && replyTarget !== null) {
        ev.preventDefault();
        setReplyTarget(null);
        return;
      }
      if (ev.key === "Enter" && !ev.shiftKey && !ev.nativeEvent.isComposing) {
        // On touch devices (no physical Shift key), Enter inserts a newline and Send button submits.
        const isCoarsePointer =
          typeof window !== "undefined" &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(pointer: coarse)").matches;
        if (isCoarsePointer) {
          return;
        }
        ev.preventDefault();
        void submitAll();
      }
    },
    [replyTarget, submitAll],
  );

  const handlePaste = useCallback(
    (ev: ClipboardEvent<HTMLTextAreaElement>): void => {
      const files = extractFilesFromClipboard(ev.clipboardData);
      if (files.length === 0) {
        return;
      }
      ev.preventDefault();
      stageFiles(files);
    },
    [stageFiles],
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

  const canSend =
    !sending &&
    !roomInactive &&
    (draft.trim().length > 0 || stagedFiles.length > 0);

  return {
    draft,
    setDraft,
    stagedFiles,
    stageFiles,
    removeStagedFile,
    clearStagedFiles: revokeAllStaged,
    canSend,
    roomInactive,
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
    handlePaste,
  };
}
