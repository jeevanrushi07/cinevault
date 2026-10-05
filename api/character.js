export default async function(req,res){
  const k=process.env.TMDB_API_KEY||req.headers['x-tmdb-api-key'];
  if(!k)return res.status(503).json({error:'TMDB API key not configured'});
  try{
    const page=1+Math.floor(Math.random()*5);
    const p=await fetch(`https://api.themoviedb.org/3/person/popular?api_key=${encodeURIComponent(k)}&language=en-US&page=${page}`);
    if(!p.ok)return res.status(p.status).json({error:'TMDB people lookup failed'});
    const people=await p.json();
    const actors=(people.results||[]).filter(x=>x.profile_path);
    for(let i=0;i<8;i++){
      const person=actors[Math.floor(Math.random()*actors.length)];
      if(!person)break;
      const c=await fetch(`https://api.themoviedb.org/3/person/${person.id}/combined_credits?api_key=${encodeURIComponent(k)}&language=en-US`);
      if(!c.ok)continue;
      const credits=await c.json();
      const roles=(credits.cast||[]).filter(x=>x.character&&x.poster_path);
      if(!roles.length)continue;
      const role=roles[Math.floor(Math.random()*roles.length)];
      return res.status(200).json({characterName:role.character,actorName:person.name,poster:person.profile_path,movieTitle:role.title||role.name||'Featured title'});
    }
    return res.status(404).json({error:'No character found'});
  }catch(e){return res.status(500).json({error:'Character lookup failed'})}
}
