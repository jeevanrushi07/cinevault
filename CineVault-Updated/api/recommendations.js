function sendMethodNotAllowed(res) {
  res.setHeader("Allow","GET");
  return res.status(405).json({error:"Method not allowed."});
}

export default async function handler(req,res) {
  if (req.method!=="GET") return sendMethodNotAllowed(res);

  const rawIds=String(req.query?.ids||"");
  const ids=[...new Set(rawIds.split(",").map(id=>id.trim()).filter(id=>/^\d+$/.test(id)))].slice(0,5);
  const type=req.query?.type==="series"?"tv":"movie";
  const key=process.env.TMDB_API_KEY||req.headers["x-tmdb-api-key"];

  if (!ids.length) return res.status(400).json({error:"At least one valid TMDB title ID is required."});
  if (!key) return res.status(503).json({error:"TMDB API key not configured"});

  try {
    const responses=await Promise.all(ids.map(async id=>{
      const response=await fetch(
        `https://api.themoviedb.org/3/${type}/${encodeURIComponent(id)}/recommendations?api_key=${encodeURIComponent(key)}&language=en-US&page=1`
      );
      const body=await response.json();
      if (!response.ok) {
        throw new Error(body.status_message||`TMDB recommendations returned HTTP ${response.status}.`);
      }
      return body.results||[];
    }));

    const ranked=new Map();
    responses.forEach((results,seedIndex)=>{
      results.forEach((item,itemIndex)=>{
        if (!item.id) return;
        const current=ranked.get(item.id)||{item,score:0};
        current.score+=(ids.length-seedIndex)*100+(results.length-itemIndex);
        ranked.set(item.id,current);
      });
    });
    const recommendations=[...ranked.values()]
      .sort((a,b)=>b.score-a.score||(Number(b.item.vote_average)||0)-(Number(a.item.vote_average)||0))
      .slice(0,30)
      .map(({item})=>({
        id:item.id,
        title:item.title||item.name||"",
        type:type==="tv"?"series":"movie",
        posterPath:item.poster_path||"",
        backdropPath:item.backdrop_path||"",
        year:(item.release_date||item.first_air_date||"").slice(0,4),
        overview:item.overview||"",
        genreIds:Array.isArray(item.genre_ids)?item.genre_ids:[],
        tmdbRating:item.vote_average||null
      }));

    res.setHeader("Cache-Control","public, s-maxage=1800, stale-while-revalidate=3600");
    return res.status(200).json({recommendations});
  } catch(error) {
    console.error("TMDB recommendation lookup failed:",error);
    return res.status(502).json({error:error.message||"Could not load TMDB recommendations."});
  }
}
