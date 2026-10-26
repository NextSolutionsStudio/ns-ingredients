// The explorer page: look up a product by barcode or name, paste a label, browse the knowledge base.
// Served by the Worker (Static Assets) and by the local explorer (scripts/explorer.ts).
import { productUrl, readProductResponse } from "./off-product.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? "") ? u : "#");
const pct = (x) => `${Math.round(x * 100)}%`;
const view = $("#view");
const REPO = "https://github.com/NextSolutionsStudio/ns-ingredients";
const meta = fetch("/v1/meta").then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
const SEVERITIES = ["warning", "caution", "notice", "info"];
const DIETS = {
  vegan: "Vegan",
  vegetarian: "Vegetarian",
  gluten_free: "Gluten-free",
  lactose_free: "Lactose-free",
};
const BASIS = {
  ingredient: "the ingredient itself",
  label_variant: "variant named on the label",
  prior_variant: "likely variant (market prior)",
  qualifier: "source named on the label",
  emphasis: "allergen emphasis",
  trace: "may-contain clause",
  nutrition: "declared nutrition",
};

// ---------------------------------------------------------------- prefs (per-browser convenience only)
const store = {
  get(k, d) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch { /* private mode */ }
  },
};
const langSel = $("#lang");
langSel.value = store.get(
  "nsi.lang",
  (navigator.language || "en").slice(0, 2) === "pl"
    ? "pl"
    : (navigator.language || "").startsWith("de")
    ? "de"
    : "en",
);
langSel.addEventListener("change", () => {
  store.set("nsi.lang", langSel.value);
  route();
});
const lang = () => langSel.value;

// ---------------------------------------------------------------- profile (who the ranking is for)
// Kept in this browser and sent with each analysis; the API evaluates it per request and stores nothing.
function savedProfile() {
  try {
    const p = JSON.parse(store.get("nsi.profile", "{}"));
    return { allergens: p?.allergens === true, diets: Array.isArray(p?.diets) ? p.diets : [] };
  } catch {
    return { allergens: false, diets: [] };
  }
}
function profileControls() {
  const p = savedProfile();
  const box = (key, label, on) =>
    `<label class="tick"><input type="checkbox" data-p="${key}" ${on ? "checked" : ""}> ${
      esc(label)
    }</label>`;
  return `<fieldset class="profile"><legend>Rank for me</legend>${
    box("allergens", "Count allergens as dangers", p.allergens)
  }${Object.entries(DIETS).map(([d, label]) => box(d, label, p.diets.includes(d))).join("")}</fieldset>`;
}
function readProfile() {
  const p = { allergens: false, diets: [] };
  for (const b of document.querySelectorAll("fieldset.profile input:checked")) {
    if (b.dataset.p === "allergens") p.allergens = true;
    else p.diets.push(b.dataset.p);
  }
  store.set("nsi.profile", JSON.stringify(p));
  return p;
}
function onProfileChange(fn) {
  for (const b of document.querySelectorAll("fieldset.profile input")) b.addEventListener("change", fn);
}

// ---------------------------------------------------------------- fetch helpers
// What the API's RateLimit headers last said, per bucket, so a visitor can see the keyless limits work.
const BUCKET_NAMES = { analyze: "analyses", "kb:read": "lookups" };
const left = {};
function noteLimit(path, res) {
  const limit = res.headers.get("ratelimit-limit");
  if (!limit) return;
  left[path.startsWith("/v1/analyze") ? "analyze" : "kb:read"] = `${
    res.headers.get("ratelimit-remaining")
  } of ${limit}`;
  $("#quota").textContent = `Left this minute: ${
    Object.entries(left).map(([b, v]) => `${v} ${BUCKET_NAMES[b]}`).join(" · ")
  }`;
}

async function getJson(path, init) {
  const res = await fetch(path, init);
  noteLimit(path, res);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.detail || body?.title || body?.error || `HTTP ${res.status}`;
    const extra = body?.errors?.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(extra ? `${msg} (${extra})` : msg);
  }
  return body;
}
const errBox = (e) => `<div class="err">${esc(e.message || e)}</div>`;
const spinner = (t) => `<div class="spin">${esc(t)}</div>`;

// ---------------------------------------------------------------- routing
let navSeq = 0;
function parseHash() {
  const h = location.hash.slice(1) || "/";
  const [path, qs] = h.split("?");
  return {
    parts: path.split("/").filter(Boolean).map(decodeURIComponent),
    params: new URLSearchParams(qs || ""),
  };
}
addEventListener("hashchange", route);
$("#search").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const q = $("#q").value.trim();
  if (!q) return;
  const digits = q.replace(/[\s-]/g, "");
  location.hash = /^\d{8,14}$/.test(digits) ? `#/ean/${digits}` : `#/search?q=${encodeURIComponent(q)}`;
});

