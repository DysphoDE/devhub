// Merkt sich pro Aufgabe (npm run build, test …) den letzten abgeschlossenen Lauf, auch über einen Neustart von DevHub hinweg.
//
// Gespeichert wird in .devhub/runs.json im App-Ordner. Die Datei ist klein: pro Aufgabe ein Eintrag,
// die ältesten fallen heraus, sobald mehr als maxEntries zusammenkommen.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeSnapshot, TaskRun } from "./types.js";

const maxEntries = 500;

/** Leitet das Ergebnis eines beendeten Laufs ab. Ein noch laufender Prozess liefert null. */
export function runFromSnapshot(snapshot: RuntimeSnapshot): TaskRun | null {
  if (!snapshot.stoppedAt || !["stopped", "error"].includes(snapshot.status)) return null;
  const outcome = snapshot.exitCode === 0 ? "success" : snapshot.status === "error" ? "failed" : "cancelled";
  return { startedAt: snapshot.startedAt, finishedAt: snapshot.stoppedAt, exitCode: snapshot.exitCode, outcome };
}

export class RunHistory {
  private runs = new Map<string, TaskRun>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") return;
      for (const [id, run] of Object.entries(parsed as Record<string, TaskRun>)) {
        if (run && typeof run.finishedAt === "string" && ["success", "failed", "cancelled"].includes(run.outcome)) this.runs.set(id, run);
      }
    } catch { /* noch keine Läufe oder unlesbar: DevHub beginnt mit leerer Historie */ }
  }

  get(id: string): TaskRun | null {
    return this.runs.get(id) ?? null;
  }

  /** Übernimmt einen beendeten Lauf. Gibt false zurück, wenn der Lauf schon bekannt war. */
  record(id: string, run: TaskRun): boolean {
    const known = this.runs.get(id);
    if (known?.finishedAt === run.finishedAt) return false;
    this.runs.delete(id);
    this.runs.set(id, run);
    while (this.runs.size > maxEntries) this.runs.delete(this.runs.keys().next().value!);
    this.writing = this.writing.then(() => this.save()).catch(() => undefined);
    return true;
  }

  /** Wartet, bis alle angestoßenen Schreibvorgänge erledigt sind. */
  flush(): Promise<void> {
    return this.writing;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(Object.fromEntries(this.runs), null, 2));
    await rename(temporaryPath, this.filePath);
  }
}
