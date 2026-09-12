# Setting Up Verified Commit Signatures on GitHub

## The Problem

You're getting an error when trying to merge or push to the main branch:

```
Merging is blocked
- Cannot update this protected ref.
- Commits must have verified signatures.
```

This occurs because the branch is protected and requires that **all commits have verified GPG/SSH signatures** before being accepted into the repository.

## Prerequisites

To resolve this, you'll need:

- An SSH key configured on your computer/Codespace (or create a new one)
- Access to GitHub settings
- Terminal bash or similar
- Git configured locally

## Step-by-Step Guide: Configure SSH Key

### Step 1: Check if you already have an SSH key

```bash
ls -la ~/.ssh/
```

Look for files like:
- `id_ed25519` (private key)
- `id_ed25519.pub` (public key)
- `id_rsa` and `id_rsa.pub` (alternative, less recommended)

### Step 2: Create an SSH key (if you don't have one)

If the `~/.ssh/` directory doesn't exist or is empty:

```bash
ssh-keygen -t ed25519 -C "your.email@github.com"
```

**Instructions during the command:**

1. When prompted `Enter file in which to save the key:`, just press **Enter** to accept the default path (`~/.ssh/id_ed25519`)
2. When prompted `Enter passphrase:`, you can:
   - Leave it blank (just press Enter twice) for maximum convenience
   - Or set a password for extra security (recommended for production)

**Verify creation:**

```bash
ls -la ~/.ssh/
```

You should now see:
- `id_ed25519` (private key - DO NOT share!)
- `id_ed25519.pub` (public key - add to GitHub)

### Step 3: Copy your public key

```bash
cat ~/.ssh/id_ed25519.pub
```

Copy the entire output (starts with `ssh-ed25519` and ends with email). It will look similar to:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJqK... your.email@github.com
```

### Step 4: Add the public key to GitHub

1. Go to [https://github.com/settings/keys](https://github.com/settings/keys)
2. Click **"New SSH key"**
3. Fill in the fields:
   - **Title:** `Codespace` (or any descriptive name)
   - **Key type:** **⚠️ Select "Signing Key"** (essential!)
   - **Key:** Paste the full key copied in the previous step
4. Click **"Add SSH key"**

### Step 5: Configure Git to use the SSH key

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519
git config --global commit.gpgsign true
```

**Verify configuration:**

```bash
git config --list | grep -E "gpg|signing"
```

You should see:

```
gpg.format=ssh
user.signingkey=~/.ssh/id_ed25519
commit.gpgsign=true
```

## Configure Allowed Signers

⚠️ **This step is critical** for Git to properly verify and display signatures.

### Step 6: Create the allowed signers file

```bash
touch ~/.ssh/allowed_signers
```

### Step 7: Add your public key to it

```bash
echo "$(git config user.email) $(cat ~/.ssh/id_ed25519.pub)" >> ~/.ssh/allowed_signers
```

### Step 8: Configure Git to use this file

```bash
git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers
```

## Testing and Verification

### Make a test commit

```bash
git commit --allow-empty -m "test: verify SSH signature"
```

### Verify the commit was signed correctly

```bash
git log --show-signature -1
```

**Expected:** The output should show

```
Good "git" signature from your.email@github.com
```

If everything is correct, you'll see: ✅ **Good "git" signature**

## Verification Checklist

- ✅ SSH key created at `~/.ssh/id_ed25519` and `~/.ssh/id_ed25519.pub`
- ✅ Public key added to GitHub Settings → SSH and GPG keys → As "Signing Key"
- ✅ `git config gpg.format` = `ssh`
- ✅ `git config user.signingkey` = `~/.ssh/id_ed25519`
- ✅ `git config commit.gpgsign` = `true`
- ✅ File `~/.ssh/allowed_signers` created
- ✅ Public key added to `allowed_signers` file
- ✅ `git config gpg.ssh.allowedSignersFile` = `~/.ssh/allowed_signers`
- ✅ Test commit signed successfully
- ✅ `git log --show-signature` shows "Good git signature"

## Next Steps

After completing this configuration:

1. **Your commits will be signed automatically** - no extra steps needed
2. **You can push/merge** to protected branches that require signatures
3. **Commits will appear with a verified badge** on GitHub (green checkmark seal)

## Troubleshooting

### Issue: "error: gpg.ssh.allowedSignersFile needs to be configured"

**Solution:** You skipped Steps 6-8. Run:
```bash
touch ~/.ssh/allowed_signers
echo "$(git config user.email) $(cat ~/.ssh/id_ed25519.pub)" >> ~/.ssh/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers
```

### Issue: Commits are not being signed

**Check:**
```bash
git config --list | grep commit.gpgsign
```

Should show `commit.gpgsign=true`. If not, run:
```bash
git config --global commit.gpgsign true
```

### Issue: Passphrase error when committing

If you added a passphrase to your SSH key, Git may ask for it each commit. To avoid this:

- Use `ssh-agent` (Linux/Mac): adds the key to the agent for the current session
- Use GitHub Desktop or another client that manages passphrases

## Quick Reference

| Task | Command |
|------|---------|
| List local SSH keys | `ls -la ~/.ssh/` |
| Create new SSH key | `ssh-keygen -t ed25519 -C "email@example.com"` |
| View public key | `cat ~/.ssh/id_ed25519.pub` |
| Check git config | `git config --list \| grep gpg` |
| Test signature | `git log --show-signature -1` |
| Open GitHub SSH settings | [github.com/settings/keys](https://github.com/settings/keys) |

---

**Documented on:** 2026-09-09
**Status:** Tested and working on GitHub Codespace
