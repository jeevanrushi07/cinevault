const $ = (s) => document.querySelector(s);

const img = (p) => p
  ? `https://image.tmdb.org/t/p/w780${p}`
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
let searchQuery = "";

function tmdbHeaders() {
  const key = localStorage.getItem("cinevault-tmdb-key");
  return key ? {"X-TMDB-API-Key": key} : {};
}

function tmdbReady() {
  return Boolean(localStorage.getItem("cinevault-tmdb-key") || config?.tmdbConfigured);
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

  const [p, m, c, s] = await Promise.all([
    supabaseClient.from("profiles").select("*").eq("id", user.id).single(),
    supabaseClient.from("movies").select("*").eq("user_id", user.id).order("created_at", {ascending:false}),
    supabaseClient.from("characters").select("*").eq("user_id", user.id).order("created_at", {ascending:false}),
    supabaseClient.from("shares").select(`
      id,tmdb_id,movie_snapshot,created_at,sender_id,receiver_id,
      sender:profiles!shares_sender_id_fkey(username),
      receiver:profiles!shares_receiver_id_fkey(username)
    `).or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`).order("created_at",{ascending:false})
  ]);

  if (p.error) throw p.error;
  if (m.error) throw m.error;
  if (c.error) throw c.error;
  if (s.error) throw s.error;

  profile = p.data;
  movies = (m.data || []).map(normalizeMovie);
  characters = c.data || [];
  incomingShares = (s.data || []).filter(x => x.receiver_id === user.id);
  outgoingShares = (s.data || []).filter(x => x.sender_id === user.id);
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
  document.body.innerHTML = `
    <div class="app">
      <aside>
        <div class="brand">
          <b>CINEVAULT</b>
          <small>PERSONAL FILM ARCHIVE</small>
        </div>
        <nav>
          <button data-tab="archive">◉ Archive</button>
          <button data-tab="recent">◷ Recent</button>
          <button data-tab="shared">◎ Shared</button>
          <button data-tab="characters">✦ Characters</button>
        </nav>
        <div class="side">
          <button id="add">＋ Add title</button>
          <button id="share">⇧ Share movie</button>
          <button id="profile">@${esc(profile?.username || "user")}</button>
          <button id="settings">⚙ Settings</button>
          <button id="logout">↪ Logout</button>
        </div>
      </aside>
      <main>
        <header>
          <div class="search">
            ⌕
            <input id="search" placeholder="Search movies, actors, directors, genres, years...">
            <kbd>⌘ K</kbd>
          </div>
          <button id="addTop">＋</button>
        </header>
        <div id="content"></div>
      </main>
    </div>`;

  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => show(b.dataset.tab));
  $("#settings").onclick = settingsModal;
  $("#add").onclick = $("#addTop").onclick = addModal;
  $("#share").onclick = shareMovieModal;
  $("#profile").onclick = profileModal;
  $("#logout").onclick = logout;
  $("#search").oninput = e => {
    searchQuery = e.target.value;
    show("archive", searchQuery);
  };
}

async function show(tab, q = "") {
  activeTab = tab;
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

  if (tab === "shared") {
    c.innerHTML = '<p class="muted">Loading shared movies…</p>';
    c.innerHTML = await shared();
    return;
  }

  const filtered = q ? movies.filter(m => matches(m,q)) : movies;
  const watchedIds = new Set(
    movies.filter(m => m.status === "watched").map(m => String(m.tmdbId))
  );

  c.innerHTML = `
    <section class="hero">
      <div>
        <span>YOUR WATCHED UNIVERSE</span>
        <h1>A private archive<br><i>of stories.</i></h1>
        <p>
          ${movies.filter(m=>m.status==="watched").length} watched ·
          ${movies.filter(m=>m.status==="want").length} want to watch.
          Search works across title, cast, director, genre and year.
        </p>
      </div>
      <div class="orb">✦<small>LIVE METADATA</small></div>
    </section>
    ${watchlist()}
    <div class="head">
      <div>
        <span>ARCHIVE</span>
        <h2>${q ? `Results for "${esc(q)}"` : "Your collection"}</h2>
      </div>
      <small>${filtered.length} TITLES</small>
    </div>
    <div class="wall">
      ${filtered.map((m,i)=>poster(m,i,watchedIds.has(String(m.tmdbId)) && m.status==="watched")).join("")}
    </div>`;

  document.querySelectorAll(".poster").forEach(p => {
    p.onclick = () => stage(movies.find(m => String(m.tmdbId) === p.dataset.id));
    p.addEventListener("dragstart", e => e.dataTransfer.setData("text/plain", p.dataset.id));
  });
}

function poster(m,i=0,mutual=false) {
  return `
    <article class="poster p${i%7} ${mutual?"mutual":""}" draggable="true" data-id="${m.tmdbId}">
      <img src="${img(m.posterPath)}" alt="${esc(m.title)}">
      <div class="shade">
        <small>${esc(m.year || "")}</small>
        <b>${esc(m.title)}</b>
        <small>${esc((m.genres||[]).slice(0,2).join(" · "))}</small>
      </div>
      ${mutual ? "<em>WATCHED</em>" : ""}
    </article>`;
}

function watchlist() {
  const ms = movies.filter(m => m.status === "want");

  return `
    <section class="watch vertical-watch"
      ondragover="event.preventDefault()"
      ondrop="dropWatch(event)">
      <div>
        <span>UP NEXT</span>
        <b>Want to watch</b>
        <small>Drag a poster here</small>
      </div>
      ${
        ms.length
        ? ms.slice(0,10).map(m=>`
          <article onclick="stageById('${m.tmdbId}')">
            <img src="${img(m.posterPath)}" alt="${esc(m.title)}">
            <b>${esc(m.title)}<small>${esc(m.year)}</small></b>
          </article>`).join("")
        : "<p>Drop a movie here to build your watchlist.</p>"
      }
    </section>`;
}

window.dropWatch = async e => {
  e.preventDefault();
  const id = e.dataTransfer.getData("text/plain");
  const m = movies.find(x => String(x.tmdbId) === String(id));
  if (!m) return;

  try {
    await updateMovie(m,{status:"want"});
    show("archive");
  } catch(err) {
    alert(err.message);
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
        <article onclick="stageById('${m.tmdbId}')">
          <time>${m.addedAt ? new Date(m.addedAt).toLocaleDateString(undefined,{month:"short",day:"2-digit"}) : ""}</time>
          <img src="${img(m.posterPath)}" alt="${esc(m.title)}">
          <div>
            <small>${esc(m.type||"movie")} · ${esc(m.year)}</small>
            <h2>${esc(m.title)}</h2>
            <p>${esc(m.overview||"No synopsis available.")}</p>
          </div>
        </article>`).join("")}
    </div>`;
}

window.stageById = id => stage(movies.find(m => String(m.tmdbId) === String(id)));

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
        <div><span>SHARED WITH YOU</span><h2>Incoming movies</h2></div>
        <small>${incoming.length} SHARES</small>
      </div>

      ${
        incoming.length
        ? `<div class="shareList">
          ${incoming.map(s=>{
            const m=normalizeMovie(s.movie_snapshot);
            return `
              <article>
                <img src="${img(m.posterPath)}" alt="${esc(m.title)}">
                <div>
                  <b>${esc(m.title)}</b>
                  <small>Shared by @${esc(s.sender?.username||"user")} · ${esc(m.year||"")}</small>
                  <p>${esc(m.overview||"")}</p>
                  <div class="actions">
                    <button class="primary" onclick="saveShared('${s.id}')">＋ Save to my library</button>
                    <button onclick='stage(${JSON.stringify(m).replace(/'/g,"&#39;")})'>Details</button>
                  </div>
                </div>
              </article>`;
          }).join("")}
        </div>`
        : '<p class="muted">No one has shared a movie with you yet.</p>'
      }

      <div class="head" style="margin-top:40px">
        <div><span>YOUR SHARES</span><h2>Sent to users</h2></div>
      </div>

      ${
        outgoing.length
        ? `<div class="shareList">
          ${outgoing.map(s=>{
            const m=normalizeMovie(s.movie_snapshot);
            return `
              <article>
                <img src="${img(m.posterPath)}" alt="${esc(m.title)}">
                <div>
                  <b>${esc(m.title)}</b>
                  <small>Shared with @${esc(s.receiver?.username||"user")}</small>
                  <div class="actions">
                    <button class="danger" onclick="revokeShare('${s.id}')">Retrieve / revoke share</button>
                  </div>
                </div>
              </article>`;
          }).join("")}
        </div>`
        : '<p class="muted">You have not shared any movies yet.</p>'
      }
    </section>`;
}

