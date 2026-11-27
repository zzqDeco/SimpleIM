import { useEffect, useState, type ReactElement } from "react";
import type { FileManifest } from "@simpleim/contracts";
import {
  Button,
  Byline,
  NoticeBanner,
  ProgressBar,
} from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { TransferViewModel } from "../../state/transfer-vm.ts";
import {
  formatFileExtensionBadge,
  isSafePreviewImage,
} from "../../utils/format.ts";

export interface FileMessageCardProps {
  readonly manifest: FileManifest;
  readonly transfer: TransferViewModel;
  readonly onDownloadFile?: (fileId: string) => Promise<void>;
  readonly onCancelDownload?: (fileId: string) => Promise<void>;
  readonly onSaveFile?: (manifest: FileManifest) => Promise<void>;
  readonly onReadFileBlob?: (
    fileId: string,
    mimeType: string,
  ) => Promise<Blob | null>;
  readonly onOpenLightbox?: (imageUrl: string, manifest: FileManifest) => void;
  readonly onMediaLayoutChange?: () => void;
  readonly onActionError?: (err: unknown) => void;
}

export function FileMessageCard({
  manifest,
  transfer,
  onDownloadFile,
  onCancelDownload,
  onSaveFile,
  onReadFileBlob,
  onOpenLightbox,
  onMediaLayoutChange,
  onActionError,
}: FileMessageCardProps): ReactElement {
  const { t } = useI18n();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const previewEligible = isSafePreviewImage(
    manifest.mimeType,
    manifest.fileSize,
  );

  // Zero-copy inline preview for safe raster images when local/OPFS blob is available.
  useEffect(() => {
    if (
      !previewEligible ||
      !transfer.canSave ||
      !onReadFileBlob ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      setPreviewUrl(null);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;

    void onReadFileBlob(manifest.fileId, manifest.mimeType)
      .then((blob) => {
        if (cancelled || !blob) {
          return;
        }
        createdUrl = URL.createObjectURL(blob);
        setPreviewUrl(createdUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewUrl(null);
        }
      });

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [
    manifest.fileId,
    manifest.mimeType,
    onReadFileBlob,
    previewEligible,
    transfer.canSave,
  ]);

  useEffect(() => {
    if (previewUrl) {
      onMediaLayoutChange?.();
    }
  }, [onMediaLayoutChange, previewUrl]);

  const extBadge = formatFileExtensionBadge(transfer.fileName);
  const showProgressBar =
    transfer.status === "downloading" ||
    (transfer.status === "paused" && transfer.percent > 0);

  return (
    <div
      className="msg-file-card"
      data-testid="msg-file-card"
      data-file-id={manifest.fileId}
      data-transfer-status={transfer.status}
      data-relay-state={transfer.relayCacheState}
    >
      {previewUrl ? (
        <button
          type="button"
          className="msg-file-preview-btn"
          data-testid="msg-file-preview"
          aria-label={t("room.files.previewAria", { name: transfer.fileName })}
          onClick={() => onOpenLightbox?.(previewUrl, manifest)}
        >
          <img
            src={previewUrl}
            alt={transfer.fileName}
            className="msg-file-preview-img"
            loading="lazy"
            onLoad={() => onMediaLayoutChange?.()}
          />
        </button>
      ) : null}

      <div className="msg-file-header">
        <span className="msg-file-ext-badge" aria-hidden="true">
          {extBadge}
        </span>

        <div className="msg-file-info">
          <span className="msg-file-name">{transfer.fileName}</span>
          <div className="msg-file-meta">
            <Byline>
              <span>{transfer.formattedSize}</span>
              <span>
                {t("room.files.peersRatio", {
                  seeds: transfer.seedCount,
                  peers: transfer.peerChunkCount,
                })}
              </span>
              {transfer.showSpeed ? <span>{transfer.formattedSpeed}</span> : null}
              {transfer.status === "downloading" ? (
                <span>{transfer.percent}%</span>
              ) : null}
            </Byline>
          </div>
        </div>

        <span
          className={`file-status-tag file-status-tag-${transfer.status}`}
        >
          {t(transfer.statusKey)}
        </span>
      </div>

      {showProgressBar ? (
        <ProgressBar
          percent={transfer.percent}
          complete={false}
          ariaLabel={t("room.files.progressAria", {
            name: transfer.fileName,
          })}
        />
      ) : null}

      {transfer.relayBadgeKey ? (
        <div
          className={`file-relay-badge file-relay-badge-${transfer.relayCacheState}`}
          data-testid="msg-file-relay-badge"
        >
          {t(transfer.relayBadgeKey, { percent: transfer.relayCachePercent })}
        </div>
      ) : null}

      {transfer.errorMessage ? (
        <NoticeBanner tone="error">{transfer.errorMessage}</NoticeBanner>
      ) : null}

      {transfer.canDownload || transfer.canCancel || transfer.canSave ? (
        <div className="msg-file-actions">
          {transfer.canDownload && onDownloadFile ? (
            <Button
              variant="primary"
              size="sm"
              testId="msg-file-download-button"
              onClick={() => {
                void onDownloadFile(manifest.fileId).catch((err) => {
                  onActionError?.(err);
                });
              }}
            >
              {t("room.files.action.download")}
            </Button>
          ) : null}

          {transfer.canCancel && onCancelDownload ? (
            <Button
              variant="danger"
              size="sm"
              testId="msg-file-cancel-button"
              onClick={() => {
                void onCancelDownload(manifest.fileId).catch((err) => {
                  onActionError?.(err);
                });
              }}
            >
              {t("room.files.action.cancel")}
            </Button>
          ) : null}

          {transfer.canSave && onSaveFile ? (
            <Button
              variant="secondary"
              size="sm"
              testId="msg-file-save-button"
              onClick={() => {
                void onSaveFile(manifest).catch((err) => {
                  onActionError?.(err);
                });
              }}
            >
              {t("room.files.action.save")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
