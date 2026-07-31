import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // CACHING: her media (clips, viseme PNGs, brand art) revalidates hourly
  // instead of on every deck load. NOT immutable on purpose — these files are
  // replaced in place (the viseme bank was rebuilt tonight under the same
  // names); a year-long immutable would serve stale mouths.
  async headers() {
    return [
      {
        source: "/avatar/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=3600, must-revalidate" },
        ],
      },
      {
        source: "/brand/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, must-revalidate" },
        ],
      },
    ];
  },
  // Allow large brand PNGs through the image optimizer
  images: {
    unoptimized: false,
  },
  turbopack: {
    resolveAlias: {
      // piper-tts-web Emscripten includes Node fs/path branches never used in browser.
      fs: { browser: "./empty-node-stub.js" },
      path: { browser: "./empty-node-stub.js" },
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }
    return config;
  },
};

export default nextConfig;
