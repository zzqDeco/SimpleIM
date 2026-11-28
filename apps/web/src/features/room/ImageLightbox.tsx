import type { ReactElement } from "react";
import type { FileManifest } from "@simpleim/contracts";
import { Button, Dialog } from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { formatBytes } from "../../utils/format.ts";

export interface ImageLightboxProps {
  readonly imageUrl: string;
  readonly manifest: FileManifest;
  readonly onSave: (manifest: FileManifest) => void;
  readonly onClose: () => void;
}

export function ImageLightbox({
  imageUrl,
  manifest,
  onSave,
  onClose,
}: ImageLightboxProps): ReactElement {
  const { t } = useI18n();

  return (
    <Dialog
      open
      onClose={onClose}
      title={manifest.fileName}
      subtitle={formatBytes(manifest.fileSize)}
      size="fullscreen"
      testId="image-lightbox"
      closeLabel={t("room.files.lightboxClose")}
      closeTestId="lightbox-close-button"
      headerActions={
        <Button
          variant="secondary"
          size="sm"
          leadingIcon="hard-drive-download"
          testId="lightbox-save-button"
          onClick={() => onSave(manifest)}
        >
          {t("room.files.action.save")}
        </Button>
      }
    >
      <div className="image-lightbox-stage">
        <img
          src={imageUrl}
          alt={manifest.fileName}
          className="image-lightbox-img"
        />
      </div>
    </Dialog>
  );
}
