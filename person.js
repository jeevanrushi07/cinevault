const root=document.querySelector("#personPage");

function esc(value="") {
  return String(value).replace(/[&<>"']/g,char=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[char]));
}

function imageUrl(path,size="w500") {
  if (!path) return "";
  return /^https?:\/\//i.test(path)?path:`https://image.tmdb.org/t/p/${size}${path}`;
}

function personAge(birthday,deathday) {
  if (!birthday) return "";
  const born=new Date(`${birthday}T00:00:00Z`);
  const died=deathday?new Date(`${deathday}T00:00:00Z`):new Date();
  if (Number.isNaN(born.getTime())||Number.isNaN(died.getTime())) return "";
  let age=died.getUTCFullYear()-born.getUTCFullYear();
  if (died.getUTCMonth()<born.getUTCMonth()||
    (died.getUTCMonth()===born.getUTCMonth()&&died.getUTCDate()<born.getUTCDate())) age--;
  return age>=0?String(age):"";
}

async function apiJson(response) {
  const body=await response.text();
  try {
    return JSON.parse(body);
  } catch {
    const excerpt=body.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim().slice(0,160);
    throw new Error(`Person API returned a non-JSON response (HTTP ${response.status})${excerpt?`: ${excerpt}`:"."}`);
  }
}

function renderCredit(credit) {
  const titleUrl=`https://www.google.com/search?q=${encodeURIComponent(`${credit.title} ${credit.year} ${credit.mediaType==="tv"?"series":"movie"}`)}`;
  return `
    <article class="personCredit">
      ${credit.posterPath
        ? `<a href="${titleUrl}" target="_blank" rel="noopener"><img src="${esc(imageUrl(credit.posterPath,"w342"))}" alt="${esc(credit.title)}"></a>`
        : `<a class="personCreditPosterFallback" href="${titleUrl}" target="_blank" rel="noopener">${esc(credit.title)}</a>`}
      <div class="personCreditBody">
        <b>${esc(credit.title||"Untitled")}</b>
        <small>${credit.mediaType==="tv"?"SERIES":"FILM"}${credit.year?` · ${esc(credit.year)}`:""}</small>
        <div class="personCreditRoles">${(credit.roles||[]).map(role=>`<span class="personRoleTag">${esc(role)}</span>`).join("")}</div>
      </div>
    </article>`;
}

async function loadPerson() {
  const id=new URLSearchParams(location.search).get("id");
  if (!id) {
    root.innerHTML='<a class="personBack" href="./">← Back to CineVault</a><p class="personError">Missing TMDB person ID.</p>';
    return;
  }
  try {
    const response=await fetch(`/api/person?id=${encodeURIComponent(id)}`);
    const person=await apiJson(response);
    if (!response.ok) throw new Error(person.error||"Could not load this person's details.");
    const age=personAge(person.birthday,person.deathday);
    const imdbUrl=person.imdbId
      ? `https://www.imdb.com/name/${encodeURIComponent(person.imdbId)}/`
      : `https://www.google.com/search?q=${encodeURIComponent(`${person.name} IMDb`)}`;
    document.title=`${person.name||"Person"} | CineVault`;
    root.innerHTML=`
      <a class="personBack" href="./">← Back to CineVault</a>
      <section class="personHero">
        ${person.profilePath
          ? `<img class="personPortrait" src="${esc(imageUrl(person.profilePath))}" alt="${esc(person.name)}">`
          : `<div class="personPortrait personPortraitFallback">${esc((person.name||"?").slice(0,1).toUpperCase())}</div>`}
        <div>
          <p class="muted">${esc(person.knownForDepartment||"FILM & TELEVISION")}</p>
          <h1 class="personTitle">${esc(person.name||"Unknown person")}</h1>
          <div class="personMeta">
            ${person.birthday?`<span>Born ${esc(person.birthday)}${age?` · ${age} years old`:""}</span>`:""}
            ${person.deathday?`<span>Died ${esc(person.deathday)}</span>`:""}
            ${person.placeOfBirth?`<span>${esc(person.placeOfBirth)}</span>`:""}
          </div>
          <a class="personImdb" href="${imdbUrl}" target="_blank" rel="noopener">${person.imdbId?"Open IMDb profile ↗":"Search IMDb ↗"}</a>
          ${person.biography?`<p class="personBio">${esc(person.biography)}</p>`:"<p class=\"personEmpty\">No biography is available from TMDB.</p>"}
        </div>
      </section>
      <div class="personSectionHead">
        <div><p class="muted">FILM & TELEVISION</p><h2>Credits</h2></div>
        <small>${(person.filmography||[]).length} TITLES</small>
      </div>
      ${(person.filmography||[]).length
        ? `<section class="personFilmography">${person.filmography.map(renderCredit).join("")}</section>`
        : '<p class="personEmpty">No filmography is available from TMDB.</p>'}`;
  } catch(error) {
    root.innerHTML=`<a class="personBack" href="./">← Back to CineVault</a><p class="personError">${esc(error.message)}</p>`;
  }
}

loadPerson();
