// Befehlspalette: ⌘K bzw. Strg K öffnet eine Suche über Projekte, Aktionen und nicht geklonte Repositories.
// Die Einträge liefert app.js über `items()`, hier liegen nur Darstellung, Suche und Tastatursteuerung.
export function createPalette({ items, escapeHtml: esc, onOpen }) {
  const dialog = document.querySelector("#palette");
  const input = document.querySelector("#palette-input");
  const list = document.querySelector("#palette-list");
  let results = [];
  let active = 0;

  const fold = (value) => String(value ?? "").toLocaleLowerCase("de").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");

  // Jedes Suchwort muss vorkommen. Treffer am Anfang des Titels oder eines Wortes stehen weiter oben.
  function score(item, words) {
    if (!words.length) return item.rank ?? 0;
    const label = fold(item.label);
    const haystack = `${label} ${fold(item.hint)} ${fold(item.keywords)}`;
    let total = 0;
    for (const word of words) {
      const index = haystack.indexOf(word);
      if (index < 0) return -1;
      if (label.startsWith(word)) total += 30;
      else if (label.includes(` ${word}`) || label.includes(`-${word}`)) total += 18;
      else if (label.includes(word)) total += 10;
      else total += 2;
    }
    return total + (item.rank ?? 0);
  }

  function highlight(text, words) {
    const source = String(text);
    const folded = fold(source);
    const marks = new Array(source.length).fill(false);
    for (const word of words) {
      let index = folded.indexOf(word);
      while (index >= 0 && word) { for (let i = index; i < index + word.length && i < marks.length; i += 1) marks[i] = true; index = folded.indexOf(word, index + word.length); }
    }
    let html = "";
    let open = false;
    for (let i = 0; i < source.length; i += 1) {
      if (marks[i] && !open) { html += "<mark>"; open = true; }
      if (!marks[i] && open) { html += "</mark>"; open = false; }
      html += esc(source[i]);
    }
    return html + (open ? "</mark>" : "");
  }

  function render() {
    const words = fold(input.value).split(/\s+/).filter(Boolean);
    const groups = ["Projekte", "Befehle", "Von GitHub klonen"];
    results = items()
      .map((item) => ({ item, value: score(item, words) }))
      .filter(({ value }) => value >= 0)
      .sort((a, b) => groups.indexOf(a.item.group) - groups.indexOf(b.item.group) || b.value - a.value)
      .slice(0, 40)
      .map(({ item }) => item);
    if (active >= results.length) active = Math.max(0, results.length - 1);
    if (!results.length) {
      list.innerHTML = `<p class="wb-palette-empty">Nichts gefunden für „${esc(input.value.trim())}“.</p>`;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    let group = "";
    list.innerHTML = results.map((item, index) => {
      const heading = item.group !== group ? `<p class="wb-palette-group" role="presentation">${esc((group = item.group))}</p>` : "";
      return `${heading}<button type="button" class="wb-palette-item ${index === active ? "active" : ""}" id="palette-item-${index}" role="option" aria-selected="${index === active}" data-palette-index="${index}" tabindex="-1">
        <i class="fa-solid fa-${esc(item.icon)}" aria-hidden="true"></i><span>${highlight(item.label, words)}</span>${item.hint ? `<small>${esc(item.hint)}</small>` : ""}</button>`;
    }).join("");
    input.setAttribute("aria-activedescendant", `palette-item-${active}`);
    list.querySelector(".wb-palette-item.active")?.scrollIntoView({ block: "nearest" });
  }

  function move(step) {
    if (!results.length) return;
    active = (active + step + results.length) % results.length;
    render();
  }

  function execute(index, modifier = null) {
    const item = results[index];
    if (!item) return;
    const action = modifier === "editor" ? item.editor : modifier === "browser" ? item.browser : item.run;
    if (!action) return;
    dialog.close();
    action();
  }

  function open(query = "") {
    input.value = query;
    active = 0;
    onOpen?.();
    render();
    if (!dialog.open) dialog.showModal();
    input.focus();
    input.select();
  }

  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); move(-1); return; }
    if (event.key === "Enter") {
      event.preventDefault();
      execute(active, event.metaKey || event.ctrlKey ? "editor" : event.altKey ? "browser" : null);
    }
  });
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-palette-index]");
    if (button) execute(Number(button.dataset.paletteIndex));
  });
  list.addEventListener("mousemove", (event) => {
    const button = event.target.closest("[data-palette-index]");
    if (!button || Number(button.dataset.paletteIndex) === active) return;
    active = Number(button.dataset.paletteIndex);
    list.querySelectorAll(".wb-palette-item").forEach((node, index) => { node.classList.toggle("active", index === active); node.setAttribute("aria-selected", String(index === active)); });
    input.setAttribute("aria-activedescendant", `palette-item-${active}`);
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });

  return { open, refresh: () => { if (dialog.open) render(); }, get isOpen() { return dialog.open; } };
}
