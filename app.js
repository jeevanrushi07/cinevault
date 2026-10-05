const $ = (s) => document.querySelector(s);

const img = (p) => p
  ? /^https?:\/\//i.test(p) ? p : `https://image.tmdb.org/t/p/w780${p}`
  : `https://placehold.co/500x750/111118/eee?text=No+Poster`;

const backdrop = (p) => p
  ? `https://image.tmdb.org/t/p/w1280${p}`
  : "";

const esc = (s = "") => String(s).replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
}[c]));

let supabaseClient = null;
let config = null;
let currentUser = null;
let profile = null;
let movies = [];
let characters = [];
let incomingShares = [];
let outgoingShares = [];
let activeTab = "archive";
let activeStageSequence = [];
let searchQuery = "";
let sharedLibraryTimer = null;
let activeSharedShareId = null;
let notifications = [];
let networkUsers = [];
let activeChatUser = null;
let chatRefreshTimer = null;
let notificationRefreshTimer = null;
let activeStageMovie = null;
const stageBackdropVisits = new Map();
let stageTrailerPlayer = null;
let stageTrailerIdleTimer = null;
let stageTrailerPointerHandler = null;
let stageTrailerScrollHandler = null;
let stageTrailerVisibilityHandler = null;
let stageTrailerWindowBlurHandler = null;
let stageTrailerWindowFocusHandler = null;
let stageTrailerKeyboardHandler = null;
let stageTrailerGeneration = 0;
let stageTrailerIsIdle = false;
let stageTrailerPageActive = !document.hidden&&document.hasFocus();
let stageTrailerContentTimer = null;
let stageTrailerFeedbackTimer = null;
let stageTrailerPlaybackRate = 1;
let stageTrailerVideoId = "";
let stageTrailerCandidates = [];
let stageTrailerCandidateIndex = 0;
let stageTrailerMovie = null;
let stageTrailerFallbackSearched = false;
let stageTrailerAudioEnabled = false;
let youtubePlayerApiPromise = null;
let archiveSearchScrollHandler = null;
let archiveSearchCompressed = false;
let archiveDecadeFilter = "";
let archiveRecommendationRequest = 0;
let headerSearchState = {query:"",page:0,totalPages:1,loading:false,request:0,items:[],people:[]};
let addSearchState = {query:"",page:0,totalPages:1,loading:false,request:0,items:[],people:[]};
const googleSearchStates={
  header:{query:"",request:0,loading:false,loaded:false,items:[],error:""},
  add:{query:"",request:0,loading:false,loaded:false,items:[],error:""}
};
const googleSearchEnabled=false;
let trailerReadMode = localStorage.getItem("cinevault-read-mode")==="true";
const copyFeedbackTimers = new WeakMap();

function personPageUrl(person) {
  return person?.id?`#person=${encodeURIComponent(person.id)}`:"";
}

function tmdbHeaders() {
  const key = localStorage.getItem("cinevault-tmdb-key");
  return key ? {"X-TMDB-API-Key": key} : {};
}

function tmdbReady() {
  return Boolean(localStorage.getItem("cinevault-tmdb-key") || config?.tmdbConfigured);
}

async function readApiJson(response,source) {
  const body=await response.text();
  try {
    return JSON.parse(body);
  } catch {
    const excerpt=body.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim().slice(0,180);
    throw new Error(`${source} returned a non-JSON response (HTTP ${response.status})${excerpt?`: ${excerpt}`:"."}`);
  }
}

function movieRow(m) {
  return {
    user_id: currentUser.id,
    tmdb_id: Number(m.tmdbId),
    title: m.title,
    type: m.type || "movie",
    poster_path: m.posterPath || null,
    backdrop_path: m.backdropPath || null,
    year: m.year || "",
    overview: m.overview || "",
    genres: m.genres || [],
    cast_members: m.cast || [],
    director: m.director || "",
    imdb_id: m.imdbId || "",
    tmdb_rating: m.tmdbRating || null,
    trailer_key: m.trailerKey || "",
    personal_note: m.personalNote || "",
    status: m.status || "watched"
  };
}

function normalizeMovie(r) {
  return {
    tmdbId: r.tmdb_id ?? r.tmdbId,
    title: r.title,
    type: r.type || "movie",
    posterPath: r.poster_path ?? r.posterPath,
    backdropPath: r.backdrop_path ?? r.backdropPath,
    year: r.year || "",
    overview: r.overview || "",
    genres: r.genres || [],
    cast: r.cast_members ?? r.cast ?? [],
    director: r.director || "",
    imdbId: r.imdb_id ?? r.imdbId ?? "",
    tmdbRating: r.tmdb_rating ?? r.tmdbRating,
    trailerKey: r.trailer_key ?? r.trailerKey ?? "",
    personalNote: r.personal_note ?? r.personalNote ?? "",
    status: r.status || "watched",
    addedAt: r.created_at || r.addedAt
  };
}

function matches(m, q) {
  q = q.toLowerCase();
  return [
    m.title, m.originalTitle, m.overview, m.director, m.year,
    ...(m.genres || []), ...(m.cast || [])
  ].filter(Boolean).join(" ").toLowerCase().includes(q);
}

document.addEventListener("click",event=>{
  if (event.target instanceof Element && event.target.classList.contains("modal")) {
    event.target.remove();
  }
});

async function initSupabase() {
  const r = await fetch("/api/config");
  if (!r.ok) throw new Error("Could not load CineVault configuration.");
  config = await r.json();

  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    throw new Error("Supabase environment variables are missing in Vercel.");
  }

  if (!window.supabase?.createClient) {
    throw new Error("Supabase client failed to load.");
  }

  supabaseClient = window.supabase.createClient(
    config.supabaseUrl,
    config.supabasePublishableKey
  );
}

async function loadData() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    currentUser = null;
    return;
  }

  currentUser = user;

  const [p, m, c, s, n] = await Promise.all([
    supabaseClient.from("profiles").select("*").eq("id", user.id).single(),
    supabaseClient.from("movies").select("*").eq("user_id", user.id).order("created_at", {ascending:false}),
    supabaseClient.from("characters").select("*").eq("user_id", user.id).order("created_at", {ascending:false}),
    supabaseClient.from("library_shares").select(
      "id,created_at,expires_at,sender_id,receiver_id"
    ).or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`).order("created_at",{ascending:false}),
    supabaseClient.from("notifications").select(
      "id,actor_id,notification_type,resource_id,created_at,read_at"
    ).eq("user_id",user.id).order("created_at",{ascending:false}).limit(50)
  ]);

  if (p.error) throw p.error;
  if (m.error) throw m.error;
  if (c.error) throw c.error;
  if (s.error) throw s.error;
  if (n.error) throw n.error;

  const shares=s.data||[];
  const participantIds=[...new Set([
    ...shares.flatMap(share=>[share.sender_id,share.receiver_id]),
    ...(n.data||[]).map(notification=>notification.actor_id).filter(Boolean)
  ])];
  let shareProfiles=[];

  if (participantIds.length) {
    const {data,error}=await supabaseClient.from("profiles")
      .select("id,username")
      .in("id",participantIds);
    if (error) throw error;
    shareProfiles=data||[];
  }

  const usernames=new Map(shareProfiles.map(person=>[person.id,person.username]));
  profile = p.data;
  movies = (m.data || []).map(normalizeMovie);
  characters = c.data || [];
  incomingShares = shares
    .filter(share => share.receiver_id === user.id)
    .map(share=>({...share,sender:{username:usernames.get(share.sender_id)||"user"}}));
  outgoingShares = shares
    .filter(share => share.sender_id === user.id)
    .map(share=>({...share,receiver:{username:usernames.get(share.receiver_id)||"user"}}));
  notifications=(n.data||[]).map(notification=>({
    ...notification,
    actor:{username:usernames.get(notification.actor_id)||"Someone"}
  }));
}

async function saveMovie(m, status) {
  m.status = status;
  const {data,error} = await supabaseClient.from("movies").upsert(
    movieRow(m), {onConflict:"user_id,tmdb_id"}
  ).select().single();

  if (error) throw error;

  const normalized = normalizeMovie(data);
  movies = [normalized, ...movies.filter(x => String(x.tmdbId) !== String(normalized.tmdbId))];
}

async function updateMovie(m, patch) {
  const {data,error} = await supabaseClient.from("movies")
    .update(patch)
    .eq("user_id",currentUser.id)
    .eq("tmdb_id",m.tmdbId)
    .select().single();

  if (error) throw error;
  Object.assign(m, normalizeMovie(data));
}

async function deleteMovie(id) {
  if (!confirm("Delete this title from your CineVault?")) return;

  const {error} = await supabaseClient.from("movies").delete()
    .eq("user_id",currentUser.id).eq("tmdb_id",Number(id));

  if (error) return alert(error.message);

  movies = movies.filter(m => String(m.tmdbId) !== String(id));
  $("#stage")?.remove();
  show("archive");
}
window.deleteMovie = deleteMovie;

function shell() {
  clearInterval(chatRefreshTimer);
  archiveSearchCompressed=false;
  if (archiveSearchScrollHandler) {
    window.removeEventListener("scroll",archiveSearchScrollHandler);
    archiveSearchScrollHandler=null;
  }
  document.body.innerHTML = `
    <div class="app">
      <aside>
        <div class="brand">
          <b>CINEVAULT</b>
          <small>PERSONAL FILM ARCHIVE</small>
        </div>
        <nav>
          <button data-tab="archive" aria-keyshortcuts="Escape" title="Return to Archive (Esc)">
            <span class="archiveNavIcon" aria-hidden="true">◉</span>
            <span class="archiveNavLabel">Archive</span>
            <kbd aria-hidden="true">ESC</kbd>
          </button>
          <button data-tab="recent">◷ Recent</button>
          <button data-tab="shared">◎ Shared</button>
          <button data-tab="network">✉ Network</button>
          <button data-tab="characters">✦ Characters</button>
          <button data-tab="contact">↗ Contact</button>
        </nav>
        <div class="side">
          <button id="add">＋ Add title</button>
          <button id="share">⇧ Share library</button>
          <button id="profile" class="profileButton" aria-label="Profile: @${esc(profile?.username || "user")}" title="Profile: @${esc(profile?.username || "user")}">
            ${profile?.avatar?`<img src="${esc(img(profile.avatar))}" alt="">`:`<span class="profileFallback" aria-hidden="true">${esc((profile?.username || "U").slice(0,1).toUpperCase())}</span>`}
            <span class="profileUsername">@${esc(profile?.username || "user")}</span>
          </button>
          <button id="settings">⚙ Settings</button>
          <button id="logout">↪ Logout</button>
        </div>
      </aside>
      <main>
        <header>
          <div class="search searchExpanded">
            ⌕
            <input id="search" autocomplete="off" placeholder="Search titles, directors, people, years, or genres...">
            <kbd>⌘ K</kbd>
            <div id="searchResults" class="headerResults"></div>
          </div>
          <div class="notificationWrap">
            <button id="notificationBell" class="notificationBell" aria-label="Notifications">🔔<span id="notificationCount" class="notificationCount"></span></button>
            <div id="notificationPanel" class="notificationPanel"></div>
          </div>
          <button id="logoutTop" class="headerLogout">↪ Logout</button>
        </header>
        <div id="content"></div>
      </main>
    </div>`;

  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => show(b.dataset.tab));
  $("#settings").onclick = settingsModal;
  $("#add").onclick = addModal;
  $("#share").onclick = shareLibraryModal;
  $("#profile").onclick = profileModal;
  $("#logout").onclick = $("#logoutTop").onclick = logout;
  $("#notificationBell").onclick=toggleNotifications;
  $("#searchResults").onscroll=()=>{
    const panel=$("#searchResults");
    if (!panel||panel.scrollHeight-panel.scrollTop-panel.clientHeight>120) return;
    loadHeaderSearchPage();
  };
  archiveSearchScrollHandler=()=>{
    if (window.scrollY>0) {
      archiveSearchCompressed=true;
      $(".search")?.classList.remove("searchExpanded");
    }
  };
  window.addEventListener("scroll",archiveSearchScrollHandler,{passive:true});
  window.onpopstate=e=>{
    if (!e.state?.cineVaultRoute) return;
    restoreAppRoute(e.state);
  };
  document.onkeydown=e=>{
    if (e.key==="Escape") {
      e.preventDefault();
      $("#profileImageViewer")?.remove();
      stopStageTrailer();
      $("#stage")?.remove();
      document.querySelectorAll(".modal").forEach(modal=>modal.remove());
      $("#notificationPanel")?.classList.remove("open");
      $("#searchResults")?.classList.remove("open");
      if ($("#search")) $("#search").value="";
      searchQuery="";
      show("archive");
      return;
    }
    const editingTarget=e.target instanceof Element&&e.target.closest("input,textarea,[contenteditable='true']");
    if ((e.ctrlKey||e.metaKey)&&!editingTarget&&e.key.toLowerCase()==="z") {
      e.preventDefault();
      history.back();
      return;
    }
    if ((e.ctrlKey||e.metaKey)&&!editingTarget&&e.key.toLowerCase()==="y") {
      e.preventDefault();
      history.forward();
      return;
    }
    if ($("#stage")&&!editingTarget&&(e.key==="ArrowLeft"||e.key==="ArrowRight")) {
      e.preventDefault();
      navigateStageMovie(e.key==="ArrowLeft"?-1:1);
      return;
    }
    if ((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k") {
      e.preventDefault();
      $("#search")?.focus();
      $("#search")?.select();
    }
  };
  let headerSearchTimer;
  $("#search").oninput = e => {
    searchQuery = e.target.value;
    show("archive", searchQuery);
    clearTimeout(headerSearchTimer);
    headerSearchTimer=setTimeout(()=>searchHeaderTitles(searchQuery),300);
  };
  $("#search").onfocus=()=>{
    if ($("#search").value.trim().length>=2) searchHeaderTitles($("#search").value);
  };
  document.addEventListener("click",e=>{
    setTimeout(()=>{
      const target=e.target instanceof Element?e.target:null;
      if (activeTab!=="archive"||history.state?.detail||$("#stage")||
        document.querySelector(".modal,#profileImageViewer")||
        target?.closest("input,textarea,select,[contenteditable='true'],.search")) return;
      focusArchiveSearch();
    },0);
    if (!e.target.closest(".search")) $("#searchResults").classList.remove("open");
    if (!e.target.closest(".notificationWrap")) $("#notificationPanel").classList.remove("open");
  });
  updateNotificationBadge();
  clearInterval(notificationRefreshTimer);
  notificationRefreshTimer=setInterval(refreshNotifications,20000);
  if (activeTab==="archive") focusArchiveSearch();
}

function focusArchiveSearch() {
  if (activeTab!=="archive"||history.state?.detail||$("#stage")||
    document.querySelector(".modal,#profileImageViewer")) return;
  const search=$("#search");
  if (!search) return;
  if (!archiveSearchCompressed) search.closest(".search")?.classList.add("searchExpanded");
  search.focus({preventScroll:true});
}

async function restoreAppRoute(route) {
  stopStageTrailer();
  $("#stage")?.remove();
  $("#profileImageViewer")?.remove();
  document.querySelectorAll(".modal").forEach(modal=>modal.remove());
  await show(route.tab||"archive",route.routeParam||"",{history:false});
  if (route.detail?.type==="movie"&&route.detail.movie) {
    stage(route.detail.movie,Boolean(route.detail.readOnly),{
      history:false,
      sequence:route.detail.sequence
    });
  } else if (route.detail?.type==="movie"&&route.detail.id) {
    const savedMovie=movies.find(movie=>String(movie.tmdbId)===String(route.detail.id));
    if (savedMovie) {
      stage(savedMovie,Boolean(route.detail.readOnly),{
        history:false,
        sequence:route.detail.sequence
      });
    } else {
      try {
        const params=new URLSearchParams({id:String(route.detail.id)});
        const response=await fetch(`/api/movie?${params}`,{headers:tmdbHeaders()});
        const movie=await readApiJson(response,"Movie details API");
        if (!response.ok) throw new Error(movie.error||"Could not restore this movie.");
        stage(movie,Boolean(route.detail.readOnly),{
          history:false,
          sequence:route.detail.sequence
        });
      } catch(error) {
        const content=$("#content");
        if (content) content.innerHTML=`<p class="personError">${esc(error.message||"Could not restore this movie.")}</p>`;
      }
    }
  } else if (route.detail?.type==="person"&&route.detail.id) {
    await renderPerson(route.detail.id);
  }
}

function initialAppRoute() {
  const state=history.state;
  if (state?.cineVaultRoute) return state;

  const hash=new URLSearchParams(location.hash.slice(1));
  const movieId=hash.get("movie");
  if (movieId) {
    return {
      cineVaultRoute:true,
      tab:"archive",
      routeParam:"",
      detail:{type:"movie",id:movieId}
    };
  }

  const personId=hash.get("person");
  if (personId) {
    return {
      cineVaultRoute:true,
      tab:"archive",
      routeParam:"",
      detail:{type:"person",id:personId}
    };
  }

  return {cineVaultRoute:true,tab:"archive",routeParam:"",detail:null};
}

function closeAppDetail() {
  stopStageTrailer();
  const current=history.state;
  if (current?.detail?.type==="movie") {
    const returnDetail=current.detail.returnDetail||null;
    const route={
      cineVaultRoute:true,
      tab:current.tab||activeTab||"archive",
      routeParam:current.routeParam||"",
      detail:returnDetail
    };
    const hash=returnDetail?.type==="person"
      ? `#person=${encodeURIComponent(returnDetail.id)}`
      : `${location.pathname}${location.search}`;
    history.replaceState(route,"",hash);
    restoreAppRoute(route);
    return;
  }
  if (history.state?.detail) {
    history.back();
    return;
  }
  $("#stage")?.remove();
  show(history.state?.tab||activeTab||"archive",history.state?.routeParam||"");
}

function openPerson(id) {
  stopStageTrailer();
  $("#stage")?.remove();
  const current=history.state&&typeof history.state==="object"?history.state:{};
  const state={
    ...current,
    cineVaultRoute:true,
    tab:current.tab||activeTab||"archive",
    routeParam:current.routeParam||"",
    detail:{type:"person",id:String(id)}
  };
  if (current.detail?.type==="person"&&String(current.detail.id)===String(id)) {
    renderPerson(id);
    return;
  }
  history.pushState(state,"",`#person=${encodeURIComponent(id)}`);
  renderPerson(id);
}

