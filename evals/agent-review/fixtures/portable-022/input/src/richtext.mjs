import * as path from "node:path";
import { marked } from "./vendor/marked.mjs";
import { isLocalLinkPath } from "./domain/link-path.mjs";
import { ARC_IDENTITY } from "./identity.mjs";
const VISUALIZATION_SCHEME = ARC_IDENTITY.visualizationScheme;
const VISUALIZE_LINE = /^ {0,3}\uE200visualize\uE202(.*)\uE201[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HOST_RICH_CONTENT = /\uE200(?:[^\uE201\r\n]*\uE201|[^\r\n]*)/g;
function visualizationSpec(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value;
  if (typeof record.path !== "string" || !path.isAbsolute(record.path) || path.extname(record.path).toLowerCase() !== ".html") {
    return null;
  }
  return {
    path: path.normalize(record.path),
    title: typeof record.title === "string" && record.title.trim() ? record.title.replace(/\s+/g, " ").trim() : null
  };
}
function markdownLabel(text) {
  return text.replace(/([\\[\]])/g, "\\$1");
}
function visualizationName(spec) {
  if (spec.title) {
    return spec.title;
  }
  const stem = path.basename(spec.path, path.extname(spec.path)).replace(/[-_]+/g, " ").trim();
  if (!stem) {
    return "Visualization";
  }
  return stem[0].toUpperCase() + stem.slice(1);
}
function visualizationAction(spec) {
  return `Open interactive visualization: ${visualizationName(spec)}`;
}
function translateVisualizationLines(text, replacement) {
  let fence = null;
  return text.split("\n").map((line) => {
    const marker = FENCE.exec(line);
    if (marker) {
      const next = { char: marker[1][0], size: marker[1].length };
      if (!fence) {
        fence = next;
      } else if (next.char === fence.char && next.size >= fence.size) {
        fence = null;
      }
      return line;
    }
    if (fence) {
      return line;
    }
    const reference = VISUALIZE_LINE.exec(line.replace(/\r$/, ""));
    return reference ? replacement(visualizationSpec(reference[1])) : line;
  }).join("\n");
}
function readableRichText(text) {
  return translateVisualizationLines(
    text,
    (spec) => spec ? visualizationAction(spec) : "Interactive visualization is unavailable."
  );
}
function withoutRichContent(text) {
  return text.replace(HOST_RICH_CONTENT, " ").replace(/[\uE200-\uE202]/g, " ");
}
function richMarkdown(text) {
  return translateVisualizationLines(text, (spec) => {
    if (!spec) {
      return "Interactive visualization is unavailable.";
    }
    const label = markdownLabel(visualizationAction(spec));
    return `[${label}](${VISUALIZATION_SCHEME}${encodeURIComponent(spec.path)})`;
  });
}
function visualizationPath(href) {
  if (!href.startsWith(VISUALIZATION_SCHEME)) {
    return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(href.slice(VISUALIZATION_SCHEME.length));
  } catch {
    return null;
  }
  return visualizationSpec(JSON.stringify({ path: decoded }))?.path ?? null;
}
function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character] || character
  );
}
const IMAGE_SUFFIX = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;
function linkTargetIsImage(target) {
  return IMAGE_SUFFIX.test(target);
}
const DRAWN_PICTURE = /<button type="button" class="image-link"[^>]*>([\s\S]*?)<\/button>/g;
const DRAWN_REMOTE_PICTURE = /<a href="#" data-link="[^"]*">([\s\S]*?)<\/a>/g;
function insideLink(body) {
  return body.replace(DRAWN_PICTURE, "$1").replace(DRAWN_REMOTE_PICTURE, "$1");
}
function hasImageReference(text) {
  return text.includes("![");
}
function comparable(target) {
  const unified = target.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}
function within(folder, candidate) {
  const base = comparable(path.resolve(folder));
  const file = comparable(candidate);
  return file === base || file.startsWith(`${base}/`);
}
function decodedTarget(target) {
  if (!target.includes("%")) {
    return target;
  }
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}
function imageInFolders(written, folders) {
  if (!written || !isLocalLinkPath(written) || !IMAGE_SUFFIX.test(written)) {
    return null;
  }
  const candidates = path.isAbsolute(written) ? [path.resolve(written)] : folders.map((folder) => path.resolve(folder, written));
  return candidates.find((file) => folders.some((folder) => within(folder, file))) ?? null;
}
function imageFileFor(target, folders) {
  return imageInFolders(decodedTarget((target || "").trim()), folders);
}
function imagePathFor(target, folders) {
  return imageInFolders((target || "").trim(), folders);
}
function imageFileName(target) {
  const tail = decodedTarget(target).replace(/\\/g, "/").split("/").pop() || "";
  return tail || "image";
}
function renderRichMarkdown(text, resolveImage) {
  if (!text) {
    return "";
  }
  try {
    const renderer = new marked.Renderer();
    renderer.html = (html) => escapeHtml(html);
    renderer.image = (href, title, alt) => {
      const target = href || "";
      const written = (alt || "").replace(/\s+/g, " ").trim();
      const label = written || escapeHtml(imageFileName(target));
      if (/^https?:\/\//i.test(target)) {
        return `<a href="#" data-link="${escapeHtml(target)}">${label}</a>`;
      }
      const picture = resolveImage ? resolveImage(target) : null;
      if (!picture) {
        return label;
      }
      return `<button type="button" class="image-link" data-image="${escapeHtml(picture.path)}" aria-label="Open image: ${label}"` + (title ? ` title="${title}"` : "") + `><img src="${escapeHtml(picture.src)}" alt="${label}"></button>`;
    };
    renderer.link = (href, title, body) => {
      const visualization = visualizationPath(href || "");
      if (visualization) {
        return `<button type="button" class="editor-link visualization-link" data-visualization="${escapeHtml(visualization)}">${body}</button>`;
      }
      return `<a href="#" data-link="${escapeHtml(href || "")}"` + (title ? ` title="${title}"` : "") + `>${insideLink(body)}</a>`;
    };
    return marked.parse(richMarkdown(text), {
      async: false,
      gfm: true,
      breaks: true,
      mangle: false,
      renderer
    });
  } catch {
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}
function renderInlineMarkdown(text) {
  if (!text) {
    return "";
  }
  try {
    const renderer = new marked.Renderer();
    renderer.html = (html) => escapeHtml(html);
    renderer.link = (_href, _title, body) => body;
    renderer.image = (href, _title, alt) => {
      const written = (alt || "").replace(/\s+/g, " ").trim();
      return written || escapeHtml(imageFileName(href || ""));
    };
    return marked.parseInline(text, { async: false, gfm: true, mangle: false, renderer });
  } catch {
    return escapeHtml(text);
  }
}
export {
  VISUALIZATION_SCHEME,
  hasImageReference,
  imageFileFor,
  imagePathFor,
  linkTargetIsImage,
  readableRichText,
  renderInlineMarkdown,
  renderRichMarkdown,
  richMarkdown,
  visualizationPath,
  withoutRichContent
};
