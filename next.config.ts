/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow large brand PNGs through the image optimizer
  images: {
    unoptimized: false,
  },
};

export default nextConfig;
