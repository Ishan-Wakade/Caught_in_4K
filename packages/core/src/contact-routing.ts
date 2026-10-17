import type { Contact, ContactRef } from "@recyclone/contracts";
import { CoreError, invariant } from "./validation.js";

export type ReplyContactOptions = {
  /** Only mock routes may accept local catalog contact IDs directly. */
  allowContactIds?: boolean;
  /** Administrator-configured Photon sender ID -> local manager contact ID. */
  aliases?: Record<string, string>;
};
function phoneKey(value: string | null | undefined): string | null {
  if (!value || !/^\+?[\d\s().-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}
/** Caller must first verify the provider webhook. No model chooses identity. */
export function resolveReplyContact(contacts: Contact[], sender: ContactRef, options: ReplyContactOptions = {}): ContactRef {
  invariant(sender && typeof sender.contactId === "string" && sender.contactId.length > 0, "Missing verified sender", 403);
  const aliases = options.aliases ?? {};
  for (const id of Object.values(aliases)) invariant(contacts.some(c => c.contact_id === id), "Photon contact map refers to an unknown contact", 503);
  const mapped = Object.hasOwn(aliases, sender.contactId) ? aliases[sender.contactId] : undefined;
  let matches: Contact[];
  if (mapped) matches = contacts.filter(c => c.contact_id === mapped);
  else if (options.allowContactIds && contacts.some(c => c.contact_id === sender.contactId)) matches = contacts.filter(c => c.contact_id === sender.contactId);
  else {
    const ids = [sender.contactId, sender.phone, sender.handle].filter((v): v is string => typeof v === "string" && v.length > 0);
    matches = contacts.filter(c => ids.some(id => {
      const phone = phoneKey(id);
      return Boolean(phone && phone === phoneKey(c.phone)) || (c.handle !== null && c.handle === id);
    }));
  }
  if (matches.length === 0) throw new CoreError(403, "Verified sender is not a configured manager contact");
  invariant(matches.length === 1, "Sender matches multiple manager contacts; configure PHOTON_CONTACT_MAP", 409);
  const match = matches[0]!;
  return { contactId: match.contact_id, ...(match.phone ? { phone: match.phone } : {}), ...(match.handle ? { handle: match.handle } : {}) };
}
