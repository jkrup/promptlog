// Loads the versioned summarizer prompt (./prompt.md). Bump `promptVersion` in its first line when the prompt
// changes meaningfully; the cache key also hashes the template, so edits never serve stale summaries.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const VERSION_RE = /^<!--\s*promptVersion:\s*([\w.-]+)\s*-->\s*\n?/;

export interface PromptTemplate {
  version: string;
  /** Short hash of the template text (goes into the cache key). */
  hash: string;
  body: string;
}

export function parsePromptTemplate(text: string): PromptTemplate {
  const m = VERSION_RE.exec(text);
  const body = m ? text.slice(m[0].length) : text;
  if (!body.includes('{{MATERIAL}}')) throw new Error('summarize prompt is missing the {{MATERIAL}} placeholder');
  return { version: m?.[1] ?? '0', hash: createHash('sha256').update(text).digest('hex').slice(0, 12), body };
}

let cached: PromptTemplate | undefined;
export function loadPromptTemplate(): PromptTemplate {
  cached ??= parsePromptTemplate(readFileSync(new URL('./prompt.md', import.meta.url), 'utf8'));
  return cached;
}

export function buildPrompt(material: string, tpl: PromptTemplate = loadPromptTemplate()): string {
  return tpl.body.replace('{{MATERIAL}}', () => material);
}

export const SYSTEM_PROMPT =
  'You are a meticulous senior engineer reviewing a pull request. Everything you know about the change is in the user message; you have no tools and no repository access. Answer only with the requested structured output.';