window.saveShared = async id => {
  const s = incomingShares.find(x=>x.id===id);
  if (!s) return;

  try {
    await saveMovie(normalizeMovie(s.movie_snapshot),"watched");
    show("archive");
  } catch(e) {
    alert(e.message);
  }
};

window.revokeShare = async id => {
  if (!confirm("Retrieve this shared movie? The recipient will no longer have access to the shared copy.")) return;

  const {error} = await supabaseClient.from("shares")
    .delete().eq("id",id).eq("sender_id",currentUser.id);

  if (error) return alert(error.message);

  await loadData();
  show("shared");
};

async function shareMovieModal(movieId) {
  const movie = movieId
    ? movies.find(m=>String(m.tmdbId)===String(movieId))
    : null;

  if (!movie) {
    if (!movies.length) return alert("Add a movie first.");

    document.body.insertAdjacentHTML("beforeend",`
      <div class="modal" id="shareModal">
        <div class="box">
          <button class="x" onclick="$('#shareModal').remove()">×</button>
          <span>SHARE A MOVIE</span>
          <h2>Choose a movie.</h2>
          <div id="shareMovieChoices">
            ${movies.slice(0,30).map(m=>`
              <button class="shareChoice" onclick="shareMovieModal('${m.tmdbId}')">
                <img src="${img(m.posterPath)}">
                <span>${esc(m.title)}</span>
              </button>`).join("")}
          </div>
        </div>
      </div>`);
    return;
  }

  document.querySelector("#shareModal")?.remove();

  document.body.insertAdjacentHTML("beforeend",`
    <div class="modal" id="shareUserModal">
      <div class="box">
        <button class="x" onclick="$('#shareUserModal').remove()">×</button>
        <span>SHARE ${esc(movie.title).toUpperCase()}</span>
        <h2>Find a CineVault user.</h2>
        <input class="field" id="shareUser" autofocus placeholder="Search username">
        <div id="shareUsers"></div>
      </div>
    </div>`);

  const input=$("#shareUser");
  let timer;

  input.oninput=()=>{
    clearTimeout(timer);
    timer=setTimeout(()=>findShareUsers(input.value,movie),250);
  };
}

