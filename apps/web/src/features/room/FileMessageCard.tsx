import { useEffect, useState, type ReactElement } from "react";
import type { FileManifest } from "@simpleim/contracts";
import {
  Button,
  Byline,
  Icon,
  NoticeBanner,
  ProgressBar,
  Tag,
  type IconName,
  type TagTone,
} from "../../design-system/index.ts";
import { formatTransferError } from "../../i18n/error-catalog.ts";
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

function transferStatusTone(status: TransferViewModel["status"]): TagTone {
  switch (status) {
    case "downloading":
      return "accent";
    case "seeding":
      return "success";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

function relayBadgeProps(state: TransferViewModel["relayCacheState"]): {
  tone: TagTone;
  icon?: IconName;
} {
  switch (state) {
    case "uploading":
      return { tone: "accent", icon: "cloud-upload" };
    case "cached":
      return { tone: "success", icon: "cloud-check" };
    case "error":
      return { tone: "danger", icon: "triangle-alert" };
    default:
      return { tone: "neutral" };
  }
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
  const relayMeta = relayBadgeProps(transfer.relayCacheState);

  return (
    <div
      className="msg-file-card"
      data-testid="msg-file-card"
      data-file-id={manifest.fileId}
      data-transfer-status={transfer.status}
      data-relay-state={transfer.relayCacheState}
    >
      {previewUrl ? (
        <Button
          variant="ghost"
          className="msg-file-preview-btn"
          testId="msg-file-preview"
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
        </Button>
      ) : null}

      <div className="msg-file-header">
        <span className="msg-file-ext-badge" aria-hidden="true">
          <Icon name={previewEligible ? "image" : "file"} size={16} />
          <span>{extBadge}</span>
        </span>

        <div className="msg-file-info">
          <span className="msg-file-name">{transfer.fileName}</span>
          <div className="msg-file-meta">
            <Byline>
              <span>{transfer.formattedSize}</span>
              {transfer.peerChunkCount > 0 ||
              transfer.status === "downloading" ||
              transfer.status === "seeding" ? (
                <span>
                  {t("room.files.peersRatio", {
                    seeds: transfer.seedCount,
                    peers: transfer.peerChunkCount,
                  })}
                </span>
              ) : null}
              {transfer.showSpeed ? <span>{transfer.formattedSpeed}</span> : null}
              {transfer.status === "downloading" ? (
                <span>{transfer.percent}%</span>
              ) : null}
            </Byline>
          </div>
        </div>

        <Tag tone={transferStatusTone(transfer.status)}>
          {t(transfer.statusKey)}
        </Tag>
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
        <Tag
          tone={relayMeta.tone}
          icon={relayMeta.icon}
          testId="msg-file-relay-badge"
          className="file-relay-tag"
        >
          {t(transfer.relayBadgeKey, { percent: transfer.relayCachePercent })}
        </Tag>
      ) : null}

      {transfer.errorMessage ? (
        <NoticeBanner tone="error">
          {formatTransferError(transfer.errorMessage, t)}
        </NoticeBanner>
      ) : null}

      {transfer.canDownload || transfer.canCancel || transfer.canSave ? (
        <div className="msg-file-actions">
          {transfer.canDownload && onDownloadFile ? (
            <Button
              variant="primary"
              size="sm"
              leadingIcon="download"
              testId="msg-file-download-button"
              onClick={() => {
                void onDownloadFile(manifest.fileId).catch((err) => {
                  onActionError?.(err);
                });
              }}
            >
              {transfer.status === "paused"
                ? t("room.files.action.resume")
                : t("room.files.action.download")}
            </Button>
          ) : null}

          {transfer.canCancel && onCancelDownload ? (
            <Button
              variant="danger"
              size="sm"
              leadingIcon="x"
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
              leadingIcon="hard-drive-download"
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