function route() {
  const seq = ++navSeq;
  const { parts, params } = parseHash();
  const [v, arg] = parts;
  for (const a of document.querySelectorAll("#tabs a")) {
    a.classList.toggle("on", (a.dataset.v || "") === (v === "paste" ? "paste" : v ? "-" : ""));
  }
  scrollTo(0, 0);
  if (v === "ean" && arg) {
    $("#q").value = arg;
    return showProduct(arg, seq);
  }
  if (v === "search") {
    $("#q").value = params.get("q") || "";
    return showSearch(params.get("q") || "", seq);
  }
  $("#q").value = "";
  if (v === "ing" && arg) return showIngredient(arg, seq);
  if (v === "paste") return showPaste(seq);
  return showHome();
}
const live = (seq) => seq === navSeq;

// ---------------------------------------------------------------- home
const BUCKET_LABELS = {
  analyze: "label analyses",
  "kb:read": "knowledge-base reads",
  off: "product lookups via us",
};
const CURL_SAMPLE = '{"text":"Ingredients: sugar, palm oil, colour: E129, E171, citric acid","lang":"en"}';

function showHome() {
  view.innerHTML = `
  <div class="panel intro">
    <h1>What is in it, how it is made, and what deserves a second look</h1>
    <p>Look up a barcode or paste an ingredient list. Each item is matched to a sourced
    knowledge base and ranked, hazards first, then quality markers like petrochemical colours, sweeteners and
    refined oils. Every claim carries its kind (fact, estimate or opinion), an evidence grade and its sources.</p>
    <p class="small muted">Product data comes from Open Food Facts. Informational only, not medical advice.</p>
  </div>
  <div class="panel">
    <h2>Look up a product or an ingredient</h2>
    <h3>Barcodes</h3>
    <div class="examples">
      <a href="#/ean/5900617013064">5900617013064 · Sante protein bar</a>
      <a href="#/ean/5907554476143">5907554476143 · vanilla protein bar</a>
      <a href="#/ean/3017620422003">3017620422003 · Nutella</a>
      <a href="#/ean/5449000000996">5449000000996 · Coca-Cola</a>
    </div>
    <h3>Ingredients</h3>
    <div class="examples">
      <a href="#/search?q=E171">E171 titanium dioxide</a>
      <a href="#/search?q=citric%20acid">citric acid</a>
      <a href="#/search?q=xylitol">xylitol</a>
      <a href="#/search?q=E129">E129 Allura red</a>
      <a href="#/search?q=olej%20palmowy">olej palmowy</a>
      <a href="#/search?q=sucralose">sucralose</a>
      <a href="#/search?q=E471">E471</a>
    </div>
    <h3>Or</h3>
    <a class="btn ghost" href="#/paste">Paste a label you have in hand</a>
  </div>
  <div class="panel">
    <h2>Use the API</h2>
    <p class="small" style="margin-top:0">This demo answers without a key. <span id="limits"></span>
    Self-host it for API keys with quotas.</p>
    <pre class="copy">curl -s ${esc(location.origin)}/v1/analyze \\
  -H 'content-type: application/json' \\
  -d '${esc(CURL_SAMPLE)}'</pre>
    <div class="row small"><a href="/docs">API reference</a><a href="/v1/openapi.json">openapi.json</a>
      <a href="${REPO}" target="_blank" rel="noopener">Source on GitHub</a></div>
  </div>`;
  meta.then((m) => {
    const per = m.keyless?.per_minute;
    if (per && $("#limits")) {
      $("#limits").textContent = `Per IP address and minute: ${
        Object.entries(per).map(([b, n]) => `${n} ${BUCKET_LABELS[b] || b}`).join(", ")
      }.`;
    }
  }).catch(() => {});
}

// ---------------------------------------------------------------- search
async function showSearch(q, seq) {
  view.innerHTML = `
  <div class="cols">
    <div class="panel"><h2>Products <span class="muted small">· Open Food Facts</span></h2><div id="offres">${
    spinner("Searching Open Food Facts…")
  }</div></div>
    <div class="panel"><h2>Ingredients <span class="muted small">· our knowledge base</span></h2><div id="kbres">${
    spinner("Searching the knowledge base…")
  }</div></div>
  </div>`;
  loadOffPage(q, 1, seq);
  try {
    const r = await getJson(`/v1/ingredients?q=${encodeURIComponent(q)}&limit=25&lang=${lang()}`);
    if (!live(seq)) return;
    $("#kbres").innerHTML = r.items.length
      ? `
      <div class="muted small">${r.total} match${r.total === 1 ? "" : "es"} · KB ${esc(r.kb_version)}</div>
      <ul class="list">${
        r.items.map((it) => `
        <li><a class="hit" href="#/ing/${encodeURIComponent(it.id)}">
          <div class="row"><span class="t">${esc(it.name)}</span>${
          it.e_number ? `<span class="chip mono">${esc(it.e_number)}</span>` : ""
        }
            <span class="chip">${esc(it.type)}</span>${
          it.review_status === "imported" ? `<span class="chip">identity only</span>` : ""
        }</div>
          <div class="muted small">${
          it.match.matched
            ? `matched “${esc(it.match.matched)}” · ${esc(it.match.type)}`
            : "words found in its description"
        } · ${it.match.score.toFixed(2)}</div>
          ${
          it.tags.length
            ? `<div class="row" style="margin-top:4px">${
              it.tags.slice(0, 8).map((t) => `<span class="chip mono">${esc(t)}</span>`).join("")
            }${it.tags.length > 8 ? `<span class="chip">+${it.tags.length - 8}</span>` : ""}</div>`
            : ""
        }
        </a></li>`).join("")
      }</ul>`
      : `<div class="muted">No ingredient matches “${esc(q)}”.</div>`;
  } catch (e) {
    if (live(seq)) $("#kbres").innerHTML = errBox(e);
  }
}