async function findShareUsers(q,movie) {
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
    $("#shareUsers").innerHTML='<p class="muted">Could not search users.</p>';
    return;
  }

  $("#shareUsers").innerHTML=(data||[]).map(u=>`
    <div class="userRow">
      <b>@${esc(u.username)}</b>
      <button class="primary" onclick="sendShare('${u.id}','${esc(u.username)}','${movie.tmdbId}')">Share</button>
    </div>`).join("") || '<p class="muted">No users found.</p>';
}

window.sendShare=async(receiverId,username,id)=>{
  const movie=movies.find(m=>String(m.tmdbId)===String(id));
  if (!movie) return;

  const {error}=await supabaseClient.from("shares").upsert({
    sender_id:currentUser.id,
    receiver_id:receiverId,
    tmdb_id:Number(movie.tmdbId),
    movie_snapshot:movieRow(movie)
  },{onConflict:"sender_id,receiver_id,tmdb_id"});

  if (error) return alert(error.message);

  $("#shareUserModal")?.remove();
  alert(`Shared with @${username}.`);
  await loadData();
  show("shared");
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
}

async function addModal() {
  if (!tmdbReady()) return settingsModal();

  document.body.insertAdjacentHTML("beforeend",`
    <div class="modal" id="modal">
      <div class="box">
        <button class="x" onclick="$('#modal').remove()">×</button>
        <span>ADD TO CINEVAULT</span>
        <h2>Find a movie or series.</h2>
        <p>Results update while you type. Select the exact match.</p>
        <div class="live">⌕<input id="aq" autofocus placeholder="Interstellar, Dark, Dune..."></div>
        <div id="results"></div>
      </div>
    </div>`);

  const input=$("#aq");
  let timer;

  input.oninput=()=>{
    clearTimeout(timer);
    timer=setTimeout(()=>searchTitles(input.value),250);
  };
}

async function searchTitles(q) {
  if (!q.trim()) {
    $("#results").innerHTML="";
    return;
  }

  const r=await fetch(
    "/api/search?query="+encodeURIComponent(q),
    {headers:tmdbHeaders()}
  ).catch(()=>null);

  if (!r || !r.ok) {
    $("#results").innerHTML='<p class="muted">TMDB is unavailable. Add a TMDB API key in Settings.</p>';
    return;
  }

  const j=await r.json();

  const html=(j.results||[])
    .filter(x=>["movie","tv"].includes(x.media_type))
    .slice(0,8)
    .map(x=>`
      <div class="result">
        <img src="${img(x.poster_path)}" alt="${esc(x.title||x.name)}">
        <div>
          <b>${esc(x.title||x.name)}</b>
          <small>${(x.release_date||x.first_air_date||"").slice(0,4)} · ${x.media_type==="tv"?"Series":"Movie"}</small>
          <p>${esc(x.overview||"")}</p>
          <div class="resultActions">
            <button class="primary" onclick='choose(${JSON.stringify(x).replace(/'/g,"&#39;")},"watched")'>＋ Add to watched</button>
            <button onclick='choose(${JSON.stringify(x).replace(/'/g,"&#39;")},"want")'>＋ Add to want to watch</button>
          </div>
        </div>
      </div>`).join("");

  $("#results").innerHTML=html || '<p class="muted">No matching titles.</p>';
}

