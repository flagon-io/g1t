// Metro in the g1t monorepo. Expo finds the workspace root and
// @g1t/contracts by itself; what it needs told is that React comes from
// this app alone. The site pins a newer React at the root, and React
// Native must run with the exact React it was built for (19.2.3 with
// Expo SDK 57), so `react` and its subpaths resolve from here wherever
// they are imported, including from packages hoisted to the root.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const here = path.join(__dirname, "package.json");

const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const pinned = moduleName === "react" || moduleName.startsWith("react/");
  const from = pinned ? { ...context, originModulePath: here } : context;
  return resolveRequest ? resolveRequest(from, moduleName, platform) : context.resolveRequest(from, moduleName, platform);
};

module.exports = config;
