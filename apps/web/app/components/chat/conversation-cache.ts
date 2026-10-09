import type { ChannelData } from "../../routes/workspace/chat/channel";
import { createConversationCache } from "../../lib/chat-cache";

/**
 * Conversations already seen in this tab (lib/chat-cache.ts): what
 * switching back to one draws at once (routes/workspace/chat/channel.tsx
 * `clientLoader`). The page keeps its entry current as messages arrive, and
 * the sidebar fills it ahead on hover.
 */
export const conversationCache = createConversationCache<ChannelData>();