async function loadOffPage(q, page, seq) {
  const box = $("#offres");
  try {
    const r = await getJson(`/off/search?q=${encodeURIComponent(q)}&page=${page}`);
    if (!live(seq)) return;
    const items = r.items.filter((p) => p.ean);
    const html = items.map((p) => `
      <li><a class="hit" href="#/ean/${encodeURIComponent(p.ean)}">
        <div class="t">${p.name ? esc(p.name) : `<span class="muted">(no name)</span>`}</div>
        <div class="muted small">${
      [p.brands, p.quantity].filter(Boolean).map(esc).join(" · ")
    } <span class="mono">${esc(p.ean)}</span></div>
      </a></li>`).join("");
    if (page === 1) {
      box.innerHTML = items.length
        ? `<div class="muted small">${r.count != null ? `${r.count} products` : ""}${
          r.page_count > 1 ? ` · page 1 of ${r.page_count}` : ""
        }</div><ul class="list" id="offlist">${html}</ul><div id="offmore"></div>`
        : `<div class="muted">No products match “${esc(q)}”.</div>`;
    } else {
      $("#offlist").insertAdjacentHTML("beforeend", html);
    }
    const more = $("#offmore");
    if (more) {
      more.innerHTML = page < r.page_count
        ? `<button class="ghost" style="margin-top:8px">Load more</button>`
        : "";
      more.querySelector("button")?.addEventListener("click", (ev) => {
        ev.target.disabled = true;
        ev.target.textContent = "Loading…";
        loadOffPage(q, page + 1, seq);
      });
    }
  } catch (e) {
    if (live(seq)) (page === 1 ? box : $("#offmore")).innerHTML = errBox(e);
  }
}

// ---------------------------------------------------------------- product
// Straight from Open Food Facts first: their product API allows any origin, so each visitor spends their
// own OFF allowance. Our /off proxy is the fallback (blocked request, OFF rate limit or outage).
async function fetchProduct(ean) {
  try {
    const res = await fetch(productUrl(ean), { signal: AbortSignal.timeout(8000) });
    if (res.status !== 429 && res.status < 500) {
      const product = readProductResponse(res.status, await res.json().catch(() => null));
      return product ? { found: true, product } : { found: false, ean };
    }
  } catch { /* fall back to the proxy */ }
  return await getJson(`/off/product/${encodeURIComponent(ean)}`);
}

