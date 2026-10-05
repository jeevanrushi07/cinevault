export default async function(req,res){
  const q=String(req.query.query||"").trim();
  const requestedPage=Number.parseInt(String(req.query.page||"1"),10);
  const page=Number.isFinite(requestedPage)?Math.min(500,Math.max(1,requestedPage)):1;
  const key=process.env.TMDB_API_KEY||req.headers["x-tmdb-api-key"];
  if(!key)return res.status(503).json({error:"TMDB API key not configured"});
  if(!q)return res.status(400).json({error:"A search query is required."});
  try{
    const response=await fetch(
      `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(key)}&include_adult=false&page=${page}&query=${encodeURIComponent(q)}`
    );
    const body=await response.json();
    return res.status(response.status).json(body);
  }catch(error){
    console.error("TMDB title search failed:",error);
    return res.status(502).json({error:error.message||"Could not search TMDB titles."});
  }
}