async function choose(r,status="watched") {
  try {
    const rr=await fetch("/api/movie/"+r.id,{headers:tmdbHeaders()});
    let x=rr.ok ? await rr.json() : null;

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
    await show("archive");
  } catch(e) {
    alert(e.message||"Could not save movie");
  }
}

function stage(m) {
  if (!m) return;

  $("#stage")?.remove();

  const imdbUrl=`https://www.google.com/search?q=${encodeURIComponent(m.title+" IMDb")}`;
  const trailerUrl=m.trailerKey
    ? `https://www.youtube.com/watch?v=${m.trailerKey}`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(m.title+" trailer")}`;

  document.body.insertAdjacentHTML("beforeend",`
    <div class="stage" id="stage">
      <button class="x" onclick="$('#stage').remove()">×</button>
      <div class="stagebg" style="background-image:linear-gradient(90deg,#08080c 20%,rgba(8,8,12,.8),rgba(8,8,12,.15)),url('${backdrop(m.backdropPath)}')">
        <div class="stagebody">
          <img src="${img(m.posterPath)}" alt="${esc(m.title)}">
          <div>
            <span>${(m.type||"movie").toUpperCase()} · ${m.year||""}</span>
            <h1>${esc(m.title)} <a target="_blank" rel="noopener" href="${imdbUrl}">↗</a></h1>

            <div class="ratings">
              ${m.imdbId ? "IMDb" : ""}
              ${m.tmdbRating ? `★ ${Number(m.tmdbRating).toFixed(1)} TMDB` : ""}
            </div>

            <div class="genres">
              ${(m.genres||[]).map(g=>`<i>${esc(g)}</i>`).join("")}
            </div>

            <p>${esc(m.overview||"No synopsis available.")}</p>

            <div class="meta">
              <span><b>DIRECTOR</b>${esc(m.director||"—")}</span>
              <span><b>CAST</b>${esc((m.cast||[]).slice(0,7).join(", ")||"—")}</span>
            </div>

            <label>
              WHAT YOU WANT TO SAY
              <textarea id="note">${esc(m.personalNote||"")}</textarea>
            </label>

            <div class="actions">
              <a class="primary" target="_blank" rel="noopener" href="${trailerUrl}">▶ Trailer</a>
              ${
                m.status==="want"
                ? `<button onclick="markWatched('${m.tmdbId}')">✓ Mark watched</button>`
                : `<button onclick="want('${m.tmdbId}')">＋ Want to watch</button>`
              }
              <button onclick="shareMovieModal('${m.tmdbId}')">⇧ Share</button>
              <button class="danger" onclick="deleteMovie('${m.tmdbId}')">Delete</button>
            </div>
          </div>
        </div>
      </div>
    </div>`);

  $("#note").onblur=async e=>{
    try {
      await updateMovie(m,{personal_note:e.target.value});
    } catch(err) {
      alert(err.message);
    }
  };
}

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

function profileModal() {
  document.body.insertAdjacentHTML("beforeend",`
    <div class="modal">
      <div class="box">
        <button class="x" onclick="this.closest('.modal').remove()">×</button>
        <span>PROFILE</span>
        <h2>Your archive identity.</h2>
        <input class="field" id="pn" value="${esc(profile?.display_name||profile?.username||"")}" placeholder="Display name">
        <button class="primary full" onclick="saveProfile(this)">Save profile</button>
      </div>
    </div>`);
}

window.saveProfile=async btn=>{
  const display_name=$("#pn").value.trim()||profile.username;

  const {data,error}=await supabaseClient.from("profiles")
    .update({display_name})
    .eq("id",currentUser.id)
    .select().single();

  if (error) return alert(error.message);

  profile=data;
  btn.closest(".modal").remove();
  shell();
  show(activeTab);
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

    shell();
    await show("archive");

    supabaseClient.auth.onAuthStateChange(event=>{
      if (event==="SIGNED_OUT") location.reload();
    });
  } catch(e) {
    console.error(e);

    document.body.innerHTML=`
      <div class="auth">
        <div class="authBox">
          <div class="brand">
            <b>CINEVAULT</b>
            <small>SETUP REQUIRED</small>
          </div>
          <h1>Connect CineVault.</h1>
          <p class="muted">${esc(e.message)}</p>
          <p class="muted">
            Add <b>SUPABASE_URL</b>,
            <b>SUPABASE_PUBLISHABLE_KEY</b>,
            and <b>TMDB_API_KEY</b>
            in Vercel, then redeploy.
            Run <b>supabase/schema.sql</b>
            once in Supabase SQL Editor.
          </p>
        </div>
      </div>`;
  }
}

boot();
