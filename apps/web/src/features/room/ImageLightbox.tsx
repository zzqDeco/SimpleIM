import { useEffect, type ReactElement } from "react";
import type { FileManifest } from "@simpleim/contracts";
import { Button } from "../../design-system/index.ts";
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

  useEffect(() => {
    const handleKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="image-lightbox-backdrop"
      data-testid="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={manifest.fileName}
      onClick={onClose}
    >
      <div
        className="image-lightbox-dialog"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="image-lightbox-header">
          <div className="image-lightbox-title">
            <span className="image-lightbox-name">{manifest.fileName}</span>
            <span className="image-lightbox-size">
              {formatBytes(manifest.fileSize)}
            </span>
          </div>
          <div className="image-lightbox-actions">
            <Button
              variant="secondary"
              size="sm"
              testId="lightbox-save-button"
              onClick={() => onSave(manifest)}
            >
              {t("room.files.action.save")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              testId="lightbox-close-button"
              aria-label={t("room.files.lightboxClose")}
              onClick={onClose}
            >
              ✕
            </Button>
          </div>
        </div>

        <div className="image-lightbox-stage">
          <img
            src={imageUrl}
            alt={manifest.fileName}
            className="image-lightbox-img"
          />
        </div>
      </div>
    </div>
  );
}
