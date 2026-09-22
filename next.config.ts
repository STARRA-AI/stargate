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
  // CACHING: her face assets are replaced IN PLACE under fixed names (both
  // body loops, the bank and its PNGs were re-cut three times on 2026-09-22)
  // while the JS that carries their geometry is rehashed every build — so a
  // client that cached a body for an hour composited the NEW bank onto an OLD
  // body. /avatar/* therefore revalidates on every load (a 304 when unchanged);
  // brand art keeps its daily window.
  async headers() {
    return [
      {
        source: "/avatar/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
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
