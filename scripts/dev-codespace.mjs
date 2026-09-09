const portForwardingDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
const codespaceName = process.env.CODESPACE_NAME;

if (!portForwardingDomain || !codespaceName) {
  console.error("This command must be run inside a GitHub Codespace.");
  console.error("Missing variables: CODESPACE_NAME and/or GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN.");
  process.exit(1);
}

console.log("GitHub Codespaces configuration detected:");
console.log(`CODESPACE_NAME=${codespaceName}`);
console.log(`GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN=${portForwardingDomain}`);
console.log("See the README to build the public URLs and update the variables manually.");
console.log("Then run `npm run dev:convex`, update .env.local, and run `npm run dev:vite` in another terminal.");
