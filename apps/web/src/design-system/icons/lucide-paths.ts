/**
 * Vendored SVG shape data from Lucide Icons (v0.475.0, https://lucide.dev).
 *
 * ISC License
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
 * All other copyright (c) for Lucide are held by Lucide Contributors 2022.
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 */

export type SvgShape =
  | { readonly tag: "path"; readonly d: string }
  | { readonly tag: "circle"; readonly cx: number; readonly cy: number; readonly r: number }
  | {
      readonly tag: "line";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
    }
  | {
      readonly tag: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx?: number;
      readonly ry?: number;
    };

export const LUCIDE_ICON_PATHS = {
  menu: [
    { tag: "line", x1: 4, y1: 12, x2: 20, y2: 12 },
    { tag: "line", x1: 4, y1: 6, x2: 20, y2: 6 },
    { tag: "line", x1: 4, y1: 18, x2: 20, y2: 18 },
  ],
  ellipsis: [
    { tag: "circle", cx: 12, cy: 12, r: 1 },
    { tag: "circle", cx: 19, cy: 12, r: 1 },
    { tag: "circle", cx: 5, cy: 12, r: 1 },
  ],
  users: [
    { tag: "path", d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" },
    { tag: "path", d: "M16 3.128a4 4 0 0 1 0 7.744" },
    { tag: "path", d: "M22 21v-2a4 4 0 0 0-3-3.87" },
    { tag: "circle", cx: 9, cy: 7, r: 4 },
  ],
  "cloud-upload": [
    { tag: "path", d: "M12 13v8" },
    {
      tag: "path",
      d: "M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242",
    },
    { tag: "path", d: "m8 17 4-4 4 4" },
  ],
  "cloud-check": [
    { tag: "path", d: "m17 15-5.5 5.5L9 18" },
    {
      tag: "path",
      d: "M5 17.743A7 7 0 1 1 15.71 10h1.79a4.5 4.5 0 0 1 1.5 8.742",
    },
  ],
  check: [{ tag: "path", d: "M20 6 9 17l-5-5" }],
  x: [
    { tag: "path", d: "M18 6 6 18" },
    { tag: "path", d: "m6 6 12 12" },
  ],
  "triangle-alert": [
    {
      tag: "path",
      d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
    },
    { tag: "path", d: "M12 9v4" },
    { tag: "path", d: "M12 17h.01" },
  ],
  info: [
    { tag: "circle", cx: 12, cy: 12, r: 10 },
    { tag: "path", d: "M12 16v-4" },
    { tag: "path", d: "M12 8h.01" },
  ],
  "loader-circle": [{ tag: "path", d: "M21 12a9 9 0 1 1-6.219-8.56" }],
  pin: [
    { tag: "path", d: "M12 17v5" },
    {
      tag: "path",
      d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
    },
  ],
  "arrow-down": [
    { tag: "path", d: "M12 5v14" },
    { tag: "path", d: "m19 12-7 7-7-7" },
  ],
  "corner-down-right": [
    { tag: "path", d: "m15 10 5 5-5 5" },
    { tag: "path", d: "M4 4v7a4 4 0 0 0 4 4h12" },
  ],
  paperclip: [
    {
      tag: "path",
      d: "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551",
    },
  ],
  send: [
    {
      tag: "path",
      d: "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
    },
    { tag: "path", d: "m21.854 2.147-10.94 10.939" },
  ],
  download: [
    { tag: "path", d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" },
    { tag: "path", d: "M7 10l5 5 5-5" },
    { tag: "path", d: "M12 15V3" },
  ],
  "hard-drive-download": [
    { tag: "path", d: "M12 2v8" },
    { tag: "path", d: "m16 6-4 4-4-4" },
    { tag: "rect", x: 2, y: 14, width: 20, height: 8, rx: 2 },
    { tag: "path", d: "M6 18h.01" },
    { tag: "path", d: "M10 18h.01" },
  ],
  locate: [
    { tag: "line", x1: 2, y1: 12, x2: 5, y2: 12 },
    { tag: "line", x1: 19, y1: 12, x2: 22, y2: 12 },
    { tag: "line", x1: 12, y1: 2, x2: 12, y2: 5 },
    { tag: "line", x1: 12, y1: 19, x2: 12, y2: 22 },
    { tag: "circle", cx: 12, cy: 12, r: 7 },
  ],
  eye: [
    {
      tag: "path",
      d: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
    },
    { tag: "circle", cx: 12, cy: 12, r: 3 },
  ],
  "eye-off": [
    {
      tag: "path",
      d: "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
    },
    { tag: "path", d: "M14.084 14.158a3 3 0 0 1-4.242-4.242" },
    {
      tag: "path",
      d: "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
    },
    { tag: "path", d: "m2 2 20 20" },
  ],
  reply: [
    { tag: "path", d: "M20 18v-2a4 4 0 0 0-4-4H4" },
    { tag: "path", d: "m9 17-5-5 5-5" },
  ],
  "rotate-ccw": [
    { tag: "path", d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" },
    { tag: "path", d: "M3 3v5h5" },
  ],
  "door-open": [
    { tag: "path", d: "M11 20H2" },
    {
      tag: "path",
      d: "M11 4.562v16.157a1 1 0 0 0 1.242.97L19 20V5.562a2 2 0 0 0-1.515-1.94l-4-1A2 2 0 0 0 11 4.561z",
    },
    { tag: "path", d: "M11 4H8a2 2 0 0 0-2 2v14" },
    { tag: "path", d: "M14 12h.01" },
    { tag: "path", d: "M22 20h-3" },
  ],
  "log-out": [
    { tag: "path", d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" },
    { tag: "path", d: "M16 17l5-5-5-5" },
    { tag: "path", d: "M21 12H9" },
  ],
  "trash-2": [
    { tag: "path", d: "M3 6h18" },
    { tag: "path", d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" },
    { tag: "path", d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" },
    { tag: "line", x1: 10, y1: 11, x2: 10, y2: 17 },
    { tag: "line", x1: 14, y1: 11, x2: 14, y2: 17 },
  ],
  monitor: [
    { tag: "rect", x: 2, y: 3, width: 20, height: 14, rx: 2 },
    { tag: "line", x1: 8, y1: 21, x2: 16, y2: 21 },
    { tag: "line", x1: 12, y1: 17, x2: 12, y2: 21 },
  ],
  moon: [{ tag: "path", d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" }],
  sun: [
    { tag: "circle", cx: 12, cy: 12, r: 4 },
    { tag: "path", d: "M12 2v2" },
    { tag: "path", d: "M12 20v2" },
    { tag: "path", d: "m4.93 4.93 1.41 1.41" },
    { tag: "path", d: "m17.66 17.66 1.41 1.41" },
    { tag: "path", d: "M2 12h2" },
    { tag: "path", d: "M20 12h2" },
    { tag: "path", d: "m6.34 17.66-1.41 1.41" },
    { tag: "path", d: "m19.07 4.93-1.41 1.41" },
  ],
  languages: [
    { tag: "path", d: "m5 8 6 6" },
    { tag: "path", d: "m4 14 6-6 2-3" },
    { tag: "path", d: "M2 5h12" },
    { tag: "path", d: "M7 2h1" },
    { tag: "path", d: "m22 22-5-10-5 10" },
    { tag: "path", d: "M14 18h6" },
  ],
  file: [
    {
      tag: "path",
      d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    },
    { tag: "path", d: "M14 2v4a2 2 0 0 0 2 2h4" },
  ],
  image: [
    { tag: "rect", x: 3, y: 3, width: 18, height: 18, rx: 2, ry: 2 },
    { tag: "circle", cx: 9, cy: 9, r: 2 },
    { tag: "path", d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" },
  ],
} as const satisfies Record<string, readonly SvgShape[]>;

export type IconName = keyof typeof LUCIDE_ICON_PATHS;

export const ICON_NAMES = Object.keys(LUCIDE_ICON_PATHS) as readonly IconName[];
