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
let searchQuery = "";
let sharedLibraryTimer = null;
let activeSharedShareId = null;
let notifications = [];
let networkUsers = [];
let activeChatUser = null;
let chatRefreshTimer = null;
let notificationRefreshTimer = null;

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
          <button data-tab="network">✉ Network</button>
          <button data-tab="characters">✦ Characters</button>
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
          <div class="search">
            ⌕
            <input id="search" autocomplete="off" placeholder="Search your archive or add a movie...">
            <kbd>⌘ K</kbd>
            <div id="searchResults" class="headerResults"></div>
          </div>
          <button id="addTop" aria-label="Add a movie">＋</button>
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
  $("#add").onclick = $("#addTop").onclick = addModal;
  $("#share").onclick = shareLibraryModal;
  $("#profile").onclick = profileModal;
  $("#logout").onclick = $("#logoutTop").onclick = logout;
  $("#notificationBell").onclick=toggleNotifications;
  document.onkeydown=e=>{
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
    if (!e.target.closest(".search")) $("#searchResults").classList.remove("open");
    if (!e.target.closest(".notificationWrap")) $("#notificationPanel").classList.remove("open");
  });
  updateNotificationBadge();
  clearInterval(notificationRefreshTimer);
  notificationRefreshTimer=setInterval(refreshNotifications,20000);
}

async function show(tab, q = "") {
  if (tab !== "sharedLibrary") stopSharedLibraryMonitor();
  if (tab !== "network") clearInterval(chatRefreshTimer);
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

  const filtered = q ? movies.filter(m => matches(m,q)) : movies;
  const watched = filtered.filter(m=>m.status==="watched");
  const want = filtered.filter(m=>m.status==="want");

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
    ${watchlist(want)}
    <div class="head">
      <div>
        <span>WATCHED COLLECTION</span>
        <h2>${q ? `Watched results for "${esc(q)}"` : "Your collection"}</h2>
      </div>
      <small>${watched.length} TITLES</small>
    </div>
    <div class="wall">
      ${watched.map((m,i)=>poster(m,i,true)).join("")}
    </div>`;

  document.querySelectorAll(".poster").forEach(p => {
    p.onclick = () => stage(movies.find(m => String(m.tmdbId) === p.dataset.id));
    p.addEventListener("dragstart", e => e.dataTransfer.setData("text/plain", p.dataset.id));
  });
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

function poster(m,i=0,mutual=false,readOnly=false,existingStatus="") {
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
        : mutual ? "<em>WATCHED</em>" : ""}
    </article>`;
}

function watchlist(ms=movies.filter(m => m.status === "want")) {

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
        ? ms.map(m=>`
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
    if (sharedPayload && activeTab==="sharedLibrary" && activeSharedShareId) {
      dropTarget.classList.add("dropComplete");
      await new Promise(resolve=>setTimeout(resolve,260));
      await renderSharedLibrary(activeSharedShareId);
    } else {
      show("archive");
    }
  } catch(err) {
    alert(err.message);
  } finally {
    dropTarget.classList.remove("dragOver");
    dropTarget.classList.add("dropComplete");
    setTimeout(()=>dropTarget.classList.remove("dropComplete"),300);
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
    card.onclick=()=>stage(movie,true);
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
        <p>Results update while you type. Select the exact match.</p>
        <div class="live">⌕<input id="aq" autofocus placeholder="Interstellar, Dark, Dune..."></div>
        <div id="results" class="searchResults"></div>
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

  try {
    const results=await fetchTitles(q);
    $("#results").innerHTML=results.length
      ? results.map(x=>titleResultMarkup(x)).join("")
      : '<p class="muted">No matching titles.</p>';
  } catch(error) {
    $("#results").innerHTML=`<p class="muted">${esc(error.message)}</p>`;
  }
}

async function fetchTitles(query) {
  const response=await fetch(
    "/api/search?query="+encodeURIComponent(query),
    {headers:tmdbHeaders()}
  );
  const result=await response.json().catch(()=>({}));

  if (!response.ok) {
    if (response.status===503) {
      throw new Error("TMDB is not configured. Add TMDB_API_KEY in Vercel or a key in Settings.");
    }
    throw new Error(result.error||"Movie search is unavailable right now.");
  }

  return (result.results||[]).filter(x=>["movie","tv"].includes(x.media_type)).slice(0,8);
}

function titleResultMarkup(item,compact=false) {
  const title=item.title||item.name||"Untitled";
  const searchUrl=`https://www.google.com/search?q=${encodeURIComponent(title)}`;
  const saved=movies.find(movie=>String(movie.tmdbId)===String(item.id));
  return `
    <div class="result ${compact?"compactResult":""} ${saved?"savedResult":""}">
      <img src="${img(item.poster_path)}" alt="${esc(title)}">
      <div>
        <b><a class="movieSearchLink" href="${searchUrl}" target="_blank" rel="noopener">${esc(title)}</a></b>
        <small>${(item.release_date||item.first_air_date||"").slice(0,4)} · ${item.media_type==="tv"?"Series":"Movie"}</small>
        ${compact ? "" : `<p>${esc(item.overview||"")}</p>`}
        ${saved
          ? `<div class="libraryStatus">${saved.status==="want"?"Already in Want to watch":"Already watched"}</div>`
          : `<div class="resultActions">
              <button class="primary" onclick='choose(${JSON.stringify(item).replace(/'/g,"&#39;")},"watched")'>＋ Watched</button>
              <button onclick='choose(${JSON.stringify(item).replace(/'/g,"&#39;")},"want")'>＋ Want to watch</button>
            </div>`}
      </div>
    </div>`;
}

