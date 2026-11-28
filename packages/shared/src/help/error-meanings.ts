// Feature 009 (research R12, FR-028): what each delivery failure means and what to do, in our own words,
// written from Meta's public error reference. Maintainers extend this list without changing screens;
// codes that appear without an entry are counted (wbm_unknown_error_codes_total) so they can be added.

export interface ErrorMeaning {
  title: string;
  meaning: string;
  action: string;
  /** When the entry was last compared with Meta's error reference. */
  checkedAt: string;
}

const CHECKED = '2026-11-27';
const entry = (title: string, meaning: string, action: string): ErrorMeaning => ({ title, meaning, action, checkedAt: CHECKED });

/** Meta Cloud API error codes. */
export const META_ERROR_MEANINGS: Readonly<Record<number, ErrorMeaning>> = {
  4: entry('The app reached its API call rate limit', 'Too many requests reached Meta from the company app in a short time.', 'Nothing to do: sending slows down and continues by itself.'),
  10: entry('Permission is not granted or was removed', 'The system user token lost a WhatsApp permission.', 'An admin reconnects the number with a token that has the WhatsApp permissions.'),
  190: entry('The access token has expired or is invalid', 'Meta no longer accepts the number\'s access token.', 'An admin replaces the token in Numbers; sending resumes after that.'),
  368: entry('The WhatsApp Business Account is restricted', 'Meta restricted the account for a policy problem.', 'Check the account in WhatsApp Manager for Meta\'s notice and appeal there if it is a mistake.'),
  80007: entry('The WhatsApp Business Account reached its rate limit', 'The account sent more requests than Meta allows in a short time.', 'Nothing to do: sending slows down and continues by itself.'),
  130429: entry('The number\'s sending speed was reached', 'The number sent messages faster than Meta allows for it.', 'Nothing to do: the platform waits and retries.'),
  131000: entry('Meta could not send the message', 'Meta reported an unknown error for this message.', 'Try again later; if it keeps happening, check Meta\'s status page.'),
  131016: entry('A Meta service is temporarily unavailable', 'WhatsApp could not take the message for a short while.', 'Nothing to do: retry rounds can send it again.'),
  131026: entry('The message could not be delivered', 'The number may not be on WhatsApp, may not have accepted WhatsApp\'s terms, or uses an old app.', 'Check the number with the customer, or reach them another way.'),
  131047: entry('More than 24 hours since the customer last wrote', 'Free-form messages can only be sent within 24 hours of the customer\'s last message.', 'Send an approved template instead.'),
  131048: entry('Sending is limited because of the number\'s quality', 'Too many people blocked or reported the number recently, so Meta limits it.', 'Send less marketing for a while and check the quality rating in Numbers.'),
  131049: entry('Held back by Meta\'s per-person marketing limit', 'Meta limits how many marketing messages each person receives from all businesses. This message was not delivered and is not charged.', 'Do not resend it within 24 hours; retry rounds hold it back for you.'),
  131050: entry('The customer stopped marketing messages', 'The customer chose in WhatsApp not to receive marketing messages from the company.', 'Do not send them marketing; utility messages and replies still work.'),
  131051: entry('This message type is not supported', 'WhatsApp does not support the kind of message that was sent.', 'Use a supported message type or template.'),
  131052: entry('The customer\'s media could not be downloaded', 'WhatsApp could not fetch a file the customer sent.', 'Ask the customer to send the file again.'),
  131053: entry('The media file could not be uploaded', 'WhatsApp could not read the file sent with the message (type, size or address).', 'Check the file type and size, and that a media address is public and secure.'),
  131056: entry('Too many messages to this customer in a short time', 'The number sent several messages to the same customer too quickly.', 'Wait a little; retry rounds can send it again.'),
  131057: entry('The account is in maintenance', 'Meta is working on the WhatsApp Business Account.', 'Wait and try again later.'),
  132000: entry('The template variables do not match', 'The number of values sent is not the number of variables in the template.', 'Check the campaign\'s variable mapping against the template.'),
  132001: entry('The template does not exist in this language or is not approved', 'Meta has no approved version of the template in that language.', 'Sync the templates and choose an approved one.'),
  132005: entry('The filled-in template is too long', 'With the values filled in, the message passes Meta\'s length limit.', 'Use shorter values or a shorter template.'),
  132007: entry('The template breaks a WhatsApp policy', 'Meta found content in the template that its policies do not allow.', 'Edit the template and submit it again.'),
  132012: entry('A template value has the wrong format', 'A value does not match what the template expects (for example a media or link value).', 'Check the values in the campaign mapping.'),
  132015: entry('The template is paused for low quality', 'Meta paused the template because customers reacted badly to it.', 'Use another template, or improve this one and wait for Meta to resume it.'),
  132016: entry('The template is disabled', 'Meta disabled the template for good after repeated pauses.', 'Create a new template with improved content.'),
  133004: entry('The Meta server is temporarily unavailable', 'WhatsApp could not take the message for a short while.', 'Nothing to do: sending retries by itself.'),
  133010: entry('The phone number is not registered', 'The number is not registered on the WhatsApp Business Platform.', 'An admin finishes the number\'s registration in WhatsApp Manager.'),
};

