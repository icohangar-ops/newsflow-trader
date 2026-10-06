import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  reactStrictMode: false,
  // Include the SQLite DB file in the standalone build so Vercel serverless
  // can copy it to /tmp at runtime (see src/lib/db.ts).
  outputFileTracingIncludes: {
    "/": ["./db/custom.db"],
  },
};

export default nextConfig;
