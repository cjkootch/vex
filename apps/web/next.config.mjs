/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@vex/ui"],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
