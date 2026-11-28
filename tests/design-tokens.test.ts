import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const STYLES_DIR = join(REPO_ROOT, "apps/web/src/styles");

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseCssCustomProperties(blockBody: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const declRe = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match: RegExpExecArray | null;
  while ((match = declRe.exec(blockBody)) !== null) {
    vars[match[1]!] = match[2]!.trim();
  }
  return vars;
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  if (clean.length === 3) {
    return [
      Number.parseInt(clean[0]! + clean[0]!, 16),
      Number.parseInt(clean[1]! + clean[1]!, 16),
      Number.parseInt(clean[2]! + clean[2]!, 16),
    ];
  }
  if (clean.length !== 6) {
    throw new Error(`Unsupported hex color: ${hex}`);
  }
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function compositeRgbaOverHex(
  rgba: string,
  bgHex: string,
): [number, number, number] {
  const m = rgba
    .trim()
    .match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!m) {
    throw new Error(`Unsupported rgba color: ${rgba}`);
  }
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  const alpha = m[4] !== undefined ? Number(m[4]) : 1;
  const [br, bg, bb] = parseHexRgb(bgHex);
  return [
    r * alpha + br * (1 - alpha),
    g * alpha + bg * (1 - alpha),
    b * alpha + bb * (1 - alpha),
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linearize = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(
  c1: [number, number, number],
  c2: [number, number, number],
): number {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function extractThemeBlock(
  cssWithoutComments: string,
  selectorPattern: RegExp,
): string {
  const m = selectorPattern.exec(cssWithoutComments);
  expect(
    m,
    `Missing CSS block matching ${selectorPattern.source}`,
  ).not.toBeNull();
  const idx = m!.index;
  const openBrace = cssWithoutComments.indexOf("{", idx);
  expect(openBrace).toBeGreaterThan(idx);
  let depth = 0;
  for (let i = openBrace; i < cssWithoutComments.length; i++) {
    const ch = cssWithoutComments[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return cssWithoutComments.slice(openBrace + 1, i);
      }
    }
  }
  throw new Error(`Unterminated CSS block matching ${selectorPattern.source}`);
}

/**
 * Extracts each top-level or nested selector block containing `--text-decorative`
 * so we can enforce that decorative gray never leaks into readable text.
 */
function findSelectorsUsingToken(cssWithoutComments: string, token: string): string[] {
  const results: string[] = [];
  const ruleRe = /([^{}@]+)\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(cssWithoutComments)) !== null) {
    const selector = match[1]!.trim().replace(/\s+/g, " ");
    const body = match[2]!;
    if (body.includes(`var(${token})`)) {
      results.push(selector);
    }
  }
  return results;
}

