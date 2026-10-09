/**
 * Whether a request comes from a phone, for the pages that open on a list
 * there and on its first item on a wider screen (Chat). The client hint
 * when the browser sends it, else the user agent. A wrong guess costs a
 * click: the page corrects itself once it knows its width.
 */
export function isPhone(headers: { get(name: string): string | null }): boolean {
  const hint = headers.get("sec-ch-ua-mobile");
  if (hint != null) return hint.trim() === "?1";
  return /iPhone|iPod|Android.+Mobile|Mobile.+Firefox|Windows Phone/i.test(headers.get("user-agent") ?? "");
}
