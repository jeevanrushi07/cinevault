export default async function handler(req,res) {
  const id=req.query?.id||req.url.split("?")[0].split("/").pop();
  const key=process.env.TMDB_API_KEY||req.headers["x-tmdb-api-key"];
  if (!key) return res.status(503).json({error:"TMDB API key not configured"});

  let requestedType=req.query?.type;
  if (!requestedType&&req.url.includes("?")) {
    requestedType=new URL(req.url,"http://localhost").searchParams.get("type");
  }
  const endpoints=requestedType==="series"?["tv"]:requestedType==="movie"?["movie"]:["movie","tv"];
  let response;
  let data;
  let type;

  try {
    for (const endpoint of endpoints) {
      response=await fetch(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(id)}?api_key=${encodeURIComponent(key)}&append_to_response=credits,videos,external_ids`);
      data=await response.json();
      if (response.ok) {
        type=endpoint==="tv"?"series":"movie";
        break;
      }
    }
  } catch (error) {
    console.error("TMDB movie detail lookup failed:",error);
    return res.status(502).json({error:"Could not reach TMDB for movie details."});
  }

  if (!response?.ok) {
    return res.status(response?.status||502).json({
      error:data?.status_message||"TMDB could not find details for this title."
    });
  }

  const credits=data.credits||{};
  const castDetails=(credits.cast||[]).slice(0,12).map(person=>({
    id:person.id,
    name:person.name,
    character:person.character||"",
    profilePath:person.profile_path||""
  }));
  const directorPerson=(credits.crew||[]).find(person=>person.job==="Director");
  const creator=(data.created_by||[])[0];
  const directorDetails=directorPerson
    ? {id:directorPerson.id,name:directorPerson.name,profilePath:directorPerson.profile_path||""}
    : creator
      ? {id:creator.id,name:creator.name,profilePath:creator.profile_path||""}
      : null;
  const trailer=(data.videos?.results||[]).find(video=>
    video.site==="YouTube"&&["Trailer","Teaser"].includes(video.type)
  );

  return res.status(200).json({
    tmdbId:data.id,
    title:data.title||data.name,
    originalTitle:data.original_title||data.original_name,
    year:(data.release_date||data.first_air_date||"").slice(0,4),
    posterPath:data.poster_path,
    backdropPath:data.backdrop_path,
    overview:data.overview||"",
    genres:(data.genres||[]).map(genre=>genre.name),
    cast:castDetails.map(person=>person.name),
    castDetails,
    director:directorDetails?.name||"",
    directorDetails,
    directorLabel:type==="series"&&creator&&!directorPerson?"CREATOR":"DIRECTOR",
    trailerKey:trailer?.key||"",
    imdbId:data.external_ids?.imdb_id||"",
    tmdbRating:data.vote_average,
    type,
    status:"watched",
    personalNote:"",
    addedAt:new Date().toISOString()
  });
}
