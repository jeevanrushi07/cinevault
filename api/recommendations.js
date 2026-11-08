function sendMethodNotAllowed(res) {
  res.setHeader("Allow","GET");
  return res.status(405).json({error:"Method not allowed."});
}

async function tmdbJson(path,key) {
  const response=await fetch(
    `https://api.themoviedb.org/3${path}${path.includes("?")?"&":"?"}api_key=${encodeURIComponent(key)}`
  );
  const body=await response.json();
  if (!response.ok) throw new Error(body.status_message||`TMDB returned HTTP ${response.status}.`);
  return body;
}

async function genreCatalog(res,key) {
  const [movieGenres,tvGenres,languages]=await Promise.all([
    tmdbJson("/genre/movie/list?language=en-US",key),
    tmdbJson("/genre/tv/list?language=en-US",key),
    tmdbJson("/configuration/languages",key)
  ]);
  const movieIds=new Map((movieGenres.genres||[]).map(genre=>[genre.name.toLocaleLowerCase(),genre.id]));
  const tvIds=new Map((tvGenres.genres||[]).map(genre=>[genre.name.toLocaleLowerCase(),genre.id]));
  const genres=[...new Set([
    ...(movieGenres.genres||[]).map(genre=>genre.name),
    ...(tvGenres.genres||[]).map(genre=>genre.name)
  ])].sort((a,b)=>a.localeCompare(b)).map(name=>({
    name,
    movieId:movieIds.get(name.toLocaleLowerCase())||null,
    tvId:tvIds.get(name.toLocaleLowerCase())||null
  }));
  res.setHeader("Cache-Control","public, s-maxage=86400, stale-while-revalidate=172800");
  return res.status(200).json({
    genres,
    languages:(languages||[]).map(language=>({
      code:language.iso_639_1,
      name:language.english_name||language.name||language.iso_639_1
    })).filter(language=>language.code&&language.name)
  });
}

async function discoverByGenres(res,key,names,animeOnly=false) {
  if (animeOnly&&!names.includes("animation")) names.push("animation");
  if (!names.length) return res.status(400).json({error:"Select at least one genre to explore."});
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
    if (animeOnly) params.set("with_original_language","ja");
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
}

export default async function handler(req,res) {
  if (req.method!=="GET") return sendMethodNotAllowed(res);

  const key=process.env.TMDB_API_KEY||req.headers["x-tmdb-api-key"];
  if (!key) return res.status(503).json({error:"TMDB API key not configured"});
  if (req.query?.catalog==="true") {
    try {
      return await genreCatalog(res,key);
    } catch(error) {
      console.error("TMDB genre and language catalog lookup failed:",error);
      return res.status(502).json({error:error.message||"Could not load TMDB filters."});
    }
  }
  if (req.query?.genres!==undefined||req.query?.anime==="true") {
    const names=[...new Set(String(req.query.genres||"").split(",")
      .map(name=>name.trim().toLocaleLowerCase()).filter(Boolean))];
    try {
      return await discoverByGenres(res,key,names,req.query?.anime==="true");
    } catch(error) {
      console.error("TMDB genre and anime discovery lookup failed:",error);
      return res.status(502).json({error:error.message||"Could not load titles for these filters."});
    }
  }

  const rawIds=String(req.query?.ids||"");
  const ids=[...new Set(rawIds.split(",").map(id=>id.trim()).filter(id=>/^\d+$/.test(id)))].slice(0,5);
  const type=req.query?.type==="series"?"tv":"movie";

  if (!ids.length) return res.status(400).json({error:"At least one valid TMDB title ID is required."});

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
        originalLanguage:item.original_language||"",
        tmdbRating:item.vote_average||null
      }));

    res.setHeader("Cache-Control","public, s-maxage=1800, stale-while-revalidate=3600");
    return res.status(200).json({recommendations});
  } catch(error) {
    console.error("TMDB recommendation lookup failed:",error);
    return res.status(502).json({error:error.message||"Could not load TMDB recommendations."});
  }
}
