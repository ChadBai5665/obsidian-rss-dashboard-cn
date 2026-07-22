export interface XPost {
  id: string;
  authorHandle: string;
  authorName?: string;
  text: string;
  createdAt?: string;
  url: string;
  conversationId?: string;
  inReplyToId?: string;
  repostOfId?: string;
  quoteOfId?: string;
  externalUrls: string[];
  metrics: {
    replies?: number;
    reposts?: number;
    likes?: number;
    quotes?: number;
    views?: number;
  };
}
