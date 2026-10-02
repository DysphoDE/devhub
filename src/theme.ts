// Dunkles Thema, abgeleitet aus den vorhandenen Stylesheets.
//
// Die Oberfläche enthält über tausend fest eingetragene Farben. Statt ein zweites Stylesheet von Hand zu
// pflegen, liest DevHub die hellen Stylesheets, übernimmt jede Regel mit Farbangaben und rechnet die Farben
// im OKLCH-Raum um: helle Flächen werden dunkel, dunkle Schrift wird hell, Farbton und Sättigung bleiben.
// Bereits dunkle Flächen (Seitenleiste, Git-Kopf) und helle Schrift auf dunklem Grund bleiben unverändert.
//
// Jede Kopie steht hinter `:where(html[data-theme="dark"])`. `:where` hat keine Spezifität, die Kopien
// behalten also die Rangfolge der Originale untereinander und gewinnen nur, weil sie später kommen.
// Eigenschaften mit Kurzschreibweise (border, background, outline) werden als reine Farb-Langform
// übernommen, damit die Kopie keine Breiten oder Abstände anderer Regeln überschreibt.
// Design-Tokens (`--name`) werden übersprungen, ihre dunklen Werte stehen von Hand in workbench.css.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

type Node =
  | { type: "rule"; selector: string; body: string }
  | { type: "group"; prelude: string; children: Node[] };

const DARK_SCOPE = ':where(html[data-theme="dark"])';

/* ---------- Farbumrechnung ---------- */

interface Rgba { r: number; g: number; b: number; a: number }

function parseColor(token: string): Rgba | null {
  const value = token.trim().toLowerCase();
  if (value === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (value === "black") return { r: 0, g: 0, b: 0, a: 1 };
  const hex = value.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let digits = hex[1];
    if (![3, 4, 6, 8].includes(digits.length)) return null;
    if (digits.length <= 4) digits = digits.split("").map((digit) => digit + digit).join("");
    const number = (offset: number) => parseInt(digits.slice(offset, offset + 2), 16);
    return { r: number(0), g: number(2), b: number(4), a: digits.length === 8 ? number(6) / 255 : 1 };
  }
  const rgb = value.match(/^rgba?\((.*)\)$/);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part: string) => part.endsWith("%") ? parseFloat(part) * 2.55 : parseFloat(part);
    const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    if ([parts[0], parts[1], parts[2]].some((part) => Number.isNaN(channel(part)))) return null;
    return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: Number.isNaN(alpha) ? 1 : alpha };
  }
  return null;
}

const toLinear = (channel: number) => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const fromLinear = (channel: number) => { const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055; return c * 255; };

function rgbToOklch({ r, g, b }: Rgba): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function oklchToRgb(L: number, C: number, H: number): [number, number, number] | null {
  const A = C * Math.cos(H); const B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ];
  if (rgb.some((channel) => channel < -0.0005 || channel > 1.0005)) return null;
  return rgb.map((channel) => Math.min(255, Math.max(0, fromLinear(Math.min(1, Math.max(0, channel)))))) as [number, number, number];
}

// Außerhalb von sRGB wird die Sättigung reduziert, bis die Farbe darstellbar ist.
function inGamut(L: number, C: number, H: number): [number, number, number] {
  let low = 0; let high = C;
  let best = oklchToRgb(L, 0, H)!;
  if (oklchToRgb(L, C, H)) return oklchToRgb(L, C, H)!;
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2;
    const candidate = oklchToRgb(L, mid, H);
    if (candidate) { best = candidate; low = mid; } else high = mid;
  }
  return best;
}

