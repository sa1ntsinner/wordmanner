import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { languages, media, parseJsonl, type Language, type Medium } from "./sample.js";

export interface VoiceNote {
  id: string;
  text: string;
  language?: Language;
  medium?: Medium;
}

export const defaultNotes = join(process.env.WORDMANNER_HOME ?? join(homedir(), ".wordmanner"), "voice-notes.jsonl");

function parseNote(value: unknown): VoiceNote {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("note must be an object");
  const note = value as Record<string, unknown>;
  if (typeof note.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(note.id)) throw new Error("invalid note id");
  if (typeof note.text !== "string" || !note.text.trim() || note.text.length > 2000) throw new Error("note text must be 1–2,000 characters");
  const parsed: VoiceNote = { id: note.id, text: note.text.trim() };
  if (note.language !== undefined) {
    if (!languages.includes(note.language as Language)) throw new Error("invalid note language");
    parsed.language = note.language as Language;
  }
  if (note.medium !== undefined) {
    if (!media.includes(note.medium as Medium)) throw new Error("invalid note medium");
    parsed.medium = note.medium as Medium;
  }
  return parsed;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function loadNotes(path = defaultNotes): Promise<VoiceNote[]> {
  try {
    return parseJsonl(await readFile(path, "utf8"), parseNote);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export function matchingNotes(notes: VoiceNote[], language: Language, medium: Medium): VoiceNote[] {
  return notes.filter(note => (!note.language || note.language === language) && (!note.medium || note.medium === medium));
}

export async function addNote(text: string, language?: Language, medium?: Medium, path = defaultNotes): Promise<VoiceNote> {
  const note = parseNote({ id: randomUUID(), text, language, medium });
  const absolute = resolve(path);
  await loadNotes(absolute);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  if (absolute === resolve(defaultNotes)) await chmod(dirname(absolute), 0o700);
  const handle = await open(absolute, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    const line = Buffer.from(JSON.stringify(note) + "\n");
    const result = await handle.write(line);
    if (result.bytesWritten !== line.length) throw new Error("incomplete note write");
  } finally {
    await handle.close();
  }
  return note;
}
