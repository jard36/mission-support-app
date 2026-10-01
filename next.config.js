/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    '/api/[[...path]]': ['./data/**/*.json'],
  },
};

module.exports = nextConfig;