async function show(tab, q = "", options = {}) {
  const routeParam=tab==="sharedLibrary"?String(q||""):"";
  if (options.history!==false&&!history.state?.cineVaultRoute) {
    const state=history.state&&typeof history.state==="object"?history.state:{};
    history.replaceState({...state,cineVaultRoute:true,tab,routeParam,detail:null},"",`${location.pathname}${location.search}`);
  } else if (options.history!==false&&(history.state.tab!==tab||history.state.routeParam!==routeParam||history.state.detail)) {
    history.pushState({...history.state,cineVaultRoute:true,tab,routeParam,detail:null},"",`${location.pathname}${location.search}`);
  }
  if (options.history!==false) $("#stage")?.remove();
  if (tab !== "sharedLibrary") stopSharedLibraryMonitor();
  if (tab !== "network") clearInterval(chatRefreshTimer);
  if (tab==="archive"&&activeTab!=="archive") archiveSearchCompressed=false;
  activeTab = tab;
  document.title="CineVault";
  const c = $("#content");
  if (!c) return;

  if (tab === "recent") {
    c.innerHTML = recent();
    return;
  }

  if (tab === "characters") {
    c.innerHTML = characterWall();
    $("#randomCharacter")?.addEventListener("click", randomCharacter);
    return;
  }

  if (tab === "network") {
    c.innerHTML='<p class="muted">Loading your network…</p>';
    await renderNetwork();
    return;
  }

  if (tab === "shared") {
    c.innerHTML = '<p class="muted">Loading shared libraries…</p>';
    c.innerHTML = await shared();
    return;
  }

  if (tab === "sharedLibrary") {
    c.innerHTML = '<p class="muted">Loading shared library…</p>';
    await renderSharedLibrary(q);
    return;
  }

  if (tab==="contact") {
    const subject="CineVault support request";
    const body=[
      "Hi Jeevan,",
      "",
      "I need help with CineVault.",
      "",
      `CineVault username: @${profile?.username||"add your username"}`,
      "",
      "What happened?",
      "",
      "Steps to reproduce:",
      "",
      "What I expected:",
      "",
      "Browser/device:",
      "",
      "Thank you,"
    ].join("\n");
    const composeParams=new URLSearchParams({
      view:"cm",
      fs:"1",
      to:"jeevanrushicreations584@gmail.com",
      su:subject,
      body
    });
    if (currentUser?.email) composeParams.set("authuser",currentUser.email);
    const composeUrl=`https://mail.google.com/mail/?${composeParams}`;
    c.innerHTML=`
      <section class="contactPage">
        <div class="contactPageGlow" aria-hidden="true"></div>
        <span class="contactEyebrow"><i></i> CINEVAULT · DIRECT LINE</span>
        <h1>A note to the<br><em>person behind</em><br>CineVault.</h1>
        <p class="contactIntro">Found a problem or have an idea that could make your archive better? Send it directly to the developer. Every thoughtful note helps shape what CineVault becomes.</p>
        <div class="contactDeveloper">
          <span class="contactAvatar" aria-hidden="true">JR</span>
          <div><small>BUILT AND LOOKED AFTER BY</small><strong>Jeevan Rushi</strong></div>
          <span class="contactStatus"><i></i> DEVELOPER</span>
        </div>
        <div class="contactAction">
          <a class="contactMailButton" href="${composeUrl}" target="_blank" rel="noopener">
            <span><small>FOR A PROBLEM OR SUGGESTION</small><b>Email Jeevan</b></span>
            <span aria-hidden="true">↗</span>
          </a>
        </div>
        <p class="contactPrivacy">Gmail will open a prefilled draft using the Google account matching your CineVault email when that account is signed in. Gmail must have permission to send from that address. Please don’t include passwords or private API keys.</p>
      </section>`;
    return;
  }

  const filtered = q ? movies.filter(m => matches(m,q)) : movies;
  const watched = filtered.filter(m=>m.status==="watched");
  const want = filtered.filter(m=>m.status==="want");
  const allWatched=movies.filter(m=>m.status==="watched");
  const allWant=movies.filter(m=>m.status==="want");
  const allLibraryMovies=movies.filter(m=>["watched","want"].includes(m.status));
  const genreCounts=new Map();
  allWatched.forEach(movie=>{
    (movie.genres||[]).forEach(genre=>{
      const name=String(genre||"").trim();
      if (!name) return;
      const key=name.toLocaleLowerCase();
      const current=genreCounts.get(key)||{name,count:0};
      current.count++;
      genreCounts.set(key,current);
    });
  });
  const topGenres=[...genreCounts.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name)).slice(0,3);
  const featuredMovie=allWatched[0]||null;
  const archiveName=profile?.username||currentUser?.email?.split("@")[0]||"cinephile";
  const decadeCounts=new Map();
  const currentYear=new Date().getFullYear();
  allLibraryMovies.forEach(movie=>{
    const year=Number(movie.year);
    if (!Number.isInteger(year)||year<1888||year>currentYear+1) return;
    const decade=`${Math.floor(year/10)*10}s`;
    decadeCounts.set(decade,(decadeCounts.get(decade)||0)+1);
  });
  const decades=[...decadeCounts.entries()].sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true}));
  const collectionByStatus={
    watched:watched.filter(movie=>!archiveDecadeFilter||
      (Number.isInteger(Number(movie.year))&&`${Math.floor(Number(movie.year)/10)*10}s`===archiveDecadeFilter)),
    want:want.filter(movie=>!archiveDecadeFilter||
      (Number.isInteger(Number(movie.year))&&`${Math.floor(Number(movie.year)/10)*10}s`===archiveDecadeFilter))
  };
  const collection=[];
  for (let index=0;index<Math.max(collectionByStatus.watched.length,collectionByStatus.want.length);index++) {
    if (collectionByStatus.watched[index]) collection.push(collectionByStatus.watched[index]);
    if (collectionByStatus.want[index]) collection.push(collectionByStatus.want[index]);
  }

  c.innerHTML = `
    <section class="archiveHero">
      ${featuredMovie?`
        <img class="archiveHeroArtwork" id="archiveHeroArtwork" src="${esc(backdrop(featuredMovie.backdropPath)||img(featuredMovie.posterPath))}" alt="">
        <div class="archiveHeroShade"></div>
        <div class="archiveHeroCopy">
          <span class="archiveEyebrow"><i></i> @${esc(archiveName.toUpperCase())}’S SCREENING ROOM <b>/</b> RECENTLY KEPT</span>
          <h1 id="archiveHeroTitle">${esc(featuredMovie.title)}</h1>
          <div class="archiveHeroMeta" id="archiveHeroMeta">${[featuredMovie.year,...(featuredMovie.genres||[]).slice(0,2)].filter(Boolean).map(esc).join(" <i>·</i> ")}</div>
          <p id="archiveHeroOverview">${esc(featuredMovie.overview||`A story from your ${topGenres[0]?.name||"personal"} collection.`)}</p>
          <button type="button" class="archiveHeroOpen" id="archiveHeroOpen" data-id="${esc(featuredMovie.tmdbId)}">OPEN THIS TITLE <span>↗</span></button>
        </div>
      `:`
        <div class="archiveHeroEmpty">
          <span class="archiveEyebrow"><i></i> @${esc(archiveName.toUpperCase())}’S SCREENING ROOM</span>
          <h1>Your story<br><em>starts here.</em></h1>
          <p>Build a collection that feels like you. Save a film you love and this room will become your own.</p>
          <button type="button" class="archiveHeroOpen" id="archiveHeroAdd">FIND YOUR FIRST FILM <span>＋</span></button>
        </div>
      `}
    </section>
    <section class="archivePulse" aria-label="Your collection at a glance">
      <div><strong>${allWatched.length}</strong><span>STORIES WATCHED</span></div>
      <div><strong>${allWant.length}</strong><span>UP NEXT</span></div>
      <div><strong>${genreCounts.size}</strong><span>GENRES EXPLORED</span></div>
      <div class="archiveTastePulse"><span>YOUR TASTE</span><strong>${topGenres.length?topGenres.map(genre=>esc(genre.name)).join(" <i>·</i> "):"Still unfolding"}</strong></div>
    </section>
    ${watchlist(want)}
    <section class="archiveRecommendations" aria-labelledby="archiveRecommendationsTitle">
      <div class="archiveRecommendationsHead">
        <div><span>SELECTED FROM YOUR TASTE</span><h2 id="archiveRecommendationsTitle">For your next screening.</h2><p>Inspired by what you’ve watched and what’s waiting in your watchlist.</p></div>
        <div class="archiveRailControls">
          <button type="button" data-recommendation-scroll="-1" aria-label="Scroll recommendations left">‹</button>
          <button type="button" data-recommendation-scroll="1" aria-label="Scroll recommendations right">›</button>
        </div>
      </div>
      <div class="archiveRecommendationRail" id="archiveRecommendationRail" aria-live="polite">
        <p class="archiveRecommendationStatus">Finding titles shaped by your collection and watchlist…</p>
      </div>
    </section>
    <section class="archiveDecades" aria-label="Filter library titles by decade">
      <div><span>YOUR LIBRARY, BY ERA</span><p>Every decade has a different feeling.</p></div>
      <div class="archiveDecadeList">
        <button type="button" class="archiveDecade ${archiveDecadeFilter?"":"active"}" data-decade="" aria-pressed="${archiveDecadeFilter?"false":"true"}"><b>ALL</b><i>${allLibraryMovies.length}</i></button>
        ${decades.map(([decade,count])=>`
          <button type="button" class="archiveDecade ${archiveDecadeFilter===decade?"active":""}" data-decade="${decade}" aria-pressed="${archiveDecadeFilter===decade}">
            <b>${decade}</b><i>${count}</i><span style="--decade-fill:${Math.max(12,Math.round(count/Math.max(...decades.map(([,value])=>value))*100))}%"></span>
          </button>`).join("")}
      </div>
    </section>
    <div class="head archiveCollectionHead">
      <div>
        <span>${q?"SEARCHING YOUR ARCHIVE":archiveDecadeFilter?`A CHAPTER FROM THE ${archiveDecadeFilter.toUpperCase()}`:"WATCHED & UP NEXT"}</span>
        <h2>${q ? `Results for "${esc(q)}"` : archiveDecadeFilter?`The ${archiveDecadeFilter}`:"Your library"}</h2>
      </div>
      <small>${collection.length} ${collection.length===1?"TITLE":"TITLES"} · ${collectionByStatus.watched.length} WATCHED · ${collectionByStatus.want.length} UP NEXT</small>
    </div>
    ${collection.length?`
      <div class="wall archiveWall">
        ${collection.map((m,i)=>poster(m,i,false,false,"",m.status)).join("")}
      </div>`:`
      <div class="archiveEmptyState">
        <span>${q?"NO MATCHES IN THIS CHAPTER":archiveDecadeFilter?"NO TITLES FROM THIS ERA YET":"YOUR ARCHIVE BEGINS HERE"}</span>
        <p>${q?"Try a different title, person, year, or genre.":archiveDecadeFilter?"Choose another decade or add a title from this era.":"Save a film or series you love, and it will find its place here."}</p>
      </div>`}`;

  document.querySelectorAll(".poster,.archiveHeroOpen[data-id]").forEach(p => {
    p.onclick = () => stageFromCard(movies.find(m => String(m.tmdbId) === p.dataset.id),p);
    if (p.classList.contains("poster")) {
      p.addEventListener("dragstart", e => e.dataTransfer.setData("text/plain", p.dataset.id));
    }
  });
  $("#archiveHeroAdd")?.addEventListener("click",addModal);
  document.querySelectorAll("[data-watchlist-scroll]").forEach(button=>{
    button.addEventListener("click",()=>{
      $("#archiveWatchlistTrack")?.scrollBy({
        left:Number(button.dataset.watchlistScroll)*Math.max(250,$("#archiveWatchlistTrack").clientWidth*.8),
        behavior:"smooth"
      });
    });
  });
  document.querySelectorAll("[data-recommendation-scroll]").forEach(button=>{
    button.addEventListener("click",()=>{
      $("#archiveRecommendationRail")?.scrollBy({
        left:Number(button.dataset.recommendationScroll)*Math.max(250,$("#archiveRecommendationRail").clientWidth*.8),
        behavior:"smooth"
      });
    });
  });
  loadArchiveRecommendations([...allWatched,...allWant]);
  document.querySelectorAll(".archiveDecade").forEach(button=>{
    button.addEventListener("click",()=>{
      archiveDecadeFilter=button.dataset.decade||"";
      show("archive",searchQuery,{history:false});
    });
  });
  const watchTarget=document.querySelector(".vertical-watch");
  if (watchTarget) {
    watchTarget.ondragenter=e=>{
      e.preventDefault();
      watchTarget.classList.add("dragOver");
    };
    watchTarget.ondragover=e=>{
      e.preventDefault();
      watchTarget.classList.add("dragOver");
    };
    watchTarget.ondragleave=e=>{
      if (e.relatedTarget instanceof Node&&watchTarget.contains(e.relatedTarget)) return;
      watchTarget.classList.remove("dragOver");
    };
    watchTarget.ondrop=dropWatch;
  }
  focusArchiveSearch();
}

async function loadArchiveRecommendations(libraryMovies) {
  const rail=$("#archiveRecommendationRail");
  if (!rail) return;
  const request=++archiveRecommendationRequest;
  if (!libraryMovies.length) {
    rail.innerHTML='<p class="archiveRecommendationStatus">Add a title to your collection or watchlist and CineVault will find recommendations based on your taste.</p>';
    return;
  }
  if (!tmdbReady()) {
    rail.innerHTML='<p class="archiveRecommendationStatus">Add a TMDB API key in Settings to get recommendations picked for your collection.</p>';
    return;
  }

  rail.innerHTML='<p class="archiveRecommendationStatus">Finding titles shaped by your collection and watchlist…</p>';
  const types=[...new Set(libraryMovies.map(movie=>movie.type==="series"?"series":"movie"))];
  const requests=types.map(async type=>{
    const matchingType=libraryMovies.filter(movie=>(movie.type==="series"?"series":"movie")===type);
    const watchedSeeds=matchingType.filter(movie=>movie.status==="watched").slice(0,3);
    const watchlistSeeds=matchingType.filter(movie=>movie.status==="want").slice(0,2);
    const seedIds=[...new Set([...watchedSeeds,...watchlistSeeds].map(movie=>String(movie.tmdbId)))];
    if (!seedIds.length) return [];
    const params=new URLSearchParams({ids:seedIds.join(","),type});
    const response=await fetch(`/api/recommendations?${params}`,{headers:tmdbHeaders()});
    const result=await readApiJson(response,"TMDB recommendations API");
    if (!response.ok) throw new Error(result.error||"TMDB recommendations are unavailable.");
    return result.recommendations||[];
  });
  const results=await Promise.allSettled(requests);
  if (request!==archiveRecommendationRequest||!$("#archiveRecommendationRail")) return;

  const recommendations=results
    .filter(result=>result.status==="fulfilled")
    .flatMap(result=>result.value)
    .filter(recommendation=>!movies.some(movie=>String(movie.tmdbId)===String(recommendation.id)))
    .filter((recommendation,index,list)=>list.findIndex(other=>
      String(other.id)===String(recommendation.id)&&other.type===recommendation.type
    )===index)
    .slice(0,18);
  const errors=results.filter(result=>result.status==="rejected").map(result=>result.reason?.message||"TMDB recommendations could not be loaded.");

  if (!recommendations.length) {
    rail.innerHTML=errors.length
      ? `<p class="archiveRecommendationStatus">Could not load recommendations: ${esc(errors.join(" "))}</p>`
      : '<p class="archiveRecommendationStatus">No new recommendations right now. Add more films or series to your collection and watchlist, then check back.</p>';
    return;
  }

  const typeLabels={movie:"FILM",series:"SERIES"};
  rail.innerHTML=recommendations.map(recommendation=>`
    <article class="archiveRecommendationCard" data-recommendation-item>
      <button type="button" class="archiveRecommendationPoster archiveRecommendationOpen" aria-label="Open details for ${esc(recommendation.title||"this recommendation")}">
        <img src="${esc(img(recommendation.posterPath))}" alt="" loading="lazy">
        <span>${typeLabels[recommendation.type]||"FILM"}${recommendation.year?` · ${esc(recommendation.year)}`:""}</span>
      </button>
      <div class="archiveRecommendationInfo">
        <button type="button" class="archiveRecommendationTitle archiveRecommendationOpen">${esc(recommendation.title||"Untitled")}</button>
        ${recommendation.tmdbRating?`<small>TMDB ${Number(recommendation.tmdbRating).toFixed(1)}</small>`:""}
        <button type="button" class="archiveRecommendationExpand" aria-expanded="false">MORE LIKE THIS <span>＋</span></button>
        <div class="archiveRecommendationActions">
          <button type="button" class="archiveRecommendationAdd" data-id="${esc(recommendation.id)}" data-type="${esc(recommendation.type)}" data-status="want">＋ WATCHLIST</button>
          <button type="button" class="archiveRecommendationAdd archiveRecommendationCollect" data-id="${esc(recommendation.id)}" data-type="${esc(recommendation.type)}" data-status="watched">＋ COLLECTION</button>
        </div>
      </div>
      <div class="archiveRecommendationExpansion" hidden>
        <p>${esc(recommendation.overview||"Explore more titles with a similar feel.")}</p>
        <span class="archiveSimilarHeading">SIMILAR PICKS</span>
        <div class="archiveSimilarRail"><p class="archiveRecommendationStatus">Open to find similar films and series…</p></div>
      </div>
    </article>`).join("")+(errors.length?`<p class="archiveRecommendationError">${esc(errors.join(" "))}</p>`:"");

  rail.querySelectorAll(".archiveRecommendationAdd").forEach(button=>{
    button.addEventListener("click",()=>addRecommendedTitle(button,button.dataset.status));
  });
  rail.querySelectorAll(".archiveRecommendationOpen").forEach(button=>{
    button.addEventListener("click",()=>openRecommendedTitle(button.closest(".archiveRecommendationCard")));
  });
  rail.querySelectorAll(".archiveRecommendationCard").forEach(card=>{
    card.addEventListener("click",event=>{
      if (event.target instanceof Element&&event.target.closest("button,a,.archiveRecommendationExpansion")) return;
      openRecommendedTitle(card);
    });
  });
  rail.querySelectorAll(".archiveRecommendationExpand").forEach(button=>{
    button.addEventListener("click",()=>toggleSimilarRecommendations(button));
  });
}

async function openRecommendedTitle(card) {
  if (!card||card.dataset.opening==="true") return;
  const action=card.querySelector(".archiveRecommendationAdd");
  const id=action?.dataset.id;
  const type=action?.dataset.type==="series"?"series":"movie";
  if (!id) return;
  card.dataset.opening="true";
  card.setAttribute("aria-busy","true");
  card.querySelectorAll(".archiveRecommendationOpen").forEach(button=>button.disabled=true);
  let errorMessage=card.querySelector(".archiveRecommendationOpenError");
  if (errorMessage) errorMessage.remove();
  try {
    const params=new URLSearchParams({id,type});
    const response=await fetch(`/api/movie?${params}`,{headers:tmdbHeaders()});
    const details=await readApiJson(response,"TMDB title details API");
    if (!response.ok) throw new Error(details.error||"Could not load this recommendation.");
    stage({
      ...details,
      tmdbId:details.tmdbId||id,
      title:details.title||"Untitled",
      type:details.type||type,
      posterPath:details.posterPath||"",
      backdropPath:details.backdropPath||"",
      genres:Array.isArray(details.genres)?details.genres:[],
      cast:details.cast||[]
    });
  } catch(error) {
    console.error("Could not open TMDB recommendation details.",error);
    errorMessage=document.createElement("p");
    errorMessage.className="archiveRecommendationOpenError";
    errorMessage.textContent=error.message||"Could not load this title's details.";
    card.querySelector(".archiveRecommendationInfo")?.append(errorMessage);
  } finally {
    delete card.dataset.opening;
    card.removeAttribute("aria-busy");
    card.querySelectorAll(".archiveRecommendationOpen").forEach(button=>button.disabled=false);
  }
}

