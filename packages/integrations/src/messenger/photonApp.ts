import { Spectrum, type SpectrumInstance } from "spectrum-ts";

export type PhotonChannel = "imessage" | "whatsapp_business";

function readChannel(env: NodeJS.ProcessEnv): PhotonChannel {
  const value = env.PHOTON_CHANNEL;
  if (value === "imessage" || value === "whatsapp_business") return value;
  throw new Error(`PHOTON_CHANNEL must be "imessage" or "whatsapp_business", got ${JSON.stringify(value)}.`);
}

// Building the provider config is the one part that's genuinely per-channel;
// everything downstream (space.create/get, space.send, app.webhook) is the
// same generic Spectrum API regardless of which provider is configured.
async function buildProviderConfig(channel: PhotonChannel, env: NodeJS.ProcessEnv) {
  if (channel === "imessage") {
    const { imessage } = await import("spectrum-ts/providers/imessage");
    // The quickstart shows imessage.config() with no arguments — Photon's
    // hosted bridge is provisioned at the project level (SPECTRUM_PROJECT_ID/
    // SPECTRUM_PROJECT_SECRET), not per-channel. Confirm this is really
    // zero-config for this project before relying on it.
    return imessage.config();
  }
  const { whatsappBusiness } = await import("spectrum-ts/providers/whatsapp-business");
  const accessToken = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    throw new Error("whatsapp_business channel requires WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.");
  }
  return whatsappBusiness.config({
    accessToken,
    appSecret: env.WHATSAPP_APP_SECRET,
    phoneNumberId,
  });
}

let appPromise: Promise<SpectrumInstance> | null = null;

/**
 * Lazily creates (once per warm process) and returns the shared Spectrum
 * app. Used by both PhotonMessenger (to send) and the webhook route (to
 * verify + deserialize inbound deliveries via app.webhook(...)) so they
 * share one authenticated session instead of each building their own.
 */
export function getPhotonApp(env: NodeJS.ProcessEnv = process.env): Promise<SpectrumInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      const projectId = env.SPECTRUM_PROJECT_ID;
      const projectSecret = env.SPECTRUM_PROJECT_SECRET;
      if (!projectId || !projectSecret) {
        throw new Error("SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET are required to construct the Photon app.");
      }
      const channel = readChannel(env);
      const providerConfig = await buildProviderConfig(channel, env);
      return Spectrum({
        projectId,
        projectSecret,
        // The SDK rejects "" (the .env.example default); omit it until a secret exists.
        webhookSecret: env.PHOTON_WEBHOOK_SECRET || undefined,
        providers: [providerConfig],
      });
    })().catch((err) => {
      appPromise = null; // allow retrying on the next call instead of caching a permanent failure
      throw err;
    });
  }
  return appPromise;
}

// imessage(app) and whatsappBusiness(app) return per-provider instance types
// that TypeScript can't merge into one nameable union for declaration
// emit (TS4058); PhotonMessenger only ever needs this much of either one.
export interface MinimalPhotonSpace {
  send(content: string): Promise<{ id: string; timestamp: Date } | undefined>;
}
export interface MinimalPhotonProvider {
  space: {
    create(userId: string): Promise<MinimalPhotonSpace>;
  };
}

export async function getPhotonProvider(env: NodeJS.ProcessEnv = process.env): Promise<MinimalPhotonProvider> {
  const app = await getPhotonApp(env);
  const channel = readChannel(env);
  if (channel === "imessage") {
    const { imessage } = await import("spectrum-ts/providers/imessage");
    return imessage(app);
  }
  const { whatsappBusiness } = await import("spectrum-ts/providers/whatsapp-business");
  return whatsappBusiness(app);
}
