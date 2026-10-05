function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json").send(JSON.stringify(body));
}

function env() {
  const url = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !service || !publishable) {
    throw new Error("Supabase server configuration is missing. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY in Vercel.");
  }
  return { url: url.replace(/\/$/, ""), service, publishable };
}

async function supabaseFetch(path, options = {}, useService = true) {
  const { url, service, publishable } = env();
  const key = useService ? service : publishable;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...(options.headers || {})
  };
  return fetch(`${url}${path}`, { ...options, headers });
}

function validateCredentials(username, password) {
  if (typeof username !== "string" || typeof password !== "string") {
    return "Username and password are required.";
  }
  const u = username.trim().toLowerCase();
  if (u.length < 3 || u.length > 30) return "Username must be 3–30 characters.";
  if (!/^[a-z0-9_.-]+$/.test(u)) {
    return "Username can contain lowercase letters, numbers, _, . and - only.";
  }
  if (password.length < 6) return "Password must contain at least 6 characters.";
  return null;
}

module.exports = { json, env, supabaseFetch, validateCredentials };