async function showProduct(ean, seq) {
  view.innerHTML = spinner(`Fetching ${ean} from Open Food Facts…`);
  let r;
  try {
    r = await fetchProduct(ean);
  } catch (e) {
    if (live(seq)) view.innerHTML = errBox(e);
    return;
  }
  if (!live(seq)) return;
  if (!r.found) {
    view.innerHTML = `<div class="panel"><h2>${esc(ean)} is not on Open Food Facts</h2>
      <p class="muted">Paste the ingredient list from the pack instead.</p><a class="btn" href="#/paste">Paste a label</a></div>`;
    return;
  }
  const p = r.product;
  const offTags = (xs) =>
    xs.map((t) => `<span class="chip mono">${esc(t.replace(/^[a-z]{2}:/, ""))}</span>`).join(" ") ||
    `<span class="muted">none listed</span>`;
  view.innerHTML = `
  <div class="panel product">
    ${
    p.image && p.image.startsWith("https://images.openfoodfacts.org/")
      ? `<img src="${esc(p.image)}" alt="">`
      : `<div class="noimg"></div>`
  }
    <div>
      <h1>${esc(p.name || "(no name)")}</h1>
      <div class="muted">${[p.brands, p.quantity].filter(Boolean).map(esc).join(" · ")}</div>
      <div class="row small" style="margin-top:6px"><span class="mono">${esc(p.ean)}</span>
        <a href="${esc(p.off_url)}" target="_blank" rel="noopener">Open Food Facts page ↗</a></div>
      <details style="margin-top:8px"><summary class="small muted">What Open Food Facts says (for comparison)</summary>
        <dl class="kv" style="margin-top:6px">
          <dt>Nutri-Score</dt><dd>${esc((p.nutriscore || "—").toUpperCase())}</dd>
          <dt>NOVA</dt><dd>${esc(p.nova ?? "—")}</dd>
          <dt>Sugars</dt><dd>${
    p.nutrition
      ? `${esc(p.nutrition.sugars_g)} g / ${esc(p.nutrition.basis.slice(3))} (sent with the analysis)`
      : "—"
  }</dd>
          <dt>Allergens</dt><dd>${offTags(p.off_allergens)}</dd>
          <dt>Traces</dt><dd>${offTags(p.off_traces)}</dd>
          <dt>Additives</dt><dd>${offTags(p.off_additives)}</dd>
          ${p.categories ? `<dt>Categories</dt><dd>${esc(p.categories)}</dd>` : ""}
        </dl></details>
    </div>
  </div>
  <div class="panel">
    <h2>Ingredient list</h2>
    <div id="textpick"></div>
    <textarea id="text" spellcheck="false" aria-label="Ingredient list"></textarea>
    <div class="row" style="margin-top:8px"><button id="go">Analyse</button>
      <span class="muted small">Edit the text first if Open Food Facts has it wrong. The list is analysed, not stored.</span></div>
    ${profileControls()}
  </div>
  <div id="result"></div>`;
  const ta = $("#text");
  if (!p.texts.length) {
    $("#textpick").innerHTML =
      `<div class="warnline">Open Food Facts has no ingredient list for this product. Type it from the pack${
        p.ingredients_image ? " or from the photo below" : ""
      }.</div>
      ${
        p.ingredients_image?.startsWith("https://images.openfoodfacts.org/")
          ? `<p><img src="${
            esc(p.ingredients_image)
          }" alt="Ingredients photo" style="max-width:100%;border-radius:8px"></p>`
          : ""
      }`;
  } else {
    const pick = (i) => {
      const t = p.texts[i];
      ta.value = t.text;
      for (const b of document.querySelectorAll("#textpick button")) {
        b.classList.toggle("ghost", Number(b.dataset.i) !== i);
      }
      $("#textpick .warnline")?.remove();
      if (!t.supported) {
        $("#textpick").insertAdjacentHTML(
          "beforeend",
          `<div class="warnline" style="margin-bottom:8px">This text is in “${
            esc(t.lang)
          }”. The analyser reads Polish, English and German; expect many unmatched items.</div>`,
        );
      }
    };
    $("#textpick").innerHTML = `<div class="langs">${
      p.texts.map((t, i) =>
        `<button class="ghost" data-i="${i}">${esc(t.lang.toUpperCase())}${
          t.supported ? "" : " (unsupported)"
        }</button>`
      ).join("")
    }</div>`;
    for (const b of document.querySelectorAll("#textpick button")) {
      b.addEventListener("click", () => {
        pick(Number(b.dataset.i));
        analyseInto($("#result"), ta.value, seq, p.nutrition);
      });
    }
    pick(0);
    analyseInto($("#result"), ta.value, seq, p.nutrition);
  }
  $("#go").addEventListener("click", () => analyseInto($("#result"), ta.value, seq, p.nutrition));
  onProfileChange(() => analyseInto($("#result"), ta.value, seq, p.nutrition));
}

// ---------------------------------------------------------------- paste
const SAMPLE =
  "Skład: koncentrat białek serwatkowych (z MLEKA) 80%, kakao o obniżonym udziale tłuszczu 8%, olej MCT (z kokosa), emulgator: lecytyny (z soi), kwas jabłkowy, aromat, substancja słodząca: sukraloza. Może zawierać JAJA i GLUTEN.";
function showPaste(seq) {
  view.innerHTML = `
  <div class="panel">
    <h2>Paste an ingredient list</h2>
    <textarea id="text" spellcheck="false" aria-label="Ingredient list"></textarea>
    <div class="row" style="margin-top:8px"><button id="go">Analyse</button>
      <button class="ghost" id="sample">Use the sample</button>
      <span class="muted small">Polish, English or German. Headers like “Skład:” and “Może zawierać…” are understood.</span></div>
    <div class="row small" style="margin-top:8px"><label>Sugars from the nutrition table (optional)
      <input id="sugars" type="number" min="0" max="100" step="0.1" inputmode="decimal" style="width:6em"></label>
      <label>carbohydrate <input id="carbs" type="number" min="0" max="100" step="0.1" inputmode="decimal" style="width:6em"></label>
      <select id="basis" aria-label="Per"><option value="100g">g per 100 g</option><option value="100ml">g per 100 ml (drink)</option></select>
      <label>serving <input id="serving" type="number" min="1" max="5000" step="1" inputmode="numeric" style="width:5em"></label></div>
    ${profileControls()}
  </div>
  <div id="result"></div>`;
  const ta = $("#text");
  ta.value = store.get("nsi.paste", SAMPLE);
  const run = () => {
    store.set("nsi.paste", ta.value);
    const num = (id) => ($(id).value === "" ? NaN : Number($(id).value));
    const sugars = num("#sugars"), carbs = num("#carbs"), serving = num("#serving");
    const basis = $("#basis").value;
    const nutrition = sugars >= 0 && sugars <= 100
      ? {
        basis,
        sugars_g: sugars,
        ...(carbs >= sugars && carbs <= 100 ? { carbohydrate_g: carbs } : {}),
        ...(serving > 0 && serving <= 5000 ? { serving: { amount: serving, unit: basis.slice(3) } } : {}),
      }
      : undefined;
    analyseInto($("#result"), ta.value, seq, nutrition);
  };
  $("#go").addEventListener("click", run);
  onProfileChange(() => $("#result").innerHTML && run());
  $("#sample").addEventListener("click", () => {
    ta.value = SAMPLE;
  });
}

// ---------------------------------------------------------------- analysis
async function analyseInto(box, text, seq, nutrition) {
  if (!text.trim()) {
    box.innerHTML = errBox("The ingredient list is empty.");
    return;
  }
  box.innerHTML = spinner("Analysing…");
  const p = readProfile();
  const profile = p.allergens || p.diets.length
    ? { ...(p.allergens ? { avoid: ["allergen.*"] } : {}), ...(p.diets.length ? { diets: p.diets } : {}) }
    : undefined;
  try {
    const a = await getJson("/v1/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: text.slice(0, 12000),
        lang: lang(),
        profile,
        nutrition: nutrition ?? undefined,
      }),
    });
    if (live(seq)) box.innerHTML = renderAnalysis(a);
  } catch (e) {
    if (live(seq)) box.innerHTML = errBox(e);
  }
}

function walk(items, fn) {
  for (const it of items) {
    fn(it);
    walk(it.children || [], fn);
  }
}

function sourceLinks(refs, sources) {
  return refs.map((r) => {
    const s = sources[r.id];
    if (!s) return `<span class="mono">${esc(r.id)}</span>`;
    const short = s.publisher
      ? `${s.publisher}${s.year ? ` ${s.year}` : ""}`
      : s.title.length > 48
      ? `${s.title.slice(0, 46)}…`
      : s.title;
    return `<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener" title="${esc(s.title)}${
      r.locator ? ` — ${esc(r.locator)}` : ""
    }">${esc(short)}</a>`;
  }).join(", ");
}

