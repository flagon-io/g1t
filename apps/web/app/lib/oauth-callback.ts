/** RFC 9207: success and error responses identify the metadata's issuer. */
export function oauthCallback(redirectUri: string, params: Record<string, string>, issuer: string): string {
  const url = new URL(redirectUri);
  for (const key of ["code", "error", "error_description", "state", "iss"]) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", issuer);
  return url.toString();
}
