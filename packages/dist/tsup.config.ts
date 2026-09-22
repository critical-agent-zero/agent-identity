import { defineConfig, type Options } from "tsup";

const common = {
  format: ["esm"],
  platform: "node",
  target: "node20",
  splitting: false,
  noExternal: [/^@agent-identity\//],
} satisfies Options;

export default defineConfig([
  {
    ...common,
    entry: { index: "src/index.ts" },
    clean: true,
    // resolve + paths inline workspace-only types into index.d.ts; consumers can't install
    // them (#38). paths is needed because those packages expose only exports-map .ts entries,
    // which tsup's dts module resolver cannot see on its own.
    dts: {
      resolve: ["@agent-identity/shared", "@agent-identity/client"],
      compilerOptions: {
        paths: {
          "@agent-identity/shared": ["../shared/src/index.ts"],
          "@agent-identity/client": ["../client/src/index.ts"],
        },
      },
    },
  },
  {
    ...common,
    entry: { cli: "src/cli.ts", server: "src/server.ts" },
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