describe("Design System Token Compliance & WCAG AA Contrast (Issue #41)", () => {
  test("non-token stylesheets ban raw colors, typography, spacing/offsets, radii, z-index, and ms durations", () => {
    const cssFiles = readdirSync(STYLES_DIR)
      .filter((name) => name.endsWith(".css"))
      .sort();
    expect(cssFiles).toContain("tokens.css");

    const allowedDecorativeSelectors = new Set([
      ".ds-byline-sep",
      ".ds-subline-glyph",
    ]);

    for (const cssFile of cssFiles) {
      const raw = readFileSync(join(STYLES_DIR, cssFile), "utf8");
      const content = stripCssComments(raw);

      // Deprecated --text-dim must not exist anywhere in styles
      expect(
        content.includes("--text-dim"),
        `${cssFile} must not reference deprecated --text-dim (use --text-muted or --text-decorative)`,
      ).toBe(false);

      if (cssFile === "tokens.css") continue;

      // 1. Zero hardcoded colors
      const hardcodedColor = content.match(
        /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/,
      );
      expect(
        hardcodedColor,
        `${cssFile} contains hardcoded color: ${hardcodedColor?.[0]}`,
      ).toBeNull();

      // 2. Zero raw font-size in px
      const rawFontSize = content.match(
        /(?:^|[;\s{])font-size\s*:\s*[^;}]*\b\d+(?:\.\d+)?px\b/g,
      );
      expect(
        rawFontSize,
        `${cssFile} has raw px font-size: ${rawFontSize?.join(", ")}`,
      ).toBeNull();

      // 3. Zero raw numeric line-height
      const rawLineHeight = content.match(
        /(?:^|[;\s{])line-height\s*:\s*\d+(?:\.\d+)?(?:px|rem|em)?\s*[;}]/g,
      );
      expect(
        rawLineHeight,
        `${cssFile} has raw numeric line-height: ${rawLineHeight?.join(", ")}`,
      ).toBeNull();

      // 4. Zero raw numeric font-weight
      const rawFontWeight = content.match(
        /(?:^|[;\s{])font-weight\s*:\s*\d{3}\s*[;}]/g,
      );
      expect(
        rawFontWeight,
        `${cssFile} has raw numeric font-weight: ${rawFontWeight?.join(", ")}`,
      ).toBeNull();

      // 5. Zero raw numeric z-index
      const rawZIndex = content.match(
        /(?:^|[;\s{])z-index\s*:\s*-?\d+\s*[;}]/g,
      );
      expect(
        rawZIndex,
        `${cssFile} has raw numeric z-index: ${rawZIndex?.join(", ")}`,
      ).toBeNull();

      // 6. Zero raw ms durations (and zero non-zero second durations)
      const rawMs = content.match(/\b\d+(?:\.\d+)?ms\b/g);
      expect(
        rawMs,
        `${cssFile} has raw ms duration: ${rawMs?.join(", ")}`,
      ).toBeNull();
      const rawNonZeroSeconds = content.match(
        /\b(?:[1-9]\d*(?:\.\d+)?|0\.\d+)s\b/g,
      );
      expect(
        rawNonZeroSeconds,
        `${cssFile} has raw non-zero second duration: ${rawNonZeroSeconds?.join(", ")}`,
      ).toBeNull();

      // 7. Zero raw border-radius in px
      const rawRadius = content.match(
        /(?:^|[;\s{])border-radius\s*:\s*[^;}]*\b\d+(?:\.\d+)?px\b/g,
      );
      expect(
        rawRadius,
        `${cssFile} has raw px border-radius: ${rawRadius?.join(", ")}`,
      ).toBeNull();

      // 8. Zero raw px in padding / margin / gap / inset / top / right / bottom / left
      // Whitelist: 0px, 1px, -1px (hairline / sr-only), and env(..., 0px) fallbacks
      const spacingViolations: string[] = [];
      const spacingRe =
        /(?:^|[;\s{])((?:padding|margin|gap|row-gap|column-gap)(?:-[a-z-]+)?|inset|top|right|bottom|left)\s*:\s*([^;}]+)[;}]/gi;
      let match: RegExpExecArray | null;
      while ((match = spacingRe.exec(content)) !== null) {
        const prop = match[1]!;
        const val = match[2]!.trim();
        const withoutEnv = val.replace(/env\([^)]*\)/g, "");
        const pxLiterals = withoutEnv.match(/-?\d+(?:\.\d+)?px\b/g) ?? [];
        for (const px of pxLiterals) {
          if (px !== "0px" && px !== "1px" && px !== "-1px") {
            spacingViolations.push(`${prop}: ${val} (raw ${px})`);
          }
        }
      }
      expect(
        spacingViolations,
        `${cssFile} has raw px spacing/offset values:\n${spacingViolations.join("\n")}`,
      ).toEqual([]);

      // 9. --text-decorative allowed ONLY in whitelisted non-text decorative selectors
      const decorativeSelectors = findSelectorsUsingToken(
        content,
        "--text-decorative",
      );
      for (const selector of decorativeSelectors) {
        expect(
          allowedDecorativeSelectors.has(selector),
          `${cssFile} uses --text-decorative in non-whitelisted selector '${selector}'`,
        ).toBe(true);
      }
    }

    // 10. Single-source light theme & prefers-reduced-motion checks
    const tokensCss = stripCssComments(
      readFileSync(join(STYLES_DIR, "tokens.css"), "utf8"),
    );
    const baseCss = stripCssComments(
      readFileSync(join(STYLES_DIR, "base.css"), "utf8"),
    );
    expect(tokensCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(baseCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(tokensCss).not.toContain("@media (prefers-color-scheme: light)");
    expect(
      (tokensCss.match(/:root\[data-theme="light"\]/g) ?? []).length,
    ).toBe(1);
    expect((tokensCss.match(/--bg-canvas\s*:/g) ?? []).length).toBe(2);
  });

  test("tokens.css dark and light themes meet WCAG AA (>= 4.5:1) for all text tokens, soft overlays, and primary button fills", () => {
    const tokensCss = stripCssComments(
      readFileSync(join(STYLES_DIR, "tokens.css"), "utf8"),
    );
    const darkVars = parseCssCustomProperties(
      extractThemeBlock(tokensCss, /:root\s*,\s*:root\[data-theme="dark"\]/),
    );
    const lightVars = parseCssCustomProperties(
      extractThemeBlock(tokensCss, /:root\[data-theme="light"\]/),
    );

    const opaqueSurfaces = [
      "--bg-canvas",
      "--bg-panel",
      "--bg-elevated",
      "--bg-input",
      "--bg-user-msg",
    ] as const;

    const textTokens = [
      "--text-primary",
      "--text-secondary",
      "--text-muted",
      "--accent-text",
      "--interactive",
      "--status-success",
      "--status-warning",
      "--status-danger",
    ] as const;

    const softBadgePairs: readonly (readonly [string, string])[] = [
      ["--accent-text", "--accent-soft"],
      ["--status-success", "--status-success-soft"],
      ["--status-warning", "--status-warning-soft"],
      ["--status-danger", "--status-danger-soft"],
    ];

    const softHostSurfaces = [
      "--bg-canvas",
      "--bg-panel",
      "--bg-elevated",
      "--bg-input",
    ] as const;

    for (const [themeName, vars] of [
      ["dark", darkVars],
      ["light", lightVars],
    ] as const) {
      expect(
        vars["--text-decorative"],
        `${themeName} must define --text-decorative`,
      ).toBeTruthy();

      for (const fgToken of textTokens) {
        const fgHex = vars[fgToken];
        expect(fgHex, `${themeName} missing ${fgToken}`).toBeTruthy();
        const fgRgb = parseHexRgb(fgHex!);

        for (const bgToken of opaqueSurfaces) {
          const bgHex = vars[bgToken];
          expect(bgHex, `${themeName} missing ${bgToken}`).toBeTruthy();
          const ratio = contrastRatio(fgRgb, parseHexRgb(bgHex!));
          expect(
            ratio,
            `${themeName} ${fgToken} (${fgHex}) on ${bgToken} (${bgHex}) = ${ratio.toFixed(2)}:1 (< 4.5:1)`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }

      // Primary button fill (--text-inverse on --accent-fill & --accent-fill-hover)
      const invRgb = parseHexRgb(vars["--text-inverse"]!);
      for (const fillToken of ["--accent-fill", "--accent-fill-hover"] as const) {
        const fillHex = vars[fillToken];
        expect(fillHex, `${themeName} missing ${fillToken}`).toBeTruthy();
        const ratio = contrastRatio(invRgb, parseHexRgb(fillHex!));
        expect(
          ratio,
          `${themeName} --text-inverse on ${fillToken} (${fillHex}) = ${ratio.toFixed(2)}:1 (< 4.5:1)`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      // Status & accent text over *-soft overlays composited onto container surfaces
      for (const [fgToken, softBgToken] of softBadgePairs) {
        const fgRgb = parseHexRgb(vars[fgToken]!);
        const softRgba = vars[softBgToken]!;
        for (const hostBg of softHostSurfaces) {
          const composited = compositeRgbaOverHex(softRgba, vars[hostBg]!);
          const ratio = contrastRatio(fgRgb, composited);
          expect(
            ratio,
            `${themeName} ${fgToken} on ${softBgToken} over ${hostBg} = ${ratio.toFixed(2)}:1 (< 4.5:1)`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
