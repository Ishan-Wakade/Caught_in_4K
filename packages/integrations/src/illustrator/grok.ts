import type { BinInventorySnapshot, Illustrator } from "@recyclone/contracts";

type IllustrateResult = Awaited<ReturnType<Illustrator["illustrate"]>>;

export type GrokIllustratorConfig = {
  apiKey: string;
};

// Real adapter skeleton. Grok Imagine's request/response shape and image
// hosting behavior are unconfirmed (no docs reviewed yet) — see
// packages/integrations/AGENTS.md "Open questions". ILLUSTRATOR_MODE=live
// routes here; until the TODOs below are resolved this throws rather than
// silently returning a fake "real" image.
export class GrokIllustrator implements Illustrator {
  constructor(private readonly config: GrokIllustratorConfig) {}

  async illustrate(_snapshot: BinInventorySnapshot): Promise<IllustrateResult> {
    throw new Error(
      "GrokIllustrator is not implemented: Grok Imagine's API has not been confirmed " +
        "against their docs. Set ILLUSTRATOR_MODE=mock, or finish this adapter once " +
        "GROK_API_KEY and the API reference are available.",
    );
    // TODO once Grok Imagine docs are reviewed:
    // const res = await fetch(GROK_IMAGINE_URL, {
    //   method: "POST",
    //   headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
    //   body: JSON.stringify({ prompt: describeSnapshot(_snapshot) }),
    // });
    // ...map res to IllustrateResult, mocked: false
  }
}