async function toggleSimilarRecommendations(button) {
  const card=button.closest(".archiveRecommendationCard");
  const expansion=card?.querySelector(".archiveRecommendationExpansion");
  const rail=expansion?.querySelector(".archiveSimilarRail");
  const control=card?.querySelector(".archiveRecommendationExpand");
  if (!card||!expansion||!rail||!control) return;
  const open=control.getAttribute("aria-expanded")==="true";
  if (!open) {
    card.parentElement.querySelectorAll(".archiveRecommendationCard.expanded").forEach(other=>{
      if (other===card) return;
      other.classList.remove("expanded");
      other.querySelector(".archiveRecommendationExpansion").hidden=true;
      other.querySelector(".archiveRecommendationExpand").setAttribute("aria-expanded","false");
      other.querySelector(".archiveRecommendationExpand").innerHTML="MORE LIKE THIS <span>＋</span>";
    });
  }
  control.setAttribute("aria-expanded",String(!open));
  control.innerHTML=open?"MORE LIKE THIS <span>＋</span>":"SIMILAR PICKS <span>−</span>";
  card.classList.toggle("expanded",!open);
  expansion.hidden=open;
  if (open||rail.dataset.loaded==="true"||rail.dataset.loading==="true") return;

  const id=card.querySelector(".archiveRecommendationAdd")?.dataset.id;
  const type=card.querySelector(".archiveRecommendationAdd")?.dataset.type==="series"?"series":"movie";
  if (!id) return;
  rail.dataset.loading="true";
  rail.innerHTML='<p class="archiveRecommendationStatus">Finding similar films and series…</p>';
  try {
    const params=new URLSearchParams({ids:id,type});
    const response=await fetch(`/api/recommendations?${params}`,{headers:tmdbHeaders()});
    const result=await readApiJson(response,"TMDB similar recommendations API");
    if (!response.ok) throw new Error(result.error||"Could not load similar recommendations.");
    const similar=(result.recommendations||[])
      .filter(item=>String(item.id)!==String(id))
      .filter(item=>!movies.some(movie=>String(movie.tmdbId)===String(item.id)))
      .slice(0,8);
    if (!similar.length) {
      rail.innerHTML='<p class="archiveRecommendationStatus">No similar titles are available yet.</p>';
    } else {
      rail.innerHTML=similar.map(item=>`
        <article class="archiveSimilarCard" data-recommendation-item>
          <img src="${esc(img(item.posterPath))}" alt="" loading="lazy">
          <span><b>${esc(item.title||"Untitled")}</b><small>${esc([item.type==="series"?"SERIES":"FILM",item.year].filter(Boolean).join(" · "))}</small></span>
          <div class="archiveSimilarActions">
            <button type="button" class="archiveRecommendationAdd" data-id="${esc(item.id)}" data-type="${esc(item.type)}" data-status="want" aria-label="Add ${esc(item.title)} to watchlist">＋ LIST</button>
            <button type="button" class="archiveRecommendationAdd archiveRecommendationCollect" data-id="${esc(item.id)}" data-type="${esc(item.type)}" data-status="watched" aria-label="Add ${esc(item.title)} to collection">＋ SEEN</button>
          </div>
        </article>`).join("");
      rail.querySelectorAll(".archiveRecommendationAdd").forEach(action=>{
        action.addEventListener("click",()=>addRecommendedTitle(action,action.dataset.status));
      });
    }
    rail.dataset.loaded="true";
  } catch(error) {
    console.error("Could not load similar TMDB recommendations.",error);
    rail.innerHTML=`<p class="archiveRecommendationStatus">Could not load similar picks: ${esc(error.message||"TMDB request failed.")}</p>`;
    rail.dataset.loaded="true";
  } finally {
    delete rail.dataset.loading;
  }
}

async function addRecommendedTitle(button,status) {
  const id=button.dataset.id;
  const type=button.dataset.type==="series"?"series":"movie";
  const targetStatus=status==="watched"?"watched":"want";
  if (!id) return;
  const item=button.closest("[data-recommendation-item]");
  const actionButtons=item?.querySelectorAll(".archiveRecommendationAdd")||[button];
  actionButtons.forEach(action=>{
    action.disabled=true;
    if (action===button) action.textContent="ADDING…";
  });
  try {
    const params=new URLSearchParams({id,type});
    const response=await fetch(`/api/movie?${params}`,{headers:tmdbHeaders()});
    const details=await readApiJson(response,"TMDB title details API");
    if (!response.ok) throw new Error(details.error||"Could not load this recommendation.");
    const movie={
      ...details,
      tmdbId:details.tmdbId||id,
      title:details.title||"Untitled",
      type:details.type||type,
      posterPath:details.posterPath||"",
      backdropPath:details.backdropPath||"",
      genres:Array.isArray(details.genres)?details.genres:[],
      cast:details.cast||[],
      status:targetStatus
    };
    await saveMovie(movie,targetStatus);
    archiveDecadeFilter="";
    await show("archive",searchQuery,{history:false});
  } catch(error) {
    console.error(`Could not add TMDB recommendation to ${targetStatus==="watched"?"the collection":"the watchlist"}.`,error);
    actionButtons.forEach(action=>{
      action.disabled=false;
      action.textContent=action.dataset.status==="watched"?"＋ COLLECTION":"＋ WATCHLIST";
    });
    alert(error.message||`Could not add this recommendation to ${targetStatus==="watched"?"your collection":"your watchlist"}.`);
  }
}

function updateNotificationBadge() {
  const badge=$("#notificationCount");
  if (!badge) return;
  const unread=notifications.filter(notification=>!notification.read_at).length;
  badge.textContent=unread ? String(unread>99?"99+":unread) : "";
  badge.classList.toggle("visible",unread>0);
}

function notificationText(notification) {
  const actor=notification.actor?.username||"Someone";
  if (notification.notification_type==="library_shared") return `@${actor} shared their library with you.`;
  if (notification.notification_type==="library_access_revoked") return `Library access with @${actor} was revoked.`;
  if (notification.notification_type==="library_access_updated") return `@${actor} changed your library access.`;
  if (notification.notification_type==="message_received") return `New message from @${actor}.`;
  return `New activity from @${actor}.`;
}

function renderNotificationPanel() {
  const panel=$("#notificationPanel");
  if (!panel) return;
  panel.innerHTML=`
    <div class="notificationPanelHead">
      <b>Notifications</b>
      <button onclick="markAllNotificationsRead()">Mark all read</button>
    </div>
    ${notifications.length
      ? notifications.map(notification=>`
        <button class="notificationItem ${notification.read_at?"":"unread"}" onclick="openNotification('${notification.id}')">
          <span>${esc(notificationText(notification))}</span>
          <small>${new Date(notification.created_at).toLocaleString()}</small>
        </button>`).join("")
      : '<p class="muted notificationEmpty">You’re all caught up.</p>'}`;
}

async function refreshNotifications() {
  if (!currentUser) return;
  const {data,error}=await supabaseClient.from("notifications")
    .select("id,actor_id,notification_type,resource_id,created_at,read_at")
    .eq("user_id",currentUser.id)
    .order("created_at",{ascending:false})
    .limit(50);
  if (error) {
    console.error("Could not refresh notifications.",error);
    return;
  }

  const rows=data||[];
  const actorIds=[...new Set(rows.map(notification=>notification.actor_id).filter(Boolean))];
  let actors=[];
  if (actorIds.length) {
    const {data:profiles,error:profileError}=await supabaseClient.from("profiles")
      .select("id,username")
      .in("id",actorIds);
    if (profileError) {
      console.error("Could not load notification names.",profileError);
      return;
    }
    actors=profiles||[];
  }
  const usernames=new Map(actors.map(actor=>[actor.id,actor.username]));
  notifications=rows.map(notification=>({
    ...notification,
    actor:{username:usernames.get(notification.actor_id)||"Someone"}
  }));
  updateNotificationBadge();
  if ($("#notificationPanel")?.classList.contains("open")) renderNotificationPanel();
}

async function toggleNotifications() {
  const panel=$("#notificationPanel");
  if (!panel) return;
  panel.classList.toggle("open");
  if (panel.classList.contains("open")) {
    await refreshNotifications();
    renderNotificationPanel();
  }
}

window.markAllNotificationsRead=async()=>{
  const {error}=await supabaseClient.rpc("mark_notifications_read",{p_notification_id:null});
  if (error) return alert(`Could not mark notifications as read: ${error.message}`);
  notifications=notifications.map(notification=>({...notification,read_at:notification.read_at||new Date().toISOString()}));
  updateNotificationBadge();
  renderNotificationPanel();
};

window.openNotification=async id=>{
  const notification=notifications.find(item=>item.id===id);
  const {error}=await supabaseClient.rpc("mark_notifications_read",{p_notification_id:id});
  if (error) return alert(`Could not mark notification as read: ${error.message}`);
  notifications=notifications.map(item=>item.id===id?{...item,read_at:new Date().toISOString()}:item);
  updateNotificationBadge();
  $("#notificationPanel")?.classList.remove("open");
  if (!notification) return;
  if (notification.notification_type==="message_received" && notification.actor_id) {
    await show("network");
    await openChat(notification.actor_id);
  } else {
    await loadData();
    await show("shared");
  }
};

async function renderNetwork() {
  if (!networkUsers.length) {
    const users=[];
    const pageSize=500;
    for (let start=0;;start+=pageSize) {
      const {data,error}=await supabaseClient.from("profiles")
        .select("id,username,display_name,avatar")
        .neq("id",currentUser.id)
        .order("username")
        .range(start,start+pageSize-1);
      if (error) {
        $("#content").innerHTML=`<p class="muted">Could not load your network: ${esc(error.message)}</p>`;
        return;
      }
      users.push(...(data||[]));
      if (!data || data.length<pageSize) break;
    }
    networkUsers=users;
  }

  const selected=activeChatUser
    ? networkUsers.find(user=>user.id===activeChatUser.id)||activeChatUser
    : null;
  $("#content").innerHTML=`
    <section class="networkPage">
      <div class="head"><div><span>CINEVAULT NETWORK</span><h2>People</h2></div><small>${networkUsers.length} USERS</small></div>
      <div class="networkLayout">
        <div class="networkDirectory">
          <input id="networkSearch" class="field networkSearch" placeholder="Find a person">
          <div id="networkUsers">${networkUserRows(networkUsers,selected?.id)}</div>
        </div>
        <section id="chatPanel" class="chatPanel">
          ${selected
            ? chatShell(selected)
            : '<div class="chatEmpty"><b>Start a conversation</b><p>Select someone from your network to message or manage library access.</p></div>'}
        </section>
      </div>
    </section>`;

  $("#networkSearch").oninput=event=>{
    const query=event.target.value.trim().toLowerCase();
    const filtered=networkUsers.filter(user=>
      `${user.username} ${user.display_name||""}`.toLowerCase().includes(query)
    );
    $("#networkUsers").innerHTML=networkUserRows(filtered,selected?.id);
    bindNetworkUserButtons();
  };
  bindNetworkUserButtons();
  if (selected) {
    await refreshChatMessages(selected,true);
    clearInterval(chatRefreshTimer);
    chatRefreshTimer=setInterval(()=>refreshChatMessages(activeChatUser,true),5000);
    $("#chatShareDuration").onchange=event=>{
      $("#chatCustomExpiry").hidden=event.target.value!=="custom";
    };
  }
}

function networkUserRows(users,selectedId) {
  return users.map(user=>`
    <button class="networkUser ${user.id===selectedId?"selected":""}" data-user-id="${user.id}">
      <span class="networkAvatar">${user.avatar
        ? `<img src="${esc(img(user.avatar))}" alt="">`
        : esc((user.display_name||user.username).slice(0,1).toUpperCase())}</span>
      <span><b>@${esc(user.username)}</b><small>${esc(user.display_name||"CineVault member")}</small></span>
      <span class="networkUserAction">Chat</span>
    </button>`).join("")||'<p class="muted networkEmpty">No users found.</p>';
}

function bindNetworkUserButtons() {
  document.querySelectorAll(".networkUser").forEach(button=>{
    button.onclick=()=>openChat(button.dataset.userId);
  });
}

async function openChat(userId) {
  const user=networkUsers.find(person=>person.id===userId);
  if (!user) {
    const {data,error}=await supabaseClient.from("profiles")
      .select("id,username,display_name,avatar").eq("id",userId).maybeSingle();
    if (error) return alert(`Could not open this conversation: ${error.message}`);
    if (!data) return alert("This user is no longer available.");
    activeChatUser=data;
    networkUsers.push(data);
  } else {
    activeChatUser=user;
  }

  clearInterval(chatRefreshTimer);
  await renderNetwork();
}

function chatShell(user) {
  const share=outgoingShares.find(item=>item.receiver_id===user.id&&shareIsActive(item));
  return `
    <div class="chatHeader">
      <div><b>@${esc(user.username)}</b><small>Private conversation</small></div>
    </div>
    <div class="chatAccess">
      <span>${share?`Library access · ${esc(shareExpiryText(share))}`:"Library not shared"}</span>
      <label for="chatShareDuration">ACCESS</label>
      <select id="chatShareDuration" class="field">
        <option value="1h">1 hour</option>
        <option value="1d">1 day</option>
        <option value="7d">1 week</option>
        <option value="30d">1 month</option>
        <option value="custom">Custom time…</option>
        <option value="forever">Until revoked</option>
      </select>
      <input id="chatCustomExpiry" class="field customExpiry" type="datetime-local" aria-label="Custom access expiry" hidden>
      <button class="primary" onclick="shareLibraryFromChat('${user.id}')">${share?"Update access":"Share library"}</button>
      ${share?`<button class="danger" onclick="revokeShare('${share.id}')">Revoke</button>`:""}
    </div>
    <div id="chatMessages" class="chatMessages"></div>
    <form id="chatForm" class="chatForm">
      <input id="chatInput" class="field" maxlength="2000" placeholder="Write a message…" autocomplete="off">
      <button class="primary" type="submit">Send</button>
    </form>`;
}

async function refreshChatMessages(user,markRead=true) {
  if (!user || activeTab!=="network" || activeChatUser?.id!==user.id) return;
  const {data,error}=await supabaseClient.from("messages")
    .select("id,sender_id,receiver_id,body,created_at,read_at")
    .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${user.id}),and(sender_id.eq.${user.id},receiver_id.eq.${currentUser.id})`)
    .order("created_at",{ascending:false}).limit(200);
  if (error) {
    const panel=$("#chatMessages");
    if (panel) panel.innerHTML=`<p class="muted">Could not load messages: ${esc(error.message)}</p>`;
    return;
  }
  if (activeTab!=="network" || activeChatUser?.id!==user.id) return;
  const messages=(data||[]).reverse();
  const panel=$("#chatMessages");
  if (!panel) return;
  const wasAtBottom=panel.scrollHeight-panel.scrollTop-panel.clientHeight<80;
  panel.innerHTML=messages.map(message=>`
    <article class="chatMessage ${message.sender_id===currentUser.id?"sent":"received"}">
      <p>${esc(message.body)}</p><small>${new Date(message.created_at).toLocaleString()}</small>
    </article>`).join("")||'<p class="muted chatEmptyMessages">No messages yet. Say hello!</p>';
  if (wasAtBottom || !panel.dataset.loaded) panel.scrollTop=panel.scrollHeight;
  panel.dataset.loaded="true";

  if (markRead && messages.some(message=>message.receiver_id===currentUser.id&&!message.read_at)) {
    const {error:readError}=await supabaseClient.rpc("mark_messages_read",{p_sender_id:user.id});
    if (readError) console.error("Could not mark messages as read.",readError);
    else refreshNotifications();
  }

  const form=$("#chatForm");
  if (form && !form.dataset.bound) {
    form.dataset.bound="true";
    form.onsubmit=async event=>{
      event.preventDefault();
      const input=$("#chatInput");
      const body=input.value.trim();
      if (!body) return;
      const {error:sendError}=await supabaseClient.from("messages").insert({
        sender_id:currentUser.id,receiver_id:user.id,body
      });
      if (sendError) return alert(`Could not send message: ${sendError.message}`);
      input.value="";
      await refreshChatMessages(user,false);
      refreshNotifications();
    };
  }
}

function shareExpiration(duration,customInput) {
  const durations={"1h":60*60*1000,"1d":24*60*60*1000,"7d":7*24*60*60*1000,"30d":30*24*60*60*1000};
  if (duration==="forever") return null;
  if (duration==="custom") {
    const value=customInput?.value;
    if (!value || !Number.isFinite(Date.parse(value)) || Date.parse(value)<=Date.now()) {
      throw new Error("Choose a future date and time for custom access.");
    }
    return new Date(value).toISOString();
  }
  if (!durations[duration]) throw new Error("Choose a valid library access duration.");
  return new Date(Date.now()+durations[duration]).toISOString();
}

window.shareLibraryFromChat=async userId=>{
  let expiresAt;
  try {
    expiresAt=shareExpiration($("#chatShareDuration").value,$("#chatCustomExpiry"));
  } catch(error) {
    return alert(error.message);
  }
  const {error}=await supabaseClient.from("library_shares").upsert({
    sender_id:currentUser.id,receiver_id:userId,created_at:new Date().toISOString(),expires_at:expiresAt
  },{onConflict:"sender_id,receiver_id"});
  if (error) return alert(`Could not share your library: ${error.message}`);
  try {
    await loadData();
    await renderNetwork();
  } catch(loadError) {
    alert(`Library access was updated, but the network could not be refreshed: ${loadError.message}`);
  }
};

function poster(m,i=0,mutual=false,readOnly=false,existingStatus="",archiveStatus="") {
  return `
    <article class="poster p${i%7} ${mutual?"mutual":""} ${readOnly&&existingStatus?"sharedDuplicate":""} ${readOnly&&existingStatus==="watched"?"sharedWatched":""}" draggable="${!existingStatus}" data-shared="${readOnly}" data-id="${m.tmdbId}">
      <img src="${img(m.posterPath)}" alt="${esc(m.title)}">
      <div class="shade">
        <small>${esc(m.year || "")}</small>
        <b>${esc(m.title)}</b>
        <small>${esc((m.genres||[]).slice(0,2).join(" · "))}</small>
      </div>
      ${readOnly&&existingStatus
        ? `<em>${existingStatus==="watched"?"ALREADY WATCHED":"IN YOUR WATCHLIST"}</em>`
        : archiveStatus==="watched"
          ? '<em class="archivePosterStatus archivePosterWatched">IN COLLECTION</em>'
          : archiveStatus==="want"
            ? '<em class="archivePosterStatus archivePosterWant">UP NEXT</em>'
        : mutual ? "<em>WATCHED</em>" : ""}
    </article>`;
}

function watchlist(ms=movies.filter(m => m.status === "want")) {

  return `
    <section class="watch vertical-watch archiveQueue"
      ondragover="event.preventDefault()"
      ondrop="dropWatch(event)">
      <div class="archiveQueueHead">
        <div><span>THE NEXT SCREENING</span><b>Your watchlist</b></div>
        <small>${ms.length} ${ms.length===1?"FILM":"FILMS"} QUEUED</small>
      </div>
      <div class="archiveQueueCarousel">
      <div class="archiveQueueTrack" id="archiveWatchlistTrack">${
        ms.length
        ? ms.map(m=>`
          <article class="archiveQueueCard" data-id="${esc(m.tmdbId)}" onclick="stageById('${esc(m.tmdbId)}',this)">
            <img src="${esc(img(m.posterPath))}" alt="" loading="lazy">
            <span><b>${esc(m.title)}</b><small>${esc([m.year,...(m.genres||[]).slice(0,1)].filter(Boolean).join(" · "))}</small></span>
            <i aria-hidden="true">↗</i>
          </article>`).join("")
        : `<div class="archiveQueueEmpty"><p>Your next favorite is still out there.</p><button type="button" onclick="addModal()">＋ FIND A FILM</button></div>`
      }</div>
      ${ms.length>1?`<div class="archiveRailControls"><button type="button" data-watchlist-scroll="-1" aria-label="Scroll watchlist left">‹</button><button type="button" data-watchlist-scroll="1" aria-label="Scroll watchlist right">›</button></div>`:""}
      </div>
    </section>`;
}

window.dropWatch = async e => {
  e.preventDefault();
  const dropTarget=e.currentTarget;
  const sharedPayload=e.dataTransfer.getData("application/x-cinevault-movie");

  try {
    if (sharedPayload) {
      const sharedMovie=JSON.parse(sharedPayload);
      const existing=movies.find(movie=>String(movie.tmdbId)===String(sharedMovie.tmdbId));
      if (existing) {
        alert(existing.status==="watched"
          ? `${existing.title} is already marked watched.`
          : `${existing.title} is already in your want-to-watch list.`);
        return;
      }
      await saveMovie(sharedMovie,"want");
    } else {
      const id=e.dataTransfer.getData("text/plain");
      const m=movies.find(x=>String(x.tmdbId)===String(id));
      if (!m) return;
      await updateMovie(m,{status:"want"});
    }
    dropTarget.classList.add("dropComplete");
    await new Promise(resolve=>setTimeout(resolve,260));
    if (sharedPayload && activeTab==="sharedLibrary" && activeSharedShareId) {
      await renderSharedLibrary(activeSharedShareId);
    } else {
      await show("archive");
    }
  } catch(err) {
    alert(err.message);
  } finally {
    dropTarget.classList.remove("dragOver");
    dropTarget.classList.remove("dropComplete");
  }
};

function recent() {
  const ms = [...movies].sort((a,b)=>new Date(b.addedAt)-new Date(a.addedAt));

  return `
    <div class="head recent">
      <div><span>RECENTLY ADDED</span><h2>New to the vault</h2></div>
    </div>
    <div class="timeline">
      ${ms.map(m=>`
        <article data-id="${m.tmdbId}" onclick="stageById('${m.tmdbId}',this)">
          <time>${m.addedAt ? new Date(m.addedAt).toLocaleDateString(undefined,{month:"short",day:"2-digit"}) : ""}</time>
          <img src="${img(m.posterPath)}" alt="${esc(m.title)}">
          <div>
            <small>${esc(m.type||"movie")} · ${esc(m.year)}</small>
            <h2>${esc(m.title)}</h2>
            <span class="recentStatus ${m.status==="want"?"recentStatusWant":"recentStatusWatched"}">${m.status==="want"?"WANT TO WATCH":"WATCHED · IN COLLECTION"}</span>
            <p>${esc(m.overview||"No synopsis available.")}</p>
          </div>
        </article>`).join("")}
    </div>`;
}

function stageFromCard(movie,card,readOnly=false,sequenceOverride=null) {
  if (!movie) return;
  let cards=[];
  if (card instanceof Element) {
    if (card.matches(".poster")) cards=[...card.parentElement.querySelectorAll(":scope > .poster")];
    else if (card.matches(".timeline article")) cards=[...card.parentElement.querySelectorAll(":scope > article")];
    else if (card.matches(".watch article")) cards=[...card.parentElement.querySelectorAll(":scope > article")];
  }
  const sequence=sequenceOverride||cards
    .map(item=>movies.find(candidate=>String(candidate.tmdbId)===item.dataset.id))
    .filter(Boolean);
  stage(movie,readOnly,{sequence:sequence.length?sequence:[movie]});
}

window.stageById = (id,card=null) => stageFromCard(
  movies.find(m=>String(m.tmdbId)===String(id)),
  card
);

function creditImage(path) {
  if (!path) return "";
  return /^https?:\/\//i.test(path) ? path : `https://image.tmdb.org/t/p/w185${path}`;
}

