# DevHub

DevHub is a local dashboard for finding, opening, running, and maintaining the projects on your development machine. Point it at the folder that contains your repositories and it builds a visual workbench from the files that are already there—no per-project registration required.

DevHub runs on **Windows, macOS, and Linux**. It integrates with the local web stack you already use: [Laragon](https://laragon.org/) on Windows, [Herd](https://herd.laravel.com/) on macOS and Windows, or [Laravel Valet](https://laravel.com/docs/valet) on macOS and Linux.

The server binds to your loopback interface by default. Project paths, Git state, process output, and configuration stay on your computer.

## What it does

- Discovers every project below a workspace folder, several category levels deep.
- Watches the workspace and refreshes projects and Git state live over server-sent events—no manual reload, and unchanged rows are left untouched so the UI never flickers.
- Detects common stacks such as Node.js, React, Vue, Next.js, PHP, Laravel, Symfony, Python, Docker, and static HTML.
- Creates launch actions from `package.json` scripts, `start.sh` (macOS/Linux), `start.bat`/`start.cmd` (Windows), `start.ps1`, static sites, and PHP entry points.
- Recognises composite scripts: a `dev` script that starts other scripts through `concurrently`, `npm-run-all`, `run-p`, or `run-s` appears as one starter with its parts, and fixed ports are read from commands such as `php -S 127.0.0.1:8787` or `vite --port 5174`.
- Starts and stops development processes, assigns free preview ports, and streams their output.
- Shows Git branch, sync state, changed files, diffs, commits, and pushes in one workbench. Changed files are checked by default; uncheck files to exclude them and commit directly.
- Opens projects in the file manager, terminal, or a detected editor on every platform.
- Lists projects as rows with exactly one primary action each (start, open, or stop). Selecting a row opens a detail panel with the last lines of running output, all starters, the local domain, the Git state, and open-in actions; a card view remains available.
- Supports favorites, recently opened projects, technology and category filters, a compact density, a list filter (`/`), and a command palette (`⌘K` on macOS, `Ctrl+K` elsewhere) that searches projects, actions, and GitHub repositories that are not yet in the workspace.
- Offers light, dark, and system appearance. The dark stylesheet is generated at `/theme-dark.css` from the light stylesheets (`src/theme.ts`), so new styles get a dark variant automatically; design tokens have hand-picked dark values in `public/workbench.css`.
- Includes a Git control center modelled on GitHub Desktop: a three-part header (repository, branch, one sync action that always names the sensible next step: fetch, pull, push, publish, or resolve), a guidance strip that explains the current state in one sentence, and two primary tabs (changes, history). When nothing is pending it shows one calm message with the latest commits instead of an empty commit form. Branches switch from a popover whose search field doubles as "create branch"; stashes, tags, remotes and identity live behind a repository menu.
- Changes show status marks (M/A/D/R/!), added and removed line counts per file, folder groups and hover actions; the commit button reports what is missing ("Zusammenfassung fehlt") instead of going grey, and a length meter flags summaries above 50/72 characters. Optional hunk staging, history search and file diffs, branch comparison, merge/rebase with per-file conflict resolution (keep mine / take theirs / editor), pull with rebase or merge for diverged branches, stashes, tags, remotes, local identity, cherry-pick, revert, clone and init are included. File menus can add files or parent folders to `.gitignore`, optionally ending tracking while retaining local files.
- An overview page lists every repository in the workspace with its changes, sync state and last commit, filters by state, and offers "fetch all" and "push all".
- "Repository hinzufügen" lists the repositories of the GitHub account that is signed in to the GitHub CLI (`gh auth login`), including organisations, marks the ones already in the workspace, and clones a selected one through `gh repo clone`, so private repositories work without extra credential setup. Cloning by URL and initialising Git in an existing project remain available.
- Uses a shared typography system in `public/design-system.css`: Inter for the interface, JetBrains Mono for code, 14px body text, 13px controls/code and at least 12px metadata.
- Supports switching and creating branches, undoing the last unpushed commit (changes stay staged), and moving discarded new files to the system trash (Windows Recycle Bin, macOS Trash, Linux via `gio`) instead of deleting them permanently.
- Shows the state of your local stack—Laragon, Herd, or Valet—as a compact indicator in the header, links projects to their local domains (`http://project.test`), and starts, stops, or reloads the web server from its panel. A notice appears only when a project's domain is unreachable because the web server is off.
- Can start silently when you sign in: Task Scheduler on Windows, a LaunchAgent on macOS, a systemd user unit on Linux.

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer
- npm
- Git for repository status and Git actions
- Optional: Laragon (Windows), Herd (macOS/Windows), or Valet (macOS/Linux) for local domains and service controls

## Quick start

```bash
git clone https://github.com/DysphoDE/DevHub.git
cd DevHub
npm install
npm run setup
npm run dev
```

`npm run setup` is the interactive setup assistant. It detects your operating system, local stack, editor, and terminal, asks for the folder that contains your projects, and writes `devhub.config.json`. It can also install the autostart for your platform and, when Herd is present, expose DevHub at `http://devhub.test`. Pass `--yes` to accept every suggestion without prompts.

Open [http://localhost:7331](http://localhost:7331).

Without the assistant, DevHub uses the parent folder of the repository as its workspace. Click the workspace path in the top-left corner to choose a different folder. Windows and macOS offer the native folder picker, Linux uses `zenity` or `kdialog` when installed, and every platform accepts an absolute path (a leading `~` is allowed).

The selection is saved in a local `devhub.config.json` file. That file is ignored by Git, so machine-specific paths are never committed.

> Moving between machines? Do not copy `node_modules` from one operating system to another—run `npm install` again on the new machine, since some dependencies contain platform-specific binaries.

## Workspace layout

Every folder is classified in three steps, which lets projects sit several levels below the workspace root:

1. **Own traces** — a manifest, a `.git` directory, source files, or an `index.html`/`index.php` make the folder a project. Its subfolders belong to it (monorepos stay one project).
2. **Bundles projects** — a folder without traces of its own whose children are projects becomes a category, and the search continues one level deeper.
3. **Code somewhere below** — otherwise the folder is only a project if any source file exists underneath. Folders holding nothing but documents, exports, or images are skipped.

```text
~/Herd/                       (or F:\ on Windows)
├── projects/                ← category
│   ├── customer-portal/     ← project
│   └── docs-site/           ← project
├── clients/                 ← category
│   └── bernd-stapfner/      ← category
│       ├── website/         ← project (named after the client folder)
│       ├── variants/        ← project
│       ├── uebergabe/       ← skipped (PDFs and HTML exports, no code)
│       └── resources/       ← skipped (images)
├── pizza-recipe/            ← project (source files, no category)
└── DevHub/                  ← listed for Git and project actions
```

Loose `.html`, `.css`, or `.md` files do not count as source code — otherwise every documentation folder would show up as a project. Conventional subfolder names (`src`, `public`, `assets`, `docs`, …) never become projects of their own.

Categories appear as filters in the sidebar. Set `categoryDepth` to `0` to disable the grouping and read every direct child as a project again, or lower it to limit how deep categories may nest.

Project metadata and launchers may be discovered recursively within each project. Large dependency and build directories are skipped automatically.

### Browser button

The green *Open in browser* action only appears when a running web server can actually answer. A local domain counts only if its document root holds an `index.php`, or an `index.html` that is not raw source — a bundler config or a `package.json` next to a `src/` directory means the folder still needs a build. Projects that only run through `npm run dev` therefore show their launcher instead of a link that would lead to a directory listing.

When DevHub itself is inside the selected workspace, it remains visible so you can open it and use the Git workbench. Its own launch actions are hidden to prevent starting a second DevHub server on the same port.

## Local stacks

DevHub talks to your local web stack through a small provider model, so the dashboard looks the same everywhere while the commands differ per platform.

| Stack | Platforms | Local domains | Service controls |
| --- | --- | --- | --- |
| Laragon | Windows | Apache virtual hosts (`auto.*.conf`) and paths below the Apache `DocumentRoot` | Start/stop Apache, open Laragon, reload virtual hosts |
| Herd | macOS, Windows | Parked paths and linked sites from Herd's Valet configuration, HTTPS when a certificate exists | `herd start`, `herd stop`, `herd restart`, open Herd |
| Valet | macOS, Linux | Parked paths and linked sites from `~/.config/valet` | `valet start`, `valet stop`, `valet restart` |

Set `stack` to `auto` (default) to pick whatever is installed—Laragon first on Windows, then Herd, then Valet—or force one of `laragon`, `herd`, `valet`, or `none`.

## Production mode

Build and run the compiled server:

```bash
npm run build
npm start
```

The default address is [http://localhost:7331](http://localhost:7331). DevHub only accepts local connections unless remote access is explicitly enabled.

## Configuration

Most users only need `npm run setup` and the workspace control in the UI. For manual changes, copy the example configuration:

```bash
cp devhub.config.example.json devhub.config.json
```

On Windows (PowerShell):

```powershell
Copy-Item devhub.config.example.json devhub.config.json
```

Important options:

| Option | Default | Purpose |
| --- | --- | --- |
| `host` | `127.0.0.1` | Address the local server binds to |
| `publicHost` | `devhub` | Hostname used by the Windows installer and accepted in the `Host` header |
| `publicUrl` | `null` | Address shown in the UI when DevHub is reachable through a proxy such as `http://devhub.test` |
| `port` | `7331` | DevHub HTTP port |
| `scanRoot` | `..` | Workspace containing the project folders (`~` is allowed) |
| `categoryDepth` | `3` | Levels of category folders above the projects (`0` disables grouping) |
| `maxDepth` | `5` | Maximum metadata scan depth per project |
| `maxEntriesPerProject` | `15000` | Safety limit for scanned entries |
| `stack` | `auto` | `auto`, `laragon`, `herd`, `valet`, or `none` |
| `laragonRoot` | `C:\laragon` | Laragon installation directory (Windows) |
| `herdRoot` | platform default | Herd data directory (`~/Library/Application Support/Herd` on macOS, `~/.config/herd` on Windows) |
| `editor` | `auto` | Editor: command, absolute path, or macOS app name (`Cursor`, `Visual Studio Code`) |
| `terminal` | `auto` | Terminal: command, absolute path, or macOS app name (`iTerm`, `Terminal`) |
| `autostartMode` | `dev` | `dev` for the watcher or `production` for the compiled server |
| `ignore` | `[]` | Additional directory names to ignore |

Environment variables override file configuration:

- `DEVHUB_ROOT`
- `DEVHUB_PORT`
- `DEVHUB_HOST`
- `DEVHUB_PUBLIC_HOST`
- `DEVHUB_PUBLIC_URL`
- `DEVHUB_STACK`
- `DEVHUB_AUTOSTART_MODE`

When `DEVHUB_ROOT` is set, the workspace is intentionally locked and cannot be changed from the UI. Binding to a non-loopback address additionally requires `DEVHUB_ALLOW_REMOTE=1`.

## Autostart

```bash
npm run autostart:install
npm run autostart:uninstall
```

The installer picks the mechanism for your platform and writes its output to `.devhub/autostart.log`:

- **Windows** — creates the `DevHub Node` scheduled task for the current user, adds the configured `publicHost` to the hosts file, and starts DevHub without a visible terminal window. Requires a UAC confirmation. `npm run windows:install` and `npm run windows:uninstall` remain available as aliases.
- **macOS** — writes `~/Library/LaunchAgents/de.devhub.node.plist` and loads it with `launchctl`. The agent inherits your current `PATH`, so `npm`, `php`, `git`, and `herd` stay reachable.
- **Linux** — writes `~/.config/systemd/user/devhub.service` and enables it with `systemctl --user`.

With Herd, the setup assistant can additionally run `herd proxy devhub http://127.0.0.1:7331`, which makes DevHub available at `http://devhub.test` without touching the hosts file.

## Project discovery

DevHub uses existing project files instead of a central registry. Among other signals, it reads:

- `package.json` scripts and dependencies;
- `composer.json` packages;
- Git metadata;
- README headings and descriptions;
- HTML and PHP entry points;
- `start.sh`, `start.bat`, `start.cmd`, and `start.ps1`; and
- optional `thumbnail.jpg`, `thumbnail.png`, `thumbnail.webp`, or `thumbnail.gif` files.

Only scripts and files inside the selected workspace are considered. Launch actions still execute local code with your user permissions, so only start projects you trust.

## Development

```bash
npm run check    # TypeScript type-check
npm test         # Node test suite
npm run build    # Compile to dist/
npm run verify   # Run all checks above
```

Repository structure:

```text
public/      Browser UI (HTML, CSS, JavaScript)
runtime/     Static preview server
scripts/     Windows autostart helpers (PowerShell)
src/         TypeScript server, scanner, Git, process management,
             stack providers (laragon.ts, herd.ts), platform helpers,
             setup assistant, and autostart installers
tests/       Scanner, configuration, Git, process, stack, and setup tests
```

## Security model

- The server binds to a loopback address and rejects non-local clients by default.
- State-changing API requests require a session-specific token.
- The UI is served with a restrictive Content Security Policy.
- Absolute project paths are not included in public project API objects.
- Local configuration, logs, build output, and dependencies are excluded from Git.

If you intentionally expose DevHub beyond your own machine, review the security implications first. It can launch processes, access repositories, and perform Git operations with the permissions of the DevHub process.

## Contributing

Issues and pull requests are welcome. Please run `npm run verify` before submitting a change.
