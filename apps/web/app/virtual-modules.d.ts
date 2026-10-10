/**
 * The doc editor's chunk and what it imports, as the browser build wrote
 * them (vite.config.ts `editorChunk`): their addresses in the server
 * build, none in the browser build and in development.
 */
declare module "virtual:g1t-editor-chunk" {
  const files: string[];
  export default files;
}
