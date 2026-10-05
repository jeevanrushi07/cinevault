export default async function handler(req,res) {
  if (req.method!=="GET") {
    res.setHeader("Allow","GET");
    return res.status(405).json({error:"Method not allowed."});
  }

  const query=String(req.query?.query||"").trim();
  if (query.length<2) return res.status(400).json({error:"Enter at least two characters to search Google."});
  if (query.length>200) return res.status(400).json({error:"Search query must be 200 characters or fewer."});
  const apiKey=process.env.GOOGLE_CSE_API_KEY;
  const engineId=process.env.GOOGLE_CSE_ID;
  if (!apiKey||!engineId) {
    return res.status(503).json({error:"Google title search is not configured. Set GOOGLE_CSE_API_KEY and GOOGLE_CSE_ID in Vercel."});
  }

  try {
    const params=new URLSearchParams({
      key:apiKey,
      cx:engineId,
      q:query,
      num:"8"
    });
    const response=await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
    const body=await response.json();
    if (!response.ok) {
      const message=body.error?.message||`Google search returned HTTP ${response.status}.`;
      console.error("Google Custom Search API request failed:",message);
      return res.status(response.status===429?429:502).json({error:message});
    }
    const results=(body.items||[]).map(item=>({
      title:String(item.title||"").slice(0,300),
      link:String(item.link||""),
      snippet:String(item.snippet||"").slice(0,600),
      displayLink:String(item.displayLink||"").slice(0,150)
    })).filter(item=>item.title&&/^https?:\/\//i.test(item.link));
    res.setHeader("Cache-Control","public, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({results});
  } catch(error) {
    console.error("Google title search failed:",error);
    return res.status(502).json({error:error.message||"Could not search Google."});
  }
}
