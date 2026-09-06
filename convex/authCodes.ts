import { v } from "convex/values";
import { query } from "./_generated/server";

export const isValidPasswordResetCode = query({
  args: { code: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const code = args.code.trim();
    if (!code) {
      return false;
    }

    const codeHash = await sha256(code);
    const verificationCode = await ctx.db
      .query("authVerificationCodes")
      .withIndex("code", (q) => q.eq("code", codeHash))
      .unique();

    return Boolean(
      verificationCode &&
        verificationCode.provider === "password-reset" &&
        verificationCode.expirationTime >= Date.now(),
    );
  },
});

async function sha256(value: string) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
