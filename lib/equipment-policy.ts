// What a provider agrees to about photographing the laser, and which wording they agreed to.
//
// The policy lives in code for the same reason the supervised-procedure list does: changing what
// somebody is committing to should be a reviewed commit, not a form field somebody edits on a
// Tuesday.
//
// VERSIONED, and that is the point. Stamping the version a provider accepted means a later
// rewording cannot silently change what they actually agreed to — the argument
// `platform_settings.cardPolicyVersion` already makes for the client card mandate. Bumping
// `EQUIPMENT_POLICY_VERSION` asks everybody again, which is the correct behaviour when the terms
// have genuinely changed and a nuisance otherwise. Do not bump it for a typo.
//
// THE FRAMING IS LOAD-BEARING, more than any rule in the app could be. There is no interlock on a
// laser; nothing here can stop somebody using it. What decides whether these photographs actually
// get taken is whether a provider reads this as Melanite watching them or as their own alibi —
// and the honest answer is that it is mostly the second. The wording says so plainly, because a
// provider who understands that is a provider who photographs the machine when they arrive.

/** Bump when the WORDING changes in a way somebody should re-read. Providers are asked again. */
export const EQUIPMENT_POLICY_VERSION = '2026-09-01.v1'

/** When providers were first asked to do this.
 *
 *  Sessions before it are unbracketed by definition and nobody could have done otherwise, so
 *  listing them as exceptions is noise — and the exceptions page is only worth opening if
 *  everything on it is something somebody could have affected. Found by running it: the first
 *  load showed sixteen unfixable rows, which is how a page becomes one nobody opens twice.
 *
 *  A fixed date rather than "when the provider accepted", because the record is about the
 *  machine. A provider who has not accepted yet is still leaving gaps worth seeing. */
export const EQUIPMENT_LOG_STARTED_AT = new Date('2026-08-31T00:00:00-06:00')

export const EQUIPMENT_POLICY_TITLE = 'Photographing the laser'

/** Shown once, before a provider books their next appointment. Written to be read in about
 *  twenty seconds by somebody who wants to get on with booking. */
export const EQUIPMENT_POLICY_POINTS: readonly string[] = [
  'Photographing the laser is expected of everyone who uses it — it comes with sharing one machine between separate practices. Do it when you arrive, before you start treating. It takes a few seconds from your phone.',
  'This is mostly for your protection. If the machine is already marked when you get it, your photo is what shows it was not you.',
  'When nobody is booked after you, photograph it again before you leave. If someone follows you the same day, their arrival photo covers it and we will not ask.',
  'If something looks wrong — damage, a warning light, a consumable running out — flag it on the photo. That reaches Melanite the same day rather than sitting in a folder.',
  'These are photographs of the equipment only. Never photograph a client here.',
] as const

/** Said out loud rather than implied, because a provider who thinks they are being blocked will
 *  look for a way around it and a provider who knows the record is simply incomplete will not.
 *
 *  It also states that Melanite can see the difference. Every other line here is written as the
 *  provider's own interest, which is true and is what gets the photographs taken — but it left
 *  the owner nothing to point at when raising a pattern with somebody. Saying it plainly is
 *  fairer than letting a provider discover it from a conversation she did not expect. */
export const EQUIPMENT_POLICY_CONSEQUENCE =
  'Nothing stops you working if you forget — you will never be locked out mid-clinic. Melanite can see which sessions were photographed and which were not. And a session with no arrival photo cannot be tied to a condition either way, so if something is found afterwards there is nothing showing it was not yours.'

/** Has this provider accepted the CURRENT wording?
 *
 *  Compares the exact version rather than "is it set", so a provider who accepted an earlier
 *  wording is asked again rather than being treated as having agreed to terms they never saw.
 */
export function hasAcceptedEquipmentPolicy(
  acceptedVersion: string | null | undefined,
): boolean {
  return acceptedVersion === EQUIPMENT_POLICY_VERSION
}
