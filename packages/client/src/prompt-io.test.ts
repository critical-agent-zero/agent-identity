import { describe, expect, it } from "vitest";
import { promptAsk, type PromptRl } from "./prompt-io.js";

function fakeRl() {
  const listeners = new Map<string, () => void>();
  let closedCount = 0;
  const rl: PromptRl = {
    question: (_q: string, opts: { signal: AbortSignal }) =>
      new Promise<string>((resolve, reject) => {
        if (opts.signal.aborted) return reject(new Error("AbortError"));
        opts.signal.addEventListener("abort", () => reject(new Error("AbortError")));
        listeners.set("answer", () => resolve("the-answer"));
      }),
    once(event: string, cb: () => void) {
      listeners.set(event, cb);
      return rl;
    },
    close() {
      closedCount++;
      listeners.get("close")?.();
    },
  };
  return { rl, fire: (e: string) => listeners.get(e)?.(), closedTimes: () => closedCount };
}

describe("promptAsk", () => {
  it("resolves normally when input answers", async () => {
    const { rl, fire } = fakeRl();
    const ask = promptAsk(rl);
    const p = ask("q? ");
    fire("answer");
    await expect(p).resolves.toBe("the-answer");
  });

  it("rejects with 'setup aborted' when input closes mid-question (Ctrl-D)", async () => {
    const { rl, fire } = fakeRl();
    const ask = promptAsk(rl);
    const p = ask("q? ");
    fire("close");
    await expect(p).rejects.toThrow(/setup aborted/);
  });

  it("rejects and closes the interface on SIGINT (Ctrl-C)", async () => {
    const { rl, fire, closedTimes } = fakeRl();
    const ask = promptAsk(rl);
    const p = ask("q? ");
    fire("SIGINT");
    await expect(p).rejects.toThrow(/setup aborted/);
    expect(closedTimes()).toBeGreaterThan(0);
  });
});
