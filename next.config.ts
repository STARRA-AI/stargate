import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
