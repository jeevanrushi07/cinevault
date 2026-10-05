function parseTitleAndYear(query) {
  const match=query.match(/^(.*?)\s+\(?((?:18|19|20)\d{2})\)?$/);
  if (match) return {title:match[1].trim(),year:match[2]};
  if (/^(?:18|19|20)\d{2}$/.test(query)) return {title:"",year:query};
  return {title:query,year:""};
}

async function tmdbJson(path,key) {
  const response=await fetch(`https://api.themoviedb.org/3${path}${path.includes("?")?"&":"?"}api_key=${encodeURIComponent(key)}`);
  const body=await response.json();
  if (!response.ok) throw new Error(body.status_message||`TMDB returned HTTP ${response.status}.`);
  return body;
}

function popular(items) {
  return items.sort((a,b)=>
    (Number(b.popularity)||0)-(Number(a.popularity)||0)||
    (Number(b.vote_count)||0)-(Number(a.vote_count)||0)
  );
}

function appendResults(results,seen,items,type,match,person="") {
  for (const item of items||[]) {
    if (!item?.id) continue;
    const mediaType=type==="multi"?(item.media_type==="tv"?"tv":"movie"):type;
    const identity=`${mediaType}:${item.id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    results.push({...item,media_type:mediaType,search_match:match,matched_person:person});
  }
}

export default async function handler(req,res) {
  if (req.method!=="GET") {
    res.setHeader("Allow","GET");
    return res.status(405).json({error:"Method not allowed."});
  }
  const query=String(req.query?.query||"").trim().slice(0,200);
  const requestedPage=Number.parseInt(String(req.query?.page||"1"),10);
  const page=Number.isFinite(requestedPage)?Math.min(500,Math.max(1,requestedPage)):1;
  const key=process.env.TMDB_API_KEY||req.headers["x-tmdb-api-key"];
  if (!key) return res.status(503).json({error:"TMDB API key not configured"});
  if (!query) return res.status(400).json({error:"A search query is required."});

  const parsed=parseTitleAndYear(query);
  const queryOnlyYear=!parsed.title&&Boolean(parsed.year);
  const title=parsed.title||(queryOnlyYear?"":query);
  const language="language=en-US";
  const pageParam=`page=${page}`;

  try {
    const primaryPromise=queryOnlyYear
      ? Promise.resolve({results:[],total_pages:1,total_results:0})
      : tmdbJson(`/search/multi?${language}&include_adult=false&${pageParam}&query=${encodeURIComponent(title)}`,key);
    const auxiliaryPromises=page===1&&title.length>=2
      ? [
          tmdbJson(`/search/person?${language}&include_adult=false&page=1&query=${encodeURIComponent(title)}`,key),
          tmdbJson(`/search/keyword?query=${encodeURIComponent(title)}&page=1`,key),
          tmdbJson(`/genre/movie/list?${language}`,key)
        ]
      : [];
    const yearPromises=parsed.year
      ? [
          tmdbJson(`/discover/movie?${language}&include_adult=false&sort_by=popularity.desc&primary_release_year=${parsed.year}&${pageParam}`,key),
          tmdbJson(`/discover/tv?${language}&include_adult=false&sort_by=popularity.desc&first_air_date_year=${parsed.year}&${pageParam}`,key)
        ]
      : [];
    const [primaryResult,auxiliaryResults,yearResults]=await Promise.all([
      primaryPromise,
      Promise.allSettled(auxiliaryPromises),
      Promise.allSettled(yearPromises)
    ]);

    const results=[];
    const seen=new Set();
    const people=[];
    appendResults(results,seen,
      (primaryResult.results||[]).filter(item=>["movie","tv"].includes(item.media_type)),
      "multi","title");
    let totalPages=Number(primaryResult.total_pages)||1;
    let totalResults=Number(primaryResult.total_results)||0;

    if (page===1&&title.length>=2) {
      const auxiliary=auxiliaryResults.map(result=>{
        if (result.status==="fulfilled") return result.value;
        console.error("An optional TMDB related-search lookup failed:",result.reason);
        return {};
      });
      const [peopleBody,keywordBody,genreBody]=auxiliary;
      const matchedPeople=(peopleBody.results||[])
        .filter(person=>person.id&&person.name)
        .slice(0,8);
      people.push(...matchedPeople.map(person=>({
        id:person.id,
        name:person.name,
        profile_path:person.profile_path||"",
        known_for_department:person.known_for_department||"",
        known_for:(person.known_for||[]).slice(0,3).map(item=>({
          id:item.id,
          title:item.title||item.name||"",
          media_type:item.media_type==="tv"?"tv":"movie",
          poster_path:item.poster_path||"",
          release_date:item.release_date||item.first_air_date||""
        }))
      })));
      const personCredits=await Promise.allSettled(matchedPeople.slice(0,2).map(async person=>{
        const [movieCredits,tvCredits]=await Promise.all([
          tmdbJson(`/person/${person.id}/movie_credits?${language}`,key),
          tmdbJson(`/person/${person.id}/tv_credits?${language}`,key)
        ]);
        const movies=[
          ...(movieCredits.crew||[]).filter(credit=>/director|writer|screenplay|story/i.test(credit.job||"")),
          ...(movieCredits.cast||[])
        ];
        const shows=[
          ...(tvCredits.crew||[]).filter(credit=>/director|writer|creator/i.test(credit.job||"")),
          ...(tvCredits.cast||[])
        ];
        return {
          person,
          movies:popular(movies).slice(0,8),
          shows:popular(shows).slice(0,8)
        };
      }));
      for (const result of personCredits) {
        if (result.status==="rejected") {
          console.error("A TMDB person-credit search failed:",result.reason);
          continue;
        }
        appendResults(results,seen,result.value.movies,"movie","person",result.value.person.name);
        appendResults(results,seen,result.value.shows,"tv","person",result.value.person.name);
      }

      const keywords=(keywordBody.results||[]).filter(item=>item.id&&item.name).slice(0,2);
      if (keywords.length) {
        const ids=keywords.map(item=>item.id).join("|");
        const keywordDiscover=await Promise.allSettled([
          tmdbJson(`/discover/movie?${language}&include_adult=false&sort_by=popularity.desc&with_keywords=${ids}&page=1`,key),
          tmdbJson(`/discover/tv?${language}&include_adult=false&sort_by=popularity.desc&with_keywords=${ids}&page=1`,key)
        ]);
        const [movieResults,tvResults]=keywordDiscover.map(result=>
          result.status==="fulfilled"?result.value.results||[]:[]
        );
        appendResults(results,seen,movieResults.slice(0,8),"movie","keyword");
        appendResults(results,seen,tvResults.slice(0,8),"tv","keyword");
      }

      const matchingGenre=(genreBody.genres||[]).find(genre=>
        genre.name.toLowerCase()===title.toLowerCase()
      );
      if (matchingGenre) {
        const genreDiscover=await Promise.allSettled([
          tmdbJson(`/discover/movie?${language}&include_adult=false&sort_by=popularity.desc&with_genres=${matchingGenre.id}&page=1`,key),
          tmdbJson(`/discover/tv?${language}&include_adult=false&sort_by=popularity.desc&with_genres=${matchingGenre.id}&page=1`,key)
        ]);
        const [movieResults,tvResults]=genreDiscover.map(result=>
          result.status==="fulfilled"?result.value.results||[]:[]
        );
        appendResults(results,seen,movieResults.slice(0,8),"movie","genre");
        appendResults(results,seen,tvResults.slice(0,8),"tv","genre");
      }
    }

    if (parsed.year) {
      const [movieResult,tvResult]=yearResults.map(result=>{
        if (result.status==="fulfilled") return result.value;
        console.error("A TMDB year-filtered search failed:",result.reason);
        return {results:[],total_pages:1,total_results:0};
      });
      appendResults(results,seen,movieResult.results,"movie","year");
      appendResults(results,seen,tvResult.results,"tv","year");
      totalPages=Math.max(totalPages,Number(movieResult.total_pages)||1,Number(tvResult.total_pages)||1);
      totalResults+=(Number(movieResult.total_results)||0)+(Number(tvResult.total_results)||0);
    }

    res.setHeader("Cache-Control","public, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      page,
      total_pages:Math.max(1,Math.min(500,totalPages)),
      total_results:totalResults,
      results,
      people
    });
  } catch(error) {
    console.error("TMDB title, person, or year search failed:",error);
    return res.status(502).json({error:error.message||"Could not search TMDB titles."});
  }
}