function creditInitials(name) {
  return String(name||"?").split(/\s+/).slice(0,2).map(part=>part[0]||"").join("").toUpperCase();
}

function formatRuntime(minutes) {
  const value=Number(minutes);
  if (!Number.isFinite(value)||value<=0) return "";
  const hours=Math.floor(value/60);
  const remainder=value%60;
  return hours?`${hours}h ${remainder}m`:`${remainder} min`;
}

function renderMovieFacts(movie) {
  const imdbUrl=movie.imdbId?`https://www.imdb.com/title/${encodeURIComponent(movie.imdbId)}/`:"";
  const imdbRating=String(movie.imdbRating||"").trim();
  const tmdbRating=Number(movie.tmdbRating);
  const hasImdbRating=imdbRating!==""&&imdbRating!=="N/A";
  const hasTmdbRating=Number.isFinite(tmdbRating)&&tmdbRating>0;
  const displayedScore=hasImdbRating
    ? `★ ${esc(imdbRating)}/10 IMDb`
    : hasTmdbRating
      ? `★ ${tmdbRating.toFixed(1)}/10 TMDB`
      : "IMDb rating unavailable";
  const ratingTitle=hasImdbRating
    ? "IMDb user rating; open IMDb title page"
    : hasTmdbRating
      ? "IMDb rating unavailable; showing TMDB user rating. Open IMDb title page"
      : movie.imdbRatingError||"IMDb rating is unavailable.";
  const runtime=movie.type==="series"
    ? [
        movie.seasonCount?`${movie.seasonCount} season${movie.seasonCount===1?"":"s"}`:"",
        movie.episodeCount?`${movie.episodeCount} episode${movie.episodeCount===1?"":"s"}`:"",
        (movie.episodeRuntime||[]).length
          ? `~${[...new Set(movie.episodeRuntime)].map(formatRuntime).filter(Boolean).join("–")} per episode`
          : ""
      ].filter(Boolean).join(" · ")
    : formatRuntime(movie.runtimeMinutes);
  return `
    <div class="movieFacts">
      ${imdbUrl
        ? `<a class="imdbScore ${hasImdbRating||hasTmdbRating?"":"imdbScoreUnavailable"}" href="${imdbUrl}" target="_blank" rel="noopener" title="${esc(ratingTitle)}" aria-label="${esc(displayedScore)}; open IMDb title page">${displayedScore} ↗</a>`
        : `<span class="imdbScore ${hasImdbRating||hasTmdbRating?"":"imdbScoreUnavailable"}" title="${esc(ratingTitle)}">${displayedScore}</span>`}
      ${hasImdbRating&&hasTmdbRating?`<span class="tmdbScore">★ ${tmdbRating.toFixed(1)} TMDB</span>`:""}
      ${runtime?`<span class="runtimeFact">${movie.type==="series"?"SERIES":"RUNTIME"} · ${esc(runtime)}</span>`:""}
    </div>`;
}

function renderCredits(movie) {
  const production=Array.isArray(movie.production)&&movie.production.length
    ? movie.production
    : movie.directorDetails?.name
      ? [{...movie.directorDetails,jobs:[movie.directorLabel||"Director"]}]
      : movie.director
        ? [{name:movie.director,profilePath:"",jobs:[movie.directorLabel||"Director"]}]
        : [];
  const cast=Array.isArray(movie.castDetails)&&movie.castDetails.length
    ? movie.castDetails
    : (movie.cast||[]).map(person=>typeof person==="string"?{name:person}:person);
  const personCard=(person,kind)=>`
    <article class="${kind}Credit">
      ${personPageUrl(person)
        ? `<a class="creditPortraitLink" href="${personPageUrl(person)}" data-person-id="${esc(person.id)}" aria-label="Open ${esc(person.name)}'s details">`
        : '<span class="creditPortraitLink">'}
        ${person.profilePath
          ? `<img src="${esc(creditImage(person.profilePath))}" alt="${esc(person.name)}">`
          : `<span class="creditInitials">${esc(creditInitials(person.name))}</span>`}
      ${personPageUrl(person)?'</a>':"</span>"}
      <span class="creditPersonHeading">
        <a class="creditPersonSearch" href="https://www.google.com/search?q=${encodeURIComponent(person.name||"Crew member")}" target="_blank" rel="noopener">${esc(person.name||"Crew member")}</a>
        <button type="button" class="copyPersonName copyPersonCompact" data-copy-name="${esc(person.name||"Crew member")}" aria-label="Copy ${esc(person.name||"Crew member")}'s name" title="Copy name"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button>
      </span>
      <div class="creditTags">${(person.jobs||[]).map(job=>`<span class="creditTag">${esc(job)}</span>`).join("")}</div>
      ${person.character?`<small>${esc(person.character)}</small>`:""}
    </article>`;
  return `
    <div class="creditSection">
      <span class="creditSectionLabel">PRODUCTION</span>
      ${production.length
        ? `<div class="productionCredits">${production.map(person=>personCard(person,"production")).join("")}</div>`
        : '<p class="creditEmpty">Production credits unavailable.</p>'}
    </div>
    <div class="creditSection">
      <span class="creditSectionLabel">CAST</span>
      ${cast.length
        ? `<div class="castCredits">${cast.map(person=>personCard({
            ...person,
            jobs:person.jobs?.length?person.jobs:["Actor"]
          },"cast")).join("")}</div>`
        : '<p class="creditEmpty">Cast details unavailable.</p>'}
    </div>`;
}

function renderCreditsPlaceholder() {
  const cards=(count,kind)=>`<div class="${kind}Credits creditSkeletonRow" aria-hidden="true">${Array.from({length:count},()=>`
    <div class="${kind}Credit creditSkeletonCard">
      <span class="creditSkeletonPortrait"></span>
      <span class="creditSkeletonLine"></span>
      <span class="creditSkeletonLine short"></span>
    </div>`).join("")}</div>`;
  return `
    <div class="creditSection creditSkeletonSection" aria-hidden="true">
      <span class="creditSectionLabel">PRODUCTION</span>${cards(4,"production")}
    </div>
    <div class="creditSection creditSkeletonSection" aria-hidden="true">
      <span class="creditSectionLabel">CAST</span>${cards(6,"cast")}
    </div>`;
}

async function refreshStageCredits(movie) {
  const panel=$("#stageCredits");
  if (!panel) return;
  if (!tmdbReady()) {
    panel.innerHTML='<p class="creditLoadMessage">Add a TMDB API key in Settings to load cast and crew portraits.</p>';
    return;
  }
  try {
    const type=movie.type==="series"?"series":"movie";
    const params=new URLSearchParams({id:String(movie.tmdbId),type});
    const response=await fetch(`/api/movie?${params}`,{headers:tmdbHeaders()});
    const details=await readApiJson(response,"Movie details API");
    if (!response.ok) throw new Error(details.error||"TMDB could not load cast and crew.");
    const currentPanel=$("#stageCredits");
    if (!currentPanel||$("#stage")?.dataset.movieId!==String(movie.tmdbId)) return;
    currentPanel.innerHTML=renderCredits(details);
    const factsPanel=$("#stageMovieFacts");
    if (factsPanel) factsPanel.innerHTML=renderMovieFacts(details);
    const updatedMovie={
      ...movie,
      backdropPaths:details.backdropPaths||[],
      trailerKey:details.trailerKey||movie.trailerKey||"",
      trailerKeys:details.trailerKeys||movie.trailerKeys||[]
    };
    if (activeStageMovie&&String(activeStageMovie.tmdbId)===String(movie.tmdbId)) {
      activeStageMovie=updatedMovie;
      const sequenceIndex=activeStageSequence.findIndex(item=>String(item.tmdbId)===String(movie.tmdbId));
      if (sequenceIndex>=0) activeStageSequence[sequenceIndex]=updatedMovie;
      const route=history.state;
      if (route?.detail?.type==="movie"&&String(route.detail.id)===String(movie.tmdbId)) {
        const sequence=Array.isArray(route.detail.sequence)?route.detail.sequence.map(item=>
          String(item.tmdbId)===String(movie.tmdbId)?updatedMovie:item
        ):route.detail.sequence;
        history.replaceState({
          ...route,
          detail:{...route.detail,movie:updatedMovie,sequence}
        },"",location.href);
      }
      setStageBackdrops(details.backdropPaths||[]);
      setupStageTrailer(updatedMovie.trailerKeys.length?updatedMovie.trailerKeys:updatedMovie.trailerKey,updatedMovie);
    }
  } catch(error) {
    const currentPanel=$("#stageCredits");
    if (!currentPanel||$("#stage")?.dataset.movieId!==String(movie.tmdbId)) return;
    currentPanel.innerHTML=`<p class="creditLoadMessage">${esc(error.message)}</p>`;
  }
}

function personAge(birthday,deathday) {
  if (!birthday) return "";
  const born=new Date(`${birthday}T00:00:00Z`);
  const died=deathday?new Date(`${deathday}T00:00:00Z`):new Date();
  if (Number.isNaN(born.getTime())||Number.isNaN(died.getTime())) return "";
  let age=died.getUTCFullYear()-born.getUTCFullYear();
  if (died.getUTCMonth()<born.getUTCMonth()||
    (died.getUTCMonth()===born.getUTCMonth()&&died.getUTCDate()<born.getUTCDate())) age--;
  return age>=0?age:"";
}

function personCreditCategory(role) {
  const normalized=String(role||"").toLowerCase();
  if (normalized.startsWith("actor ·")||normalized==="actor") return "Acted";
  if (/^(co-)?director$/.test(normalized)) return "Directed";
  if (normalized.includes("producer")) return "Produced";
  if (/(writer|writing|screenplay|story)/.test(normalized)) return "Wrote";
  if (/(music|composer|score)/.test(normalized)) return "Music";
  if (normalized.includes("editor")) return "Edited";
  return "Other crew";
}

function renderPersonCredit(credit,index) {
  const categories=[...new Set((credit.roles||[]).map(personCreditCategory))];
  return `
    <button type="button" class="personCreditCard" data-credit-index="${index}" data-credit-categories="${esc(categories.join("|"))}">
      ${credit.posterPath
        ? `<img src="${esc(img(credit.posterPath))}" alt="">`
        : '<span class="personCreditPosterFallback">No poster</span>'}
      <span class="personCreditCardBody">
        <b>${esc(credit.title||"Untitled")}</b>
        <small>${credit.mediaType==="tv"?"SERIES":"FILM"}${credit.year?` · ${esc(credit.year)}`:""}</small>
        <span class="creditTags">${(credit.roles||[]).map(role=>`<span class="creditTag">${esc(role)}</span>`).join("")}</span>
      </span>
    </button>`;
}

async function renderPerson(id) {
  const content=$("#content");
  if (!content) return;
  content.innerHTML='<p class="muted">Loading person details…</p>';
  try {
    const response=await fetch(`/api/person?id=${encodeURIComponent(id)}`,{headers:tmdbHeaders()});
    const person=await readApiJson(response,"Person details API");
    if (!response.ok) throw new Error(person.error||"Could not load this person's details.");
    if (history.state?.detail?.type!=="person"||String(history.state.detail.id)!==String(id)) return;
    const age=personAge(person.birthday,person.deathday);
    const imdbUrl=person.imdbId
      ? `https://www.imdb.com/name/${encodeURIComponent(person.imdbId)}/`
      : `https://www.google.com/search?q=${encodeURIComponent(`${person.name} IMDb`)}`;
    const credits=person.filmography||[];
    const creditCategories=["Acted","Directed","Produced","Wrote","Music","Edited","Other crew"]
      .map(category=>({
        category,
        count:credits.filter(credit=>(credit.roles||[]).some(role=>personCreditCategory(role)===category)).length
      }))
      .filter(item=>item.count);
    document.title=`${person.name||"Person"} | CineVault`;
    content.innerHTML=`
      <section class="personPage">
        <button type="button" class="personBack" id="personBack">← Back</button>
        <section class="personHero">
          ${person.profilePath
            ? `<img class="personPortrait" src="${esc(creditImage(person.profilePath))}" alt="${esc(person.name)}">`
            : `<div class="personPortrait personPortraitFallback">${esc((person.name||"?").slice(0,1).toUpperCase())}</div>`}
          <div>
            <p class="muted">${esc(person.knownForDepartment||"FILM & TELEVISION")}</p>
            <div class="personTitleRow">
              <h1 class="personTitle"><a href="https://www.google.com/search?q=${encodeURIComponent(person.name||"Unknown person")}" target="_blank" rel="noopener">${esc(person.name||"Unknown person")}</a></h1>
              <button type="button" class="copyPersonName personTitleCopy" data-copy-name="${esc(person.name||"Unknown person")}" aria-label="Copy ${esc(person.name||"Unknown person")}'s name" title="Copy name"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button>
            </div>
            <div class="personMeta">
              ${person.birthday?`<span>Born ${esc(person.birthday)}${age!==""?` · ${age} years old`:""}</span>`:""}
              ${person.deathday?`<span>Died ${esc(person.deathday)}</span>`:""}
              ${person.placeOfBirth?`<span>${esc(person.placeOfBirth)}</span>`:""}
            </div>
            <a class="personImdb" href="${imdbUrl}" target="_blank" rel="noopener">${person.imdbId?"Open IMDb profile ↗":"Search IMDb ↗"}</a>
            ${person.biography?`<p class="personBio">${esc(person.biography)}</p>`:"<p class=\"personEmpty\">No biography is available from TMDB.</p>"}
          </div>
        </section>
        <div class="personSectionHead">
          <div><p class="muted">FILM & TELEVISION</p><h2>Credits</h2></div>
          <small>${credits.length} TITLES</small>
        </div>
        ${credits.length
          ? `<div class="personCreditFilters" role="group" aria-label="Filter credits">
              <button type="button" class="personCreditFilter active" data-category="all" aria-pressed="true">All <small>${credits.length}</small></button>
              ${creditCategories.map(({category,count})=>`<button type="button" class="personCreditFilter" data-category="${esc(category)}" aria-pressed="false">${esc(category)} <small>${count}</small></button>`).join("")}
            </div>
            <section class="personFilmography">${credits.map(renderPersonCredit).join("")}</section>`
          : '<p class="personEmpty">No filmography is available from TMDB.</p>'}
      </section>`;
    $("#personBack").onclick=closeAppDetail;
    document.querySelectorAll(".copyPersonName").forEach(button=>{
      button.onclick=()=>copyPersonName(button);
    });
    document.querySelectorAll(".personCreditFilter").forEach(filter=>{
      filter.onclick=()=>{
        const category=filter.dataset.category;
        document.querySelectorAll(".personCreditFilter").forEach(button=>{
          const selected=button===filter;
          button.classList.toggle("active",selected);
          button.setAttribute("aria-pressed",String(selected));
        });
        document.querySelectorAll(".personCreditCard").forEach(card=>{
          card.hidden=category!=="all"&&!card.dataset.creditCategories.split("|").includes(category);
        });
      };
    });
    document.querySelectorAll(".personCreditCard").forEach((button,index)=>{
      button.onclick=()=>openPersonCredit(credits[index]);
    });
  } catch(error) {
    if (history.state?.detail?.type!=="person"||String(history.state.detail.id)!==String(id)) return;
    content.innerHTML=`
      <section class="personPage">
        <button type="button" class="personBack" onclick="closeAppDetail()">← Back</button>
        <p class="personError">${esc(error.message)}</p>
      </section>`;
  }
}

async function openPersonCredit(credit) {
  if (!credit?.id) return;
  const type=credit.mediaType==="tv"?"series":"movie";
  const params=new URLSearchParams({id:String(credit.id),type});
  try {
    const response=await fetch(`/api/movie?${params}`,{headers:tmdbHeaders()});
    const movie=await readApiJson(response,"Movie details API");
    if (!response.ok) throw new Error(movie.error||"Could not load this title.");
    stage(movie);
  } catch(error) {
    alert(error.message);
  }
}

function characterWall() {
  return `
    <div class="head">
      <div><span>CHARACTER COLLECTION</span><h2>Your character wall</h2></div>
      <button class="primary" id="randomCharacter">＋ Random character</button>
    </div>
    <div class="characterGrid">
      ${characters.map(c=>`
        <article class="characterCard">
          <img src="${img(c.poster)}" alt="${esc(c.character_name)}">
          <div>
            <b>${esc(c.character_name)}</b>
            <small>${esc(c.actor_name||"")} · ${esc(c.movie_title||"")}</small>
            <button class="danger" onclick="deleteCharacter('${c.id}')">Delete</button>
          </div>
        </article>`).join("")}
    </div>`;
}

async function deleteCharacter(id) {
  if (!confirm("Delete this character?")) return;

  const {error} = await supabaseClient.from("characters")
    .delete().eq("id",id).eq("user_id",currentUser.id);

  if (error) return alert(error.message);

  characters = characters.filter(c => c.id !== id);
  show("characters");
}
window.deleteCharacter = deleteCharacter;

async function randomCharacter() {
  const r = await fetch("/api/character",{headers:tmdbHeaders()});
  if (!r.ok) return alert("Character data is unavailable. Check your TMDB API key.");

  const c = await r.json();

  const {data,error} = await supabaseClient.from("characters").insert({
    user_id:currentUser.id,
    character_name:c.characterName,
    actor_name:c.actorName,
    poster:c.poster,
    movie_title:c.movieTitle
  }).select().single();

  if (error) return alert(error.message);

  characters.unshift(data);
  show("characters");
}

async function shared() {
  const incoming = incomingShares;
  const outgoing = outgoingShares;

  return `
    <section class="sharePage">
      <div class="head">
        <div><span>SHARED WITH YOU</span><h2>Incoming libraries</h2></div>
        <small>${incoming.length} SHARES</small>
      </div>
      <button class="primary" onclick="shareLibraryModal()">Share my library</button>

      ${
        incoming.length
        ? `<div class="shareList">
          ${incoming.map(s=>`
            <article class="libraryShareCard">
              <div>
                <b>@${esc(s.sender?.username||"user")}'s library</b>
                <small>${shareExpiryText(s)} · Read-only access to watched and want-to-watch titles</small>
                <div class="actions">
                  ${shareIsActive(s)
                    ? `<button class="primary" onclick="openSharedLibrary('${s.id}')">View library</button>`
                    : '<span class="muted">Access ended</span>'}
                  <button class="danger" onclick="leaveShare('${s.id}')">Remove access</button>
                </div>
              </div>
            </article>`).join("")}
        </div>`
        : '<p class="muted">No one has shared a library with you yet.</p>'
      }

      <div class="head" style="margin-top:40px">
        <div><span>YOUR SHARES</span><h2>Libraries shared with users</h2></div>
      </div>

      ${
        outgoing.length
        ? `<div class="shareList">
          ${outgoing.map(s=>`
            <article class="libraryShareCard">
              <div>
                <b>Your library → @${esc(s.receiver?.username||"user")}</b>
                <small>${shareExpiryText(s)} · Watched and want-to-watch titles</small>
                <div class="actions">
                  ${shareIsActive(s)
                    ? `<button class="danger" onclick="revokeShare('${s.id}')">Revoke access</button>`
                    : '<span class="muted">Access ended</span>'}
                </div>
              </div>
            </article>`).join("")}
        </div>`
        : '<p class="muted">You have not shared your library yet.</p>'
      }
    </section>`;
}

