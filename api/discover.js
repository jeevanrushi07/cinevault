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
  const names=[...new Set(String(req.query?.genres||"").split(",")
    .map(name=>name.trim().toLocaleLowerCase()).filter(Boolean))];
  const key=process.env.TMDB_API_KEY||req.headers["x-tmdb-api-key"];
  if (!key) return res.status(503).json({error:"TMDB API key not configured"});
  if (!names.length) return res.status(400).json({error:"Select at least one genre to explore."});

  try {
    const [movieCatalog,tvCatalog]=await Promise.all([
      tmdbJson("/genre/movie/list?language=en-US",key),
      tmdbJson("/genre/tv/list?language=en-US",key)
    ]);
    const genreSets=[
      {type:"movie",genres:movieCatalog.genres||[]},
      {type:"series",genres:tvCatalog.genres||[]}
    ].map(({type,genres})=>({
      type,
      ids:names.map(name=>genres.find(genre=>genre.name.toLocaleLowerCase()===name)?.id)
    })).filter(({ids})=>ids.length&&ids.every(Boolean));

    if (!genreSets.length) {
      return res.status(400).json({error:"The selected genres are not available for movies or series."});
    }

    const resultSets=await Promise.all(genreSets.map(async({type,ids})=>{
      const endpoint=type==="series"?"tv":"movie";
      const params=new URLSearchParams({
        language:"en-US",
        include_adult:"false",
        sort_by:"popularity.desc",
        with_genres:ids.join("|"),
        page:"1"
      });
      const data=await tmdbJson(`/discover/${endpoint}?${params}`,key);
      return (data.results||[]).map(item=>({
        id:item.id,
        title:item.title||item.name||"",
        type,
        posterPath:item.poster_path||"",
        year:(item.release_date||item.first_air_date||"").slice(0,4),
        overview:item.overview||"",
        genreIds:Array.isArray(item.genre_ids)?item.genre_ids:[],
        originalLanguage:item.original_language||"",
        tmdbRating:Number(item.vote_average)||null,
        popularity:Number(item.popularity)||0
      }));
    }));
    const recommendations=resultSets.flat()
      .sort((a,b)=>b.popularity-a.popularity)
      .filter((item,index,list)=>list.findIndex(other=>
        String(other.id)===String(item.id)&&other.type===item.type
      )===index)
      .slice(0,30)
      .map(({popularity,...item})=>item);

    res.setHeader("Cache-Control","public, s-maxage=1800, stale-while-revalidate=3600");
    return res.status(200).json({recommendations});
  } catch(error) {
    console.error("TMDB genre discovery lookup failed:",error);
    return res.status(502).json({error:error.message||"Could not load titles for these genres."});
  }
}
