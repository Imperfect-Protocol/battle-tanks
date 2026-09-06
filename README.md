# Battle Tanks

Project code: `WWEFFP`

Battle Tanks is a Convex-backed realtime tank tactics game. Two players join the same board, submit command scripts, and watch the shared arena update in both browser sessions.

## Development

```sh
npm install
npm run dev
```

`npm run dev` starts Convex and Vite together after the app is connected to a Convex project.

## OAuth

The app uses Convex Auth with Google OAuth. Local auth keys and `SITE_URL` are set on the local Convex deployment.

Create Google OAuth credentials with this local redirect URI:

```txt
http://127.0.0.1:3211/api/auth/callback/google
```

Then set the Google credentials in Convex:

```sh
npx convex env set AUTH_GOOGLE_ID=<google-client-id>
npx convex env set AUTH_GOOGLE_SECRET=<google-client-secret>
```
