function methodNotAllowed(res) {
  res.setHeader("Allow","GET");
  return res.status(405).json({error:"Method not allowed."});
}

export default async function handler(req,res) {
  if (req.method!=="GET") return methodNotAllowed(res);
  const query=String(req.query?.query||"").trim().slice(0,120);
  const key=process.env.TMDB_API_KEY||req.headers["x-tmdb-api-key"];
  if (query.length<2) return res.status(400).json({error:"Search for at least two letters."});
  if (!key) return res.status(503).json({error:"TMDB API key not configured"});

  try {
    const response=await fetch(
      `https://api.themoviedb.org/3/search/person?include_adult=false&language=en-US&page=1&query=${encodeURIComponent(query)}&api_key=${encodeURIComponent(key)}`
    );
    const body=await response.json();
    if (!response.ok) {
      return res.status(response.status).json({error:body.status_message||"TMDB could not search for people."});
    }
    const results=(body.results||[]).filter(person=>person.id&&person.name).slice(0,16).map(person=>({
      id:person.id,
      name:person.name,
      profile_path:person.profile_path||"",
      known_for_department:person.known_for_department||"FILM & TELEVISION",
      known_for:(person.known_for||[]).slice(0,3).map(item=>item.title||item.name||"").filter(Boolean)
    }));
    res.setHeader("Cache-Control","public, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({results});
  } catch(error) {
    console.error("TMDB favorite-people search failed:",error);
    return res.status(502).json({error:error.message||"Could not search TMDB people."});
  }
}
