import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Standalone output copies only what the server needs into .next/standalone,
  // which is what the Dockerfile ships.
  output: 'standalone',
  // The dev server and `next build` write to the same directory by default, so a
  // build check run while the app is being served knocked the server over.
  // Development gets a directory of its own; production keeps .next for the image.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  // This app is the root of its own trace, even when it lives inside a larger
  // repository that has its own lockfile.
  outputFileTracingRoot: import.meta.dirname,
  // node:sqlite is a Node built-in newer than the bundler's list; keep it
  // external so the server requires it at runtime instead of trying to bundle.
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals ?? []), { 'node:sqlite': 'commonjs node:sqlite' }];
    }
    return config;
  },
};

export default nextConfig;
