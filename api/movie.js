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
      response=await fetch(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(id)}?api_key=${encodeURIComponent(key)}&append_to_response=credits,videos,external_ids,images&include_image_language=en,null`);
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
    profilePath:person.profile_path||"",
    jobs:["Actor"]
  }));
  const productionJobs=new Set([
    "Director","Producer","Executive Producer","Co-Producer","Associate Producer",
    "Music Director","Music","Original Music Composer","Composer","Music Supervisor",
    "Writer","Screenplay","Story","Teleplay","Screenwriter","Director of Photography",
    "Cinematography","Editor","Production Design","Art Direction","Costume Design",
    "Sound Designer","Casting Director"
  ]);
  const productionPeople=new Map();
  for (const person of credits.crew||[]) {
    if (!productionJobs.has(person.job)||!person.id) continue;
    const current=productionPeople.get(person.id)||{
      id:person.id,
      name:person.name,
      profilePath:person.profile_path||"",
      jobs:[]
    };
    if (!current.jobs.includes(person.job)) current.jobs.push(person.job);
    productionPeople.set(person.id,current);
  }
  const creator=(data.created_by||[])[0];
  if (creator?.id&&!productionPeople.has(creator.id)) {
    productionPeople.set(creator.id,{
      id:creator.id,
      name:creator.name,
      profilePath:creator.profile_path||"",
      jobs:["Creator"]
    });
  }
  const productionPriority=person=>{
    const jobs=person.jobs||[];
    if (jobs.includes("Director")) return 0;
    if (jobs.some(job=>["Music Director","Music","Original Music Composer","Composer","Music Supervisor"].includes(job))) return 1;
    if (jobs.some(job=>["Producer","Executive Producer","Co-Producer","Associate Producer"].includes(job))) return 2;
    if (jobs.includes("Creator")) return 3;
    if (jobs.some(job=>["Writer","Screenplay","Story","Teleplay","Screenwriter"].includes(job))) return 4;
    if (jobs.some(job=>["Director of Photography","Cinematography"].includes(job))) return 5;
    if (jobs.some(job=>["Editor","Casting Director"].includes(job))) return 6;
    if (jobs.some(job=>["Production Design","Art Direction","Costume Design"].includes(job))) return 7;
    return 8;
  };
  const production=[...productionPeople.values()]
    .sort((a,b)=>productionPriority(a)-productionPriority(b)||a.name.localeCompare(b.name));
  const directorDetails=production.find(person=>person.jobs.includes("Director"))||null;
  const trailerVideos=(data.videos?.results||[])
    .filter(video=>video.site==="YouTube"&&["Trailer","Teaser"].includes(video.type)&&video.key)
    .sort((a,b)=>{
      const score=video=>
        (video.type==="Trailer"?100:0)+
        (video.official?40:0)+
        (video.iso_639_1==="en"?20:0)+
        (video.size>=1080?10:video.size>=720?5:0)+
        (video.name?.toLowerCase().includes("trailer")?3:0);
      return score(b)-score(a);
    });
  const trailerKeys=[...new Set(trailerVideos.map(video=>video.key))];
  const imdbId=data.external_ids?.imdb_id||"";
  const backdropPaths=[...new Set([
    data.backdrop_path,
    ...(data.images?.backdrops||[])
      .slice()
      .sort((a,b)=>(Number(b.vote_average)||0)-(Number(a.vote_average)||0))
      .map(image=>image.file_path)
  ].filter(path=>typeof path==="string"&&path.startsWith("/")))].slice(0,8);
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
    backdropPaths,
    overview:data.overview||"",
    genres:(data.genres||[]).map(genre=>genre.name),
    cast:castDetails.map(person=>person.name),
    castDetails,
    director:directorDetails?.name||"",
    directorDetails,
    production,
    directorLabel:type==="series"&&creator&&!directorDetails?"CREATOR":"DIRECTOR",
    trailerKey:trailerKeys[0]||"",
    trailerKeys,
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
