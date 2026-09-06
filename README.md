# Battle Tanks

Project code: `WWEFFP`

Battle Tanks is a Convex-backed realtime tank tactics game. Two players join the same board, submit command scripts, and watch the shared arena update in both browser sessions.

## Development

```sh
npm install
npm run dev
```

`npm run dev` starts Convex and Vite together after the app is connected to a Convex project.

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