let headerSearchRequest=0;

async function searchHeaderTitles(query) {
  const results=$("#searchResults");
  if (!results) return;

  if (query.trim().length<2) {
    results.innerHTML="";
    results.classList.remove("open");
    return;
  }

  const request=++headerSearchRequest;
  results.innerHTML='<p class="muted searchStatus">Searching titles…</p>';
  results.classList.add("open");

  try {
    const found=await fetchTitles(query);
    if (request!==headerSearchRequest || $("#search")?.value.trim()!==query.trim()) return;
    const alreadySaved=found.filter(item=>movies.some(movie=>String(movie.tmdbId)===String(item.id)));
    const toAdd=found.filter(item=>!movies.some(movie=>String(movie.tmdbId)===String(item.id)));
    results.innerHTML=found.length
      ? `${alreadySaved.length
          ? `<section class="searchTray alreadySavedTray"><p class="searchStatus">ALREADY IN YOUR LIBRARY</p>${alreadySaved.map(item=>titleResultMarkup(item,true)).join("")}</section>`
          : ""}
        ${toAdd.length
          ? `<section class="searchTray addTitlesTray"><p class="searchStatus">ADD TO YOUR LIBRARY</p>${toAdd.map(item=>titleResultMarkup(item,true)).join("")}</section>`
          : ""}`
      : '<p class="muted searchStatus">No matching movies or series.</p>';
  } catch(error) {
    if (request!==headerSearchRequest) return;
    results.innerHTML=`<p class="muted searchStatus">${esc(error.message)}</p>`;
  }
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

function stage(m,readOnly=false) {
  if (!m) return;

  $("#stage")?.remove();

  const movieSearchUrl=`https://www.google.com/search?q=${encodeURIComponent(m.title)}`;
  const imdbUrl=`https://www.google.com/search?q=${encodeURIComponent(m.title+" IMDb")}`;
  const trailerUrl=m.trailerKey
    ? `https://www.youtube.com/watch?v=${m.trailerKey}`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(m.title+" trailer")}`;

  document.body.insertAdjacentHTML("beforeend",`
    <div class="stage" id="stage">
      <button class="x" onclick="$('#stage').remove()">×</button>
      <div class="stagebg" onclick="event.stopPropagation()" style="background-image:linear-gradient(90deg,#08080c 20%,rgba(8,8,12,.8),rgba(8,8,12,.15)),url('${backdrop(m.backdropPath)}')">
        <div class="stagebody">
          <img src="${img(m.posterPath)}" alt="${esc(m.title)}">
          <div>
            <span>${(m.type||"movie").toUpperCase()} · ${m.year||""}</span>
            <h1><a class="movieSearchLink" target="_blank" rel="noopener" href="${movieSearchUrl}">${esc(m.title)}</a> <a target="_blank" rel="noopener" href="${imdbUrl}">↗</a></h1>

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

            ${readOnly ? "" : `
              <label>
                WHAT YOU WANT TO SAY
                <textarea id="note">${esc(m.personalNote||"")}</textarea>
              </label>`}

            <div class="actions">
              <a class="primary" target="_blank" rel="noopener" href="${trailerUrl}">▶ Trailer</a>
              ${readOnly ? "" : `
                ${
                m.status==="want"
                ? `<button onclick="markWatched('${m.tmdbId}')">✓ Mark watched</button>`
                : `<button onclick="want('${m.tmdbId}')">＋ Want to watch</button>`
                }
                <button class="danger" onclick="deleteMovie('${m.tmdbId}')">Delete</button>`}
            </div>
          </div>
        </div>
      </div>
    </div>`);

  $("#stage").onclick=e=>{
    if (e.target===e.currentTarget) $("#stage").remove();
  };

  if (!readOnly) $("#note").onblur=async e=>{
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
      <div class="box">
        <button class="x" onclick="this.closest('.modal').remove()">×</button>
        <span>PROFILE</span>
        <h2>Your archive identity.</h2>
        <input class="field" id="pn" value="${esc(profile?.display_name||profile?.username||"")}" placeholder="Display name">
        <div class="profilePhotoSection">
          <label class="shareExpiryLabel" for="profileAvatarUrl">PROFILE PICTURE · ONLINE IMAGE LINK</label>
          <div id="avatarDrop" class="avatarDrop">
            <img id="avatarPreview" src="${esc(avatar)}" alt="Profile picture preview" ${avatar?"":"hidden"}>
            <span id="avatarDropHint">${avatar?"Current profile picture":"Drop an image from a webpage here"}</span>
          </div>
          <input class="field" id="profileAvatarUrl" type="url" value="${esc(avatar)}" placeholder="Paste an image URL (https://…)" autocomplete="url">
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
    </div>`);

  const urlInput=$("#profileAvatarUrl");
  const preview=$("#avatarPreview");
  const drop=$("#avatarDrop");
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
