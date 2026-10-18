import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source (contracts/README.md).
  transpilePackages: ["@recyclone/contracts", "@recyclone/core", "@recyclone/integrations"],
  // Those packages import siblings as "./x.js" (NodeNext style) while the files are .ts.
  // Only webpack honours this, so dev/build run with --webpack (Turbopack ignores it).
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
  // Stop `next dev` from appending its own block to apps/web/AGENTS.md on every
  // run (on every agent's branch), which would cause merge conflicts.
  agentRules: false,
  // Pages that moved when the demo and management screens became one app.
  async redirects() {
    return [
      // Open the site on the dashboard's live-footage camera wall.
      { source: "/", destination: "/dashboard/live-footage", permanent: false },
      { source: "/recommendations", destination: "/messages", permanent: false },
      { source: "/items", destination: "/catalog", permanent: false },
    ];
  },
};

export default nextConfig;
