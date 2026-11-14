import { useCallback, useRef, useState, type DragEvent } from "react";

export interface UseFileDropzoneParams {
  readonly onFilesDropped: (files: File[]) => void;
}

export interface FileDropzoneController {
  readonly dragActive: boolean;
  readonly onDragEnter: (ev: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (ev: DragEvent<HTMLElement>) => void;
  readonly onDragLeave: (ev: DragEvent<HTMLElement>) => void;
  readonly onDrop: (ev: DragEvent<HTMLElement>) => void;
}

export function useFileDropzone({
  onFilesDropped,
}: UseFileDropzoneParams): FileDropzoneController {
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  const onDragEnter = useCallback((ev: DragEvent<HTMLElement>): void => {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.dataTransfer.types.includes("Files")) {
      dragDepthRef.current += 1;
      setDragActive(true);
    }
  }, []);

  const onDragOver = useCallback((ev: DragEvent<HTMLElement>): void => {
    ev.preventDefault();
    ev.stopPropagation();
  }, []);

  const onDragLeave = useCallback((ev: DragEvent<HTMLElement>): void => {
    ev.preventDefault();
    ev.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  }, []);

  const onDrop = useCallback(
    (ev: DragEvent<HTMLElement>): void => {
      ev.preventDefault();
      ev.stopPropagation();
      dragDepthRef.current = 0;
      setDragActive(false);
      const dropped = ev.dataTransfer.files
        ? Array.from(ev.dataTransfer.files)
        : [];
      if (dropped.length > 0) {
        onFilesDropped(dropped);
      }
    },
    [onFilesDropped],
  );

  return {
    dragActive,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };
}
