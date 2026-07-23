export const unsafeReleaseTextCases = [
  { rule: "credential-value", text: 'token = "plain-secret-value"' },
  { rule: "credential-value", text: "SESSION: abcdefghijklmnop" },
  { rule: "credential-value", text: "Api Key = qwertyuiopasdfgh" },
  { rule: "credential-value", text: "access-key: abcdefghijklmnop" },
  {
    rule: "credential-url",
    text: "https://example.invalid/feed?access_key=abcdefghijklmnop",
  },
  {
    rule: "credential-url",
    text: "https://person:password@example.invalid/feed",
  },
  {
    rule: "credential-url",
    text: "https://example.invalid/#token=abcdefghijklmnop",
  },
  {
    rule: "credential-url",
    text: "https%253A%252F%252Fexample.invalid%252F%253Fapi_key%253Dabcdefghijklmnop",
  },
  { rule: "home-path", text: "/root/private/note.md" },
  { rule: "home-path", text: "/home/person/private/note.md" },
  { rule: "home-path", text: "/Users/person/Vault/note.md" },
  { rule: "home-path", text: String.raw`D:\Vault\private\note.md` },
  {
    rule: "home-path",
    text: String.raw`\\server\share\Vault\private\note.md`,
  },
] as const;

export const safeReleaseTextCases = [
  "Authorization is a header name.",
  "The token field stores a runtime value.",
  "const token = candidate;",
  "const apiKey = settings.apiKey;",
  "headers.Authorization = `Bearer ${apiKey}`;",
] as const;