/** The platform's own reasons (not Meta codes). */
export const PLATFORM_REASON_MEANINGS: Readonly<Record<string, ErrorMeaning>> = {
  unknown_outcome_not_retried: entry(
    'The send outcome is unknown',
    'The request may have reached Meta, but no answer came back, so it is not sent again to avoid a double message.',
    'Check with the customer if needed; nothing else to do.',
  ),
  EXPIRED_BEFORE_SENDING: entry('Expired before sending', 'The message waited in the queue longer than the template\'s time-to-live, so it was not sent.', 'Resume campaigns sooner, or give the template a longer time-to-live.'),
  NOT_DELIVERED_IN_TIME: entry('Not delivered in time', 'WhatsApp could not deliver the message within the template\'s time-to-live, so it was dropped.', 'Nothing to resend: a late code or reminder would confuse the customer.'),
  OFFER_ENDED: entry('The offer had ended', 'The offer\'s end time passed before the message was sent, so it was not sent.', 'Set a later end time for the next offer campaign.'),
  MEDIA_NOT_HTTPS: entry('The media address is not secure', 'Media addresses must start with https://.', 'Use a secure (https) address for the file.'),
  MEDIA_NOT_PUBLIC: entry('The media address is not public', 'The address points to a private or local network.', 'Use a public address that anyone can open.'),
  MEDIA_UNREACHABLE: entry('The media address could not be opened', 'The address did not answer, or answered with an error.', 'Open the address in a browser to check it, then fix it.'),
  MEDIA_WRONG_TYPE: entry('The file at the media address is the wrong type', 'The file is not the type the template header needs.', 'Use a JPEG or PNG for images, MP4 for videos and PDF for documents.'),
  MEDIA_TOO_LARGE: entry('The file at the media address is too large', 'The file is larger than WhatsApp allows for this header.', 'Use a smaller file: images up to 5 MB, videos 16 MB, documents 100 MB.'),
  MEDIA_TIMEOUT: entry('The media address took too long', 'The address did not answer within 5 seconds.', 'Use a faster host for the file.'),
};

/** General advice for codes without an entry. */
export const GENERAL_ADVICE = 'Check the message and the template, and try again later. If it keeps happening, look the code up in Meta\'s error reference.';

/** The meaning of a Meta error code, or general advice with Meta's own text when there is no entry. */
export function meaningOfMetaError(code: number | null | undefined, metaText?: string | null): ErrorMeaning & { known: boolean } {
  const known = code !== null && code !== undefined ? META_ERROR_MEANINGS[code] : undefined;
  if (known) return { ...known, known: true };
  const title = metaText?.trim() || 'Meta rejected the message';
  return { title: code !== null && code !== undefined ? `${title} (code ${code})` : title, meaning: metaText?.trim() || 'Meta did not explain the problem.', action: GENERAL_ADVICE, checkedAt: CHECKED, known: false };
}

/** The meaning of a platform reason key, or null. */
export function meaningOfPlatformReason(reason: string | null | undefined): ErrorMeaning | null {
  return reason ? (PLATFORM_REASON_MEANINGS[reason] ?? null) : null;
}

/**
 * What a stored failure means and what to do (FR-028): a platform reason key, else the Meta code's entry,
 * else Meta's own text with general advice (`known: false`, counted by the api). Null with no failure.
 */
export function failureHelp(code: number | null | undefined, reason: string | null | undefined): { meaning: string; action: string; known: boolean } | null {
  const platform = meaningOfPlatformReason(reason);
  if (platform) return { meaning: platform.meaning, action: platform.action, known: true };
  if ((code === null || code === undefined) && !reason) return null;
  const meta = meaningOfMetaError(code, reason);
  return { meaning: meta.meaning, action: meta.action, known: meta.known };
}
