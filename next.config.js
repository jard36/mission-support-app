/** @type {import('next').NextConfig} */
const nextConfig = {
  // PptxGenJS relies on Node runtime constructors that break when Turbopack
  // bundles it into the catch-all API route. Load it from node_modules instead.
  serverExternalPackages: ['pptxgenjs'],
  outputFileTracingIncludes: {
    '/api/[[...path]]': ['./data/**/*.json'],
  },
};

module.exports = nextConfig;
