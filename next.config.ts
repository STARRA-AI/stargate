import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ★ SEPARATE BUILD DIRECTORIES. A production `next build` writes the same
  // .next/ that a RUNNING dev server is serving from, deletes its development
  // manifests, and the live deck starts throwing
  // `ENOENT: .next/static/development/_buildManifest.js.tmp` on every request.
  // That happened for real on 2026-09-04 — a build took the running deck down.
  // STARRA_DIST lets the production lane live in .next-prod so `npm run dev`
  // and `npm run deck:fast` can run at the same time without touching each
  // other. Unset (the default) keeps plain `.next`, so dev is unchanged.
  distDir: process.env.STARRA_DIST || ".next",
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
