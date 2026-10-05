// What Wrangler makes of the files the service imports: fonts as bytes
// (the "Data" rule in wrangler.jsonc) and WebAssembly as compiled modules.

declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
