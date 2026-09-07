import type { NextConfig } from 'next';

// The discovery API and the ENS reader live at the repo root (graph/, seller/),
// outside this app. They are imported directly rather than copied — a fork of
// the price-normalisation or ENSIP-25 encoding logic is exactly the kind of
// silent drift MOV-222 built tests to prevent.
const nextConfig: NextConfig = {
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
  serverExternalPackages: ['node:sqlite'],
  typedRoutes: false,
};

export default nextConfig;
