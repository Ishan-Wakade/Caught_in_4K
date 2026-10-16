import type { ReplySink } from "@recyclone/integrations";

// I owns createCore({ messenger, illustrator, interpreter }) and the module
// under apps/web/app/api/ that wires it (contract §6). That module doesn't
// exist yet, so this resolves to a stub that fails loudly instead of
// silently no-op'ing on real manager replies. Once it exists, point
// getReplySink() at it, e.g.:
//
//   import { core } from "../_core";
//   export function getReplySink(): ReplySink { return core; }
export function getReplySink(): ReplySink {
  return {
    async handleReply() {
      throw new Error(
        "No ReplySink wired yet: packages/core's createCore(...) has not landed. " +
          "See apps/web/app/api/photon/_replySink.ts.",
      );
    },
  };
}