function shareIsActive(share) {
  return !share.expires_at || Date.parse(share.expires_at) > Date.now();
}

function shareExpiryText(share) {
  if (!share.expires_at) return "Until revoked";
  const date = new Date(share.expires_at);
  const formatted = date.toLocaleString();
  return shareIsActive(share) ? `Expires ${formatted}` : `Expired ${formatted}`;
}

function stopSharedLibraryMonitor() {
  if (sharedLibraryTimer) clearInterval(sharedLibraryTimer);
  sharedLibraryTimer = null;
  activeSharedShareId = null;
}

async function renderSharedLibrary(shareId) {
  activeSharedShareId = shareId;
  const {data:share,error:shareError} = await supabaseClient.from("library_shares")
    .select("id,sender_id,receiver_id,expires_at")
    .eq("id",shareId)
    .eq("receiver_id",currentUser.id)
    .maybeSingle();

  if (activeTab!=="sharedLibrary" || activeSharedShareId!==shareId) return;

  if (shareError) {
    $("#content").innerHTML=`<p class="muted">Could not verify library access: ${esc(shareError.message)}</p>`;
    return;
  }

  if (!share || !shareIsActive(share)) {
    stopSharedLibraryMonitor();
    try {
      await loadData();
    } catch (error) {
      $("#content").innerHTML=`<p class="muted">The share is no longer available. Could not refresh shared libraries: ${esc(error.message)}</p>`;
      return;
    }
    if (activeTab!=="sharedLibrary") return;
    $("#content").innerHTML=`
      <p class="muted">This library share has expired, been revoked, or is no longer available.</p>
      <button class="primary" onclick="show('shared')">Back to shared libraries</button>`;
    return;
  }

  const {data,error} = await supabaseClient.rpc("get_shared_library",{p_share_id:shareId});
  if (activeTab!=="sharedLibrary" || activeSharedShareId!==shareId) return;
  if (error) {
    $("#content").innerHTML=`<p class="muted">Could not load the shared library: ${esc(error.message)}</p>`;
    return;
  }

  const sharedMovies=(data||[]).map(normalizeMovie);
  const ownMovies=new Map(movies.map(movie=>[String(movie.tmdbId),movie]));
  const watched=sharedMovies.filter(m=>m.status==="watched");
  const want=sharedMovies.filter(m=>m.status==="want");
  const owner=incomingShares.find(s=>s.id===shareId)?.sender?.username||"user";

  $("#content").innerHTML=`
    <section class="sharedLibrary">
      <div class="head">
        <div><span>READ-ONLY SHARED LIBRARY</span><h2>@${esc(owner)}'s collection</h2></div>
        <button onclick="show('shared')">← All shared libraries</button>
      </div>
      <p class="muted">${shareExpiryText(share)} · ${watched.length} watched · ${want.length} want to watch</p>
      <div class="sharedDropTarget" aria-label="Drop a title here to add it to your Want to watch">
        <b>＋ Add to your Want to watch</b>
        <small>Drag a title here to add it to your list</small>
      </div>
      <div class="head"><div><span>WATCHED</span><h2>Seen</h2></div><small>${watched.length} TITLES</small></div>
      <p class="muted sharedLibraryHint">Drag a title to your Want to watch panel. Titles already in your library are marked.</p>
      ${watched.length
        ? `<div class="wall">${watched.map((m,i)=>poster(m,i,false,true,ownMovies.get(String(m.tmdbId))?.status||"")).join("")}</div>`
        : '<p class="muted">No watched titles in this library.</p>'}
      <div class="head"><div><span>UP NEXT</span><h2>Want to watch</h2></div><small>${want.length} TITLES</small></div>
      ${want.length
        ? `<div class="wall">${want.map((m,i)=>poster(m,i,false,true,ownMovies.get(String(m.tmdbId))?.status||"")).join("")}</div>`
        : '<p class="muted">No titles in the want-to-watch list.</p>'}
    </section>`;

  document.querySelectorAll("#content .poster").forEach(card=>{
    const movie=sharedMovies.find(m=>String(m.tmdbId)===card.dataset.id);
    card.onclick=()=>stage(movie,true,{
      sequence:[...card.parentElement.querySelectorAll(":scope > .poster")]
        .map(item=>sharedMovies.find(candidate=>String(candidate.tmdbId)===item.dataset.id))
        .filter(Boolean)
    });
    if (card.draggable && movie) {
      card.ondragstart=event=>{
        event.dataTransfer.setData("application/x-cinevault-movie",JSON.stringify(movie));
        event.dataTransfer.setData("text/plain",String(movie.tmdbId));
      };
    }
  });

  const dropTarget=document.querySelector(".sharedDropTarget");
  if (dropTarget) {
    dropTarget.ondragenter=event=>{
      event.preventDefault();
      dropTarget.classList.add("dragOver");
    };
    dropTarget.ondragover=event=>{
      event.preventDefault();
      if (!dropTarget.classList.contains("dragOver")) dropTarget.classList.add("dragOver");
    };
    dropTarget.ondragleave=event=>{
      if (event.relatedTarget instanceof Node&&dropTarget.contains(event.relatedTarget)) return;
      dropTarget.classList.remove("dragOver");
    };
    dropTarget.ondrop=dropWatch;
  }

  if (sharedLibraryTimer) clearInterval(sharedLibraryTimer);
  sharedLibraryTimer=setInterval(()=>refreshSharedLibraryAccess(shareId),15000);
}

async function refreshSharedLibraryAccess(shareId) {
  if (activeTab!=="sharedLibrary" || activeSharedShareId!==shareId) return;

  const {data,error}=await supabaseClient.from("library_shares")
    .select("id,expires_at")
    .eq("id",shareId)
    .eq("receiver_id",currentUser.id)
    .maybeSingle();

  if (error) {
    console.error("Could not refresh shared library access.",error);
    stopSharedLibraryMonitor();
    $("#content").innerHTML=`<p class="muted">Could not verify shared library access: ${esc(error.message)}</p>`;
    return;
  }

  if (!data || !shareIsActive(data)) {
    stopSharedLibraryMonitor();
    $("#stage")?.remove();
    try {
      await loadData();
    } catch (loadError) {
      $("#content").innerHTML=`<p class="muted">Access ended. Could not refresh shared libraries: ${esc(loadError.message)}</p>`;
      return;
    }
    show("shared");
  }
}

window.openSharedLibrary=id=>show("sharedLibrary",id);

window.leaveShare=async id=>{
  if (!confirm("Remove this shared library from your account? You will lose access.")) return;

  const {error}=await supabaseClient.from("library_shares")
    .delete().eq("id",id).eq("receiver_id",currentUser.id);
  if (error) return alert(error.message);
  try {
    await loadData();
    show("shared");
  } catch (loadError) {
    alert(`Access was removed, but shared libraries could not be refreshed: ${loadError.message}`);
  }
};

window.revokeShare=async id=>{
  if (!confirm("Revoke this library share now? The recipient will immediately lose access.")) return;

  const {error}=await supabaseClient.from("library_shares")
    .delete().eq("id",id).eq("sender_id",currentUser.id);
  if (error) return alert(error.message);
  try {
    await loadData();
    show("shared");
  } catch (loadError) {
    alert(`Access was revoked, but shared libraries could not be refreshed: ${loadError.message}`);
  }
};

function shareLibraryModal() {
  document.body.insertAdjacentHTML("beforeend",`
    <div class="modal" id="shareLibraryModal">
      <div class="box">
        <button class="x" onclick="$('#shareLibraryModal').remove()">×</button>
        <span>SHARE YOUR CINEVAULT</span>
        <h2>Share your whole library.</h2>
        <p>Recipients can view your watched and want-to-watch lists. They cannot change your library.</p>
        <label class="shareExpiryLabel" for="shareDuration">ACCESS FOR</label>
        <select id="shareDuration" class="field shareDuration">
            <option value="1h">1 hour</option>
            <option value="1d">1 day</option>
            <option value="7d">1 week</option>
            <option value="30d">1 month</option>
            <option value="custom">Custom time…</option>
            <option value="forever">Until I revoke access</option>
          </select>
          <input id="shareCustomExpiry" class="field customExpiry" type="datetime-local" aria-label="Custom access expiry" hidden>
        <input class="field" id="shareUser" autofocus placeholder="Search username">
        <div id="shareUsers"></div>
      </div>
    </div>`);

  const input=$("#shareUser");
  $("#shareDuration").onchange=event=>{
    $("#shareCustomExpiry").hidden=event.target.value!=="custom";
  };
  let timer;

  input.oninput=()=>{
    clearTimeout(timer);
    timer=setTimeout(()=>findShareUsers(input.value),250);
  };
}

async function findShareUsers(q) {
  if (q.trim().length<2) {
    $("#shareUsers").innerHTML="";
    return;
  }

  const {data,error}=await supabaseClient.from("profiles")
    .select("id,username")
    .ilike("username",`%${q.trim()}%`)
    .neq("id",currentUser.id)
    .limit(20);

  if (error) {
    $("#shareUsers").innerHTML=`<p class="muted">Could not search users: ${esc(error.message)}</p>`;
    return;
  }

  $("#shareUsers").innerHTML=(data||[]).map(u=>`
    <div class="userRow">
      <b>@${esc(u.username)}</b>
      <button class="primary" onclick="shareLibraryWith('${u.id}','${esc(u.username)}')">Share library</button>
    </div>`).join("") || '<p class="muted">No users found.</p>';
}

window.shareLibraryWith=async(receiverId,username)=>{
  let expiresAt;
  try {
    expiresAt=shareExpiration($("#shareDuration").value,$("#shareCustomExpiry"));
  } catch(error) {
    return alert(error.message);
  }
  const {error}=await supabaseClient.from("library_shares").upsert({
    sender_id:currentUser.id,
    receiver_id:receiverId,
    created_at:new Date().toISOString(),
    expires_at:expiresAt
  },{onConflict:"sender_id,receiver_id"});

  if (error) return alert(error.message);

  $("#shareLibraryModal")?.remove();
  alert(`Your library is shared with @${username}.`);
  try {
    await loadData();
    show("shared");
  } catch (loadError) {
    alert(`Library sharing succeeded, but shared libraries could not be refreshed: ${loadError.message}`);
  }
};

function authModal(message="") {
  document.body.innerHTML=`
    <div class="auth">
      <div class="authBox">
        <div class="brand"><b>CINEVAULT</b><small>PERSONAL FILM ARCHIVE</small></div>
        <h1>Your archive, your account.</h1>
        <div class="authTabs">
          <button id="loginTab">Login</button>
          <button id="signupTab">Create account</button>
        </div>
        <input class="field" id="au" placeholder="Username" autocomplete="username">
        <input class="field" id="ap" type="password" placeholder="Password" autocomplete="current-password">
        <button class="primary full" id="authGo">Login</button>
        <p id="authMsg" class="muted">${esc(message)}</p>
      </div>
    </div>`;

  let mode="login";

  const updateMode = () => {
    const password = $("#ap");
    mode = mode === "login" ? "signup" : "login";
    $("#authGo").textContent = mode === "signup" ? "Create account" : "Login";
    password.autocomplete = mode === "signup" ? "new-password" : "current-password";
    $("#authMsg").textContent = mode === "signup"
      ? "Username: 3–30 lowercase letters, numbers, _ . or - · Password: 6+ characters"
      : "";
  };

  $("#signupTab").onclick=()=>{
    mode="signup";
    $("#authGo").textContent="Create account";
    $("#ap").autocomplete="new-password";
    $("#authMsg").textContent="Username: 3–30 lowercase letters, numbers, _ . or - · Password: 6+ characters";
  };

  $("#loginTab").onclick=()=>{
    mode="login";
    $("#authGo").textContent="Login";
    $("#ap").autocomplete="current-password";
    $("#authMsg").textContent="";
  };

  $("#authGo").onclick=async()=>{
    const username=$("#au").value.trim().toLowerCase();
    const password=$("#ap").value;

    if (username.length < 3 || username.length > 30) {
      $("#authMsg").textContent="Username must be 3–30 characters.";
      return;
    }

    if (!/^[a-z0-9_.-]+$/.test(username)) {
      $("#authMsg").textContent="Username can contain lowercase letters, numbers, _, . and - only.";
      return;
    }

    if (password.length < 6) {
      $("#authMsg").textContent="Password must contain at least 6 characters.";
      return;
    }

    $("#authGo").disabled=true;
    $("#authMsg").textContent=mode === "signup" ? "Creating account…" : "Signing in…";

    try {
      const endpoint = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
      const r = await fetch(endpoint, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({username,password})
      });

      const data = await r.json().catch(()=>({}));
      if (!r.ok) throw new Error(data.error || "Authentication failed.");

      if (!data.access_token || !data.refresh_token) {
        throw new Error("Authentication succeeded but no session was returned.");
      }

      const {error:setError} = await supabaseClient.auth.setSession({
        access_token:data.access_token,
        refresh_token:data.refresh_token
      });
      if (setError) throw setError;

      await loadData();
      shell();
      await show("archive");
    } catch(e) {
      console.error(e);
      $("#authMsg").textContent=e.message||"Authentication failed.";
    } finally {
      $("#authGo").disabled=false;
    }
  };

  ["#au","#ap"].forEach(selector=>{
    $(selector).onkeydown=event=>{
      if (event.key==="Enter") {
        event.preventDefault();
        $("#authGo").click();
      }
    };
  });
}

async function addModal() {
  if (!tmdbReady()) return settingsModal();

  document.body.insertAdjacentHTML("beforeend",`
    <div class="modal" id="modal">
      <div class="box searchBox">
        <button class="x" onclick="$('#modal').remove()">×</button>
        <span>ADD TO CINEVAULT</span>
        <h2>Find a movie or series.</h2>
        <p>Search by title, director, cast member, genre, or year. Select the exact match.</p>
        <div class="live">⌕<input id="aq" autofocus placeholder="Dune, Denis Villeneuve, 2021, Science Fiction..."></div>
        <div id="results" class="searchResults">
          ${googleSearchEnabled?'<section class="googleSearchTray"><span>GOOGLE SEARCH</span><div id="addGoogleSearchResults"><p class="muted searchStatus">Search Google alongside TMDB to find the exact title.</p></div></section>':""}
          <section id="tmdbSearchResults"></section>
        </div>
      </div>
    </div>`);

  const input=$("#aq");
  let timer;

  input.oninput=()=>{
    clearTimeout(timer);
      timer=setTimeout(()=>{
        searchTitles(input.value);
      if (googleSearchEnabled) searchGoogleTitles(input.value,"add");
      },250);
  };
  $("#results").onscroll=()=>{
    const panel=$("#results");
    if (!panel||panel.scrollHeight-panel.scrollTop-panel.clientHeight>120) return;
    searchTitles(input.value);
  };
}

async function searchTitles(q) {
  const results=$("#tmdbSearchResults");
  if (!results) return;
  if (q.trim().length<2) {
    addSearchState={query:"",page:0,totalPages:1,loading:false,request:addSearchState.request+1,items:[],people:[]};
    results.innerHTML="";
    return;
  }
  if (addSearchState.query!==q.trim()) {
    addSearchState={query:q.trim(),page:0,totalPages:1,loading:false,request:addSearchState.request+1,items:[],people:[]};
  }
  await loadAddSearchPage();
}

async function fetchTitlePage(query,page=1) {
  const response=await fetch(
    `/api/search?query=${encodeURIComponent(query)}&page=${page}`,
    {headers:tmdbHeaders()}
  );
  const result=await response.json().catch(()=>({}));

  if (!response.ok) {
    if (response.status===503) {
      throw new Error("TMDB is not configured. Add TMDB_API_KEY in Vercel or a key in Settings.");
    }
    throw new Error(result.error||"Movie search is unavailable right now.");
  }

  return {
    results:(result.results||[]).filter(x=>["movie","tv"].includes(x.media_type)),
    people:Array.isArray(result.people)?result.people:[],
    page:Number(result.page)||page,
    totalPages:Math.max(1,Math.min(500,Number(result.total_pages)||1))
  };
}

async function searchGoogleTitles(query,context) {
  const state=googleSearchStates[context];
  const normalized=query.trim();
  if (!state) return;
  if (normalized.length<2) {
    state.query="";
    state.request++;
    state.loading=false;
    state.loaded=false;
    state.items=[];
    state.error="";
    renderGoogleResults(context);
    return;
  }
  if (state.query===normalized&&(state.loading||state.loaded)) return;
  state.query=normalized;
  state.loading=true;
  state.loaded=false;
  state.items=[];
  state.error="";
  const request=++state.request;
  renderGoogleResults(context);
  try {
    const response=await fetch(`/api/google-search?query=${encodeURIComponent(normalized)}`);
    const result=await readApiJson(response,"Google Custom Search API");
    if (!response.ok) throw new Error(result.error||"Google search is unavailable.");
    if (request!==state.request||state.query!==normalized) return;
    state.items=result.results||[];
  } catch(error) {
    if (request!==state.request||state.query!==normalized) return;
    state.error=error.message||"Google search is unavailable.";
  } finally {
    if (request===state.request) {
      state.loading=false;
      state.loaded=true;
      renderGoogleResults(context);
    }
  }
}

function renderGoogleResults(context) {
  const state=googleSearchStates[context];
  const target=$(context==="header"?"#headerGoogleSearchResults":"#addGoogleSearchResults");
  if (!state||!target) return;
  if (state.loading) {
    target.innerHTML='<p class="muted searchStatus">Searching Google in parallel…</p>';
    return;
  }
  if (state.error) {
    target.innerHTML=`<p class="muted searchStatus">${esc(state.error)}</p>`;
    return;
  }
  if (!state.items.length) {
    target.innerHTML=state.query.length>=2
      ? '<p class="muted searchStatus">No Google results for this title.</p>'
      : '<p class="muted searchStatus">Search Google alongside TMDB to find the exact title.</p>';
    return;
  }
  target.innerHTML=state.items.map((item,index)=>`
    <article class="googleTitleResult">
      <div class="googleTitleResultCopy">
        <a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
        <small>${esc(item.displayLink)}</small>
        <p>${esc(item.snippet)}</p>
      </div>
      <button type="button" class="googleMapTitle" data-google-index="${index}">FIND TMDB MATCH</button>
      <div class="googleTmdbMatches" hidden></div>
    </article>`).join("");
  target.querySelectorAll(".googleMapTitle").forEach(button=>{
    button.addEventListener("click",()=>mapGoogleResultToTmdb(button,context));
  });
}

function titleFromGoogleResult(title) {
  return String(title||"")
    .replace(/\s+(?:[-|–—]\s*)(?:IMDb|Wikipedia|Rotten Tomatoes|TMDB|Letterboxd|The Movie Database).*$/i,"")
    .replace(/\s*\|\s*.*$/,"")
    .trim();
}

