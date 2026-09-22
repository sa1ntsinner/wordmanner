export const languages = ["en", "ru"] as const;
export const media = ["email", "chat", "presentation", "article", "technical", "code-comment", "general"] as const;

export type Language = (typeof languages)[number];
export type Medium = (typeof media)[number];

export interface Sample {
  id: string;
  text: string;
  language: Language;
  medium: Medium;
  audience?: string;
  intent?: string;
  tags?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${key} must be a non-empty string of at most 200 characters`);
  }
  return value.trim();
}

export function parseSample(value: unknown): Sample {
  if (!isRecord(value)) throw new Error("sample must be an object");
  const { id, text, language, medium, audience, intent, tags } = value;
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) {
    throw new Error("id must be 1–100 letters, digits, dots, underscores or hyphens");
  }
  if (typeof text !== "string" || !text.trim() || text.length > 20_000) {
    throw new Error("text must be a non-empty string of at most 20,000 characters");
  }
  if (!languages.includes(language as Language)) throw new Error(`language must be ${languages.join(" or ")}`);
  if (!media.includes(medium as Medium)) throw new Error(`medium must be one of ${media.join(", ")}`);
  if (tags !== undefined && (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== "string" || !tag.trim() || tag.length > 50))) {
    throw new Error("tags must be an array of up to 20 non-empty strings of at most 50 characters");
  }

  const sample: Sample = { id, text: text.trim(), language: language as Language, medium: medium as Medium };
  const parsedAudience = optionalText(audience, "audience");
  const parsedIntent = optionalText(intent, "intent");
  if (parsedAudience) sample.audience = parsedAudience;
  if (parsedIntent) sample.intent = parsedIntent;
  if (tags) sample.tags = tags.map((tag: string) => tag.trim());
  return sample;
}

export function parseJsonl<T>(input: string, parse: (value: unknown) => T): T[] {
  return input.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [parse(JSON.parse(line) as unknown)];
    } catch (error) {
      throw new Error(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
