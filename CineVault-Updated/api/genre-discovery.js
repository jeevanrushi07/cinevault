function sendMethodNotAllowed(res) {
  res.setHeader("Allow","GET");
  return res.status(405).json({error:"Method not allowed."});
}

function query(path,key) {
  return `https://api.themoviedb.org/3${path}${path.includes("?")?"&":"?"}api_key=${encodeURIComponent(key)}`;
}

async function tmdb(path,key) {
  const response=await fetch(query(path,key));
  const body=await response.json();
  if (!response.ok) throw new Error(body.status_message||`TMDB returned HTTP ${response.status}.`);
  return body;
}

function appendRanked(map,items,type,reason,score=1,person=null) {
  for (const item of items||[]) {
    if (!item?.id) continue;
    const itemType=item.type==="tv"||item.type==="series"
      ? "series"
      : item.type==="movie"?"movie":type==="tv"||type==="series"?"series":"movie";
    const key=`${itemType}:${item.id}`;
    const current=map.get(key)||{
      id:item.id,
      type:itemType,
      title:item.title||item.name||"Untitled",
      posterPath:item.poster_path||"",
      year:(item.release_date||item.first_air_date||"").slice(0,4),
      overview:item.overview||"",
      rating:Number(item.vote_average)||0,
      voteCount:Number(item.vote_count)||0,
      genreIds:Array.isArray(item.genre_ids)?item.genre_ids:[],
      reasons:[],
      people:[],
      score:0
    };
    current.score+=score;
    if (!current.reasons.includes(reason)) current.reasons.push(reason);
    if (person&&!current.people.some(existing=>existing.id===person.id)) current.people.push(person);
    map.set(key,current);
  }
}

function normalizeTitle(item) {
  return {
    id:item.id,
    type:item.type,
    title:item.title,
    posterPath:item.posterPath,
    year:item.year,
    overview:item.overview,
    tmdbRating:item.rating||null,
    genreIds:item.genreIds,
    reasons:item.reasons,
    people:item.people,
    score:item.score
  };
}

