import { describe, expect, test } from "bun:test";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const REPO_ROOT = join(import.meta.dir, "..");

function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "build") {
      continue;
    }
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function extractImportSpecifiers(filePath: string): string[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specs: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return specs;
}

describe("Workspace & Clean Architecture Import Boundaries", () => {
  test("packages/contracts has zero internal, node, bun, or runtime third-party imports", () => {
    const files = collectSourceFiles(join(REPO_ROOT, "packages/contracts/src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const spec of extractImportSpecifiers(file)) {
        expect(
          spec.startsWith("."),
          `${relative(REPO_ROOT, file)} imported forbidden module '${spec}'`,
        ).toBe(true);
      }
    }
  });

  test("packages/crypto imports only @simpleim/contracts, @noble/*, or relative modules", () => {
    const files = collectSourceFiles(join(REPO_ROOT, "packages/crypto/src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const spec of extractImportSpecifiers(file)) {
        const allowed =
          spec.startsWith(".") ||
          spec === "@simpleim/contracts" ||
          spec.startsWith("@noble/hashes/") ||
          spec.startsWith("@noble/curves/") ||
          spec.startsWith("@noble/ciphers/");
        expect(
          allowed,
          `${relative(REPO_ROOT, file)} imported forbidden module '${spec}'`,
        ).toBe(true);
      }
    }
  });

  test("packages/peer-core imports only @simpleim/contracts, @simpleim/crypto, or relative modules (zero DOM/werift/bun/node)", () => {
    const files = collectSourceFiles(join(REPO_ROOT, "packages/peer-core/src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const spec of extractImportSpecifiers(file)) {
        const allowed =
          spec.startsWith(".") ||
          spec === "@simpleim/contracts" ||
          spec === "@simpleim/crypto";
        expect(
          allowed,
          `${relative(REPO_ROOT, file)} imported forbidden module '${spec}'`,
        ).toBe(true);
      }
    }
  });

  test("apps/server never imports peer-core, web, cli, or werift, and enforces 4-layer Clean Architecture", () => {
    const serverSrc = join(REPO_ROOT, "apps/server/src");
    const files = collectSourceFiles(serverSrc);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const rel = relative(serverSrc, file).split(sep).join("/");
      const specs = extractImportSpecifiers(file);

      for (const spec of specs) {
        const forbiddenGlobal =
          spec.startsWith("@simpleim/peer-core") ||
          spec.startsWith("@simpleim/web") ||
          spec.startsWith("@simpleim/cli") ||
          spec === "werift" ||
          spec.startsWith("react");
        expect(
          forbiddenGlobal,
          `apps/server/src/${rel} imported forbidden package '${spec}'`,
        ).toBe(false);
      }

      if (rel.startsWith("domain/")) {
        for (const spec of specs) {
          const allowed =
            spec.startsWith(".") || spec === "@simpleim/contracts";
          // Also ensure relative imports stay inside domain/
          const escapesDomain =
            spec.startsWith("../") && !rel.slice("domain/".length).includes("/");
          expect(
            allowed && !escapesDomain,
            `domain layer violation in apps/server/src/${rel}: '${spec}'`,
          ).toBe(true);
        }
      } else if (rel.startsWith("app/")) {
        for (const spec of specs) {
          const touchesAdapterOrInfra =
            spec.includes("/adapter/") ||
            spec.includes("/infra/") ||
            spec.startsWith("bun:") ||
            spec.startsWith("node:");
          expect(
            touchesAdapterOrInfra,
            `app layer violation in apps/server/src/${rel}: '${spec}'`,
          ).toBe(false);
        }
      } else if (rel.startsWith("adapter/")) {
        for (const spec of specs) {
          const touchesInfra =
            spec.includes("/infra/") || spec === "bun:sqlite";
          expect(
            touchesInfra,
            `adapter layer must not import infra in apps/server/src/${rel}: '${spec}'`,
          ).toBe(false);
        }
      } else if (rel.startsWith("infra/")) {
        for (const spec of specs) {
          const touchesAppOrAdapter =
            spec.includes("/app/") || spec.includes("/adapter/");
          expect(
            touchesAppOrAdapter,
            `infra layer must not import app or adapter in apps/server/src/${rel}: '${spec}'`,
          ).toBe(false);
        }
      }
    }
  });

  test("apps/web never imports server, cli, werift, bun:*, or node:*", () => {
    const files = collectSourceFiles(join(REPO_ROOT, "apps/web/src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const spec of extractImportSpecifiers(file)) {
        const forbidden =
          spec.startsWith("@simpleim/server") ||
          spec.startsWith("@simpleim/cli") ||
          spec === "werift" ||
          spec.startsWith("bun:") ||
          spec.startsWith("node:");
        expect(
          forbidden,
          `${relative(REPO_ROOT, file)} imported forbidden module '${spec}'`,
        ).toBe(false);
      }
    }
  });

  test("apps/web enforces 5-layer decoupled frontend boundaries (design-system, state, hooks, theme, i18n, features)", () => {
    const webSrc = join(REPO_ROOT, "apps/web/src");
    expect(existsSync(join(webSrc, "components"))).toBe(false);
    expect(existsSync(join(webSrc, "styles.css"))).toBe(false);

    const files = collectSourceFiles(webSrc);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const rel = relative(webSrc, file).split(sep).join("/");
      const specs = extractImportSpecifiers(file);

      if (rel.startsWith("design-system/")) {
        for (const spec of specs) {
          const allowed = spec === "react" || spec.startsWith("./");
          expect(
            allowed,
            `design-system must remain pure UI (apps/web/src/${rel} imported '${spec}')`,
          ).toBe(true);
        }
      } else if (rel.startsWith("state/")) {
        expect(
          rel.endsWith(".ts"),
          `state layer must be pure .ts without JSX: apps/web/src/${rel}`,
        ).toBe(true);
        for (const spec of specs) {
          const forbidden =
            spec.startsWith("react") ||
            spec.includes("/design-system") ||
            spec.includes("/hooks") ||
            spec.includes("/features") ||
            spec.includes("/theme") ||
            spec.includes("/crypto") ||
            spec.includes("/storage") ||
            spec.includes("/transport");
          expect(
            forbidden,
            `state layer violation in apps/web/src/${rel}: '${spec}'`,
          ).toBe(false);
        }
      } else if (rel.startsWith("hooks/")) {
        expect(
          rel.endsWith(".ts"),
          `hooks layer must be headless .ts without JSX: apps/web/src/${rel}`,
        ).toBe(true);
        for (const spec of specs) {
          const forbidden =
            spec.includes("/design-system") || spec.includes("/features");
          expect(
            forbidden,
            `hooks layer must not import UI components in apps/web/src/${rel}: '${spec}'`,
          ).toBe(false);
        }
      } else if (rel.startsWith("theme/") || rel.startsWith("i18n/")) {
        for (const spec of specs) {
          const forbidden =
            spec.includes("/design-system") ||
            spec.includes("/state") ||
            spec.includes("/hooks") ||
            spec.includes("/features");
          expect(
            forbidden,
            `theme/i18n layer violation in apps/web/src/${rel}: '${spec}'`,
          ).toBe(false);
        }
      } else if (rel.startsWith("features/")) {
        const featureName = rel.split("/")[1] ?? "";
        for (const spec of specs) {
          const touchesLowLevelAdapters =
            spec.includes("/api/") ||
            spec.includes("/crypto/") ||
            spec.includes("/storage/") ||
            spec.includes("/transport/");
          expect(
            touchesLowLevelAdapters,
            `feature view must use hooks/state instead of low-level adapters in apps/web/src/${rel}: '${spec}'`,
          ).toBe(false);

          if (featureName === "auth") {
            expect(
              spec.includes("/lobby") || spec.includes("/room"),
              `features/auth must not couple to lobby or room (${rel}: '${spec}')`,
            ).toBe(false);
          } else if (featureName === "lobby") {
            expect(
              spec.includes("/auth") || spec.includes("/room"),
              `features/lobby must not couple to auth or room (${rel}: '${spec}')`,
            ).toBe(false);
          } else if (featureName === "room") {
            expect(
              spec.includes("/auth") || spec.includes("/lobby"),
              `features/room must not couple to auth or lobby (${rel}: '${spec}')`,
            ).toBe(false);
          } else if (featureName === "preferences") {
            expect(
              spec.includes("/auth") ||
                spec.includes("/lobby") ||
                spec.includes("/room") ||
                spec.includes("/hooks") ||
                spec.includes("/state"),
              `features/preferences must stay self-contained (${rel}: '${spec}')`,
            ).toBe(false);
          }
        }
      }
    }
  });

  test("apps/cli never imports server or web", () => {
    const files = collectSourceFiles(join(REPO_ROOT, "apps/cli/src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const spec of extractImportSpecifiers(file)) {
        const forbidden =
          spec.startsWith("@simpleim/server") ||
          spec.startsWith("@simpleim/web") ||
          spec.startsWith("react");
        expect(
          forbidden,
          `${relative(REPO_ROOT, file)} imported forbidden module '${spec}'`,
        ).toBe(false);
      }
    }
  });
});