function formatColor([r, g, b]: [number, number, number], alpha: number): string {
  const hex = (value: number) => Math.round(value).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${alpha < 1 ? hex(alpha * 255) : ""}`;
}

export type ColorRole = "text" | "surface";

/** Rechnet eine helle Farbe in ihr dunkles Gegenstück um. Gibt den Wert unverändert zurück, wenn er schon passt. */
export function darkColor(token: string, role: ColorRole): string {
  const color = parseColor(token);
  if (!color) return token;
  const [L, C, H] = rgbToOklch(color);
  if (role === "text") {
    // Helle Schrift steht schon auf dunklem Grund oder auf farbigen Knöpfen.
    if (L > 0.72) return token;
    return formatColor(inGamut(0.97 - 0.42 * L, C * 1.05, H), color.a);
  }
  // Dunkle oder kräftige Flächen bleiben, ebenso zarte weiße Überlagerungen auf dunklem Grund.
  if (L < 0.6 || (color.a < 0.35 && L > 0.9)) return token;
  return formatColor(inGamut(0.19 + (1 - L) * 0.62, C * 0.75, H), color.a);
}

const colorToken = /#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)|(?<![\w-])(?:white|black)(?![\w-])/g;

// Einige dunkle Flächen (Seitenleiste, Toasts, Dialogköpfe) nutzen den Schrift-Token --ink als Hintergrund.
// Im dunklen Thema ist --ink hell, deshalb zeigen Flächen auf eigene Tokens, die dunkel bleiben.
const surfaceTokenAliases: Record<string, string> = { "--ink": "--surface-ink", "--ink-2": "--surface-ink-2" };

export function mapColors(value: string, role: ColorRole): string {
  if (/url\(/i.test(value)) return value;
  const mapped = value.replace(colorToken, (match) => darkColor(match, role));
  if (role !== "surface") return mapped;
  return mapped.replace(/var\((--[\w-]+)/g, (match, name: string) => surfaceTokenAliases[name] ? `var(${surfaceTokenAliases[name]}` : match);
}

/* ---------- CSS lesen ---------- */

function skipString(source: string, index: number): number {
  const quote = source[index];
  let i = index + 1;
  while (i < source.length && source[i] !== quote) i += source[i] === "\\" ? 2 : 1;
  return i;
}

function stripComments(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"' || char === "'") { const end = skipString(source, i); out += source.slice(i, end + 1); i = end; continue; }
    if (char === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 1; continue; }
    out += char;
  }
  return out;
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"' || char === "'") { i = skipString(source, i); continue; }
    if (char === "{") depth += 1;
    else if (char === "}") { depth -= 1; if (depth === 0) return i; }
  }
  return source.length;
}

function parseNodes(source: string, start: number, end: number): Node[] {
  const nodes: Node[] = [];
  let i = start;
  while (i < end) {
    let j = i; let paren = 0;
    while (j < end) {
      const char = source[j];
      if (char === '"' || char === "'") { j = skipString(source, j) + 1; continue; }
      if (char === "(") paren += 1;
      else if (char === ")") paren -= 1;
      else if (paren === 0 && (char === "{" || char === ";" || char === "}")) break;
      j += 1;
    }
    if (j >= end) break;
    if (source[j] !== "{") { i = j + 1; continue; }
    const prelude = source.slice(i, j).trim();
    const close = matchingBrace(source, j);
    if (prelude.startsWith("@")) {
      const name = prelude.slice(1).split(/[\s(]/)[0].toLowerCase();
      if (["media", "supports", "container", "layer"].includes(name)) nodes.push({ type: "group", prelude, children: parseNodes(source, j + 1, close) });
    } else if (prelude) {
      nodes.push({ type: "rule", selector: prelude, body: source.slice(j + 1, close) });
    }
    i = close + 1;
  }
  return nodes;
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0; let current = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '"' || char === "'") { const end = skipString(value, i); current += value.slice(i, end + 1); i = end; continue; }
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (depth === 0 && char === separator) { parts.push(current); current = ""; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/* ---------- Regeln übertragen ---------- */

const textProperties = new Set(["color", "fill", "stroke", "caret-color", "text-decoration-color", "-webkit-text-fill-color", "accent-color", "column-rule-color"]);
const directSurfaceProperties = new Set(["background-color", "background-image", "border-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-block-color", "border-inline-color", "border-block-start-color", "border-block-end-color", "border-inline-start-color", "border-inline-end-color",
  "outline-color", "box-shadow", "text-shadow", "scrollbar-color"]);
const borderShorthand = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
const isColorWord = (token: string) => /^(#[0-9a-f]{3,8}|rgba?\(.*\)|hsla?\(.*\)|color-mix\(.*\)|var\(.*\)|white|black|transparent|currentcolor)$/i.test(token);

function shorthandColor(value: string): string | null {
  const tokens = splitTopLevel(value.replace(/!important/i, "").trim(), " ").map((token) => token.trim()).filter(Boolean);
  return tokens.find(isColorWord) ?? null;
}

function darkDeclarations(body: string): string[] {
  const out: string[] = [];
  for (const raw of splitTopLevel(body, ";")) {
    const colon = raw.indexOf(":");
    if (colon < 0) continue;
    const property = raw.slice(0, colon).trim().toLowerCase();
    let value = raw.slice(colon + 1).trim();
    if (!property || property.startsWith("--") || !value) continue;
    const important = /!important\s*$/i.test(value);
    value = value.replace(/\s*!important\s*$/i, "");
    const suffix = important ? " !important" : "";
    if (textProperties.has(property)) out.push(`${property}: ${mapColors(value, "text")}${suffix}`);
    else if (directSurfaceProperties.has(property)) out.push(`${property}: ${mapColors(value, "surface")}${suffix}`);
    else if (borderShorthand.test(property)) out.push(`${property}-color: ${mapColors(shorthandColor(value) ?? "currentcolor", "surface")}${suffix}`);
    else if (property === "outline") out.push(`outline-color: ${mapColors(shorthandColor(value) ?? "currentcolor", "surface")}${suffix}`);
    else if (property === "text-decoration") out.push(`text-decoration-color: ${mapColors(shorthandColor(value) ?? "currentcolor", "text")}${suffix}`);
    else if (property === "column-rule") out.push(`column-rule-color: ${mapColors(shorthandColor(value) ?? "currentcolor", "text")}${suffix}`);
    else if (property === "background") {
      if (/url\(/i.test(value)) continue;
      const gradient = splitTopLevel(value, ",").length > 1 || /gradient\(/i.test(value);
      if (gradient) { out.push(`background-image: ${mapColors(value, "surface")}${suffix}`); continue; }
      const color = shorthandColor(value);
      out.push(`background-color: ${mapColors(color ?? "transparent", "surface")}${suffix}`);
      out.push(`background-image: none${suffix}`);
    }
  }
  return out;
}

export function darkSelector(selectorList: string): string {
  return splitTopLevel(selectorList, ",").map((selector) => {
    const trimmed = selector.trim();
    if (/^(:root|html)(?![\w-])/.test(trimmed)) return trimmed.replace(/^(:root|html)/, 'html[data-theme="dark"]');
    return `${DARK_SCOPE} ${trimmed}`;
  }).join(", ");
}

function renderNodes(nodes: Node[], indent = ""): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "group") {
      const inner = renderNodes(node.children, `${indent}  `);
      if (inner) out += `${indent}${node.prelude} {\n${inner}${indent}}\n`;
      continue;
    }
    // Scrollbalken-Pseudoelemente und Regeln, die schon für ein Thema geschrieben sind, bleiben außen vor.
    if (/::?-webkit-scrollbar|::-moz-|data-theme/.test(node.selector)) continue;
    const declarations = darkDeclarations(node.body);
    if (declarations.length) out += `${indent}${darkSelector(node.selector)} { ${declarations.join("; ")}; }\n`;
  }
  return out;
}

/** Erzeugt das dunkle Stylesheet aus CSS-Quelltext. */
export function buildDarkTheme(sources: Array<{ name: string; css: string }>): string {
  let out = "/* Automatisch aus den hellen Stylesheets erzeugt (src/theme.ts). Nicht von Hand bearbeiten. */\n";
  for (const { name, css } of sources) {
    const clean = stripComments(css);
    out += `\n/* ${name} */\n${renderNodes(parseNodes(clean, 0, clean.length))}`;
  }
  return out;
}

/* ---------- Ausliefern mit Zwischenspeicher ---------- */

export const themeSourceFiles = ["styles.css", "git-workspace.css", "design-system.css", "workbench.css"];
let cached: { key: string; css: string } | null = null;

export async function darkThemeStylesheet(publicDirectory: string): Promise<string> {
  const files = themeSourceFiles.map((file) => path.join(publicDirectory, file));
  const stamps = await Promise.all(files.map(async (file) => { try { const info = await stat(file); return `${file}:${info.mtimeMs}:${info.size}`; } catch { return `${file}:missing`; } }));
  const key = stamps.join("|");
  if (cached?.key === key) return cached.css;
  const sources = await Promise.all(files.map(async (file) => ({ name: path.basename(file), css: await readFile(file, "utf8").catch(() => "") })));
  cached = { key, css: buildDarkTheme(sources) };
  return cached.css;
}
