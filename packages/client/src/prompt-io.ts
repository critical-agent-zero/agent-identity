/** The readline surface promptAsk needs; matches node:readline/promises. */
export interface PromptRl {
  question(query: string, options: { signal: AbortSignal }): Promise<string>;
  once(event: string, listener: () => void): unknown;
  close(): void;
}

/** An io.ask that fails fast when input closes (Ctrl-D) or interrupts
 *  (Ctrl-C). Without this, rl.question's promise never settles after EOF,
 *  the event loop drains mid-await, and Node exits 13 with an "unsettled
 *  top-level await" warning instead of a clean abort message. */
export function promptAsk(rl: PromptRl): (query: string) => Promise<string> {
  const aborted = new AbortController();
  rl.once("close", () => aborted.abort());
  rl.once("SIGINT", () => {
    aborted.abort();
    rl.close();
  });
  return async (query) => {
    try {
      return await rl.question(query, { signal: aborted.signal });
    } catch (err) {
      if (aborted.signal.aborted) throw new Error("setup aborted");
      throw err;
    }
  };
}
