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
  async headers() {
    const headers = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ];
    if (process.env.NODE_ENV === 'production') {
      headers.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' });
    }
    return [{ source: '/:path*', headers }];
  },
};

module.exports = nextConfig;