async function mapGoogleResultToTmdb(button,context) {
  const state=googleSearchStates[context];
  const item=state?.items[Number(button.dataset.googleIndex)];
  const container=button.closest(".googleTitleResult")?.querySelector(".googleTmdbMatches");
  if (!item||!container||button.dataset.loading==="true") return;
  const title=titleFromGoogleResult(item.title)||state.query;
  const queryAtStart=state.query;
  button.dataset.loading="true";
  button.disabled=true;
  button.textContent="SEARCHING TMDB…";
  container.hidden=false;
  container.innerHTML='<p class="muted searchStatus">Matching this Google result to a TMDB title…</p>';
  try {
    const page=await fetchTitlePage(title,1);
    if (state.query!==queryAtStart) return;
    const matches=page.results.filter(result=>["movie","tv"].includes(result.media_type)).slice(0,5);
    if (!matches.length) {
      container.innerHTML=`<p class="muted searchStatus">TMDB found no match for “${esc(title)}”. Try a different Google result.</p>`;
      return;
    }
    container.innerHTML=matches.map(result=>`
      <button type="button" class="googleTmdbMatch" data-id="${esc(result.id)}" data-type="${result.media_type==="tv"?"series":"movie"}">
        <img src="${esc(img(result.poster_path))}" alt="" loading="lazy">
        <span><b>${esc(result.title||result.name||"Untitled")}</b><small>${esc((result.release_date||result.first_air_date||"").slice(0,4))} · ${result.media_type==="tv"?"SERIES":"FILM"} · TMDB</small></span>
        <i>OPEN TITLE</i>
      </button>`).join("");
    container.querySelectorAll(".googleTmdbMatch").forEach(match=>{
      match.addEventListener("click",()=>openGoogleTmdbMatch(match));
    });
  } catch(error) {
    container.innerHTML=`<p class="muted searchStatus">Could not match this Google result to TMDB: ${esc(error.message||"Search failed.")}</p>`;
  } finally {
    delete button.dataset.loading;
    button.disabled=false;
    button.textContent="FIND TMDB MATCH";
  }
}

async function openGoogleTmdbMatch(button) {
  const id=button.dataset.id;
  const type=button.dataset.type==="series"?"series":"movie";
  if (!id||button.disabled) return;
  button.disabled=true;
  try {
    const params=new URLSearchParams({id,type});
    const response=await fetch(`/api/movie?${params}`,{headers:tmdbHeaders()});
    const details=await readApiJson(response,"TMDB title details API");
    if (!response.ok) throw new Error(details.error||"Could not load the matching TMDB title.");
    stage(details);
  } catch(error) {
    console.error("Could not open the matched TMDB title.",error);
    alert(error.message||"Could not load the matching TMDB title.");
    button.disabled=false;
  }
}

