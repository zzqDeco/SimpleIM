import { useMemo, type ReactElement } from "react";
import type { FileManifest } from "@simpleim/contracts";
import type { SwarmTransferProgress } from "@simpleim/peer-core";
import {
  Button,
  Byline,
  NoticeBanner,
  ProgressBar,
} from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  countActiveDownloads,
  deriveTransferViewModel,
} from "../../state/transfer-vm.ts";

export interface FileListSectionProps {
  readonly files: readonly FileManifest[];
  readonly transfers: ReadonlyMap<string, SwarmTransferProgress>;
  readonly localPeerId: string;
  readonly canSaveFile: (fileId: string) => boolean;
  readonly onDownloadFile: (fileId: string) => Promise<void>;
  readonly onCancelDownload: (fileId: string) => Promise<void>;
  readonly onSaveFile: (manifest: FileManifest) => Promise<void>;
  readonly onActionError: (err: unknown) => void;
}

export function FileListSection({
  files,
  transfers,
  localPeerId,
  canSaveFile,
  onDownloadFile,
  onCancelDownload,
  onSaveFile,
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

            return (
              <div
                key={manifest.fileId}
                className="file-row file-card"
                data-transfer-status={vm.status}
              >
                <div className="file-row-top">
                  <span className="file-row-name">{vm.fileName}</span>
                  <span
                    className={`file-status-tag file-status-tag-${vm.status}`}
                  >
                    {t(vm.statusKey)}
                  </span>
                </div>

                <ProgressBar
                  percent={vm.percent}
                  complete={vm.status === "seeding"}
                  ariaLabel={t("room.files.progressAria", {
                    name: vm.fileName,
                  })}
                />

                <div className="file-row-meta">
                  <Byline>
                    <span>{vm.formattedSize}</span>
                    <span>
                      {t("room.files.peersRatio", {
                        seeds: vm.seedCount,
                        peers: vm.peerChunkCount,
                      })}
                    </span>
                    {vm.showSpeed ? <span>{vm.formattedSpeed}</span> : null}
                  </Byline>
                  <span>{vm.percent}%</span>
                </div>

                {vm.errorMessage ? (
                  <NoticeBanner tone="error">{vm.errorMessage}</NoticeBanner>
                ) : null}

                <div className="file-row-actions">
                  {vm.canDownload ? (
                    <Button
                      variant="primary"
                      size="sm"
                      testId="file-download-button"
                      onClick={() => {
                        void onDownloadFile(manifest.fileId).catch(
                          onActionError,
                        );
                      }}
                    >
                      {t("room.files.action.download")}
                    </Button>
                  ) : null}

                  {vm.canCancel ? (
                    <Button
                      variant="danger"
                      size="sm"
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
