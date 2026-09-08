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

# Running on GitHub Codespaces

https://github.com/features/codespaces

The project uses three services during development:

- Vite: web interface on port `5173`.
- Convex: API and database on port `3210`.
- Convex Auth: authentication on port `3211`.

On GitHub Codespaces, follow these steps:

1. Run the diagnostic:

```sh
npm run dev:codespace
```

The command displays `CODESPACE_NAME` and `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`. It does not modify files or start services.

2. Start Convex:

```sh
npm run dev:convex
```

Wait for `Convex functions ready!` to appear. This command may automatically update `.env.local` with local URLs. This is expected; the URLs will be configured in the next step.

3. Replace `<codespace>` with the value of `CODESPACE_NAME` and `<domain>` with the value of `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`. Use these values to manually update `.env.local`:

```env
VITE_CONVEX_URL=https://<codespace>-3210.<domain>
VITE_CONVEX_SITE_URL=https://<codespace>-3211.<domain>
```

In Convex, these two variables point to different servers:

- `VITE_CONVEX_URL`: URL of the main Convex backend. The frontend uses this URL to access queries, mutations, and actions.
- `VITE_CONVEX_SITE_URL`: URL of the Convex HTTP server. It is used to access HTTP endpoints, such as authentication endpoints and other custom endpoints.

In the Codespaces environment:

- `3210` is the main Convex backend.
- `3211` is the Convex HTTP server.
- `3211` is not the Vite application. The Vite application continues running on port `5173`.

Configure the origin used by Convex Auth:

```sh
npx convex env set SITE_URL https://<codespace>-5173.<domain>
```

### Why is this configuration necessary on Codespaces?

In local development, the frontend accesses Convex via `127.0.0.1`. On GitHub Codespaces, the application runs inside the container and must be accessed by the browser through forwarded port URLs.

Therefore, on Codespaces, `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` must point to the URLs of ports `3210` and `3211`. The `SITE_URL` variable must also be configured in the Convex deployment to tell Convex Auth what the origin of the application is.

This configuration is only necessary to access the project via Codespaces. In local development, keep the URLs as `http://127.0.0.1`.

4. In another terminal, after updating `.env.local` with the URLs, start Vite:

```sh
npm run dev:vite
```

5. Expose the ports after the services start:

   In the Codespaces **Ports** panel, verify that ports `3210`, `3211`, `5173`, and `6790` have been automatically forwarded. If any are not available, forward them manually.

   In this workflow, change the visibility of ports `3210`, `3211`, `5173`, and `6790` to **Public**. Ports `3210` and `3211` must be public so the frontend can establish a WebSocket connection with Convex and access the authentication HTTP server. Port `5173` exposes the Vite application.

### Which URL should I use to access the application?

When accessing the frontend in a browser, inside or outside the Codespace, use the URL forwarded by GitHub Codespaces:

```txt
https://<codespace>-5173.<domain>/sign-in
```

In this project's example:

```txt
https://ominous-fiesta-5xjq7jrxrw7hv64-5173.app.github.dev/sign-in
```

To return to local development, restore these values in `.env.local`:

```env
VITE_CONVEX_URL=http://127.0.0.1:3210
VITE_CONVEX_SITE_URL=http://127.0.0.1:3211
```

Then restore the origin of Convex Auth:

```sh
npx convex env set SITE_URL http://127.0.0.1:5173
```

Do not remove other variables from `.env.local`, such as authentication credentials.


### Convex

**Convex is primarily PaaS**: it provides a ready-made platform/backend for your application, including database, functions, and managed infrastructure.
   * **IaaS (Infrastructure as a Service)** → you receive infrastructure: servers, networks, storage. Example: AWS EC2.
   * **PaaS (Platform as a Service)** → you receive a ready-made platform to **run your application**, without managing infrastructure. Example: Heroku.
   * **SaaS (Software as a Service)** → you receive **ready-to-use software**. Example: Gmail.

