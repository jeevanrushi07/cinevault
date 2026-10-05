async function readTmdbJson(response) {
  const body=await response.text();
  try {
    return JSON.parse(body);
  } catch {
    const excerpt=body.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim().slice(0,160);
    throw new Error(`TMDB returned a non-JSON response (HTTP ${response.status})${excerpt?`: ${excerpt}`:"."}`);
  }
}

export default async function handler(req,res) {
  const id=req.query?.id||new URL(req.url,"http://localhost").searchParams.get("id");
  const key=process.env.TMDB_API_KEY||req.headers["x-tmdb-api-key"];
  if (!id) return res.status(400).json({error:"A TMDB person ID is required."});
  if (!key) return res.status(503).json({error:"TMDB API key not configured"});

  try {
    const [personResponse,creditsResponse]=await Promise.all([
      fetch(`https://api.themoviedb.org/3/person/${encodeURIComponent(id)}?api_key=${encodeURIComponent(key)}&append_to_response=external_ids`),
      fetch(`https://api.themoviedb.org/3/person/${encodeURIComponent(id)}/combined_credits?api_key=${encodeURIComponent(key)}&language=en-US`)
    ]);
    const [person,credits]=await Promise.all([
      readTmdbJson(personResponse),
      readTmdbJson(creditsResponse)
    ]);
    if (!personResponse.ok) {
      return res.status(personResponse.status).json({error:person.status_message||"TMDB could not find this person."});
    }
    if (!creditsResponse.ok) {
      return res.status(creditsResponse.status).json({error:credits.status_message||"TMDB could not load this person's credits."});
    }

    const grouped=new Map();
    for (const item of [...(credits.cast||[]),...(credits.crew||[])]) {
      if (!item.id||!item.media_type) continue;
      const mediaType=item.media_type==="tv"?"tv":"movie";
      const keyId=`${mediaType}:${item.id}`;
      const credit=grouped.get(keyId)||{
        id:item.id,
        mediaType,
        title:item.title||item.name||"",
        year:(item.release_date||item.first_air_date||"").slice(0,4),
        posterPath:item.poster_path||"",
        roles:[],
        popularity:Number(item.popularity)||0
      };
      const role=item.character?`Actor · ${item.character}`:item.job||"Crew";
      if (!credit.roles.includes(role)) credit.roles.push(role);
      grouped.set(keyId,credit);
    }
    const filmography=[...grouped.values()]
      .sort((a,b)=>b.popularity-a.popularity||b.year.localeCompare(a.year))
      .slice(0,48)
      .map(({popularity,...credit})=>credit);

    return res.status(200).json({
      id:person.id,
      name:person.name||"",
      biography:person.biography||"",
      birthday:person.birthday||"",
      deathday:person.deathday||"",
      placeOfBirth:person.place_of_birth||"",
      knownForDepartment:person.known_for_department||"",
      profilePath:person.profile_path||"",
      imdbId:person.external_ids?.imdb_id||"",
      filmography
    });
  } catch (error) {
    console.error("TMDB person details lookup failed:",error);
    return res.status(502).json({error:error.message||"Could not load person details from TMDB."});
  }
}