export default async function handler(req,res) {
  if (req.method!=="GET") return sendMethodNotAllowed(res);
  const key=process.env.TMDB_API_KEY||req.headers["x-tmdb-api-key"];
  if (!key) return res.status(503).json({error:"TMDB API key not configured"});

  const exploredNames=new Set(String(req.query?.explored||"").split("|").map(name=>name.trim().toLocaleLowerCase()).filter(Boolean));
  const watchedGenreCounts=new Map();
  for (const entry of String(req.query?.watchedGenres||"").split("|")) {
    const [name,count]=entry.split(":");
    const normalized=name?.trim().toLocaleLowerCase();
    const value=Number(count);
    if (normalized&&Number.isFinite(value)&&value>0) watchedGenreCounts.set(normalized,value);
  }
  const seeds=[...new Map(String(req.query?.seeds||"").split(",").map(seed=>{
    const [id,type]=seed.trim().split(":");
    return /^\d+$/.test(id||"")?[[`${type==="series"?"tv":"movie"}:${id}`,{id,type:type==="series"?"tv":"movie"}]]:[];
  }).flat()).values()].slice(0,5);
  const favorites=new Set(String(req.query?.favorites||"").split(",").filter(id=>/^\d+$/.test(id)));
  const saved=new Set(String(req.query?.saved||"").split(",").filter(id=>/^\d+:(?:movie|series)$/.test(id)));

  try {
    const [movieGenres,tvGenres]=await Promise.all([
      tmdb("/genre/movie/list?language=en-US",key),
      tmdb("/genre/tv/list?language=en-US",key)
    ]);
    const catalog=[
      ...(movieGenres.genres||[]).map(genre=>({...genre,type:"movie"})),
      ...(tvGenres.genres||[]).map(genre=>({...genre,type:"series"}))
    ];
    const catalogNames=new Set(catalog.map(genre=>genre.name.toLocaleLowerCase()));
    const watchedNames=[...exploredNames].filter(name=>catalogNames.has(name));
    const unexplored=catalog.filter(genre=>!exploredNames.has(genre.name.toLocaleLowerCase()));
    const familiar=catalog.filter(genre=>exploredNames.has(genre.name.toLocaleLowerCase()));
    const errors=[];

    const seedResults=await Promise.allSettled(seeds.map(async seed=>{
      const endpoint=seed.type==="tv"?"tv":"movie";
      const [recommendations,details]=await Promise.all([
        tmdb(`/${endpoint}/${seed.id}/recommendations?language=en-US&page=1`,key),
        tmdb(`/${endpoint}/${seed.id}?append_to_response=credits&language=en-US`,key)
      ]);
      const crew=(details.credits?.crew||[]).filter(person=>
        /director|writer|screenplay|story|composer|music/i.test(person.job||"")
      );
      const people=[...(details.credits?.cast||[]).slice(0,10),...crew];
      return {seed,recommendations:recommendations.results||[],people,crew};
    }));

    const genreAffinity=new Map();
    const creativeAffinity=new Map();
    const discoveryCandidates=new Map();
    const familiarCandidates=new Map();
    seedResults.forEach(result=>{
      if (result.status==="rejected") {
        errors.push(result.reason?.message||"Could not read a watched title's taste signals.");
        return;
      }
      const {seed,recommendations,people,crew}=result.value;
      recommendations.forEach((item,index)=>{
        const weight=Math.max(1,40-index);
        (item.genre_ids||[]).forEach(id=>{
          const genreKey=`${seed.type}:${id}`;
          genreAffinity.set(genreKey,(genreAffinity.get(genreKey)||0)+weight);
        });
      });
      people.forEach((person,index)=>{
        if (!person.id||favorites.has(String(person.id))) return;
        const key=String(person.id);
        const current=creativeAffinity.get(key)||{
          id:key,
          name:person.name||"",
          profilePath:person.profile_path||"",
          department:person.known_for_department||person.department||"",
          score:0
        };
        current.score+=Math.max(1,18-index)+(crew.includes(person)?12:0);
        creativeAffinity.set(key,current);
      });
    });

    const relatedUnexplored=unexplored
      .map(genre=>({...genre,affinity:genreAffinity.get(`${genre.type}:${genre.id}`)||0}))
      .sort((a,b)=>b.affinity-a.affinity||a.name.localeCompare(b.name))
      .slice(0,8);
    const genreDiscoveries=await Promise.allSettled(relatedUnexplored.map(async genre=>{
      const endpoint=genre.type==="series"?"tv":"movie";
      const body=await tmdb(`/discover/${endpoint}?language=en-US&include_adult=false&sort_by=vote_average.desc&vote_count.gte=150&with_genres=${genre.id}&page=1`,key);
      return {genre,items:body.results||[]};
    }));
    genreDiscoveries.forEach(result=>{
      if (result.status==="rejected") {
        errors.push(result.reason?.message||"Could not load unexplored-genre picks.");
        return;
      }
      const {genre,items}=result.value;
      appendRanked(discoveryCandidates,items,genre.type,`NEW GENRE · ${genre.name}`,Math.max(2,genre.affinity));
    });

    const newCreatives=[...creativeAffinity.values()]
      .sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name))
      .slice(0,5);
    const creativeResults=await Promise.allSettled(newCreatives.map(async person=>{
      const credits=await tmdb(`/person/${person.id}/combined_credits?language=en-US`,key);
      const grouped=new Map();
      for (const item of [...(credits.cast||[]),...(credits.crew||[])]) {
        if (!item.id||!item.media_type) continue;
        const type=item.media_type==="tv"?"series":"movie";
        const key=`${type}:${item.id}`;
        const current=grouped.get(key)||{...item,type};
        grouped.set(key,current);
      }
      return {person,items:[...grouped.values()]};
    }));
    creativeResults.forEach(result=>{
      if (result.status==="rejected") {
        errors.push(result.reason?.message||"Could not load a new creative's titles.");
        return;
      }
      const {person,items}=result.value;
      appendRanked(discoveryCandidates,items,"movie",`NEW CREATIVE · ${person.name}`,person.score,person);
    });

    const favoriteGenres=familiar
      .sort((a,b)=>(watchedGenreCounts.get(b.name.toLocaleLowerCase())||0)-(watchedGenreCounts.get(a.name.toLocaleLowerCase())||0)||a.name.localeCompare(b.name))
      .slice(0,6);
    const familiarDiscoveries=await Promise.allSettled(favoriteGenres.map(async genre=>{
      const endpoint=genre.type==="series"?"tv":"movie";
      const body=await tmdb(`/discover/${endpoint}?language=en-US&include_adult=false&sort_by=vote_average.desc&vote_count.gte=250&with_genres=${genre.id}&page=1`,key);
      return {genre,items:body.results||[]};
    }));
    familiarDiscoveries.forEach(result=>{
      if (result.status==="rejected") {
        errors.push(result.reason?.message||"Could not load explored-genre picks.");
        return;
      }
      const {genre,items}=result.value;
      appendRanked(familiarCandidates,items,genre.type,`EXPLORE ${genre.name}`,watchedGenreCounts.get(genre.name.toLocaleLowerCase())||1);
    });

    const removeSaved=map=>[...map.values()].filter(item=>!saved.has(`${item.id}:${item.type}`));
    const rankedDiscovery=removeSaved(discoveryCandidates)
      .sort((a,b)=>b.score-a.score||b.rating-a.rating||b.voteCount-a.voteCount)
      .slice(0,30).map(normalizeTitle);
    const discoveryKeys=new Set(rankedDiscovery.map(item=>`${item.id}:${item.type}`));
    const rankedFamiliar=removeSaved(familiarCandidates)
      .filter(item=>!discoveryKeys.has(`${item.id}:${item.type}`))
      .sort((a,b)=>b.rating-a.rating||b.voteCount-a.voteCount||b.score-a.score)
      .slice(0,30).map(normalizeTitle);

    res.setHeader("Cache-Control","private, max-age=300, stale-while-revalidate=600");
    return res.status(200).json({
      genres:catalog.map(({id,name,type})=>({id,name,type})),
      exploredGenres:watchedNames,
      unexploredGenres:[...new Set(unexplored.map(genre=>genre.name))],
      discovery:rankedDiscovery,
      familiar:rankedFamiliar,
      errors:[...new Set(errors)]
    });
  } catch(error) {
    console.error("Genre discovery lookup failed:",error);
    return res.status(502).json({error:error.message||"Could not load genre discovery."});
  }
}
