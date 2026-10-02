import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { composedScripts, portFromCommand, scanWorkspace } from "../src/scanner.js";
import type { AppConfig } from "../src/types.js";

function testConfig(root: string): AppConfig {
  return {
    host: "127.0.0.1", publicHost: "devhub", publicUrl: null, autostartMode: "dev", port: 7331, scanRoot: root,
    categoryDepth: 1, maxDepth: 5, maxEntriesPerProject: 5000,
    ignore: ["node_modules", ".git", "dist", "build"], stack: "none",
    laragonRoot: path.join(root, "no-laragon"), herdRoot: path.join(root, "no-herd"), editor: "auto", terminal: "auto"
  };
}

const isWindows = process.platform === "win32";

test("findet Package-Scripts und Startdateien der eigenen Plattform rekursiv", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-scan-"));
  try {
    const project = path.join(root, "Kundenportal");
    const frontend = path.join(project, "apps", "frontend");
    await mkdir(frontend, { recursive: true });
    await writeFile(path.join(project, "project.ini"), 'title = "Kundenportal Next"\ndescription = "Testprojekt"\n');
    await writeFile(path.join(frontend, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.0.0",
      scripts: { dev: "vite", build: "vite build", "dev:mock": "vite --mode mock" }
    }));
    // Beide Startdateien liegen im Projekt, sichtbar wird nur die zur laufenden Plattform passende.
    await writeFile(path.join(project, "start.bat"), "@echo off\r\n");
    await writeFile(path.join(project, "start.sh"), "#!/bin/sh\necho dev\n");
    await mkdir(path.join(project, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(project, "node_modules", "ignored", "package.json"), JSON.stringify({ scripts: { dev: "ignored" } }));

    const config = testConfig(root);
    const projects = await scanWorkspace(config, path.join(root, "devhub-node"));

    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, "Kundenportal Next");
    assert.equal(projects[0].description, "Testprojekt");
    assert.equal(projects[0].descriptionAuto, false);
    assert.deepEqual(projects[0].launchers.map((launcher) => launcher.command), [
      "pnpm run dev",
      "pnpm run dev:mock",
      isWindows ? '"start.bat"' : 'sh "start.sh"'
    ]);
    const starter = projects[0].launchers.find((launcher) => launcher.kind !== "package-script")!;
    assert.equal(starter.kind, isWindows ? "batch" : "shell");
    if (!isWindows) assert.equal(starter.executable, "/bin/sh");
    assert.equal(projects[0].launchers.filter((launcher) => launcher.kind === "package-script").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignoriert versteckte und unterstrichene Projektordner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-ignore-"));
  try {
    for (const name of [".cache", "_intern", "$system"]) {
      await mkdir(path.join(root, name), { recursive: true });
      await writeFile(path.join(root, name, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    }
    const config = { ...testConfig(root), ignore: [] };
    assert.deepEqual(await scanWorkspace(config, path.join(root, "devhub-node")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listet DevHub selbst ohne konkurrierende Startaktionen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-self-"));
  try {
    const appPath = path.join(root, "DevHub");
    const projectPath = path.join(root, "Kundenportal");
    await mkdir(appPath, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(path.join(appPath, "package.json"), JSON.stringify({ scripts: { dev: "tsx watch src/server.ts" } }));
    await writeFile(path.join(projectPath, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));

    const projects = await scanWorkspace(testConfig(root), appPath);
    assert.deepEqual(projects.map((project) => project.relativePath), ["DevHub", "Kundenportal"]);
    assert.deepEqual(projects.find((project) => project.relativePath === "DevHub")?.launchers, []);
    assert.equal(projects.find((project) => project.relativePath === "DevHub")?.isSelf, true);
    assert.equal(projects.find((project) => project.relativePath === "Kundenportal")?.isSelf, false);
    assert.equal(projects.find((project) => project.relativePath === "Kundenportal")?.launchers.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("erkennt reine HTML- und PHP-Projekte mit abgeleiteten Metadaten", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-web-"));
  try {
    const htmlProject = path.join(root, "landing-page");
    const phpProject = path.join(root, "kunden-api");
    await mkdir(htmlProject, { recursive: true });
    await mkdir(path.join(phpProject, "public"), { recursive: true });
    await writeFile(path.join(htmlProject, "README.md"), "# Nordlicht Studio\n\nEine handgefertigte Portfolio-Website für ein kleines Designstudio.\n");
    await writeFile(path.join(htmlProject, "index.html"), '<!doctype html><title>Nordlicht Studio</title><meta name="description" content="Portfolio und Projekte aus Hamburg.">');
    await writeFile(path.join(phpProject, "composer.json"), JSON.stringify({ name: "acme/kunden-api", description: "API für das Kundenportal", require: { "laravel/framework": "^12" } }));
    await writeFile(path.join(phpProject, "public", "index.php"), "<?php echo 'ok';");

    const projects = await scanWorkspace(testConfig(root), path.join(root, "devhub-node"));
    assert.equal(projects.length, 2);
    const html = projects.find((project) => project.relativePath === "landing-page")!;
    const php = projects.find((project) => project.relativePath === "kunden-api")!;
    assert.equal(html.name, "Nordlicht Studio");
    assert.equal(html.description, "Portfolio und Projekte aus Hamburg.");
    assert.ok(html.technologies.includes("HTML"));
    assert.equal(html.launchers[0].kind, "static-server");
    assert.equal(php.description, "API für das Kundenportal");
    assert.ok(php.technologies.includes("Laravel"));
    assert.equal(php.launchers.at(-1)?.kind, "php-server");
    assert.equal(php.launchers.at(-1)?.executable, isWindows ? "php.exe" : "php");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("liest Projekte aus Kategorieordnern ein und behält Projekte direkt im Workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-category-"));
  try {
    await mkdir(path.join(root, "games", "ante-up"), { recursive: true });
    await mkdir(path.join(root, "games", "chromaring"), { recursive: true });
    await mkdir(path.join(root, "clients", "ikigai", "website"), { recursive: true });
    await mkdir(path.join(root, "pizza-rezept"), { recursive: true });
    await writeFile(path.join(root, "games", "ante-up", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    await writeFile(path.join(root, "games", "chromaring", "index.html"), "<!doctype html><title>Chromaring</title>");
    await writeFile(path.join(root, "clients", "ikigai", "website", "package.json"), JSON.stringify({ scripts: { dev: "astro dev" } }));
    await writeFile(path.join(root, "pizza-rezept", "index.html"), "<!doctype html><title>Pizza</title>");

    const projects = await scanWorkspace(testConfig(root), path.join(root, "devhub"));
    const byPath = new Map(projects.map((project) => [project.relativePath, project]));

    assert.deepEqual([...byPath.keys()].sort(), ["clients/ikigai", "games/ante-up", "games/chromaring", "pizza-rezept"]);
    assert.equal(byPath.get("games/ante-up")?.category, "Games");
    assert.equal(byPath.get("games/ante-up")?.categoryPath, "games");
    assert.equal(byPath.get("pizza-rezept")?.category, null);
    assert.equal(byPath.get("pizza-rezept")?.categoryPath, null);
    // Kunden bündeln mehrere Ordner, bleiben bei categoryDepth 1 aber ein Projekt mit verschachtelten Startern.
    assert.equal(byPath.get("clients/ikigai")?.category, "Clients");
    assert.equal(byPath.get("clients/ikigai")?.launchers.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("behandelt Ordner mit eigenen Projektspuren trotz Unterordnern als Projekt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-monorepo-"));
  try {
    await mkdir(path.join(root, "monorepo", "apps", "web"), { recursive: true });
    await writeFile(path.join(root, "monorepo", "package.json"), JSON.stringify({ scripts: { dev: "turbo dev" } }));
    await writeFile(path.join(root, "monorepo", "apps", "web", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));

    const projects = await scanWorkspace(testConfig(root), path.join(root, "devhub"));
    assert.deepEqual(projects.map((project) => project.relativePath), ["monorepo"]);
    assert.equal(projects[0].category, null);
    assert.equal(projects[0].launchers.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("liest mit categoryDepth 0 wieder flach ein", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-flat-"));
  try {
    await mkdir(path.join(root, "games", "ante-up"), { recursive: true });
    await writeFile(path.join(root, "games", "ante-up", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));

    const projects = await scanWorkspace({ ...testConfig(root), categoryDepth: 0 }, path.join(root, "devhub"));
    assert.deepEqual(projects.map((project) => project.relativePath), ["games"]);
    assert.equal(projects[0].category, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verlinkt Projekte unterhalb des Apache-DocumentRoot direkt über localhost", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-docroot-"));
  try {
    const laragonRoot = path.join(root, "laragon");
    await mkdir(path.join(laragonRoot, "usr"), { recursive: true });
    await writeFile(path.join(laragonRoot, "usr", "laragon.ini"), `[apache]\nDocumentRoot=${root}\n`);
    await mkdir(path.join(root, "fun", "eis-guide"), { recursive: true });
    await mkdir(path.join(root, "projects", "shop", "public"), { recursive: true });
    await mkdir(path.join(root, "projects", "spa"), { recursive: true });
    await mkdir(path.join(root, "clients", "kunde", "website", "public", "admin"), { recursive: true });
    await mkdir(path.join(root, "fun", "eis-guide", "bildgenerator"), { recursive: true });
    await writeFile(path.join(root, "clients", "kunde", "website", "public", "index.html"), "<!doctype html><title>Kunde</title>");
    await writeFile(path.join(root, "clients", "kunde", "website", "public", "admin", "index.php"), "<?php echo 'admin';");
    await writeFile(path.join(root, "fun", "eis-guide", "index.html"), "<!doctype html><title>Eis</title>");
    await writeFile(path.join(root, "fun", "eis-guide", "bildgenerator", "index.php"), "<?php echo 'tool';");
    await writeFile(path.join(root, "projects", "shop", "public", "index.php"), "<?php echo 'ok';");
    await writeFile(path.join(root, "projects", "spa", "index.html"), '<!doctype html><script type="module" src="/src/main.tsx"></script>');
    await writeFile(path.join(root, "projects", "spa", "package.json"), JSON.stringify({ dependencies: { vite: "^7" }, scripts: { dev: "vite" } }));

    const projects = await scanWorkspace({ ...testConfig(root), stack: "laragon", laragonRoot }, path.join(root, "devhub"));
    const byPath = new Map(projects.map((project) => [project.relativePath, project]));

    // Ein tiefer liegendes Unterwerkzeug darf die Startseite des Projekts nicht verdrängen.
    assert.equal(byPath.get("fun/eis-guide")?.defaultUrl, "http://localhost/fun/eis-guide/");
    // Laravel-Layout: Apache muss auf das öffentliche Verzeichnis zeigen, nicht auf die Projektwurzel.
    assert.equal(byPath.get("projects/shop")?.defaultUrl, "http://localhost/projects/shop/public/");
    // Vite-Projekte brauchen ihren Dev-Server, die rohe index.html wäre im Browser unbrauchbar.
    assert.equal(byPath.get("projects/spa")?.defaultUrl, null);
    // Ein tiefes admin/index.php darf die flachere Startseite nicht überstimmen.
    assert.equal(byPath.get("clients/kunde")?.defaultUrl, "http://localhost/clients/kunde/website/public/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zeigt Projektordner ohne Manifest, sobald irgendwo darunter Code liegt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-folder-"));
  try {
    await mkdir(path.join(root, "Konzeptentwürfe", "src"), { recursive: true });
    await writeFile(path.join(root, "Konzeptentwürfe", "src", "prototyp.js"), "console.log('hi');\n");
    const projects = await scanWorkspace(testConfig(root), path.join(root, "devhub-node"));
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, "Konzeptentwürfe");
    // Der Unterordner "src" gehört zum Projekt und wird nie selbst eines.
    assert.equal(projects[0].relativePath, "Konzeptentwürfe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("überspringt Ordner, die nur Dokumente statt Code enthalten", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-docs-"));
  try {
    const client = path.join(root, "clients", "bernd-stapfner");
    await mkdir(path.join(client, "uebergabe", "fonts"), { recursive: true });
    await mkdir(path.join(client, "resources"), { recursive: true });
    await mkdir(path.join(client, "website"), { recursive: true });
    await writeFile(path.join(client, "uebergabe", "01-uebergabe.html"), "<h1>Übergabe</h1>");
    await writeFile(path.join(client, "uebergabe", "doku.css"), "body { color: #111; }");
    await writeFile(path.join(client, "uebergabe", "01-uebergabe.pdf"), "%PDF-1.7");
    await writeFile(path.join(client, "uebergabe", "fonts", "inter.woff2"), "font");
    await writeFile(path.join(client, "resources", "BS-1628.jpeg"), "jpeg");
    await writeFile(path.join(client, "website", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));

    const projects = await scanWorkspace({ ...testConfig(root), categoryDepth: 3 }, path.join(root, "devhub"));
    assert.deepEqual(projects.map((project) => project.relativePath), ["clients/bernd-stapfner/website"]);
    // Der Kundenordner wird zur Kategorie, der generische Ordnername erbt seinen Namen.
    assert.equal(projects[0].category, "Clients / Bernd Stapfner");
    assert.equal(projects[0].categoryPath, "clients/bernd-stapfner");
    assert.equal(projects[0].name, "Bernd Stapfner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignoriert Virtual Hosts, deren DocumentRoot nichts ausliefern kann", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-vhost-"));
  try {
    const laragonRoot = path.join(root, "laragon");
    const sites = path.join(laragonRoot, "etc", "apache2", "sites-enabled");
    await mkdir(sites, { recursive: true });
    await mkdir(path.join(laragonRoot, "usr"), { recursive: true });
    await writeFile(path.join(laragonRoot, "usr", "laragon.ini"), "[apache]\nDocumentRoot=C:\\nirgendwo\n");

    // Next.js: public/ existiert, enthält aber keinen Einstiegspunkt.
    await mkdir(path.join(root, "projects", "nerdbattle", "public"), { recursive: true });
    await writeFile(path.join(root, "projects", "nerdbattle", "package.json"), JSON.stringify({ scripts: { dev: "next dev" } }));
    // Vite: rohe index.html neben dem Manifest, im Browser unbrauchbar.
    await mkdir(path.join(root, "projects", "ante-up", "src"), { recursive: true });
    await writeFile(path.join(root, "projects", "ante-up", "index.html"), '<script type="module" src="/src/main.jsx"></script>');
    await writeFile(path.join(root, "projects", "ante-up", "src", "main.jsx"), "export default null;");
    await writeFile(path.join(root, "projects", "ante-up", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    // Fertiger Build: index.html ohne Manifest daneben.
    await mkdir(path.join(root, "clients", "kunde", "website", "dist"), { recursive: true });
    await writeFile(path.join(root, "clients", "kunde", "website", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    await writeFile(path.join(root, "clients", "kunde", "website", "dist", "index.html"), "<!doctype html><title>Kunde</title>");

    for (const [name, documentRoot] of [
      ["nerdbattle", path.join(root, "projects", "nerdbattle", "public")],
      ["ante-up", path.join(root, "projects", "ante-up")],
      ["kunde", path.join(root, "clients", "kunde", "website", "dist")]
    ] as const) {
      await writeFile(path.join(sites, `nested.${name}.test.conf`),
        `<VirtualHost *:80>\n  DocumentRoot "${documentRoot.split(path.sep).join("/")}"\n  ServerName ${name}.test\n</VirtualHost>\n`);
    }

    const projects = await scanWorkspace({ ...testConfig(root), categoryDepth: 3, stack: "laragon", laragonRoot }, path.join(root, "devhub"));
    const byPath = new Map(projects.map((project) => [project.relativePath, project]));

    assert.equal(byPath.get("projects/nerdbattle")?.defaultUrl, null);
    assert.equal(byPath.get("projects/ante-up")?.defaultUrl, null);
    assert.equal(byPath.get("clients/kunde/website")?.defaultUrl, "http://kunde.test/");

    // Fertiges HTML mit Tailwind-Setup daneben bleibt auslieferbar - nur src/ macht daraus Quellcode.
    await writeFile(path.join(root, "projects", "ante-up", "package.json"), JSON.stringify({ scripts: { build: "tailwindcss" } }));
    await rm(path.join(root, "projects", "ante-up", "src"), { recursive: true, force: true });
    const rescanned = await scanWorkspace({ ...testConfig(root), categoryDepth: 3, stack: "laragon", laragonRoot }, path.join(root, "devhub"));
    assert.equal(rescanned.find((project) => project.relativePath === "projects/ante-up")?.defaultUrl, "http://ante-up.test/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("liest feste Ports aus Startbefehlen", () => {
  assert.equal(portFromCommand("php -S 127.0.0.1:8787 -t ../public ../public/dev-router.php"), 8787);
  assert.equal(portFromCommand("vite --port 5174"), 5174);
  assert.equal(portFromCommand("vite --port=4000 --host"), 4000);
  assert.equal(portFromCommand("next dev -p 3001"), 3001);
  assert.equal(portFromCommand("PORT=8080 node server.js"), 8080);
  assert.equal(portFromCommand("vite"), null);
  assert.equal(portFromCommand("vite --host 127.0.0.1"), null);
});

test("erkennt Teilskripte von concurrently, npm-run-all und run-p", () => {
  const available = ["dev", "dev:php", "dev:php2", "dev:worker", "dev:vite", "build", "watch:css", "watch:js"];
  assert.deepEqual(composedScripts('concurrently --kill-others --names php,vite "npm:dev:php" "npm:dev:vite"', available, "dev"), ["dev:php", "dev:vite"]);
  assert.deepEqual(composedScripts('concurrently "npm:dev:*"', available, "dev"), ["dev:php", "dev:php2", "dev:worker", "dev:vite"]);
  assert.deepEqual(composedScripts('concurrently "npm run watch:css" "pnpm watch:js"', available, "dev"), ["watch:css", "watch:js"]);
  assert.deepEqual(composedScripts("run-p watch:*", available, "dev"), ["watch:css", "watch:js"]);
  assert.deepEqual(composedScripts("npm-run-all --parallel dev:php dev:vite", available, "dev"), ["dev:php", "dev:vite"]);
  assert.deepEqual(composedScripts("vite", available, "dev"), []);
  assert.deepEqual(composedScripts("npm run build && vite", available, "dev"), [], "ohne Sammelwerkzeug ist es kein Sammelskript");
});

test("ordnet die Teile eines Sammelskripts dem Hauptstarter zu", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-composed-"));
  try {
    const frontend = path.join(root, "Bildwerk", "frontend");
    await mkdir(frontend, { recursive: true });
    await writeFile(path.join(frontend, "package.json"), JSON.stringify({
      scripts: {
        dev: 'concurrently --kill-others --names php1,worker,vite "npm:dev:php" "npm:dev:worker" "npm:dev:vite"',
        "dev:php": "php -S 127.0.0.1:8787 -t ../public",
        "dev:worker": "php -S 127.0.0.1:8790 -t ../public",
        "dev:vite": "vite"
      }
    }));
    const projects = await scanWorkspace(testConfig(root), path.join(root, "devhub-node"));
    const launchers = projects[0].launchers;
    const byScript = (script: string) => launchers.find((launcher) => launcher.command === `npm run ${script}`);
    const dev = byScript("dev")!;
    assert.equal(dev.preferred, true);
    assert.equal(dev.parentId, null);
    assert.deepEqual(dev.parts.map((part) => [part.script, part.port]), [["dev:php", 8787], ["dev:worker", 8790], ["dev:vite", null]]);
    for (const part of dev.parts) {
      const child = launchers.find((launcher) => launcher.id === part.launcherId)!;
      assert.equal(child.parentId, dev.id, `${part.script} gehört zu dev`);
      assert.equal(child.preferred, false);
    }
    assert.equal(byScript("dev:php")?.port, 8787);
    assert.equal(projects[0].descriptionAuto, true);
    assert.equal(projects[0].isSelf, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
