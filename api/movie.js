async function readServiceJson(response,service) {
  const body=await response.text();
  try {
    return JSON.parse(body);
  } catch {
    const excerpt=body.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim().slice(0,180);
    throw new Error(`${service} returned a non-JSON response (HTTP ${response.status})${excerpt?`: ${excerpt}`:"."}`);
  }
}

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
      data=await readServiceJson(response,"TMDB");
      if (response.ok) {
        type=endpoint==="tv"?"series":"movie";
        break;
      }
    }
  } catch (error) {
    console.error("TMDB movie detail lookup failed:",error);
    return res.status(502).json({error:error.message||"Could not reach TMDB for movie details."});
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
  const imdbId=data.external_ids?.imdb_id||"";
  let imdbRating=null;
  let imdbRatingError="";
  const omdbKey=process.env.OMDB_API_KEY;
  if (!omdbKey&&imdbId) imdbRatingError="Configure OMDB_API_KEY in Vercel to load IMDb ratings.";
  if (imdbId&&omdbKey) {
    try {
      const ratingResponse=await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(omdbKey)}`);
      const ratingData=await readServiceJson(ratingResponse,"OMDb");
      if (ratingResponse.ok&&ratingData.Response!=="False"&&ratingData.imdbRating&&ratingData.imdbRating!=="N/A") {
        imdbRating=ratingData.imdbRating;
      } else {
        imdbRatingError=ratingData.Error||"IMDb rating is unavailable.";
      }
    } catch (error) {
      console.error("IMDb rating lookup failed:",error);
      imdbRatingError=error.message||"Could not load the IMDb rating.";
    }
  }

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
    imdbId,
    imdbRating,
    imdbRatingError,
    tmdbRating:data.vote_average,
    runtimeMinutes:data.runtime||null,
    episodeRuntime:data.episode_run_time||[],
    seasonCount:data.number_of_seasons||null,
    episodeCount:data.number_of_episodes||null,
    type,
    status:"watched",
    personalNote:"",
    addedAt:new Date().toISOString()
  });
}
