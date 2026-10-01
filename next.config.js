/** @type {import('next').NextConfig} */
const nextConfig = {
  // PptxGenJS relies on Node runtime constructors that break when Turbopack
  // bundles it into the catch-all API route. Load it from node_modules instead.
  serverExternalPackages: ['pptxgenjs'],
  outputFileTracingIncludes: {
    // The PPTX generator reads the church logo from disk at runtime. Include
    // it in the serverless API function so production exports match local ones.
    '/api/[[...path]]': ['./data/**/*.json', './public/images/logo.png'],
  },
};

module.exports = nextConfig;
