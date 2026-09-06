import GitHub from "@auth/core/providers/github";
import { Email } from "@convex-dev/auth/providers/Email";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

const PasswordReset = Email({
  id: "password-reset",
  name: "Password Reset",
  from: "Battle Tanks <onboarding@resend.dev>",
  maxAge: 30 * 60,
  async sendVerificationRequest({ identifier, url, provider }) {
    const apiKey = process.env.AUTH_RESEND_KEY;
    if (!apiKey) {
      console.info(`[Battle Tanks] Password reset link for ${identifier}: ${url}`);
      return;
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: provider.from,
        to: identifier,
        subject: "Reset your Battle Tanks password",
        html: `<p>Reset your Battle Tanks password:</p><p><a href="${url}">${url}</a></p>`,
        text: `Reset your Battle Tanks password: ${url}`,
      }),
    });

    if (!response.ok) {
      throw new Error("Could not send password reset email");
    }
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
    }),
    Password({ reset: PasswordReset }),
  ],
});
