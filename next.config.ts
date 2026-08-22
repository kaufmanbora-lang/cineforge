import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    serverActions: { bodySizeLimit: "8mb" },
    optimizePackageImports: ["lucide-react"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "generativelanguage.googleapis.com" },
      { protocol: "http", hostname: "localhost", port: "9000" },
    ],
  },
  serverExternalPackages: ["bullmq", "pg"],
};

export default nextConfig;
