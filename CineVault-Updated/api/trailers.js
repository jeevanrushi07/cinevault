export default async function handler(req,res) {
  if (req.method!=="GET") {
    res.setHeader("Allow","GET");
    return res.status(405).json({error:"Method not allowed."});
  }

  const title=String(req.query?.title||"").trim().slice(0,160);
  const year=String(req.query?.year||"").match(/^\d{4}$/)?.[0]||"";
  const type=req.query?.type==="series"?"series":"movie";
  const key=process.env.YOUTUBE_API_KEY;

  if (!title) return res.status(400).json({error:"A movie or series title is required."});
  if (!key) return res.status(503).json({error:"YOUTUBE_API_KEY is not configured in Vercel."});

  const query=[title,year,type==="series"?"series trailer":"movie trailer","official"].filter(Boolean).join(" ");
  const params=new URLSearchParams({
    part:"snippet",
    type:"video",
    videoEmbeddable:"true",
    videoSyndicated:"true",
    safeSearch:"moderate",
    relevanceLanguage:"en",
    maxResults:"10",
    q:query,
    key
  });

  try {
    const response=await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const data=await response.json();
    if (!response.ok) {
      const message=data.error?.message||"YouTube trailer search failed.";
      console.error("YouTube trailer search failed:",response.status,message);
      return res.status(response.status===403?502:response.status).json({error:message});
    }

    const trailers=[...new Set((data.items||[])
      .map(item=>item.id?.videoId)
      .filter(id=>typeof id==="string"&&/^[\w-]{11}$/.test(id)))];
    res.setHeader("Cache-Control","public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json({trailers});
  } catch(error) {
    console.error("YouTube trailer search request failed:",error);
    return res.status(502).json({error:error.message||"Could not search YouTube for a trailer."});
  }
}