function appendUniqueTitles(existing,incoming) {
  const seen=new Set(existing.map(item=>`${item.media_type}:${item.id}`));
  return [...existing,...incoming.filter(item=>{
    const key=`${item.media_type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
}

function searchResultGroupsMarkup(state,titleContent) {
  const peopleContent=state.people.length
    ? state.people.map(person=>`
      <button type="button" class="searchPersonResult" data-person-id="${esc(person.id)}">
        ${person.profile_path
          ? `<img src="${esc(creditImage(person.profile_path))}" alt="" loading="lazy">`
          : `<span class="searchPersonInitial">${esc(creditInitials(person.name))}</span>`}
        <span><b>${esc(person.name)}</b><small>${esc(person.known_for_department||"Film & television")}</small>
          ${person.known_for?.length?`<small>Known for ${esc(person.known_for.map(item=>item.title).filter(Boolean).join(" · "))}</small>`:""}
        </span><i>OPEN PERSON</i>
      </button>`).join("")
    : '<p class="muted searchStatus">No related people found.</p>';
  return `
    <section class="searchResultBox searchTitlesBox" aria-label="Movie and series results">
      <h3 class="searchResultBoxTitle">TITLES <span>${state.items.length}</span></h3>
      ${titleContent}
      ${state.page<state.totalPages?'<p class="muted searchStatus searchPageStatus">Scroll for more titles</p>':'<p class="muted searchStatus searchPageStatus">End of results</p>'}
    </section>
    <section class="searchResultBox searchPeopleBox" aria-label="Related people">
      <h3 class="searchResultBoxTitle">PEOPLE <span>${state.people.length}</span></h3>
      ${peopleContent}
    </section>`;
}

function bindSearchResultActions(container) {
  container.querySelectorAll(".searchMovieResult").forEach(card=>{
    card.addEventListener("click",event=>{
      if (event.target instanceof Element&&event.target.closest("button")) return;
      openSearchTitle(card.dataset.id,card.dataset.type);
    });
    card.addEventListener("keydown",event=>{
      if ((event.key==="Enter"||event.key===" ")&&event.target===card) {
        event.preventDefault();
        openSearchTitle(card.dataset.id,card.dataset.type);
      }
    });
  });
  container.querySelectorAll(".searchTitleOpen").forEach(button=>{
    button.addEventListener("click",()=>openSearchTitle(button.dataset.id,button.dataset.type));
  });
  container.querySelectorAll(".searchPersonResult").forEach(button=>{
    button.addEventListener("click",()=>{
      $("#modal")?.remove();
      $("#searchResults")?.classList.remove("open");
      openPerson(button.dataset.personId);
    });
  });
}

async function openSearchTitle(id,type) {
  if (!id) return;
  try {
    const params=new URLSearchParams({id:String(id),type:type==="tv"||type==="series"?"series":"movie"});
    const response=await fetch(`/api/movie?${params}`,{headers:tmdbHeaders()});
    const details=await readApiJson(response,"TMDB title details API");
    if (!response.ok) throw new Error(details.error||"Could not load this title.");
    $("#modal")?.remove();
    $("#searchResults")?.classList.remove("open");
    stage(details);
  } catch(error) {
    console.error("Could not open search result details.",error);
    alert(error.message||"Could not load this title's details.");
  }
}

async function loadAddSearchPage() {
  if (addSearchState.loading||addSearchState.page>=addSearchState.totalPages) return;
  const results=$("#tmdbSearchResults");
  const panel=$("#results");
  if (!results||!panel) return;
  addSearchState.loading=true;
  const request=addSearchState.request;
  const requestedPage=addSearchState.page+1;
  results.insertAdjacentHTML("beforeend",'<p class="muted searchStatus searchPageStatus">Loading more titles…</p>');
  try {
    const page=await fetchTitlePage(addSearchState.query,requestedPage);
    if (request!==addSearchState.request||!$("#tmdbSearchResults")) return;
    addSearchState.items=appendUniqueTitles(addSearchState.items,page.results);
    if (requestedPage===1) addSearchState.people=page.people;
    addSearchState.page=page.page;
    addSearchState.totalPages=page.totalPages;
    renderAddSearchResults();
  } catch(error) {
    if (request!==addSearchState.request) return;
    results.querySelector(".searchPageStatus")?.remove();
    results.insertAdjacentHTML("beforeend",`<p class="muted searchStatus searchPageStatus">${esc(error.message)}</p>`);
  } finally {
    if (request===addSearchState.request) addSearchState.loading=false;
  }
}

function renderAddSearchResults() {
  const results=$("#tmdbSearchResults");
  if (!results) return;
  const saved=addSearchState.items.filter(item=>movies.some(movie=>String(movie.tmdbId)===String(item.id)));
  const unsaved=addSearchState.items.filter(item=>!movies.some(movie=>String(movie.tmdbId)===String(item.id)));
  const titleResults=addSearchState.items.length
    ? `${saved.length
        ? `<section class="searchTray alreadySavedTray"><p class="searchStatus">ALREADY IN YOUR LIBRARY</p>${saved.map(item=>titleResultMarkup(item)).join("")}</section>`
        : ""}
      ${unsaved.length
        ? `<section class="searchTray addTitlesTray"><p class="searchStatus">ADD TO YOUR LIBRARY</p>${unsaved.map(item=>titleResultMarkup(item)).join("")}</section>`
        : ""}`
    : '<p class="muted">No matching titles.</p>';
  results.innerHTML=searchResultGroupsMarkup(addSearchState,titleResults);
  bindSearchResultActions(results);
  const panel=$("#results");
  if (addSearchState.page<addSearchState.totalPages&&panel&&panel.scrollHeight<=panel.clientHeight+8) {
    setTimeout(()=>loadAddSearchPage(),0);
  }
}

function titleResultMarkup(item,compact=false) {
  const title=item.title||item.name||"Untitled";
  const saved=movies.find(movie=>String(movie.tmdbId)===String(item.id));
  const matchLabel=item.search_match==="person"
    ? `RELATED TO ${item.matched_person||"CAST OR CREW"}`
    : item.search_match==="year"
      ? `RELEASED IN ${item.release_date?.slice(0,4)||item.first_air_date?.slice(0,4)||"THIS YEAR"}`
      : item.search_match==="keyword"
        ? "RELATED KEYWORD"
        : item.search_match==="genre"
          ? "GENRE MATCH"
          : "";
  return `
    <article class="result searchMovieResult ${compact?"compactResult":""} ${saved?"savedResult":""}" data-id="${esc(item.id)}" data-type="${item.media_type==="tv"?"tv":"movie"}" tabindex="0" aria-label="Open details for ${esc(title)}">
      <button type="button" class="searchTitleOpen" data-id="${esc(item.id)}" data-type="${item.media_type==="tv"?"tv":"movie"}" aria-label="Open ${esc(title)} details">
        <img src="${img(item.poster_path)}" alt="" loading="lazy">
      </button>
      <div class="searchMovieCopy">
        <button type="button" class="searchTitleText searchTitleOpen" data-id="${esc(item.id)}" data-type="${item.media_type==="tv"?"tv":"movie"}">${esc(title)}</button>
        <small>${(item.release_date||item.first_air_date||"").slice(0,4)} · ${item.media_type==="tv"?"Series":"Movie"}${matchLabel?` · ${esc(matchLabel)}`:""}</small>
        ${compact ? "" : `<p>${esc(item.overview||"")}</p>`}
        ${saved
          ? `<div class="libraryStatus">${saved.status==="want"?"Already in Want to watch":"Already watched"}</div>`
          : `<div class="resultActions">
              <button class="primary" onclick='choose(${JSON.stringify(item).replace(/'/g,"&#39;")},"watched")'>＋ Watched</button>
              <button onclick='choose(${JSON.stringify(item).replace(/'/g,"&#39;")},"want")'>＋ Want to watch</button>
            </div>`}
      </div>
    </article>`;
}

let headerSearchRequest=0;

async function searchHeaderTitles(query) {
  const results=$("#searchResults");
  if (!results) return;

  if (query.trim().length<2) {
    headerSearchState={query:"",page:0,totalPages:1,loading:false,request:headerSearchState.request+1,items:[],people:[]};
    if (googleSearchEnabled) searchGoogleTitles(query,"header");
    results.innerHTML="";
    results.classList.remove("open");
    return;
  }

  const normalizedQuery=query.trim();
  const request=++headerSearchRequest;
  headerSearchState={query:normalizedQuery,page:0,totalPages:1,loading:false,request,items:[],people:[]};
  if (googleSearchEnabled) searchGoogleTitles(normalizedQuery,"header");
  results.innerHTML=`${googleSearchEnabled?'<section class="googleSearchTray"><span>GOOGLE SEARCH</span><div id="headerGoogleSearchResults"><p class="muted searchStatus">Searching Google in parallel…</p></div></section>':""}<section class="searchTray" id="headerTmdbSearchResults"><p class="muted searchStatus">Searching TMDB…</p></section>`;
  results.classList.add("open");

  try {
    const page=await fetchTitlePage(normalizedQuery,1);
    if (request!==headerSearchRequest || $("#search")?.value.trim()!==normalizedQuery) return;
    headerSearchState.items=page.results;
    headerSearchState.people=page.people;
    headerSearchState.page=page.page;
    headerSearchState.totalPages=page.totalPages;
    renderHeaderSearchResults();
  } catch(error) {
    if (request!==headerSearchRequest) return;
    const tmdbResults=$("#headerTmdbSearchResults");
    if (tmdbResults) tmdbResults.innerHTML=`<p class="muted searchStatus">${esc(error.message)}</p>`;
  }
}

async function loadHeaderSearchPage() {
  const state=headerSearchState;
  if (state.loading||state.page>=state.totalPages||state.query!==$("#search")?.value.trim()) return;
  const results=$("#searchResults");
  if (!results) return;
  state.loading=true;
  const request=state.request;
  const requestedPage=state.page+1;
  $("#headerTmdbSearchResults")?.insertAdjacentHTML("beforeend",'<p class="muted searchStatus searchPageStatus">Loading more titles…</p>');
  try {
    const page=await fetchTitlePage(state.query,requestedPage);
    if (request!==headerSearchState.request||state.query!==$("#search")?.value.trim()) return;
    state.items=appendUniqueTitles(state.items,page.results);
    state.page=page.page;
    state.totalPages=page.totalPages;
    renderHeaderSearchResults();
  } catch(error) {
    if (request!==headerSearchState.request) return;
    $("#headerTmdbSearchResults")?.querySelector(".searchPageStatus")?.remove();
    $("#headerTmdbSearchResults")?.insertAdjacentHTML("beforeend",`<p class="muted searchStatus searchPageStatus">${esc(error.message)}</p>`);
  } finally {
    if (request===headerSearchState.request) state.loading=false;
  }
}

function renderHeaderSearchResults() {
  const results=$("#searchResults");
  const tmdbResults=$("#headerTmdbSearchResults");
  if (!results||!tmdbResults) return;
  const alreadySaved=headerSearchState.items.filter(item=>movies.some(movie=>String(movie.tmdbId)===String(item.id)));
  const toAdd=headerSearchState.items.filter(item=>!movies.some(movie=>String(movie.tmdbId)===String(item.id)));
  const titleContent=headerSearchState.items.length
    ? `${alreadySaved.length
        ? `<section class="searchTray alreadySavedTray"><p class="searchStatus">ALREADY IN YOUR LIBRARY</p>${alreadySaved.map(item=>titleResultMarkup(item,true)).join("")}</section>`
        : ""}
      ${toAdd.length
        ? `<section class="searchTray addTitlesTray"><p class="searchStatus">ADD TO YOUR LIBRARY</p>${toAdd.map(item=>titleResultMarkup(item,true)).join("")}</section>`
        : ""}`
    : '<p class="muted searchStatus">No matching movies or series.</p>';
  tmdbResults.innerHTML=searchResultGroupsMarkup(headerSearchState,titleContent);
  bindSearchResultActions(tmdbResults);
  renderGoogleResults("header");
  if (headerSearchState.page<headerSearchState.totalPages&&results.scrollHeight<=results.clientHeight+8) {
    setTimeout(()=>loadHeaderSearchPage(),0);
  }
}

async function choose(r,status="watched") {
  try {
    const type=r.media_type==="tv"?"series":"movie";
    const params=new URLSearchParams({id:String(r.id),type});
    const rr=await fetch(`/api/movie?${params}`,{headers:tmdbHeaders()});
    let x=rr.ok ? await readApiJson(rr,"Movie details API") : null;

    if (!x) {
      x={
        tmdbId:r.id,
        title:r.title||r.name,
        year:(r.release_date||r.first_air_date||"").slice(0,4),
        posterPath:r.poster_path,
        backdropPath:r.backdrop_path,
        overview:r.overview,
        genres:[],
        cast:[],
        director:"",
        type:r.media_type==="tv"?"series":"movie",
        personalNote:""
      };
    }

    await saveMovie(x,status);
    $("#modal")?.remove();
    if ($("#search")) {
      $("#search").value="";
      searchQuery="";
      $("#searchResults")?.classList.remove("open");
    }
    await show("archive");
  } catch(e) {
    alert(e.message||"Could not save movie");
  }
}

function stage(m,readOnly=false,options={}) {
  if (!m) return;

  const existingStage=$("#stage");
  const newStageVisit=!existingStage||existingStage.dataset.movieId!==String(m.tmdbId);
  const previousBackdrop=existingStage?.dataset.backdropPath||"";
  let visitIndex=0;
  if (newStageVisit) {
    visitIndex=stageBackdropVisits.get(String(m.tmdbId))||0;
    stageBackdropVisits.set(String(m.tmdbId),visitIndex+1);
  } else {
    visitIndex=Math.max(0,(stageBackdropVisits.get(String(m.tmdbId))||1)-1);
  }
  const existingPaths=(m.backdropPaths||[]).filter(path=>typeof path==="string"&&path.startsWith("/"));
  const selectedBackdrop=previousBackdrop||
    existingPaths[visitIndex%Math.max(1,existingPaths.length)]||
    m.backdropPath||m.posterPath||"";

  stopStageTrailer();
  $("#stage")?.remove();
  activeStageMovie=m;
  if (Array.isArray(options.sequence)&&options.sequence.length) {
    activeStageSequence=options.sequence;
  } else {
    activeStageSequence=[m];
  }
  let movieIndex=activeStageSequence.findIndex(movie=>String(movie.tmdbId)===String(m.tmdbId));
  if (movieIndex<0) {
    activeStageSequence=[m];
    movieIndex=0;
  }
  document.title=`${m.title||"Movie"} | CineVault`;
  if (options.history!==false) {
    const current=history.state&&typeof history.state==="object"?history.state:{};
    const detail={
      type:"movie",
      id:String(m.tmdbId),
      movie:m,
      readOnly,
      sequence:activeStageSequence,
      returnDetail:current.detail?.type==="movie"
        ? current.detail.returnDetail||null
        : current.detail?.type==="person"
          ? {type:"person",id:String(current.detail.id)}
          : null
    };
    if (current.detail?.type!=="movie"||String(current.detail.id)!==String(m.tmdbId)) {
      history.pushState({
        ...current,
        cineVaultRoute:true,
        tab:current.tab||activeTab||"archive",
        routeParam:current.routeParam||"",
        detail
      },"",`#movie=${encodeURIComponent(m.tmdbId)}`);
    }
  }

  const movieSearchUrl=`https://www.google.com/search?q=${encodeURIComponent(m.title)}`;
  const trailerUrl=m.trailerKey
    ? `https://www.youtube.com/watch?v=${m.trailerKey}`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(m.title+" trailer")}`;
  const savedMovie=movies.find(movie=>String(movie.tmdbId)===String(m.tmdbId));
  const listStatus=savedMovie?.status||"";

  document.body.insertAdjacentHTML("beforeend",`
    <div class="stage ${options.direction===1?"movieSlideNext":options.direction===-1?"movieSlidePrevious":""}" id="stage" data-movie-id="${esc(m.tmdbId)}" data-trailer-key="${esc(m.trailerKey||"")}">
      ${activeStageSequence.length>1?`
        <button type="button" class="movieNavArrow movieNavPrevious ${movieIndex===0?"atSequenceEdge":""}" onclick="navigateStageMovie(-1)" aria-label="Previous movie" title="Previous movie" aria-disabled="${movieIndex===0}">‹</button>
        <button type="button" class="movieNavArrow movieNavNext ${movieIndex===activeStageSequence.length-1?"atSequenceEdge":""}" onclick="navigateStageMovie(1)" aria-label="Next movie" title="Next movie" aria-disabled="${movieIndex===activeStageSequence.length-1}">›</button>`:""}
      <button type="button" class="x stageClose" onclick="closeAppDetail()" aria-label="Close movie details">×</button>
      <div class="stagebg" data-read-only="${readOnly}" data-backdrop-path="${esc(selectedBackdrop)}">
        <div class="stageBackdropLayer active" id="stageBackdropA" aria-hidden="true" style="background-image:linear-gradient(90deg,rgba(8,8,12,.42),rgba(8,8,12,.68),rgba(8,8,12,.4)),url('${backdrop(selectedBackdrop)}')"></div>
        <div class="stageBackdropLayer" id="stageBackdropB" aria-hidden="true"></div>
        <div class="stageTrailerLayer" id="stageTrailerLayer" aria-hidden="true"><div id="stageTrailerPlayer"></div></div>
        <a class="stageTrailerFallback" id="stageTrailerFallback" target="_blank" rel="noopener" hidden>▶ Open trailer on YouTube</a>
        <div class="stageTrailerFeedback" id="stageTrailerFeedback" role="status" aria-live="polite" hidden></div>
        <div class="stageListControls" role="group" aria-label="Your movie lists">
          <button class="stageListButton ${listStatus==="watched"?"selected":""}" onclick="setStageListStatus('watched')" ${listStatus==="watched"?"disabled aria-pressed=\"true\"":"aria-pressed=\"false\""}>${listStatus==="watched"?"✓ Watched":listStatus?"Move to Watched":"＋ Add to Watched"}</button>
          <button class="stageListButton ${listStatus==="want"?"selected":""}" onclick="setStageListStatus('want')" ${listStatus==="want"?"disabled aria-pressed=\"true\"":"aria-pressed=\"false\""}>${listStatus==="want"?"✓ Want to watch":listStatus?"Move to Want to watch":"＋ Add to Want to watch"}</button>
          <label class="readModeToggle" title="Disable automatic trailer playback">
            <input type="checkbox" ${trailerReadMode?"checked":""} onchange="setTrailerReadMode(this.checked)">
            <span class="readModeSwitch" aria-hidden="true"></span>
            <span>Read mode</span>
          </label>
          <label class="stageTrailerAudioToggle" title="Turn trailer audio on or off">
            <input type="checkbox" ${stageTrailerAudioEnabled?"checked":""} onchange="setStageTrailerAudio(this.checked)">
            <span class="readModeSwitch" aria-hidden="true"></span>
            <span>Audio</span>
          </label>
        </div>
        <div class="stagebody">
          <img src="${img(m.posterPath)}" alt="${esc(m.title)}">
          <div>
            <span>${(m.type||"movie").toUpperCase()}</span>
            <div class="stageTitleRow">
              <h1><a class="movieSearchLink" target="_blank" rel="noopener" href="${movieSearchUrl}">${esc(m.title)}</a></h1>
              <button type="button" class="copyMovieTitle" aria-label="Copy movie title" title="Copy movie title"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button>
            </div>
            <div class="stageMovieMeta">
              ${m.year?`<span class="movieYear">${esc(m.year)}</span>`:""}
              <div class="stageMovieFacts" id="stageMovieFacts">${renderMovieFacts(m)}</div>
            </div>

            <div class="genres">
              ${(m.genres||[]).map(g=>`<i>${esc(g)}</i>`).join("")}
            </div>

            <p>${esc(m.overview||"No synopsis available.")}</p>

            <div class="creditsPanel creditsLoading" id="stageCredits" aria-label="Loading ratings, production details, and cast">
              ${renderCreditsPlaceholder()}
            </div>

            ${readOnly ? "" : `
              <label>
                WHAT YOU WANT TO SAY
                <textarea id="note">${esc(m.personalNote||"")}</textarea>
              </label>`}

            <div class="actions">
              <a class="primary" target="_blank" rel="noopener" href="${trailerUrl}">▶ Trailer</a>
              ${readOnly ? "" : `
                <button class="danger" onclick="deleteMovie('${m.tmdbId}')">Delete</button>`}
            </div>
            <p class="stageKeyboardHint">TRAILER KEYS · Z BACK 5S · X FORWARD 5S · D SPEED UP · S SLOW DOWN</p>
          </div>
        </div>
        <section class="stageRecommendations" id="stageRecommendations" aria-label="Recommended titles">
          <div class="stageRecommendationsHead">
            <span>MORE FOR YOUR SCREENING</span>
            <h2>Because you opened ${esc(m.title||"this title")}.</h2>
          </div>
          <div class="stageRecommendationRail" id="stageRecommendationRail" aria-live="polite">
            <p class="archiveRecommendationStatus">Finding titles with a similar feel…</p>
          </div>
        </section>
      </div>
    </div>`);

  $("#stage").onclick=e=>{
    const copyNameButton=e.target instanceof Element?e.target.closest(".copyPersonName"):null;
    if (copyNameButton) {
      e.preventDefault();
      e.stopPropagation();
      copyPersonName(copyNameButton);
      return;
    }
    const personLink=e.target instanceof Element?e.target.closest("[data-person-id]"):null;
    if (personLink) {
      e.preventDefault();
      openPerson(personLink.dataset.personId);
      return;
    }
    if (e.target instanceof Element&&e.target.closest(".movieNavArrow")) return;
    if (e.target===e.currentTarget||
      (e.target instanceof Element&&!e.target.closest(".stagebg,.movieNavArrow,.stageClose"))) {
      closeAppDetail();
    }
  };
  setupStageTrailer(m.trailerKeys?.length?m.trailerKeys:m.trailerKey,m);
  refreshStageCredits(m);
  loadStageRecommendations(m);
  $("#stage .copyMovieTitle").onclick=event=>copyMovieTitle(event.currentTarget);

  if (!readOnly) $("#note").onblur=async e=>{
    try {
      await updateMovie(m,{personal_note:e.target.value});
    } catch(err) {
      alert(err.message);
    }
  };
}

async function loadStageRecommendations(movie) {
  const rail=$("#stageRecommendationRail");
  if (!rail||!movie?.tmdbId) return;
  const stageId=String(movie.tmdbId);
  try {
    const params=new URLSearchParams({
      ids:stageId,
      type:movie.type==="series"?"series":"movie"
    });
    const response=await fetch(`/api/recommendations?${params}`,{headers:tmdbHeaders()});
    const result=await readApiJson(response,"TMDB similar recommendations API");
    if (!response.ok) throw new Error(result.error||"Could not load related recommendations.");
    if ($("#stage")?.dataset.movieId!==stageId) return;
    const recommendations=(result.recommendations||[])
      .filter(item=>String(item.id)!==stageId)
      .filter(item=>!movies.some(saved=>String(saved.tmdbId)===String(item.id)))
      .slice(0,8);
    if (!recommendations.length) {
      rail.innerHTML='<p class="archiveRecommendationStatus">No new related titles are available right now.</p>';
      return;
    }
    rail.innerHTML=recommendations.map(item=>`
      <article class="stageRecommendationCard" data-recommendation-item>
        <button type="button" class="stageRecommendationOpen archiveRecommendationOpen" aria-label="Open details for ${esc(item.title||"this recommendation")}">
          <img src="${esc(img(item.posterPath))}" alt="" loading="lazy">
          <span><b>${esc(item.title||"Untitled")}</b><small>${esc([item.type==="series"?"SERIES":"FILM",item.year].filter(Boolean).join(" · "))}</small></span>
        </button>
        <div class="stageRecommendationActions">
          <button type="button" class="archiveRecommendationAdd" data-id="${esc(item.id)}" data-type="${esc(item.type)}" data-status="want">＋ WATCHLIST</button>
          <button type="button" class="archiveRecommendationAdd archiveRecommendationCollect" data-id="${esc(item.id)}" data-type="${esc(item.type)}" data-status="watched">＋ COLLECTION</button>
        </div>
      </article>`).join("");
    rail.querySelectorAll(".stageRecommendationOpen").forEach(button=>{
      button.addEventListener("click",()=>openRecommendedTitle(button.closest(".stageRecommendationCard")));
    });
    rail.querySelectorAll(".archiveRecommendationAdd").forEach(button=>{
      button.addEventListener("click",()=>addRecommendedTitle(button,button.dataset.status));
    });
  } catch(error) {
    if ($("#stage")?.dataset.movieId!==stageId) return;
    console.error("Could not load related recommendations for the title details.",error);
    rail.innerHTML=`<p class="archiveRecommendationStatus">Could not load related titles: ${esc(error.message||"TMDB request failed.")}</p>`;
  }
}

async function copyMovieTitle(button) {
  if (!activeStageMovie?.title||!button) return;
  try {
    await navigator.clipboard.writeText(activeStageMovie.title);
    showCopyFeedback(button);
  } catch(error) {
    console.error("Could not copy movie title to clipboard.",error);
    alert("Could not copy the movie title. Check clipboard permissions and try again.");
  }
}

async function copyPersonName(button) {
  const name=button?.dataset.copyName;
  if (!name) return;
  try {
    await navigator.clipboard.writeText(name);
    showCopyFeedback(button);
  } catch(error) {
    console.error("Could not copy person name to clipboard.",error);
    alert("Could not copy the name. Check clipboard permissions and try again.");
  }
}

function showCopyFeedback(button) {
  const previousTimer=copyFeedbackTimers.get(button);
  if (previousTimer) clearTimeout(previousTimer);
  button.classList.remove("copyFeedbackVisible");
  void button.offsetWidth;
  button.classList.add("copyFeedbackVisible");
  copyFeedbackTimers.set(button,setTimeout(()=>{
    button.classList.remove("copyFeedbackVisible");
    copyFeedbackTimers.delete(button);
  },2000));
}

function setStageBackdrops(paths) {
  const images=[...new Set((paths||[]).filter(path=>typeof path==="string"&&path.startsWith("/")))];
  if (!images.length||!$("#stage")) return;
  const movieId=String(activeStageMovie?.tmdbId||"");
  const visitIndex=Math.max(0,(stageBackdropVisits.get(movieId)||1)-1);
  const selected=images[visitIndex%images.length];
  const layers=[$("#stageBackdropA"),$("#stageBackdropB")];
  if (!layers[0]||!layers[1]) return;
  const backgroundImage=`linear-gradient(90deg,rgba(8,8,12,.42),rgba(8,8,12,.68),rgba(8,8,12,.4)),url("${backdrop(selected)}")`;
  if ($("#stage").dataset.backdropPath===selected) return;
  $("#stage").dataset.backdropPath=selected;
  layers[0].style.backgroundImage=backgroundImage;
  layers[1].style.backgroundImage="";
  layers[0].classList.add("active");
  layers[1].classList.remove("active");
}

function loadYouTubePlayerApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubePlayerApiPromise) return youtubePlayerApiPromise;
  youtubePlayerApiPromise=new Promise((resolve,reject)=>{
    const script=document.createElement("script");
    script.src="https://www.youtube.com/iframe_api";
    script.async=true;
    script.onerror=()=>{
      youtubePlayerApiPromise=null;
      reject(new Error("Could not load YouTube's player API."));
    };
    const previousCallback=window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady=()=>{
      if (typeof previousCallback==="function") previousCallback();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("YouTube's player API did not initialize."));
    };
    document.head.appendChild(script);
  });
  return youtubePlayerApiPromise;
}

function stopStageTrailer() {
  stageTrailerGeneration++;
  clearTimeout(stageTrailerIdleTimer);
  stageTrailerIdleTimer=null;
  if (stageTrailerPointerHandler) {
    document.removeEventListener("pointermove",stageTrailerPointerHandler);
    stageTrailerPointerHandler=null;
  }
  if (stageTrailerScrollHandler) {
    document.removeEventListener("scroll",stageTrailerScrollHandler,true);
    stageTrailerScrollHandler=null;
  }
  if (stageTrailerVisibilityHandler) {
    document.removeEventListener("visibilitychange",stageTrailerVisibilityHandler);
    stageTrailerVisibilityHandler=null;
  }
  if (stageTrailerWindowBlurHandler) {
    window.removeEventListener("blur",stageTrailerWindowBlurHandler);
    stageTrailerWindowBlurHandler=null;
  }
  if (stageTrailerWindowFocusHandler) {
    window.removeEventListener("focus",stageTrailerWindowFocusHandler);
    stageTrailerWindowFocusHandler=null;
  }
  if (stageTrailerKeyboardHandler) {
    document.removeEventListener("keydown",stageTrailerKeyboardHandler);
    stageTrailerKeyboardHandler=null;
  }
  stageTrailerIsIdle=false;
  clearTimeout(stageTrailerContentTimer);
  stageTrailerContentTimer=null;
  clearTimeout(stageTrailerFeedbackTimer);
  stageTrailerFeedbackTimer=null;
  stageTrailerVideoId="";
  stageTrailerCandidates=[];
  stageTrailerCandidateIndex=0;
  stageTrailerMovie=null;
  stageTrailerFallbackSearched=false;
  stageTrailerPlaybackRate=1;
  if (stageTrailerPlayer) {
    stageTrailerPlayer.destroy();
    stageTrailerPlayer=null;
  }
  $("#stage")?.classList.remove("trailerVisible");
  $("#stage")?.classList.remove("trailerContentHidden");
}

function setupStageTrailer(videoId,movie=activeStageMovie) {
  const holder=$("#stageTrailerPlayer");
  const stageElement=$("#stage");
  const candidates=[...new Set((Array.isArray(videoId)?videoId:[videoId]).filter(key=>typeof key==="string"&&key.trim()))];
  if (!holder||!stageElement||!movie||trailerReadMode) return;
  stopStageTrailer();
  const generation=stageTrailerGeneration;
  stageTrailerIsIdle=false;
  stageTrailerCandidates=candidates;
  stageTrailerCandidateIndex=0;
  stageTrailerVideoId=stageTrailerCandidates[0]||"";
  stageTrailerMovie={title:movie.title||"",year:movie.year||"",type:movie.type||"movie"};
  stageTrailerPointerHandler=()=>{
    stageTrailerActivity();
  };
  stageTrailerPlaybackRate=1;
  stageTrailerKeyboardHandler=handleStageTrailerShortcut;
  document.addEventListener("keydown",stageTrailerKeyboardHandler);
  stageTrailerScrollHandler=()=>stageTrailerActivity();
  document.addEventListener("pointermove",stageTrailerPointerHandler,{passive:true});
  document.addEventListener("scroll",stageTrailerScrollHandler,{capture:true,passive:true});
  stageTrailerVisibilityHandler=()=>{
    if (document.hidden) pauseStageTrailerForInactivePage();
    else resumeStageTrailerForActivePage();
  };
  stageTrailerWindowBlurHandler=()=>pauseStageTrailerForInactivePage();
  stageTrailerWindowFocusHandler=()=>resumeStageTrailerForActivePage();
  document.addEventListener("visibilitychange",stageTrailerVisibilityHandler);
  window.addEventListener("blur",stageTrailerWindowBlurHandler);
  window.addEventListener("focus",stageTrailerWindowFocusHandler);
  scheduleStageTrailer(generation);
}

function scheduleStageTrailer(generation=stageTrailerGeneration) {
  clearTimeout(stageTrailerIdleTimer);
  if (!stageTrailerPageActive||document.hidden) return;
  stageTrailerIdleTimer=setTimeout(()=>startStageTrailerAfterIdle(generation),5000);
}

async function startStageTrailerAfterIdle(generation) {
  if (generation!==stageTrailerGeneration||trailerReadMode||!stageTrailerMovie||!$("#stageTrailerPlayer")) return;
  stageTrailerIsIdle=true;
  try {
    if (!stageTrailerCandidates.length&&!stageTrailerFallbackSearched) {
      const fallback=await searchYouTubeTrailerCandidates(generation);
      if (generation!==stageTrailerGeneration||!stageTrailerIsIdle||trailerReadMode) return;
      if (fallback.error||!stageTrailerCandidates.length) {
        showStageTrailerFallback(fallback.error);
        return;
      }
    }
    if (!stageTrailerCandidates.length) {
      showStageTrailerFallback("No embeddable trailers were found.");
      return;
    }
    const YT=await loadYouTubePlayerApi();
    if (generation!==stageTrailerGeneration||!stageTrailerIsIdle||trailerReadMode||!$("#stageTrailerPlayer")) return;
    if (!stageTrailerPlayer) {
      stageTrailerPlayer=new YT.Player("stageTrailerPlayer",{
        videoId:stageTrailerVideoId,
        playerVars:{autoplay:0,controls:0,disablekb:1,fs:0,iv_load_policy:3,modestbranding:1,playsinline:1,rel:0,origin:location.origin},
        events:{
          onReady:event=>{
            applyStageTrailerAudio(event.target);
            stageTrailerPlaybackRate=1;
            event.target.setPlaybackRate(1);
            if (stageTrailerIsIdle&&generation===stageTrailerGeneration) event.target.playVideo();
            else event.target.pauseVideo();
          },
          onStateChange:event=>{
            if (event.data===YT.PlayerState.PLAYING&&stageTrailerIsIdle&&generation===stageTrailerGeneration) {
              $("#stage")?.classList.add("trailerVisible");
              $("#stageTrailerFallback")?.setAttribute("hidden","");
              if (stageTrailerContentTimer===null) {
                stageTrailerContentTimer=setTimeout(()=>{
                  stageTrailerContentTimer=null;
                  if (generation===stageTrailerGeneration&&stageTrailerIsIdle&&!trailerReadMode) {
                    $("#stage")?.classList.add("trailerContentHidden");
                  }
                },7000);
              }
            }
            if (event.data===YT.PlayerState.PAUSED&&generation===stageTrailerGeneration) {
              clearTimeout(stageTrailerContentTimer);
              stageTrailerContentTimer=null;
            }
            if (event.data===YT.PlayerState.ENDED&&stageTrailerIsIdle&&generation===stageTrailerGeneration) {
              event.target.seekTo(0,true);
              stageTrailerPlaybackRate=1;
              event.target.setPlaybackRate(1);
              applyStageTrailerAudio(event.target);
              event.target.playVideo();
            }
          },
          onError:event=>tryNextStageTrailer(event.data,generation)
        }
      });
    } else {
      applyStageTrailerAudio();
      stageTrailerPlayer.playVideo();
    }
  } catch(error) {
    $("#stage")?.classList.remove("trailerVisible");
    console.error("Could not start the muted background trailer.",error);
  }
}

function tryNextStageTrailer(errorCode,generation=stageTrailerGeneration) {
  if (generation!==stageTrailerGeneration) return;
  const nextIndex=stageTrailerCandidateIndex+1;
  if (nextIndex>=stageTrailerCandidates.length) {
    clearTimeout(stageTrailerContentTimer);
    stageTrailerContentTimer=null;
    $("#stage")?.classList.remove("trailerVisible");
    $("#stage")?.classList.remove("trailerContentHidden");
    if (!stageTrailerFallbackSearched) {
      searchYouTubeTrailerCandidates(generation).then(result=>{
        if (generation!==stageTrailerGeneration) return;
        if (result.trailers?.length) {
          if (stageTrailerCandidateIndex+1<stageTrailerCandidates.length) {
            stageTrailerCandidateIndex++;
            stageTrailerVideoId=stageTrailerCandidates[stageTrailerCandidateIndex];
            if (stageTrailerIsIdle) stageTrailerPlayer?.loadVideoById(stageTrailerVideoId);
            else stageTrailerPlayer?.cueVideoById(stageTrailerVideoId);
            return;
          }
        }
        showStageTrailerFallback(result.error||`All embedded trailer candidates failed (YouTube error ${errorCode}).`);
      });
      return;
    }
    showStageTrailerFallback(`All embedded trailer candidates failed (YouTube error ${errorCode}).`);
    return;
  }
  stageTrailerCandidateIndex=nextIndex;
  stageTrailerVideoId=stageTrailerCandidates[nextIndex];
  stageTrailerPlaybackRate=1;
  stageTrailerPlayer?.setPlaybackRate(1);
  console.warn(`YouTube trailer ${stageTrailerCandidateIndex} failed with error ${errorCode}; trying another available trailer.`);
  applyStageTrailerAudio();
  if (stageTrailerIsIdle) {
    stageTrailerPlayer?.loadVideoById({videoId:stageTrailerVideoId,suggestedQuality:"hd720"});
  } else {
    stageTrailerPlayer?.cueVideoById({videoId:stageTrailerVideoId,suggestedQuality:"hd720"});
  }
}

async function searchYouTubeTrailerCandidates(generation) {
  if (stageTrailerFallbackSearched||!stageTrailerMovie) return {trailers:[]};
  stageTrailerFallbackSearched=true;
  const params=new URLSearchParams({
    title:stageTrailerMovie.title,
    year:String(stageTrailerMovie.year||""),
    type:stageTrailerMovie.type
  });
  try {
    const response=await fetch(`/api/trailers?${params}`);
    const result=await response.json().catch(()=>({}));
    if (generation!==stageTrailerGeneration) return {trailers:[]};
    if (!response.ok) return {trailers:[],error:result.error||"YouTube trailer search failed."};
    const currentIds=new Set(stageTrailerCandidates);
    const trailers=(result.trailers||[]).filter(id=>typeof id==="string"&&!currentIds.has(id));
    stageTrailerCandidates.push(...trailers);
    if (!stageTrailerVideoId&&stageTrailerCandidates.length) {
      stageTrailerCandidateIndex=0;
      stageTrailerVideoId=stageTrailerCandidates[0];
    }
    return {trailers};
  } catch(error) {
    if (generation===stageTrailerGeneration) console.error("YouTube trailer fallback lookup failed.",error);
    return {trailers:[],error:error.message||"YouTube trailer search failed."};
  }
}

function showStageTrailerFallback(message="") {
  const fallback=$("#stageTrailerFallback");
  if (!fallback||!stageTrailerMovie) return;
  const query=[stageTrailerMovie.title,stageTrailerMovie.year,"trailer"].filter(Boolean).join(" ");
  fallback.href=`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  fallback.hidden=false;
  fallback.title=message||"Open trailer search results on YouTube.";
}

