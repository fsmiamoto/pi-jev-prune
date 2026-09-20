export interface StubInput {
  toolCallId: string;
  tool: string;
  keyArg: string;
  lines: number;
  sizeTokens: number;
  isError: boolean;
}

export const STUB_PREFIX = "[pruned: ";

/** Template-only stub. No generative summary; identical input → identical output (cache stability). */
export function stubText(s: StubInput): string {
  const arg = s.keyArg ? ` ${s.keyArg}` : "";
  const err = s.isError ? ", error" : "";
  return `${STUB_PREFIX}${s.tool}${arg} — ${s.lines} lines/~${s.sizeTokens} tok${err}. Use recall("${s.toolCallId}") to restore.]`;
}

export function isStub(text: string): boolean {
  return text.startsWith(STUB_PREFIX);
}
