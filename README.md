# Battle Tanks

Battle Tanks is a Convex-backed realtime tank tactics game. Two players join the same board, submit command scripts, and watch the shared arena update in both browser sessions.

## Development

First install dependencies, create the local Convex deployment, and generate the Convex Auth keys for that deployment:

```sh
npm install
npx convex dev --once
npx @convex-dev/auth --skip-git-check --web-server-url http://127.0.0.1:5173
```

Then run the whole app:

```sh
npm run dev
```

`npm run dev` starts Convex and Vite together. The auth setup command sets `JWT_PRIVATE_KEY`, `JWKS`, and `SITE_URL` on the local Convex deployment; those values are not committed to git.

## Auth

The app uses Convex Auth with only two sign-in methods enabled:

- GitHub OAuth
- Email and password

Local Convex Auth keys and `SITE_URL` are set on the local Convex deployment.

Create GitHub OAuth credentials with this local callback URL:

```txt
http://127.0.0.1:3211/api/auth/callback/github
```

Then set the GitHub credentials in Convex:

```sh
npx convex env set AUTH_GITHUB_ID=<github-client-id>
npx convex env set AUTH_GITHUB_SECRET=<github-client-secret>
```

Password sign-in does not need an external OAuth client.

Password reset links are sent through Resend when this Convex environment variable is set:

```sh
npx convex env set AUTH_RESEND_KEY=<resend-api-key>
```

Without `AUTH_RESEND_KEY`, local development logs the reset link in the Convex output.

## Running on GitHub Codespaces

See the [GitHub Codespaces Guide](docs/GITHUB_CODESPACES.md) for detailed setup instructions.

## Convex

**Convex is primarily PaaS**: it provides a ready-made platform/backend for your application, including database, functions, and managed infrastructure.
   * **IaaS (Infrastructure as a Service)** → you receive infrastructure: servers, networks, storage. Example: AWS EC2.
   * **PaaS (Platform as a Service)** → you receive a ready-made platform to **run your application**, without managing infrastructure. Example: Heroku.
   * **SaaS (Software as a Service)** → you receive **ready-to-use software**. Example: Gmail.

## Commit Signatures

This repository requires all commits to have verified signatures. See the [GitHub Commit Signatures Guide](docs/GITHUB_COMMIT_SIGNATURES.md) for step-by-step instructions on setting up SSH-based commit signing.

