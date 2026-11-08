async function tmdbJson(path,key) {
  const response=await fetch(
    `https://api.themoviedb.org/3${path}${path.includes("?")?"&":"?"}api_key=${encodeURIComponent(key)}`
  );
  const body=await response.json();
  if (!response.ok) throw new Error(body.status_message||`TMDB returned HTTP ${response.status}.`);
  return body;
}

export default async function handler(req,res) {
  if (req.method!=="GET") {
    res.setHeader("Allow","GET");
    return res.status(405).json({error:"Method not allowed."});
  }
  const key=process.env.TMDB_API_KEY||req.headers["x-tmdb-api-key"];
  if (!key) return res.status(503).json({error:"TMDB API key not configured"});

  try {
    const [movieGenres,tvGenres,languages]=await Promise.all([
      tmdbJson("/genre/movie/list?language=en-US",key),
      tmdbJson("/genre/tv/list?language=en-US",key),
      tmdbJson("/configuration/languages",key)
    ]);
    const genres=[...new Map(
      [...(movieGenres.genres||[]),...(tvGenres.genres||[])].map(genre=>[
        String(genre.name).toLocaleLowerCase(),
        {name:genre.name,movieId:movieGenres.genres?.find(item=>item.name===genre.name)?.id||null,
          tvId:tvGenres.genres?.find(item=>item.name===genre.name)?.id||null}
      ])
    ).values()].sort((a,b)=>a.name.localeCompare(b.name));
    res.setHeader("Cache-Control","public, s-maxage=86400, stale-while-revalidate=172800");
    return res.status(200).json({
      genres,
      languages:(languages||[]).map(language=>({
        code:language.iso_639_1,
        name:language.english_name||language.name||language.iso_639_1
      })).filter(language=>language.code&&language.name)
    });
  } catch(error) {
    console.error("TMDB genre and language catalog lookup failed:",error);
    return res.status(502).json({error:error.message||"Could not load TMDB filters."});
  }
}
