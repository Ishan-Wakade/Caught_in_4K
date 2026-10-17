import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source (contracts/README.md).
  transpilePackages: ["@recyclone/contracts", "@recyclone/core"],
  // Those packages import siblings as "./x.js" (NodeNext style) while the files are .ts.
  // Only webpack honours this, so dev/build run with --webpack (Turbopack ignores it).
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
  // Stop `next dev` from appending its own block to apps/web/AGENTS.md on every
  // run (on every agent's branch), which would cause merge conflicts.
  agentRules: false,
  // TEMPORARY (user-approved for the mock preview deploy, 2026-10-16): `next build`
  // type-checks I's API routes, and packages/core has 4 null-confidence type errors
  // (see AGENTS.md). Web code is still checked by `pnpm typecheck`. Remove once I fixes core.
  typescript: { ignoreBuildErrors: true },
  // Pages that moved when the demo and management screens became one app.
  async redirects() {
    return [
      { source: "/demo", destination: "/live", permanent: false },
      { source: "/recommendations", destination: "/messages", permanent: false },
      { source: "/items", destination: "/catalog", permanent: false },
    ];
  },
};

export default nextConfig;
