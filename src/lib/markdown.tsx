"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Tiny, dependency-free markdown renderer that emits React elements.
 *
 * Deliberately NOT string-based: we never touch `dangerouslySetInnerHTML`, so
 * there is no HTML-injection surface. The only attribute we forward is link
 * `href`, which is passed through `safeUrl` (http/https/mailto/relative only —
 * `javascript:` and friends fall back to plain text).
 *
 * Supported: ATX headings, **bold** / *italic* (and `_` variants), `inline code`,
 * fenced ``` code blocks ```, unordered/ordered lists, blockquotes, `---` rules,
 * links, and paragraphs. Intentionally flat (no nested lists) — enough for
 * STARRA's replies, nothing more.
 */

function safeUrl(raw: string): string | null {
  const u = raw.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (u.startsWith("/") || u.startsWith("#")) return u;
  return null;
}

const INLINE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "code", re: /`([^`]+)`/ },
  { name: "bold", re: /\*\*([\s\S]+?)\*\*/ },
  { name: "boldu", re: /__([\s\S]+?)__/ },
  { name: "link", re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
  { name: "italic", re: /\*([^*\n]+?)\*/ },
  // NOTE: no regex lookbehind — macOS 12 WebKit (the WKWebView) can't parse it and
  // the whole deck bundle fails to load. The leading boundary is captured (group 1)
  // instead of a lookbehind; parseInline re-emits it. Lookahead is fine in WebKit.
  { name: "italicu", re: /(^|[^A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])/ },
];

function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;

  while (rest.length > 0) {
    let bestIdx = Infinity;
    let bestName = "";
    let bestMatch: RegExpExecArray | null = null;

    for (const p of INLINE_PATTERNS) {
      const m = p.re.exec(rest);
      if (m && m.index < bestIdx) {
        bestIdx = m.index;
        bestName = p.name;
        bestMatch = m;
      }
    }

    if (!bestMatch) {
      out.push(rest);
      break;
    }

    if (bestIdx > 0) out.push(rest.slice(0, bestIdx));
    const key = `${keyPrefix}-${i++}`;

    switch (bestName) {
      case "code":
        out.push(
          <code key={key} className="md-code">
            {bestMatch[1]}
          </code>,
        );
        break;
      case "bold":
      case "boldu":
        out.push(<strong key={key}>{parseInline(bestMatch[1], key)}</strong>);
        break;
      case "italic":
        out.push(<em key={key}>{parseInline(bestMatch[1], key)}</em>);
        break;
      case "italicu":
        // group 1 = captured leading boundary char (or ""), group 2 = content
        if (bestMatch[1]) out.push(bestMatch[1]);
        out.push(<em key={key}>{parseInline(bestMatch[2], key)}</em>);
        break;
      case "link": {
        const href = safeUrl(bestMatch[2]);
        if (href) {
          out.push(
            <a key={key} href={href} target="_blank" rel="noopener noreferrer">
              {parseInline(bestMatch[1], key)}
            </a>,
          );
        } else {
          out.push(...parseInline(bestMatch[1], key));
        }
        break;
      }
      default:
        out.push(bestMatch[0]);
    }

    rest = rest.slice(bestIdx + bestMatch[0].length);
  }

  return out;
}

type Block =
  | { type: "p"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; code: string; lang: string }
  | { type: "quote"; text: string }
  | { type: "hr" };

function toBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block — the info string's first token is the language tag
    const fence = /^```\s*(\S*)/.exec(line);
    if (fence) {
      const lang = fence[1].replace(/[^A-Za-z0-9#+._-]/g, "").slice(0, 20);
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or fall off EOF)
      blocks.push({ type: "code", code: code.join("\n"), lang });
      continue;
    }

    // blank line
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ type: "h", level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    // blockquote (collapse consecutive lines)
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: quote.join(" ") });
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    // paragraph (collapse consecutive plain lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", text: para.join(" ") });
  }

  return blocks;
}

/** How long the "Copied" acknowledgement stays lit on the copy control (ms). */
const COPIED_MS = 1200;

/**
 * Sectioned-off code block: header bar with the fence's language tag and a
 * one-click copy control over the raw code, pre below. This is the "give me
 * code properly" surface — anywhere STARRA fences code, it renders as this.
 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const onCopy = useCallback(async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) return;
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, COPIED_MS);
  }, [code]);

  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span className="md-codeblock-lang">{lang || "code"}</span>
        <button
          type="button"
          className={
            copied ? "md-codeblock-copy md-codeblock-copied" : "md-codeblock-copy"
          }
          aria-label={copied ? "Copied to clipboard" : "Copy this code block"}
          onClick={onCopy}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="md-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Heading({ level, children }: { level: number; children: ReactNode }) {
  const cls = `md-h md-h${level}`;
  switch (level) {
    case 1:
      return <h1 className={cls}>{children}</h1>;
    case 2:
      return <h2 className={cls}>{children}</h2>;
    case 3:
      return <h3 className={cls}>{children}</h3>;
    case 4:
      return <h4 className={cls}>{children}</h4>;
    case 5:
      return <h5 className={cls}>{children}</h5>;
    default:
      return <h6 className={cls}>{children}</h6>;
  }
}

/**
 * Render markdown source to React nodes.
 * `trailing` (e.g. a streaming caret) is appended inline to the last block when
 * that block is a paragraph/heading/quote, otherwise as a trailing sibling.
 */
export function renderMarkdown(src: string, trailing?: ReactNode): ReactNode {
  const blocks = toBlocks(src);

  if (blocks.length === 0) {
    return trailing ? <p className="md-p">{trailing}</p> : null;
  }

  return (
    <>
      {blocks.map((b, idx) => {
        const key = `b-${idx}`;
        const isLast = idx === blocks.length - 1;
        const tail = isLast ? trailing : undefined;

        switch (b.type) {
          case "h":
            return (
              <Heading key={key} level={b.level}>
                {parseInline(b.text, key)}
                {tail}
              </Heading>
            );
          case "code":
            return (
              <Fragment key={key}>
                <CodeBlock code={b.code} lang={b.lang} />
                {tail}
              </Fragment>
            );
          case "quote":
            return (
              <blockquote key={key} className="md-quote">
                {parseInline(b.text, key)}
                {tail}
              </blockquote>
            );
          case "hr":
            return (
              <span key={key}>
                <hr className="md-hr" />
                {tail}
              </span>
            );
          case "list":
            return b.ordered ? (
              <Fragment key={key}>
                <ol className="md-list">
                  {b.items.map((it, j) => (
                    <li key={`${key}-${j}`}>{parseInline(it, `${key}-${j}`)}</li>
                  ))}
                </ol>
                {tail}
              </Fragment>
            ) : (
              <Fragment key={key}>
                <ul className="md-list">
                  {b.items.map((it, j) => (
                    <li key={`${key}-${j}`}>{parseInline(it, `${key}-${j}`)}</li>
                  ))}
                </ul>
                {tail}
              </Fragment>
            );
          case "p":
          default:
            return (
              <p key={key} className="md-p">
                {parseInline(b.text, key)}
                {tail}
              </p>
            );
        }
      })}
    </>
  );
}
