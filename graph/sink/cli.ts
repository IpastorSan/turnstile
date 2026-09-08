// Argument reading and top-level error handling, shared by the sink commands.
//
// Without `main()`, a thrown error at the top level of an ES module prints a V8
// stack trace, which reads like a crash in the tool rather than a mistyped path
// or an unsourced .env. Operators run these by hand; the failure should be one
// line they can act on.

export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

export function numberFlag(argv: string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} expects a number, got '${raw}'`);
  return value;
}

export async function main(run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
