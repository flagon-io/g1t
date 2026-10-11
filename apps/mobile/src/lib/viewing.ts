/**
 * The conversation on screen now, if any: a banner or a notification for
 * it is not shown, as the site skips toasts for the conversation open.
 * Set by the conversation and thread screens while they are in front.
 */
export const viewing: { channelId: string | null; threadRoot: string | null } = { channelId: null, threadRoot: null };
