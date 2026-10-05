const crypto = require("crypto");
const { json, env, supabaseFetch, validateCredentials } = require("./_supabase");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });

  try {
    const { username: rawUsername, password } = req.body || {};
    const username = typeof rawUsername === "string" ? rawUsername.trim().toLowerCase() : "";
    const validation = validateCredentials(username, password);
    if (validation) return json(res, 400, { error: validation });

    const existing = await supabaseFetch(
      `/rest/v1/profiles?select=id&username=eq.${encodeURIComponent(username)}&limit=1`
    );
    if (!existing.ok) {
      const detail = await existing.text();
      console.error("Profile lookup failed:", detail);
      return json(res, 500, { error: "Could not check username availability." });
    }
    const rows = await existing.json();
    if (rows.length) return json(res, 409, { error: "That username is already taken." });

    // This is an internal Auth identifier only. It is never shown to the user.
    // The user-facing identity remains the unique username.
    const internalEmail = `${crypto.randomUUID().replace(/-/g, "")}@auth.cinevault.app`;

    const createUser = await supabaseFetch("/auth/v1/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: internalEmail,
        password,
        email_confirm: true,
        user_metadata: { username }
      })
    });

    const created = await createUser.json().catch(() => ({}));
    if (!createUser.ok) {
      console.error("Auth user creation failed:", created);
      return json(res, createUser.status === 422 ? 400 : 500, {
        error: created.msg || created.message || "Could not create account."
      });
    }

    const userId = created.id;
    if (!userId) return json(res, 500, { error: "Supabase did not return the new user ID." });

    // Create the public profile explicitly. This makes the flow work even if
    // the database does not have an auth.users trigger installed.
    const profile = await supabaseFetch("/rest/v1/profiles?on_conflict=id", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({ id: userId, username, display_name: username })
    });

    if (!profile.ok) {
      console.error("Profile creation failed:", await profile.text());
      // Remove the Auth user so a partially-created account is not left behind.
      await supabaseFetch(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
      return json(res, 500, { error: "Account could not be initialized." });
    }

    // Exchange the internal Auth email/password for the normal Supabase session.
    const token = await supabaseFetch("/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: internalEmail, password })
    }, false);

    const session = await token.json().catch(() => ({}));
    if (!token.ok) {
      console.error("Session creation failed:", session);
      return json(res, 500, { error: "Account was created but login session could not be created." });
    }

    return json(res, 201, {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      user: { id: userId, username }
    });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error.message || "Signup failed." });
  }
};
