const { json, env, supabaseFetch, validateCredentials } = require("./_supabase");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });

  try {
    const { username: rawUsername, password } = req.body || {};
    const username = typeof rawUsername === "string" ? rawUsername.trim().toLowerCase() : "";
    const validation = validateCredentials(username, password);
    if (validation) return json(res, 400, { error: validation });

    const profileResponse = await supabaseFetch(
      `/rest/v1/profiles?select=id,username&username=eq.${encodeURIComponent(username)}&limit=1`
    );
    if (!profileResponse.ok) {
      console.error("Profile lookup failed:", await profileResponse.text());
      return json(res, 500, { error: "Could not sign in." });
    }

    const profiles = await profileResponse.json();
    if (!profiles.length) return json(res, 401, { error: "Invalid username or password." });

    const userId = profiles[0].id;

    // Get the internal Auth email on the server only. It is never sent to the browser.
    const userResponse = await supabaseFetch(`/auth/v1/admin/users/${encodeURIComponent(userId)}`);
    if (!userResponse.ok) {
      console.error("Auth user lookup failed:", await userResponse.text());
      return json(res, 401, { error: "Invalid username or password." });
    }

    const authUser = await userResponse.json();
    if (!authUser.email) return json(res, 401, { error: "Invalid username or password." });

    const { publishable } = env();
    const tokenResponse = await fetch(
      `${process.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          apikey: publishable,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email: authUser.email, password })
      }
    );

    const session = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok) return json(res, 401, { error: "Invalid username or password." });

    return json(res, 200, {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      user: { id: userId, username }
    });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "Could not sign in." });
  }
};