/** The glycemic-load estimate as a summary stat: always labelled an estimate. */
function glStat(gl) {
  if (!gl) return "";
  if (gl.status === "unknown") {
    const why = gl.reason === "low_coverage"
      ? `only ${pct(gl.coverage)} of the carbohydrate has a GI source`
      : "total carbohydrate needs fibre to subtract";
    return `<div class="stat"><b>GL unknown</b><span>${esc(why)}</span></div>`;
  }
  const [lo, hi] = gl.range;
  const band = gl.band ? (gl.band[0] === gl.band[1] ? gl.band[0] : gl.band.join("–")) : "";
  return `<div class="stat"><b class="${
    gl.band?.[0] === "high" ? "s-notice" : ""
  }" style="background:none">GL ${esc(lo === hi ? lo : `${lo}–${hi}`)}</b><span>per ${
    esc(gl.per === "serving" ? "serving" : gl.per.replace("100", "100 "))
  }${band ? ` · ${esc(band)}` : ""} · estimate, not a measured GI${
    gl.coverage < 1 ? ` · ${pct(gl.coverage)} covered` : ""
  }</span></div>`;
}

function renderAnalysis(a) {
  const names = new Map();
  const labelText = new Map(); // path → the words on the label
  walk(a.items, (it) => {
    if (it.match) names.set(it.match.ingredient_id, it.match.name);
    labelText.set(it.path, it.name);
  });
  const why = (b) => names.get(b.ingredient_id) || `“${labelText.get(b.path) || b.path}”`;
  const s = a.summary;
  const counts = SEVERITIES.filter((k) => s[k]).map((k) =>
    `<span class="chip s-${k}">${s[k]} ${k}${s[k] > 1 ? "s" : ""}</span>`
  ).join(" ");
  const flags = [...a.flags].sort((x, y) => SEVERITIES.indexOf(x.severity) - SEVERITIES.indexOf(y.severity));

  // A may-contain clause is not a label item, so it never ranks; the profile reports it as a trace hit.
  const traces = (a.profile?.hits ?? []).filter((h) => h.trace).map((h) =>
    a.may_contain.find((m) => m.allergens.includes(h.code))?.text ?? h.code
  );
  const forYou = traces.length
    ? `<div class="warnline" style="margin-bottom:8px">For you: the label says it may contain ${
      [...new Set(traces)].map(esc).join(", ")
    } (cross-contamination warning).</div>`
    : "";

  const RANK_SHOWN = 8;
  const rankHtml = a.ranking.slice(0, RANK_SHOWN).map((r) => `
    <li class="rank" style="border-color:var(--${r.level})">
      <div class="row"><span class="chip s-${r.level}">${esc(r.level)}</span>${
    r.ingredient_id
      ? `<a href="#/ing/${encodeURIComponent(r.ingredient_id)}"><b>${
        esc(names.get(r.ingredient_id) || r.name)
      }</b></a>`
      : `<b>${esc(r.name)}</b>`
  }<span class="muted small">on the label: “${esc(r.name)}”</span>${
    r.personal ? `<span class="chip" title="Ranks here because of your profile">for you</span>` : ""
  }</div>
      <ul class="reasons">${
    r.reasons.map((x) =>
      `<li><span class="dot" style="color:var(--${x.severity})"></span>${esc(x.label)}<span class="muted">${
        [x.concern, x.certainty !== "yes" ? x.certainty : "", x.grade ? `grade ${x.grade}` : ""].filter(
          Boolean,
        )
          .map(esc).join(" · ")
      }</span></li>`
    ).join("")
  }</ul>
    </li>`).join("");

  const flagHtml = flags.map((f) => `
    <details class="flag" ${f.severity === "warning" || f.severity === "caution" ? "open" : ""}>
      <summary><span class="dot s-${f.severity}" style="background:var(--${f.severity})"></span><span class="lbl">${
    esc(f.label)
  }</span>
        <span class="chip mono">${esc(f.code)}</span><span class="chip d-${f.certainty}">${
    esc(f.certainty)
  }</span>
        <span class="chip">${esc(f.kind)}</span><span class="chip" title="Evidence grade">grade ${
    esc(f.grade)
  }</span></summary>
      <ul>${
    f.triggers.map((t) => `
        <li>${
      t.ingredient_id
        ? `<a href="#/ing/${encodeURIComponent(t.ingredient_id)}"><b>${
          esc(names.get(t.ingredient_id) || t.ingredient_id)
        }</b></a>`
        : "<b>Nutrition table</b>"
    }
          <span class="muted">via ${esc(BASIS[t.basis] || t.basis)}${
      t.variant_id ? ` (${esc(t.variant_id)})` : ""
    }${t.probability != null ? `, p ≈ ${pct(t.probability)}` : ""}${
      t.certainty !== f.certainty ? `, ${esc(t.certainty)}` : ""
    }</span>
          ${t.population?.length ? `<span class="chip">${t.population.map(esc).join(", ")}</span>` : ""}
          <div>${esc(t.note)}${
      t.sources.length ? ` <span class="muted small">— ${sourceLinks(t.sources, a.sources)}</span>` : ""
    }</div></li>`).join("")
  }</ul>
    </details>`).join("");

  const item = (it) => {
    const m = it.match;
    const conf = m && m.confidence < 0.9
      ? `<span class="chip d-maybe" title="Match confidence">${esc(m.match_type)} ${
        m.confidence.toFixed(2)
      }</span>`
      : m && m.match_type !== "exact"
      ? `<span class="chip">${esc(m.match_type)}</span>`
      : "";
    let variant = "";
    if (it.variant) {
      if (it.variant.basis === "label") {
        const ids = it.variant.candidates?.length > 1
          ? it.variant.candidates.map((c) => c.id).join(" + ")
          : it.variant.name || it.variant.id;
        variant = `<span class="chip d-yes" title="Named on the label">variant: ${esc(ids)}</span>`;
      } else if (it.variant.candidates?.length) {
        const top = [...it.variant.candidates].sort((x, y) => y.probability - x.probability);
        variant = `<span class="chip d-maybe" title="${
          esc(top.map((c) => `${c.id} ${pct(c.probability)}`).join(", "))
        }">likely ${esc(top[0].id)} ${pct(top[0].probability)} (estimate)</span>`;
      }
    }
    const pctTxt = it.percent ? `<span class="chip">${esc(it.percent.raw)}</span>` : "";
    const role = it.role !== "ingredient"
      ? `<span class="chip">${esc(it.role === "class" ? "class" : it.role)}</span>`
      : "";
    const fn = it.function ? `<span class="chip">${esc(it.function.name)}</span>` : "";
    const target = m
      ? `<span class="arrow">→</span><a href="#/ing/${encodeURIComponent(m.ingredient_id)}">${
        esc(m.name)
      }</a>${m.e_number ? `<span class="chip mono">${esc(m.e_number)}</span>` : ""}${
        m.review_status === "imported"
          ? `<span class="chip" title="Identity data only, no curated claims">identity only</span>`
          : ""
      }`
      : it.role !== "ingredient"
      ? ""
      : it.children?.some((c) => c.role === "ingredient")
      ? `<span class="unmatched">compound: read through its parts</span>`
      : `<span class="unmatched">not in the KB</span>`;
    const kids = it.children?.length ? `<ol>${it.children.map(item).join("")}</ol>` : "";
    return `<li><div class="it"><span class="src">${
      esc(it.name)
    }</span>${pctTxt}${role}${fn}${target}${conf}${variant}${
      it.emphasized?.length
        ? `<span class="chip s-caution" title="Emphasised on the label">${
          it.emphasized.map(esc).join(", ")
        }</span>`
        : ""
    }</div>${kids}</li>`;
  };

  return `
  <div class="panel">
    <div class="summary">
      <div class="stat"><b class="${s.danger ? `s-${s.danger}` : ""}" style="background:none">${
    esc(s.danger || "none found")
  }</b><span>top hazard${
    s.highest && s.highest !== s.danger ? ` · any flag up to ${esc(s.highest)}` : ""
  }</span></div>
      <div class="stat"><b>${a.coverage.matched} / ${a.coverage.ingredients}</b><span>recognised (${
    pct(a.coverage.ratio)
  })${a.coverage.low_confidence ? ` · ${a.coverage.low_confidence} low-confidence` : ""}</span></div>
      <div class="stat"><b>${a.flags.length}</b><span>flags</span></div>${
    a.nutrition
      ? `<div class="stat"><b class="${
        a.nutrition.sugars.band === "high" ? "s-caution" : ""
      }" style="background:none">${esc(a.nutrition.sugars.band)} sugars</b><span>${
        esc(a.nutrition.sugars.per_100)
      } g / 100 ${esc(a.nutrition.basis.slice(3))} · ${
        esc(a.nutrition.sugars.ri_percent_per_100)
      }% of RI · UK front-of-pack bands</span></div>`
      : ""
  }${glStat(a.nutrition?.glycemic_load)}
      <div class="row">${counts}</div>
    </div>
    ${
    a.ai_generated_content
      ? `<p class="small muted" style="margin:10px 0 0">Some matched entries are AI-drafted and not yet reviewed by a specialist.</p>`
      : ""
  }
    <h3>Look at these first</h3>
    ${forYou}
    ${
    rankHtml
      ? `<ol class="ranking">${rankHtml}</ol>${
        a.ranking.length > RANK_SHOWN
          ? `<p class="small muted">${a.ranking.length - RANK_SHOWN} more below, under Flags.</p>`
          : ""
      }`
      : `<div class="muted">Nothing recognised on this label ranks as a hazard or a quality concern.</div>`
  }
    <h3>Diets</h3>
    <div class="diets">${
    Object.entries(DIETS).map(([k, label]) => {
      const d = a.diets[k];
      const reasons = d.because.slice(0, 4).map((b) => `${why(b)}: ${b.status}`).join(", ");
      return `<div class="diet d-${d.status}" title="${
        esc(d.because.map((b) => `${why(b)} (item ${b.path}): ${b.status}`).join("\n"))
      }"><b>${label}</b><span>${esc(d.status)}${reasons ? ` — ${esc(reasons)}` : ""}</span></div>`;
    }).join("")
  }</div>
    <h3>Flags</h3>
    ${flagHtml || `<div class="muted">No flags.</div>`}
    ${
    a.may_contain.length
      ? `<h3>May contain</h3><div class="row">${
        a.may_contain.map((m) =>
          `<span class="chip s-caution">${
            m.ingredient_id
              ? `<a href="#/ing/${encodeURIComponent(m.ingredient_id)}" style="color:inherit">${
                esc(m.text)
              }</a>`
              : esc(m.text)
          }${m.allergens.length ? ` · ${m.allergens.map(esc).join(", ")}` : ""}</span>`
        ).join("")
      }</div>`
      : ""
  }
    ${
    a.label_statements.length
      ? `<h3>Label statements</h3><div class="row">${
        a.label_statements.map((x) => `<span class="chip">${esc(x)}</span>`).join("")
      }</div>`
      : ""
  }
  </div>
  <div class="panel">
    <h2>How the list was read</h2>
    <ol class="tree">${a.items.map(item).join("")}</ol>
    ${
    a.unanalysed_text ? `<h3>Not analysed</h3><div class="muted small">${esc(a.unanalysed_text)}</div>` : ""
  }
    <p class="foot">${esc(a.disclaimer)} · KB ${esc(a.kb_version)}</p>
    <details><summary class="small muted">Raw API response</summary><pre>${
    esc(JSON.stringify(a, null, 2))
  }</pre></details>
  </div>`;
}

// ---------------------------------------------------------------- ingredient
async function showIngredient(id, seq) {
  view.innerHTML = spinner("Loading ingredient…");
  let d;
  try {
    d = await getJson(`/v1/ingredients/${encodeURIComponent(id)}?lang=${lang()}`);
  } catch (e) {
    if (live(seq)) view.innerHTML = errBox(e);
    return;
  }
  if (!live(seq)) return;
  const groups = new Map();
  for (const a of d.assertions) {
    if (!groups.has(a.group)) groups.set(a.group, []);
    groups.get(a.group).push(a);
  }
  const srcList = Object.entries(d.sources);
  view.innerHTML = `
  <div class="panel">
    <div class="row"><h2 style="margin:0;font-size:20px">${esc(d.name)}</h2>${
    d.e_number ? `<span class="chip mono">${esc(d.e_number)}</span>` : ""
  }
      <span class="chip">${esc(d.type)}</span><span class="chip">${
    esc(d.review_status)
  }</span><span class="chip">${esc(d.provenance)}</span></div>
    ${
    d.summary ? `<p>${esc(d.summary)}</p>` : `<p class="muted">No curated summary — identity data only.</p>`
  }
    <dl class="kv">
      <dt>Id</dt><dd class="mono">${esc(d.id)}</dd>
      ${
    d.functions.length ? `<dt>Functions</dt><dd>${d.functions.map((f) => esc(f.name)).join(", ")}</dd>` : ""
  }
      ${
    Object.entries(d.names).map(([l, ns]) => `<dt>Names (${esc(l)})</dt><dd>${ns.map(esc).join(" · ")}</dd>`)
      .join("")
  }
      ${
    d.ids
      ? Object.entries(d.ids).map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`).join("")
      : ""
  }
    </dl>
  </div>
  ${
    d.variants.length
      ? `<div class="panel"><h2>Production variants</h2>${
        d.variants.map((v) => `
    <div style="margin-bottom:12px">
      <div class="row"><b>${esc(v.name || v.id)}</b><span class="chip mono">${esc(v.id)}</span>${
          v.prior != null ? `<span class="chip d-maybe">market prior ${pct(v.prior)}</span>` : ""
        }</div>
      <div class="small">${esc(v.process)}</div>
      ${v.prior_rationale ? `<div class="small muted">Prior: ${esc(v.prior_rationale)}</div>` : ""}
      ${
          v.residues.length
            ? `<div class="small muted">Possible residues: ${
              v.residues.map((r) => `${esc(r.substance)}${r.limit ? ` (limit ${esc(r.limit)})` : ""}`).join(
                ", ",
              )
            }</div>`
            : ""
        }
    </div>`).join("")
      }</div>`
      : ""
  }
  ${
    d.assertions.length
      ? `<div class="panel"><h2>What it implies</h2>${
        [...groups].map(([g, as]) => `
    <h3>${esc(g)}</h3>
    <div class="tablewrap"><table><thead><tr><th>Implication</th><th>Answer</th><th>Basis</th><th>Note</th><th>Sources</th></tr></thead><tbody>
    ${
          as.map((a) =>
            `<tr>
      <td><span class="dot" style="display:inline-block;color:var(--${a.severity})"></span> ${
              esc(a.label)
            }<div class="mono muted">${esc(a.code)}</div></td>
      <td><span class="chip d-${a.certainty}">${esc(a.certainty)}</span>${
              a.variant ? `<div class="small muted">variant ${esc(a.variant)}</div>` : ""
            }${
              a.population?.length ? `<div class="small muted">${a.population.map(esc).join(", ")}</div>` : ""
            }</td>
      <td class="small">${esc(a.kind)} · grade ${esc(a.grade)}${
              a.jurisdiction ? `<div class="muted">${esc(a.jurisdiction)}</div>` : ""
            }${a.dose ? `<div class="muted">${esc(a.dose)}</div>` : ""}</td>
      <td class="small">${esc(a.note)}</td>
      <td class="small">${sourceLinks(a.sources, d.sources)}</td></tr>`
          ).join("")
        }
    </tbody></table></div>`).join("")
      }</div>`
      : ""
  }
  ${
    d.regulatory.length || d.reference_values.length
      ? `<div class="panel"><h2>Regulatory status and reference values</h2>
    ${
        d.regulatory.map((r) =>
          `<div class="small" style="margin-bottom:6px"><b>${esc(r.jurisdiction)}</b> — ${esc(r.status)}${
            r.conditions ? `; ${esc(r.conditions)}` : ""
          }${r.since ? ` (since ${esc(r.since)})` : ""} <span class="muted">— ${
            sourceLinks([{ id: r.source }], d.sources)
          }</span></div>`
        ).join("")
      }
    ${
        d.reference_values.map((r) =>
          `<div class="small" style="margin-bottom:6px"><b>${esc(r.type)}</b> ${esc(r.value)}${
            r.unit ? ` ${esc(r.unit)}` : ""
          } — ${esc(r.body)}${r.year ? ` ${r.year}` : ""} <span class="muted">— ${
            sourceLinks([{ id: r.source }], d.sources)
          }</span></div>`
        ).join("")
      }
  </div>`
      : ""
  }
  ${
    d.review_notes.length
      ? `<div class="panel"><h2>Open review notes</h2><ul class="small">${
        d.review_notes.map((n) => `<li>${esc(n)}</li>`).join("")
      }</ul></div>`
      : ""
  }
  ${
    srcList.length
      ? `<div class="panel"><h2>Sources</h2><ol class="small">${
        srcList.map(([sid, s]) =>
          `<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.title)}</a>${
            s.publisher ? ` — ${esc(s.publisher)}` : ""
          }${s.year ? `, ${s.year}` : ""} <span class="mono muted">${esc(sid)}</span></li>`
        ).join("")
      }</ol></div>`
      : ""
  }
  <details class="panel"><summary class="small muted">Raw API response</summary><pre>${
    esc(JSON.stringify(d, null, 2))
  }</pre></details>`;
}

// ---------------------------------------------------------------- boot
meta.then((m) => {
  $("#kbv").textContent = `KB ${m.kb_version} · ${m.counts.ingredients} ingredients`;
}).catch(() => {
  $("#kbv").textContent = "API unreachable";
});
route();
