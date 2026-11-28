import { useMemo, type ReactElement } from "react";
import type { FileManifest } from "@simpleim/contracts";
import type { SwarmTransferProgress } from "@simpleim/peer-core";
import {
  Button,
  Byline,
  NoticeBanner,
  ProgressBar,
  Tag,
  type IconName,
  type TagTone,
} from "../../design-system/index.ts";
import { formatTransferError } from "../../i18n/error-catalog.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  countActiveDownloads,
  deriveTransferViewModel,
  type TransferViewModel,
} from "../../state/transfer-vm.ts";

export interface FileListSectionProps {
  readonly files: readonly FileManifest[];
  readonly transfers: ReadonlyMap<string, SwarmTransferProgress>;
  readonly localPeerId: string;
  readonly canSaveFile: (fileId: string) => boolean;
  readonly onDownloadFile: (fileId: string) => Promise<void>;
  readonly onCancelDownload: (fileId: string) => Promise<void>;
  readonly onSaveFile: (manifest: FileManifest) => Promise<void>;
  readonly onLocateFile?: (fileId: string) => void;
  readonly onActionError: (err: unknown) => void;
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

export function FileListSection({
  files,
  transfers,
  localPeerId,
  canSaveFile,
  onDownloadFile,
  onCancelDownload,
  onSaveFile,
  onLocateFile,
  onActionError,
}: FileListSectionProps): ReactElement {
  const { t } = useI18n();

  const activeDownloadCount = useMemo(
    () => countActiveDownloads(files, transfers),
    [files, transfers],
  );

  return (
    <section className="side-section" aria-labelledby="files-heading">
      <div className="side-section-header">
        <h2 id="files-heading" className="side-section-title">
          {t("room.files.heading")}
        </h2>
        <span className="side-section-count">{files.length}</span>
      </div>

      <div className="sr-only" role="status" aria-live="polite">
        {t("room.files.srSummary", {
          total: files.length,
          active: activeDownloadCount,
        })}
      </div>

      <div data-testid="file-list" className="side-list">
        {files.length === 0 ? (
          <p className="side-empty">{t("room.files.empty")}</p>
        ) : (
          files.map((manifest) => {
            const vm = deriveTransferViewModel(
              manifest,
              transfers.get(manifest.fileId),
              localPeerId,
              canSaveFile(manifest.fileId),
            );
            const relayMeta = relayBadgeProps(vm.relayCacheState);

            return (
              <div
                key={manifest.fileId}
                className="file-row file-card"
                data-transfer-status={vm.status}
                data-relay-state={vm.relayCacheState}
              >
                <div className="file-row-top">
                  <span className="file-row-name">{vm.fileName}</span>
                  <Tag tone={transferStatusTone(vm.status)}>
                    {t(vm.statusKey)}
                  </Tag>
                </div>

                {vm.status === "downloading" ||
                (vm.status === "paused" && vm.percent > 0) ? (
                  <ProgressBar
                    percent={vm.percent}
                    complete={false}
                    ariaLabel={t("room.files.progressAria", {
                      name: vm.fileName,
                    })}
                  />
                ) : null}

                <div className="file-row-meta">
                  <Byline>
                    <span>{vm.formattedSize}</span>
                    {vm.peerChunkCount > 0 ||
                    vm.status === "downloading" ||
                    vm.status === "seeding" ? (
                      <span>
                        {t("room.files.peersRatio", {
                          seeds: vm.seedCount,
                          peers: vm.peerChunkCount,
                        })}
                      </span>
                    ) : null}
                    {vm.showSpeed ? <span>{vm.formattedSpeed}</span> : null}
                  </Byline>
                  {vm.status === "downloading" ||
                  (vm.status === "paused" && vm.percent > 0) ? (
                    <span>{vm.percent}%</span>
                  ) : null}
                </div>

                {vm.relayBadgeKey ? (
                  <Tag
                    tone={relayMeta.tone}
                    icon={relayMeta.icon}
                    testId="file-relay-badge"
                    className="file-relay-tag"
                  >
                    {t(vm.relayBadgeKey, { percent: vm.relayCachePercent })}
                  </Tag>
                ) : null}

                {vm.errorMessage ? (
                  <NoticeBanner tone="error">
                    {formatTransferError(vm.errorMessage, t)}
                  </NoticeBanner>
                ) : null}

                <div className="file-row-actions">
                  {onLocateFile ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      leadingIcon="locate"
                      testId="file-locate-button"
                      aria-label={t("room.files.action.locateAria", {
                        name: vm.fileName,
                      })}
                      onClick={() => onLocateFile(manifest.fileId)}
                    >
                      {t("room.files.action.locate")}
                    </Button>
                  ) : null}

                  {vm.canDownload ? (
                    <Button
                      variant="primary"
                      size="sm"
                      leadingIcon="download"
                      testId="file-download-button"
                      onClick={() => {
                        void onDownloadFile(manifest.fileId).catch(
                          onActionError,
                        );
                      }}
                    >
                      {vm.status === "paused"
                        ? t("room.files.action.resume")
                        : t("room.files.action.download")}
                    </Button>
                  ) : null}

                  {vm.canCancel ? (
                    <Button
                      variant="danger"
                      size="sm"
                      leadingIcon="x"
                      testId="file-cancel-button"
                      onClick={() => {
                        void onCancelDownload(manifest.fileId).catch(
                          onActionError,
                        );
                      }}
                    >
                      {t("room.files.action.cancel")}
                    </Button>
                  ) : null}

                  {vm.canSave ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      leadingIcon="hard-drive-download"
                      testId="file-save-button"
                      onClick={() => {
                        void onSaveFile(manifest).catch(onActionError);
                      }}
                    >
                      {t("room.files.action.save")}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