function showStageTrailerFeedback(message) {
  const feedback=$("#stageTrailerFeedback");
  if (!feedback) return;
  clearTimeout(stageTrailerFeedbackTimer);
  feedback.textContent=message;
  feedback.hidden=false;
  stageTrailerFeedbackTimer=setTimeout(()=>{
    feedback.hidden=true;
    stageTrailerFeedbackTimer=null;
  },1400);
}

function handleStageTrailerShortcut(event) {
  if (!$("#stage")||!stageTrailerPlayer||event.altKey||event.ctrlKey||event.metaKey) return;
  if (event.target instanceof Element&&event.target.closest("input,textarea,select,button,a,[contenteditable='true']")) return;
  if (event.code==="Space"||event.key===" ") {
    event.preventDefault();
    const playingState=window.YT?.PlayerState?.PLAYING;
    const playerState=stageTrailerPlayer.getPlayerState();
    if (playerState===playingState) {
      stageTrailerPlayer.pauseVideo();
      showStageTrailerFeedback("Paused");
    } else if (stageTrailerPageActive&&!document.hidden&&!trailerReadMode) {
      clearTimeout(stageTrailerIdleTimer);
      stageTrailerIdleTimer=null;
      stageTrailerIsIdle=true;
      applyStageTrailerAudio();
      stageTrailerPlayer.playVideo();
      showStageTrailerFeedback("Playing");
    }
    return;
  }
  const key=event.key.toLowerCase();
  if (!["z","x","d","s"].includes(key)) return;
  event.preventDefault();
  if (key==="z"||key==="x") {
    const current=Number(stageTrailerPlayer.getCurrentTime());
    const duration=Number(stageTrailerPlayer.getDuration());
    if (!Number.isFinite(current)||!Number.isFinite(duration)) return;
    const target=Math.min(duration,Math.max(0,current+(key==="z"?-5:5)));
    stageTrailerPlayer.seekTo(target,true);
    showStageTrailerFeedback(`${key==="z"?"−":"+"}${Math.round(Math.abs(target-current))} sec`);
    return;
  }

  const current=stageTrailerPlaybackRate||1;
  const available=stageTrailerPlayer.getAvailablePlaybackRates?.();
  const rates=[...new Set((Array.isArray(available)&&available.length?available:[0.25,0.5,1,1.5,2])
    .map(Number).filter(rate=>Number.isFinite(rate)&&rate>0))].sort((a,b)=>a-b);
  const direction=key==="d"?1:-1;
  const options=rates.filter(rate=>direction>0?rate>current:rate<current);
  const nextRate=options.sort((a,b)=>
    Math.abs(a-(current+direction*.5))-Math.abs(b-(current+direction*.5))
  )[0];
  if (!nextRate) {
    showStageTrailerFeedback(direction>0?"Maximum supported speed":"Minimum supported speed");
    return;
  }
  stageTrailerPlaybackRate=nextRate;
  stageTrailerPlayer.setPlaybackRate(nextRate);
  showStageTrailerFeedback(`${nextRate.toFixed(1)}× speed`);
}

function stageTrailerActivity() {
  if (trailerReadMode||!stageTrailerPointerHandler) return;
  if (!stageTrailerPageActive||document.hidden) return;
  stageTrailerIsIdle=false;
  clearTimeout(stageTrailerIdleTimer);
  clearTimeout(stageTrailerContentTimer);
  stageTrailerContentTimer=null;
  $("#stage")?.classList.remove("trailerVisible");
  $("#stage")?.classList.remove("trailerContentHidden");
  if (stageTrailerPlayer) stageTrailerPlayer.pauseVideo();
  scheduleStageTrailer();
}

function pauseStageTrailerForInactivePage() {
  stageTrailerPageActive=false;
  stageTrailerIsIdle=false;
  clearTimeout(stageTrailerIdleTimer);
  stageTrailerIdleTimer=null;
  clearTimeout(stageTrailerContentTimer);
  stageTrailerContentTimer=null;
  $("#stage")?.classList.remove("trailerVisible","trailerContentHidden");
  stageTrailerPlayer?.pauseVideo();
}

function resumeStageTrailerForActivePage() {
  if (document.hidden||trailerReadMode||!stageTrailerPointerHandler) return;
  stageTrailerPageActive=true;
  stageTrailerIsIdle=false;
  scheduleStageTrailer();
}

function applyStageTrailerAudio(player=stageTrailerPlayer) {
  if (!player) return;
  if (stageTrailerAudioEnabled) player.unMute();
  else player.mute();
}

window.setStageTrailerAudio=enabled=>{
  stageTrailerAudioEnabled=Boolean(enabled);
  applyStageTrailerAudio();
  if (!stageTrailerAudioEnabled||trailerReadMode||!stageTrailerMovie||!stageTrailerPageActive||document.hidden) return;
  clearTimeout(stageTrailerIdleTimer);
  stageTrailerIdleTimer=null;
  stageTrailerIsIdle=true;
  $("#stage")?.classList.add("trailerContentHidden");
  if (stageTrailerPlayer) {
    stageTrailerPlayer.playVideo();
  } else {
    startStageTrailerAfterIdle(stageTrailerGeneration);
  }
};

function navigateStageMovie(direction) {
  const currentIndex=activeStageSequence.findIndex(movie=>
    String(movie.tmdbId)===String(activeStageMovie?.tmdbId)
  );
  const nextMovie=activeStageSequence[currentIndex+direction];
  if (!nextMovie) return;
  const readOnly=document.querySelector("#stage .stagebg")?.dataset.readOnly==="true";
  stage(nextMovie,readOnly,{sequence:activeStageSequence,direction});
}

window.setTrailerReadMode=enabled=>{
  trailerReadMode=Boolean(enabled);
  localStorage.setItem("cinevault-read-mode",String(trailerReadMode));
  if (trailerReadMode) {
    stopStageTrailer();
  } else if (activeStageMovie) {
    setupStageTrailer(
      activeStageMovie.trailerKeys?.length?activeStageMovie.trailerKeys:activeStageMovie.trailerKey,
      activeStageMovie
    );
  }
};

window.setStageListStatus=async status=>{
  const stageMovie=activeStageMovie;
  if (!stageMovie||!["watched","want"].includes(status)) return;
  const savedMovie=movies.find(movie=>String(movie.tmdbId)===String(stageMovie.tmdbId));
  if (savedMovie?.status===status) return;

  try {
    if (savedMovie) {
      await updateMovie(savedMovie,{status});
      stage({...stageMovie,status},document.querySelector("#stage .stagebg")?.dataset.readOnly==="true",{
        history:false,
        sequence:activeStageSequence
      });
    } else {
      await saveMovie(stageMovie,status);
      stage({...stageMovie,status},document.querySelector("#stage .stagebg")?.dataset.readOnly==="true",{
        history:false,
        sequence:activeStageSequence
      });
    }
  } catch(error) {
    alert(error.message||"Could not update movie list.");
  }
};

window.markWatched=async id=>{
  const m=movies.find(x=>String(x.tmdbId)===String(id));
  if (!m) return;

  try {
    await updateMovie(m,{status:"watched"});
    $("#stage")?.remove();
    show("archive");
  } catch(e) {
    alert(e.message);
  }
};

window.want=async id=>{
  const m=movies.find(x=>String(x.tmdbId)===String(id));
  if (!m) return;

  try {
    await updateMovie(m,{status:"want"});
    $("#stage")?.remove();
    show("archive");
  } catch(e) {
    alert(e.message);
  }
};

async function settingsModal() {
  const local=localStorage.getItem("cinevault-tmdb-key")||"";

  document.body.insertAdjacentHTML("beforeend",`
    <div class="modal" id="settingsModal">
      <div class="box">
        <button class="x" onclick="$('#settingsModal').remove()">×</button>
        <span>SETTINGS</span>
        <h2>CineVault connections.</h2>
        <p>Supabase is connected through Vercel environment variables. TMDB can use the server-side Vercel key or an optional browser key stored only on this device.</p>

        <label class="keylabel">
          TMDB API KEY
          <input class="field" id="tmdbKey" type="password" value="${esc(local)}" placeholder="Optional browser TMDB key" autocomplete="off">
        </label>

        <button class="primary full" id="saveKey">Save browser TMDB key</button>
        <button class="full" id="clearKey" style="margin-top:8px">Clear browser key</button>

        <small class="muted" style="display:block;margin-top:10px">
          Supabase: connected · TMDB server key:
          ${config?.tmdbConfigured ? "configured" : "not configured"}
        </small>
      </div>
    </div>`);

  $("#saveKey").onclick=()=>{
    const key=$("#tmdbKey").value.trim();

    if (key) localStorage.setItem("cinevault-tmdb-key",key);
    else localStorage.removeItem("cinevault-tmdb-key");

    $("#settingsModal").remove();
    alert("TMDB setting saved.");
  };

  $("#clearKey").onclick=()=>{
    localStorage.removeItem("cinevault-tmdb-key");
    $("#settingsModal").remove();
    alert("Browser TMDB key cleared.");
  };
}

function profileImageSuggestions() {
  const suggestions=[
    ...movies.filter(movie=>movie.status==="watched"&&movie.posterPath).map(movie=>({
      url:img(movie.posterPath),label:movie.title
    })),
    ...characters.filter(character=>character.poster).map(character=>({
      url:img(character.poster),label:character.character_name||character.actor_name||"Character"
    }))
  ];
  return [...new Map(suggestions.map(item=>[item.url,item])).values()].slice(0,12);
}

function profileModal() {
  const avatar=profile?.avatar?img(profile.avatar):"";
  const suggestions=profileImageSuggestions();
  document.body.insertAdjacentHTML("beforeend",`
    <div class="modal" id="profileModal">
      <div class="box profileBox">
        <button class="x" onclick="this.closest('.modal').remove()">×</button>
        <span>PROFILE</span>
        <div class="profileOverview">
          <div class="profileAvatarWrap">
            <button type="button" id="profileImageView" class="profileImageView" aria-label="View profile picture full screen" ${avatar?"":"disabled"}>
              ${avatar?`<img src="${esc(avatar)}" alt="Profile picture">`:`<span class="profileFallback profileViewFallback" aria-hidden="true">${esc((profile?.username||"U").slice(0,1).toUpperCase())}</span>`}
            </button>
            <button type="button" id="editProfile" class="profileEditButton" aria-label="Edit profile and profile picture" title="Edit profile">✎</button>
          </div>
          <div class="profileIdentity">
            <h2>${esc(profile?.display_name||profile?.username||"Your profile")}</h2>
            <p>@${esc(profile?.username||"user")}</p>
          </div>
        </div>
        <div id="profileEditSection" class="profileEditSection" hidden>
          <label class="shareExpiryLabel" for="pn">DISPLAY NAME</label>
          <input class="field profileNameInput" id="pn" value="${esc(profile?.display_name||profile?.username||"")}" placeholder="Display name">
          <div class="profilePhotoSection">
            <label class="shareExpiryLabel" for="profileAvatarUrl">PROFILE PICTURE · ONLINE IMAGE LINK</label>
            <div id="avatarDrop" class="avatarDrop">
              <img id="avatarPreview" src="${esc(avatar)}" alt="Profile picture preview" ${avatar?"":"hidden"}>
              <span id="avatarDropHint">${avatar?"Current profile picture":"Drop an image from a webpage here"}</span>
            </div>
            <div class="profileAvatarActions">
              <input class="field" id="profileAvatarUrl" type="url" value="${esc(avatar)}" placeholder="Paste an image URL (https://…)" autocomplete="url">
              <button type="button" id="removeAvatar" class="danger">Remove picture</button>
            </div>
            <p class="muted profilePhotoHint">Images stay hosted at their original online source; CineVault saves only the image link. To use Google Images, open a search and copy or drag the image itself.</p>
            <a class="profileImageSearch" href="https://www.google.com/search?tbm=isch&q=${encodeURIComponent((profile?.display_name||profile?.username||"movie character")+" portrait")}" target="_blank" rel="noopener">Search images online ↗</a>
            ${suggestions.length?`
              <p class="muted profileSuggestionsLabel">SUGGESTIONS FROM YOUR WATCHED MOVIES AND CHARACTERS</p>
              <div class="profileSuggestions">
                ${suggestions.map(item=>`
                  <button type="button" class="profileSuggestion" data-avatar-url="${esc(item.url)}" title="${esc(item.label)}">
                    <img src="${esc(item.url)}" alt="${esc(item.label)}">
                  </button>`).join("")}
              </div>`:""}
            <small id="avatarMessage" class="muted profilePhotoHint"></small>
          </div>
          <button class="primary full" onclick="saveProfile(this)">Save profile</button>
        </div>
      </div>
    </div>`);

  const imageView=$("#profileImageView");
  if (avatar) imageView.onclick=()=>showProfileImage(avatar);
  $("#editProfile").onclick=()=>{
    const editor=$("#profileEditSection");
    editor.hidden=false;
    $("#editProfile").setAttribute("aria-expanded","true");
    editor.scrollIntoView({behavior:"smooth",block:"nearest"});
  };

  const urlInput=$("#profileAvatarUrl");
  const preview=$("#avatarPreview");
  const drop=$("#avatarDrop");
  preview.onclick=()=>{
    if (!preview.hidden&&preview.src) showProfileImage(preview.src);
  };
  const setAvatar=value=>{
    const url=normalizeImageUrl(value);
    if (!url) {
      $("#avatarMessage").textContent="Use a valid http or https image URL.";
      return false;
    }
    urlInput.value=url;
    preview.src=url;
    preview.hidden=false;
    $("#avatarDropHint").textContent="Profile picture preview";
    $("#avatarMessage").textContent="Preview loaded from the original image source.";
    return true;
  };

  urlInput.oninput=()=> {
    if (!urlInput.value.trim()) {
      preview.removeAttribute("src");
      preview.hidden=true;
      $("#avatarDropHint").textContent="Drop an image from a webpage here";
      $("#avatarMessage").textContent="No profile picture selected.";
      return;
    }
    setAvatar(urlInput.value);
  };
  preview.onerror=()=>$("#avatarMessage").textContent="Could not load that image. Try a direct image link.";
  $("#removeAvatar").onclick=()=>{
    urlInput.value="";
    preview.removeAttribute("src");
    preview.hidden=true;
    $("#avatarDropHint").textContent="Drop an image from a webpage here";
    $("#avatarMessage").textContent="Profile picture will be removed when you save.";
  };
  document.querySelectorAll(".profileSuggestion").forEach(button=>{
    button.onclick=()=>setAvatar(button.dataset.avatarUrl);
  });
  drop.ondragover=event=>{
    event.preventDefault();
    drop.classList.add("dragOver");
  };
  drop.ondragleave=()=>drop.classList.remove("dragOver");
  drop.ondrop=event=>{
    event.preventDefault();
    drop.classList.remove("dragOver");
    const transfer=event.dataTransfer;
    let droppedUrl="";
    const html=transfer.getData("text/html");
    if (html) {
      const doc=new DOMParser().parseFromString(html,"text/html");
      droppedUrl=doc.querySelector("img")?.src||doc.querySelector("a")?.href||"";
    }
    if (!droppedUrl) {
      droppedUrl=transfer.getData("text/uri-list").split(/\r?\n/).find(line=>line&&!line.startsWith("#"))||"";
    }
    if (!droppedUrl) droppedUrl=transfer.getData("text/plain").trim();
    if (!setAvatar(droppedUrl)) {
      $("#avatarMessage").textContent="Drop an online image or image link, or paste its URL. Local files are not uploaded.";
    }
  };
}

function showProfileImage(url) {
  document.body.insertAdjacentHTML("beforeend",`
    <div id="profileImageViewer" class="profileImageViewer" role="dialog" aria-modal="true" aria-label="Full-size profile picture">
      <button type="button" class="profileImageClose" aria-label="Close image">×</button>
      <img class="profileFullImage" src="${esc(url)}" alt="Full-size profile picture">
      <span class="profileImageDimensions">Loading image dimensions…</span>
    </div>`);
  const viewer=$("#profileImageViewer");
  const image=viewer.querySelector("img");
  image.onload=()=> {
    viewer.querySelector(".profileImageDimensions").textContent=`${image.naturalWidth} × ${image.naturalHeight} px`;
  };
  image.onerror=()=> {
    viewer.querySelector(".profileImageDimensions").textContent="Could not load this image.";
  };
  if (image.complete) {
    if (image.naturalWidth) image.onload();
    else image.onerror();
  }
  viewer.querySelector(".profileImageClose").onclick=()=>viewer.remove();
  viewer.onclick=event=>{
    if (event.target===viewer) viewer.remove();
  };
}

function normalizeImageUrl(value) {
  try {
    const url=new URL(String(value||"").trim());
    return ["http:","https:"].includes(url.protocol)&&!url.username&&!url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

window.saveProfile=async btn=>{
  const display_name=$("#pn").value.trim()||profile.username;
  const avatarValue=$("#profileAvatarUrl").value.trim();
  const avatar=avatarValue?normalizeImageUrl(avatarValue):null;
  if (avatarValue&&!avatar) {
    $("#avatarMessage").textContent="Use a valid http or https image URL.";
    return;
  }

  const {data,error}=await supabaseClient.from("profiles")
    .update({display_name,avatar})
    .eq("id",currentUser.id)
    .select().single();

  if (error) return alert(error.message);

  profile=data;
  btn.closest(".modal").remove();
  shell();
  show(activeTab);
  profileModal();
};

async function logout() {
  await supabaseClient.auth.signOut();
  location.reload();
}

async function boot() {
  try {
    await initSupabase();
    await loadData();

    if (!currentUser) {
      authModal();
      return;
    }

    const route=initialAppRoute();
    if (!history.state?.cineVaultRoute) {
      history.replaceState({...history.state,...route},"",location.href);
    }
    shell();
    await restoreAppRoute(route);

    supabaseClient.auth.onAuthStateChange(event=>{
      if (event==="SIGNED_OUT") location.reload();
    });
  } catch(e) {
    console.error(e);
    const message=e.message||"Unknown startup error.";
    const code=e.code||"";
    const needsSocialMigration=/notifications|messages/i.test(message);
    const needsLibraryMigration=!needsSocialMigration
      && (code==="42P01" || code==="PGRST205" || /library_shares/i.test(message));
    const missingConfig=/environment variables are missing/i.test(message);
    const heading=needsSocialMigration
      ? "Finish the network setup."
      : needsLibraryMigration
      ? "Finish the library-sharing setup."
      : missingConfig
        ? "Connect CineVault."
        : "CineVault could not start.";
    const guidance=needsSocialMigration
      ? "Run <b>supabase/social_features.sql</b> in Supabase SQL Editor, then reload the app. This adds messaging, notifications, and their access policies."
      : needsLibraryMigration
      ? "Run <b>supabase/library_sharing.sql</b> in Supabase SQL Editor, then reload the app. This adds the expiring library-sharing table and access function."
      : missingConfig
        ? "Add <b>SUPABASE_URL</b> and <b>SUPABASE_PUBLISHABLE_KEY</b> in Vercel, then redeploy. Add <b>TMDB_API_KEY</b> to enable movie search."
        : "Check the database setup and Vercel deployment, then reload. The specific error above can help identify the missing setup.";

    document.body.innerHTML=`
      <div class="auth">
        <div class="authBox">
          <div class="brand">
            <b>CINEVAULT</b>
            <small>${needsSocialMigration||needsLibraryMigration?"DATABASE MIGRATION REQUIRED":"SETUP REQUIRED"}</small>
          </div>
          <h1>${heading}</h1>
          <p class="muted">${esc(message)}${code?` (${esc(code)})`:""}</p>
          <p class="muted">${guidance}</p>
        </div>
      </div>`;
  }
}

boot();
