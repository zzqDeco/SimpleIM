import { Fragment, type ReactElement, type ReactNode } from "react";

export type MarkdownInlineToken =
  | { type: "text"; content: string }
  | { type: "code"; content: string }
  | { type: "bold"; children: MarkdownInlineToken[] }
  | { type: "italic"; children: MarkdownInlineToken[] }
  | { type: "link"; label: string; href: string };

export type MarkdownBlockToken =
  | { type: "code_block"; language: string; code: string }
  | { type: "paragraph"; lines: MarkdownInlineToken[][] };

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export function sanitizeLinkUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > 2048 || CONTROL_CHAR_RE.test(trimmed)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (!parsed.hostname) {
    return null;
  }
  return parsed.toString();
}

function appendTextToken(tokens: MarkdownInlineToken[], text: string): void {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last && last.type === "text") {
    last.content += text;
  } else {
    tokens.push({ type: "text", content: text });
  }
}

function findClosingLinkParen(input: string, openParenIdx: number): number {
  let depth = 1;
  for (let i = openParenIdx + 1; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    } else if (ch === "\n") {
      return -1;
    }
  }
  return -1;
}

function splitBareUrlTrailingPunctuation(raw: string): {
  urlPart: string;
  trailing: string;
} {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1];
    if (ch === "." || ch === "," || ch === ";" || ch === ":" || ch === "!" || ch === "?") {
      end--;
      continue;
    }
    if (ch === ")") {
      const candidate = raw.slice(0, end);
      let opens = 0;
      let closes = 0;
      for (const c of candidate) {
        if (c === "(") opens++;
        else if (c === ")") closes++;
      }
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return {
    urlPart: raw.slice(0, end),
    trailing: raw.slice(end),
  };
}

export function tokenizeInlineMarkdown(text: string): MarkdownInlineToken[] {
  const tokens: MarkdownInlineToken[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // 1. Inline `code`
    if (ch === "`") {
      const closeIdx = text.indexOf("`", i + 1);
      if (closeIdx > i + 1) {
        tokens.push({
          type: "code",
          content: text.slice(i + 1, closeIdx),
        });
        i = closeIdx + 1;
        continue;
      }
    }

    // 2. Markdown link [label](url)
    if (ch === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (
        closeBracket > i + 1 &&
        text[closeBracket + 1] === "(" &&
        !text.slice(i + 1, closeBracket).includes("[")
      ) {
        const closeParen = findClosingLinkParen(text, closeBracket + 1);
        if (closeParen > closeBracket + 1) {
          const label = text.slice(i + 1, closeBracket);
          const rawUrl = text.slice(closeBracket + 2, closeParen);
          const safeHref = sanitizeLinkUrl(rawUrl);
          if (safeHref !== null) {
            tokens.push({
              type: "link",
              label,
              href: safeHref,
            });
          } else {
            // Dangerous or invalid scheme (e.g. javascript:, data:) -> render inert label text only
            appendTextToken(tokens, label);
          }
          i = closeParen + 1;
          continue;
        }
      }
    }

    // 3. Bold **...**
    if (ch === "*" && text[i + 1] === "*") {
      const closeBold = text.indexOf("**", i + 2);
      if (closeBold > i + 2) {
        const inner = text.slice(i + 2, closeBold);
        tokens.push({
          type: "bold",
          children: tokenizeInlineMarkdown(inner),
        });
        i = closeBold + 2;
        continue;
      }
    }

    // 4. Italic *...*
    if (ch === "*" && text[i + 1] !== "*" && text[i + 1] !== " ") {
      let closeItalic = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === "*" && text[j - 1] !== " " && text[j + 1] !== "*") {
          closeItalic = j;
          break;
        }
      }
      if (closeItalic > i + 1) {
        const inner = text.slice(i + 1, closeItalic);
        tokens.push({
          type: "italic",
          children: tokenizeInlineMarkdown(inner),
        });
        i = closeItalic + 1;
        continue;
      }
    }

    // 5. Bare http(s):// URL
    if (
      (text.startsWith("https://", i) || text.startsWith("http://", i)) &&
      (i === 0 || /[\s(]/.test(text[i - 1] ?? ""))
    ) {
      let end = i;
      while (end < text.length && !/\s/.test(text[end] ?? "")) {
        end++;
      }
      const rawCandidate = text.slice(i, end);
      const { urlPart, trailing } = splitBareUrlTrailingPunctuation(rawCandidate);
      const safeHref = sanitizeLinkUrl(urlPart);
      if (safeHref !== null) {
        tokens.push({
          type: "link",
          label: urlPart,
          href: safeHref,
        });
        appendTextToken(tokens, trailing);
        i = end;
        continue;
      }
    }

    appendTextToken(tokens, ch ?? "");
    i++;
  }

  return tokens;
}

export function tokenizeMarkdownBlocks(input: string): MarkdownBlockToken[] {
  const normalized = input.replace(/\r\n?/g, "\n");
  if (normalized.length === 0) {
    return [];
  }

  const lines = normalized.split("\n");
  const blocks: MarkdownBlockToken[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return;
    blocks.push({
      type: "paragraph",
      lines: paragraphLines.map((line) => tokenizeInlineMarkdown(line)),
    });
    paragraphLines = [];
  };

  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx] ?? "";
    const trimmedStart = line.trimStart();

    if (trimmedStart.startsWith("```")) {
      flushParagraph();
      const language = trimmedStart.slice(3).trim().slice(0, 32);
      const codeLines: string[] = [];
      idx++;
      while (idx < lines.length) {
        const innerLine = lines[idx] ?? "";
        if (innerLine.trim() === "```") {
          idx++;
          break;
        }
        codeLines.push(innerLine);
        idx++;
      }
      blocks.push({
        type: "code_block",
        language,
        code: codeLines.join("\n"),
      });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      idx++;
      continue;
    }

    paragraphLines.push(line);
    idx++;
  }

  flushParagraph();
  return blocks;
}

function renderInlineTokens(tokens: MarkdownInlineToken[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (token.type) {
      case "text":
        return <Fragment key={key}>{token.content}</Fragment>;
      case "code":
        return (
          <code key={key} className="md-inline-code">
            {token.content}
          </code>
        );
      case "bold":
        return (
          <strong key={key}>
            {renderInlineTokens(token.children, `${key}-b`)}
          </strong>
        );
      case "italic":
        return (
          <em key={key}>
            {renderInlineTokens(token.children, `${key}-i`)}
          </em>
        );
      case "link":
        return (
          <a
            key={key}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
            className="md-link"
          >
            {token.label}
          </a>
        );
    }
  });
}

export function renderSafeMarkdown(content: string): ReactElement {
  const blocks = tokenizeMarkdownBlocks(content);
  return (
    <div className="md-content">
      {blocks.map((block, bIdx) => {
        if (block.type === "code_block") {
          return (
            <pre key={`b-${bIdx}`} className="md-code-block">
              <code data-lang={block.language || undefined}>{block.code}</code>
            </pre>
          );
        }
        return (
          <p key={`b-${bIdx}`} className="md-paragraph">
            {block.lines.map((lineTokens, lIdx) => (
              <Fragment key={`l-${bIdx}-${lIdx}`}>
                {lIdx > 0 ? <br /> : null}
                {renderInlineTokens(lineTokens, `i-${bIdx}-${lIdx}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

export function SafeMarkdown({ content }: { content: string }): ReactElement {
  return renderSafeMarkdown(content);
}
