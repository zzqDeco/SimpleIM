import type { ReactElement } from "react";
import {
  LUCIDE_ICON_PATHS,
  type IconName,
  type SvgShape,
} from "./icons/lucide-paths.ts";

export type { IconName };

export interface IconProps {
  readonly name: IconName;
  readonly size?: 16 | 20;
  readonly label?: string;
  readonly spin?: boolean;
  readonly className?: string;
}

function renderShape(shape: SvgShape, index: number): ReactElement {
  switch (shape.tag) {
    case "path":
      return <path key={index} d={shape.d} />;
    case "circle":
      return <circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} />;
    case "line":
      return (
        <line
          key={index}
          x1={shape.x1}
          y1={shape.y1}
          x2={shape.x2}
          y2={shape.y2}
        />
      );
    case "rect":
      return (
        <rect
          key={index}
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={shape.rx}
          ry={shape.ry}
        />
      );
  }
}

export function Icon({
  name,
  size = 16,
  label,
  spin = false,
  className,
}: IconProps): ReactElement {
  const shapes = LUCIDE_ICON_PATHS[name];
  const parts = ["ds-icon"];
  if (spin) {
    parts.push("ds-icon-spin");
  }
  if (className) {
    parts.push(className);
  }

  return (
    <svg
      className={parts.join(" ")}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={name}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {shapes.map(renderShape)}
    </svg>
  );
}
