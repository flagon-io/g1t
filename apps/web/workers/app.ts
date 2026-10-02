import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const GIT_PATH = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export default {
  async fetch(request, env) {
    // Git over HTTPS shares this hostname but belongs to the repos service.
    if (GIT_PATH.test(new URL(request.url).pathname)) {
      return env.REPOS.fetch(request);
    }
    return requestHandler(request);
  },
} satisfies ExportedHandler<Env>;
