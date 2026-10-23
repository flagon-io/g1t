// Six blobs at once, each 100 MB streamed from a download straight into
// g1t.sh in 90 MiB chunks with registry.mjs's putBlobChunked, as
// copyImage does (#474). The digest given is wrong on purpose, so no blob
// is finished: the uploads are let go by g1t.sh's sweep.
// usage: node stream-copy.mjs <registry.mjs> <label>
const [module, label] = process.argv.slice(2);
const { repositoryClient } = await import(new URL(module, `file://${process.cwd()}/`).href);
const token = process.env.TOKEN;
const to = repositoryClient("g1t.sh", "flagon-io/g1t-hosted", { credentials: async () => ({ username: "g1t", password: token }) });
const source = () =>
  new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 4; i++) {
        const response = await fetch("https://speed.cloudflare.com/__down?bytes=25000000");
        for await (const piece of response.body) controller.enqueue(piece);
      }
      controller.close();
    },
  });
const one = async (n) => {
  const timing = { writeMs: 0 };
  const started = Date.now();
  let sent = 0;
  try {
    await to.putBlobChunked(source(), `sha256:${"0".repeat(64)}`, { timing, onChunk: (at) => (sent = at) });
  } catch (error) {
    if (!/came as/.test(String(error))) throw error;
  }
  const took = (Date.now() - started) / 1000;
  console.log(
    `${label} #${n}: ${(sent / 1e6).toFixed(0)} MB in ${took.toFixed(0)}s = ${(sent / 1e6 / took).toFixed(2)} MB/s (writing ${(timing.writeMs / 1000).toFixed(0)}s)`,
  );
};
const started = Date.now();
await Promise.all([1, 2, 3, 4, 5, 6].map(one));
console.log(`${label}: six in ${((Date.now() - started) / 1000).toFixed(0)}s`);
