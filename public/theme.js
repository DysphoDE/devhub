// Setzt das Farbthema, bevor die Seite gezeichnet wird, damit beim Laden nichts hell aufblitzt.
// „System“ folgt der Einstellung des Betriebssystems und wechselt mit ihr.
(() => {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const read = () => { try { return localStorage.getItem("devhub_theme") || "system"; } catch { return "system"; } };
  const apply = (choice = read()) => {
    const dark = choice === "dark" || (choice !== "light" && media.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.themeChoice = choice;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b111a" : "#17202c");
  };
  apply();
  media.addEventListener("change", () => { if (read() === "system") apply(); });
  window.devhubTheme = {
    get: read,
    set(choice) {
      try { localStorage.setItem("devhub_theme", choice); } catch { /* ohne Speicher gilt die Wahl nur bis zum Neuladen */ }
      apply(choice);
      window.dispatchEvent(new CustomEvent("devhub-theme", { detail: choice }));
    }
  };
})();
