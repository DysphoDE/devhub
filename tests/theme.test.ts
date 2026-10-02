import assert from "node:assert/strict";
import test from "node:test";
import { buildDarkTheme, darkColor, darkSelector, mapColors } from "../src/theme.js";

const lightness = (hex: string) => {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test("macht helle Flächen dunkel und dunkle Schrift hell", () => {
  assert.ok(lightness(darkColor("#ffffff", "surface")) < 0.05, "Weiß wird zur dunklen Fläche");
  assert.ok(lightness(darkColor("#17202c", "text")) > 0.6, "dunkle Schrift wird hell");
  const muted = lightness(darkColor("#667583", "text"));
  const ink = lightness(darkColor("#17202c", "text"));
  assert.ok(muted < ink, "die Abstufung zwischen Haupt- und Nebenschrift bleibt erhalten");
});

test("lässt dunkle Flächen, helle Schrift und Überlagerungen unverändert", () => {
  assert.equal(darkColor("#182234", "surface"), "#182234", "Seitenleiste bleibt");
  assert.equal(darkColor("#315bf5", "surface"), "#315bf5", "kräftige Knopffarbe bleibt");
  assert.equal(darkColor("white", "text"), "white", "weiße Schrift auf Knöpfen bleibt");
  assert.equal(darkColor("#ffffff0d", "surface"), "#ffffff0d", "zarte Überlagerung bleibt");
  assert.equal(darkColor("transparent", "surface"), "transparent");
  assert.equal(darkColor("var(--surface)", "surface"), "var(--surface)");
});

test("erhält Transparenz und ersetzt nur echte Farbwörter", () => {
  assert.match(darkColor("rgba(255, 255, 255, .7)", "surface"), /^#[0-9a-f]{6}b3$/);
  assert.equal(mapColors("nowrap white-space", "text"), "nowrap white-space");
  assert.match(mapColors("0 0 0 1px #dbe1e5, 0 4px 8px rgba(0,0,0,.2)", "surface"), /^0 0 0 1px #[0-9a-f]{6}, 0 4px 8px rgba\(0,0,0,\.2\)$/);
});

test("setzt Selektoren hinter den dunklen Bereich, ohne Spezifität hinzuzufügen", () => {
  assert.equal(darkSelector(".card h2, .card:hover"), ':where(html[data-theme="dark"]) .card h2, :where(html[data-theme="dark"]) .card:hover');
  assert.equal(darkSelector(":root"), 'html[data-theme="dark"]');
  assert.equal(darkSelector("html body"), 'html[data-theme="dark"] body');
  assert.equal(darkSelector(".a:is(.b, .c)"), ':where(html[data-theme="dark"]) .a:is(.b, .c)');
});

test("überträgt Kurzschreibweisen nur als Farb-Langform", () => {
  const css = buildDarkTheme([{ name: "probe.css", css: `
    :root { --surface: #fff; }
    .box { padding: 4px; border: 1px solid #dbe1e5; background: #fff; color: #17202c; outline: 0; }
    .ghost { background: none; border: 0; }
    .tone { border-left: 3px solid var(--signal); background: linear-gradient(#fff, #eef1f4); }
    .plain { margin: 0; display: grid; }
    @media (max-width: 600px) { .box { color: #667583 !important; } }
    @keyframes spin { to { color: #000; } }
    @font-face { font-family: "X"; src: url("x.woff2"); }
  ` }]);
  assert.doesNotMatch(css, /--surface/, "Tokens bleiben den handgeschriebenen Werten überlassen");
  assert.doesNotMatch(css, /padding|margin|display|1px solid/, "keine Maße oder Layout-Angaben");
  assert.match(css, /\.box \{ border-color: #[0-9a-f]{6}; background-color: #[0-9a-f]{6}; background-image: none; color: #[0-9a-f]{6}; outline-color: currentcolor; \}/);
  assert.match(css, /\.ghost \{ background-color: transparent; background-image: none; border-color: currentcolor; \}/);
  assert.match(css, /\.tone \{ border-left-color: var\(--signal\); background-image: linear-gradient\(#[0-9a-f]{6}, #[0-9a-f]{6}\); \}/);
  assert.doesNotMatch(css, /\.plain/, "Regeln ohne Farben entfallen");
  assert.match(css, /@media \(max-width: 600px\) \{\n {2}:where\(html\[data-theme="dark"\]\) \.box \{ color: #[0-9a-f]{6} !important; \}/);
  assert.doesNotMatch(css, /spin|font-face|woff2/, "Keyframes und Schriften werden nicht kopiert");
});

test("hält Flächen dunkel, die den Schrift-Token --ink als Hintergrund nutzen", () => {
  assert.equal(mapColors("var(--ink)", "surface"), "var(--surface-ink)");
  assert.equal(mapColors("var(--ink-2)", "surface"), "var(--surface-ink-2)");
  assert.equal(mapColors("var(--ink)", "text"), "var(--ink)", "als Schriftfarbe bleibt --ink");
  assert.equal(mapColors("var(--ink-soft)", "surface"), "var(--ink-soft)", "nur exakt diese Tokens");
});
