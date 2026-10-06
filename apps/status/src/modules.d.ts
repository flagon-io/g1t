/** Font files, bundled as Data modules (see `rules` in wrangler.jsonc). */
declare module "*.woff2" {
  const data: ArrayBuffer;
  export default data;
}
