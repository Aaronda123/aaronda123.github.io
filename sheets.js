// ==============================================================================================================
// CONTRACT – sheets.js (owner: builder CORE). Spec: ARCHITECTURE.md §3.2.8, §3.5.4, §5.4-§5.6, §8.4, CHANGES-1 CR2/CR3.
// Logic of the three full-screen sheets whose static DOM lives in index.html (VISUAL):
//   "setup" (#sheet-setup, Einstellungen: fill/read/validate/save, Stimme testen, Gehirn testen, Setup-/Kurzbefehl-Link),
//   "help"  (#sheet-help, „Hey Jarvis“ einrichten: #help-url, #help-standalone, device switch preselected from the UA),
//   "data"  (#sheet-data, Gemerkt / Kurzbefehle / Termine / Konto / Gespräch / Verbrauch lists, delete, import),
//   "import" (#sheet-import, „Einstellungen übernehmen?“ for a #cfg= Setup-Link: what would change, accept/decline;
//            open("import", { payload, source: "link"|"code" }) – nothing is applied before „Übernehmen“, sec-priv-1).
// The setup sheet saves unsaved changes when it is closed (✕, Esc, Back, another sheet) and a successful „Testen“
// stores the tested key at once (visual-ux-2). Setup-Links never carry keys (browser history); the keys move with the
// Setup-Code (copy here, paste on the other device → the same „Einstellungen übernehmen?“ sheet, sec-priv-1/-3).
// v4: "welcome" (#sheet-welcome, „Jarvis einrichten“): six steps (Mikrofon, Bildschirm wach, Stimme, Gehirn, Google,
//     Fertig), one per screen, each skippable; every step button calls cb.onCommand("wz_mic" | "wz_awake" | "wz_voice" |
//     "google_connect" | "brain_test") SYNCHRONOUSLY inside the tap (iOS grants mic/audio/wake lock/popup only there)
//     and shows the returned { ok, text }. „Los geht's“ → onCommand("wz_finish", { background }); ✕/Esc/Back →
//     onCommand("wz_closed"). From the wizard into the settings (Gehirn/Google) and back without losing the step.
//     Settings section „Google verbinden“ (#sec-google): Client-ID field, Verbinden / Gmail erlauben / Trennen
//     (onCommand "google_connect" { mail } / "google_disconnect" / "google_preload"), status from cb.status().google,
//     the page origin for the OAuth client (#google-origin).
// export function init(cb)        cb: { onSave(patch) → Promise, onCommand(cmd, detail) → any, onOpenChange(name|null),
//                                       status() → { keyState, voiceState, micState, wakeState, standalone }, toast(text) }
//                                 onCommand: "voice_test" {draft} · "history_clear" {} · "log_clear" {} ·
//                                            "brain_test" {draft} → Promise<{ ok: boolean, text: string }> ·
//                                            "import_done" { accepted }
// export function open(name, { section, payload }?)   "setup"|"help"|"data"|"import"; section → #sec-<section>
// export function close(name?)                undefined = all
// export function isOpen(name?): boolean      undefined = any
// export function refresh(): void             re-fill status chips and data lists
// Imports: store.js, intents.js. Renders user data with textContent only (never innerHTML).
// ==============================================================================================================
// Die drei Blätter: Einstellungen, „Hey Jarvis“ einrichten, Daten. Alles, was nur den Speicher betrifft, erledigt
// sheets.js selbst über store.js; was andere Module braucht (Stimme testen, Gespräch löschen, Gehirn testen),
// geht über die Rückrufe an app.js.
import * as store from "./store.js";
import { line } from "./intents.js";

const SHEET_IDS = Object.freeze({ setup: "sheet-setup", help: "sheet-help", data: "sheet-data", import: "sheet-import",
  welcome: "sheet-welcome" });
const NAMES = Object.keys(SHEET_IDS);
const CLAUDE_KEY_RX = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const GEMINI_KEY_RX = /^[A-Za-z0-9_-]{30,}$/;
const PROVIDERS = new Set(["auto", "claude", "gemini"]);
const GOOGLE_RX = /^[0-9]{5,}-[a-z0-9]{8,}\.apps\.googleusercontent\.com$/;
const WZ_STEPS = Object.freeze(["mic", "awake", "voice", "brain", "google", "done"]);
const FREE_PRESET = "geraet";

// Einstellung → Feld (§3.3, §5.5); type: text | key | int | float | check | select
const FIELDS = Object.freeze([
  ["anrede", "f-anrede", "text"], ["vorname", "f-vorname", "text"], ["firma", "f-firma", "text"],
  ["wohnort", "f-wohnort", "text"], ["gedaechtnis", "f-gedaechtnis", "text"],
  ["anthropicKey", "f-anthropic", "key"], ["azureKey", "f-azure", "key"], ["azureRegion", "f-region", "select"],
  ["voicePreset", "f-preset", "select"], ["voiceSpeed", "f-voice-speed", "int"],
  ["wakeWord", "f-wake", "check"], ["startInBackground", "f-background", "check"],
  ["listenOnOpen", "f-listen-open", "check"], ["greeting", "f-greeting", "check"],
  ["keepAwake", "f-keepawake", "check"], ["theme", "f-theme", "select"], ["autoHideMinutes", "f-autohide", "int"],
  ["silenceSeconds", "f-silence", "float"], ["unsureSeconds", "f-unsure", "float"], ["hesitationSeconds", "f-hesitation", "float"],
  ["maxRecordSeconds", "f-maxrecord", "int"], ["speakMaxSentences", "f-sentences", "int"],
  ["imageSeconds", "f-imageseconds", "int"],
  // Mitdenken und Plaudern (Mac 13.10. abends)
  ["proactiveOffers", "f-offers", "check"], ["followUpAfterOffer", "f-fu-offer", "check"],
  ["followUpAfterQuestion", "f-fu-question", "check"], ["followUpSmalltalk", "f-fu-chat", "check"],
  ["smalltalkFollowSeconds", "f-chat-seconds", "int"],
  // Google Kalender + Gmail (v4)
  ["googleClientId", "f-google-client", "key"],
]);

let cb = {};
let inited = false;
let current = null;            // offenes Blatt
let filledClosing = "";        // Abschlussfrage, wie sie beim Füllen im Feld stand (Standard = null bleibt null)
let filledClosingWasDefault = false;
let saving = false;
let testing = false;
let setupSnapshot = "";        // Formular beim Öffnen (ungespeicherte Änderungen erkennen)
let importPayload = null;      // Setup-Link / Setup-Code, der auf „Übernehmen“ wartet
let importSource = "link";     // "link" (#cfg= beim Öffnen) | "code" (eingefügter Setup-Code)
let wzStep = 0;                // „Jarvis einrichten“: aktueller Schritt
const wzOk = new Set();        // Schritte, deren Knopf geklappt hat
let wzReturn = false;          // aus dem Assistenten in die Einstellungen: beim Schließen zurück zum Assistenten
let wzEnding = false;          // „Los geht's“ schließt das Blatt (kein „übersprungen“)

const $ = (id) => (typeof document !== "undefined" ? document.getElementById(id) : null);

function call(name, ...args) {
  const fn = cb && cb[name];
  if (typeof fn !== "function") return undefined;
  try {
    return fn(...args);
  } catch (e) {
    console.error(`sheets: ${name}`, e);
    return undefined;
  }
}

function toast(text) {
  if (text) call("toast", String(text));
}

function settingsNow() {
  try { return store.settings() || {}; } catch { return {}; }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function isIOS() {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent || "")
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  try { if (navigator.standalone === true) return true; } catch { /* ignore */ }
  try { return !!window.matchMedia?.("(display-mode: standalone)").matches; } catch { return false; }
}

function device() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  if (isIOS()) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

// ---------------------------------------------------------------- Gehirn-Felder (CR2; Ids von VISUAL)
function geminiField() {
  const form = $("setup-form");
  if (!form) return null;
  return $("f-gemini") || $("f-gemini-key") || form.querySelector('input[id*="gemini" i]');
}

function providerControls() {
  const form = $("setup-form");
  if (!form) return { radios: [], select: null };
  const radios = [...form.querySelectorAll('input[type="radio"]')].filter((r) => PROVIDERS.has(r.value));
  const select = $("f-provider") || $("f-brain") || $("f-brain-provider")
    || [...form.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "gemini"));
  return { radios, select: select || null };
}

function readProvider() {
  const { radios, select } = providerControls();
  const on = radios.find((r) => r.checked);
  if (on) return on.value;
  if (select && PROVIDERS.has(select.value)) return select.value;
  return null;
}

function writeProvider(value) {
  const v = PROVIDERS.has(value) ? value : "auto";
  const { radios, select } = providerControls();
  for (const r of radios) r.checked = r.value === v;
  if (select) select.value = v;
}

/** Format-Prüfung der Schlüssel im Formular: "FEHLT" | "GESPEICHERT" | "UNGÜLTIG" (§5.5, CR2). */
function keyStateFromForm() {
  const claude = String($("f-anthropic")?.value ?? settingsNow().anthropicKey ?? "").trim();
  const gf = geminiField();
  const gemini = String(gf ? gf.value : settingsNow().geminiKey ?? "").trim();
  if ((claude && !CLAUDE_KEY_RX.test(claude)) || (gemini && !GEMINI_KEY_RX.test(gemini))) return "UNGÜLTIG";
  const provider = readProvider() || settingsNow().brainProvider || "auto";
  if (provider === "claude") return claude ? "GESPEICHERT" : "FEHLT";
  if (provider === "gemini") return gemini ? "GESPEICHERT" : "FEHLT";
  return claude || gemini ? "GESPEICHERT" : "FEHLT";
}

// ---------------------------------------------------------------- Stimme (CR1.2)
function updatePresetOptions() {
  const sel = $("f-preset");
  if (!sel) return;
  const opts = [...sel.options];
  if (!opts.some((o) => o.value === FREE_PRESET)) return;      // ohne Gratis-Stimme gibt es nichts zu sperren
  const azure = !!String($("f-azure")?.value ?? "").trim();
  for (const o of opts) o.disabled = !azure && o.value !== FREE_PRESET;
  if (!azure && sel.value !== FREE_PRESET) sel.value = FREE_PRESET;
}

function draftVoice() {
  const s = settingsNow();
  const speed = parseNum($("f-voice-speed")?.value, true);
  return {
    voicePreset: $("f-preset")?.value || s.voicePreset,
    voiceSpeed: speed == null ? s.voiceSpeed : speed,
    azureKey: String($("f-azure")?.value ?? s.azureKey ?? "").trim(),
    azureRegion: $("f-region")?.value || s.azureRegion,
  };
}

function draftBrain() {
  const s = settingsNow();
  const gf = geminiField();
  return {
    brainProvider: readProvider() || s.brainProvider || "auto",
    anthropicKey: String($("f-anthropic")?.value ?? s.anthropicKey ?? "").trim(),
    geminiKey: String(gf ? gf.value : s.geminiKey ?? "").trim(),
  };
}

// ---------------------------------------------------------------- Formular füllen / lesen
function parseNum(v, int = false) {
  const t = String(v ?? "").trim().replace(",", ".").replace(/%$/, "");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return int ? Math.round(n) : n;
}

function fillSetup() {
  const s = settingsNow();
  for (const [key, id, type] of FIELDS) {
    const f = $(id);
    if (!f) continue;
    const v = s[key];
    if (type === "check") f.checked = !!v;
    else if (type === "select") {
      if (v != null && [...f.options].some((o) => o.value === String(v))) f.value = String(v);
    } else f.value = v == null ? "" : String(v);
  }
  // Abschlussfrage: Standard (null) zeigt den Satz mit der aktuellen Anrede
  const closing = $("f-closing");
  if (closing) {
    filledClosingWasDefault = s.closingPhrase === null || s.closingPhrase === undefined;
    try { filledClosing = store.closingPhrase(); } catch { filledClosing = ""; }
    closing.value = filledClosing;
  }
  const gf = geminiField();
  if (gf) gf.value = String(s.geminiKey ?? "");
  writeProvider(s.brainProvider || "auto");
  // Ältere Stände mit Butler, aber ohne Azure-Schlüssel: Gerätestimme (CR1.2)
  const sel = $("f-preset");
  if (sel && !String(s.azureKey ?? "").trim() && [...sel.options].some((o) => o.value === FREE_PRESET)) sel.value = FREE_PRESET;
  updatePresetOptions();
  fillStatus();
  setupSnapshot = JSON.stringify(readSetup());
  if (GOOGLE_RX.test(String(s.googleClientId || ""))) call("onCommand", "google_preload", {});
}

function setupDirty() {
  return isOpen("setup") && !!setupSnapshot && JSON.stringify(readSetup()) !== setupSnapshot;
}

// ✕, Esc, Zurück oder ein anderes Blatt: Eingetragenes nicht still wegwerfen, sondern speichern (visual-ux-2).
// Ein Schlüssel, der nicht richtig aussieht, bleibt dabei weg (der gespeicherte bleibt).
function saveIfDirty() {
  if (!setupDirty() || saving) return;
  const patch = readSetup();
  const claude = String(patch.anthropicKey ?? "").trim();
  const gemini = String(patch.geminiKey ?? "").trim();
  let skipped = false;
  if (claude && !CLAUDE_KEY_RX.test(claude)) { delete patch.anthropicKey; skipped = true; }
  if (gemini && !GEMINI_KEY_RX.test(gemini)) { delete patch.geminiKey; skipped = true; }
  const gid = String(patch.googleClientId ?? "").trim();
  if (gid && !GOOGLE_RX.test(gid)) { delete patch.googleClientId; skipped = true; }
  setupSnapshot = JSON.stringify(readSetup());
  try {
    Promise.resolve(call("onSave", patch)).catch((e) => console.error("sheets: save", e));
    toast(skipped ? "Gespeichert – der Schlüssel sah nicht richtig aus und bleibt draußen." : "Gespeichert.");
  } catch (e) {
    console.error("sheets: save", e);
  }
}

function readSetup() {
  const patch = {};
  for (const [key, id, type] of FIELDS) {
    const f = $(id);
    if (!f) continue;
    if (type === "check") patch[key] = !!f.checked;
    else if (type === "int" || type === "float") {
      const n = parseNum(f.value, type === "int");
      if (n != null) patch[key] = n;
    } else if (type === "key") patch[key] = String(f.value ?? "").trim();
    else if (type === "select") {
      if (f.value) patch[key] = f.value;
    } else patch[key] = String(f.value ?? "").trim();
  }
  const closing = $("f-closing");
  if (closing) {
    const v = String(closing.value ?? "").trim();
    patch.closingPhrase = filledClosingWasDefault && v === filledClosing.trim() ? null : v;
  }
  const gf = geminiField();
  if (gf) patch.geminiKey = String(gf.value ?? "").trim();
  const provider = readProvider();
  if (provider) patch.brainProvider = provider;
  if (patch.voicePreset && patch.voicePreset !== FREE_PRESET && !patch.azureKey
    && [...($("f-preset")?.options || [])].some((o) => o.value === FREE_PRESET)) patch.voicePreset = FREE_PRESET;
  return patch;
}

function fillStatus() {
  const st = call("status") || {};
  setText($("key-state"), keyStateFromForm());
  $("key-state")?.classList.toggle("warn", keyStateFromForm() === "UNGÜLTIG");
  if (st.voiceState != null) setText($("voice-state"), String(st.voiceState));
  if (st.micState != null) setText($("mic-state"), String(st.micState));
  if (st.wakeState != null) setText($("wake-state"), String(st.wakeState));
  const hint = $("install-hint");
  if (hint) hint.hidden = !!(st.standalone ?? isStandalone()) || !isIOS();
  // „Kurzbefehl-Link“ gibt es nur für die iOS-App „Kurzbefehle“ (CR3.1: keine iPhone-Knöpfe auf anderen Geräten)
  const sc = document.querySelector('#sheet-setup [data-cmd="copy_shortcut_link"]');
  if (sc) sc.hidden = device() !== "ios";
  fillGoogle(st.google);
}

// ---------------------------------------------------------------- Google verbinden (v4)
function googleIdFromForm() {
  return String($("f-google-client")?.value ?? settingsNow().googleClientId ?? "").trim();
}

function fillGoogle(g) {
  const origin = typeof location !== "undefined" ? location.origin : "";
  setText($("google-origin"), origin);
  const st = g || {};
  const id = googleIdFromForm();
  const chip = $("google-state");
  const acc = $("google-account");
  let chipText = "KEINE CLIENT-ID", accText = "Noch keine Client-ID eingetragen – die Anleitung steht unten.", cls = "";
  if (id && !GOOGLE_RX.test(id)) {
    chipText = "UNGÜLTIG";
    accText = "Die Client-ID sieht nicht richtig aus. Sie endet auf „.apps.googleusercontent.com“.";
    cls = "warn";
  } else if (id) {
    const parts = [st.calendar ? "Kalender ✓" : "", st.mail ? "Gmail ✓" : st.linked?.mail ? "" : "Gmail: fragt beim ersten Mal"]
      .filter(Boolean).join(" · ");
    if (st.connected) {
      chipText = "VERBUNDEN";
      accText = `Verbunden${st.email ? ` als ${st.email}` : ""}${parts ? ` · ${parts}` : ""}.`;
      cls = "ok";
    } else if (st.linked && (st.linked.calendar || st.linked.mail)) {
      chipText = "ERNEUERN";
      accText = `${st.email ? `${st.email}: ` : ""}Die Verbindung gilt eine Stunde. Jarvis erneuert sie still, sonst tipp auf „Verbinden“.`;
      cls = "warn";
    } else {
      chipText = "NICHT VERBUNDEN";
      accText = "Client-ID gespeichert. Tipp auf „Verbinden“ und melde dich bei Google an.";
    }
  }
  setText(chip, chipText);
  chip?.classList.toggle("warn", cls === "warn");
  if (acc) {
    setText(acc, accText);
    acc.classList.toggle("ok", cls === "ok");
    acc.classList.toggle("warn", cls === "warn");
  }
}

/** „Verbinden“ / „Gmail erlauben“: Client-ID aus dem Feld zuerst speichern, dann synchron im Tippen verbinden. */
function googleConnect(mail) {
  const id = googleIdFromForm();
  if (!id) {
    toast("Trag zuerst deine Client-ID ein.");
    const d = $("google-howto");
    if (d) d.open = true;
    try { $("f-google-client")?.focus(); } catch { /* ignore */ }
    return null;
  }
  if (!GOOGLE_RX.test(id)) {
    toast("Die Client-ID sieht nicht richtig aus. Sie endet auf „.apps.googleusercontent.com“.");
    return null;
  }
  if (id !== String(settingsNow().googleClientId || "")) {
    call("onSave", { googleClientId: id });
    setupSnapshot = JSON.stringify(readSetup());
  }
  const p = call("onCommand", "google_connect", { mail: !!mail });
  Promise.resolve(p).then((res) => {
    if (res?.text) toast(res.text);
    refresh();
  }, () => refresh());
  return p;
}

// ---------------------------------------------------------------- Hilfe (§5.4, CR3.4)
function fillHelp() {
  const url = location.origin + location.pathname;
  setText($("help-url"), url);
  for (const x of document.querySelectorAll(`#${SHEET_IDS.help} .help-url-copy`)) setText(x, url);
  const sa = $("help-standalone");
  if (sa) {
    const text = !isStandalone() && isIOS()
      ? "Du nutzt Jarvis gerade in Safari. Für das Symbol auf dem Home-Bildschirm siehe Punkt 1." : "";
    setText(sa, text);
    sa.hidden = !text;
  }
  selectDevice(device());
}

// Geräte-Umschalter: jedes Element mit data-device im Hilfe-Blatt. Knöpfe/Radios schalten, alles andere zeigt
// nur den Text für das gewählte Gerät.
function selectDevice(dev) {
  const help = $(SHEET_IDS.help);
  if (!help) return;
  const items = [...help.querySelectorAll("[data-device]")];
  if (!items.length) return;
  const known = new Set(items.map((x) => x.dataset.device));
  const d = known.has(dev) ? dev : (known.has("ios") ? "ios" : items[0].dataset.device);
  help.dataset.device = d;
  for (const x of items) {
    const mine = x.dataset.device === d;
    const tag = x.tagName;
    if (tag === "INPUT" && (x.type === "radio" || x.type === "checkbox")) x.checked = mine;
    else if (tag === "BUTTON" || x.getAttribute("role") === "tab") {
      x.classList.toggle("on", mine);
      x.classList.toggle("active", mine);
      x.setAttribute("aria-pressed", mine ? "true" : "false");
      if (x.getAttribute("role") === "tab") x.setAttribute("aria-selected", mine ? "true" : "false");
    } else if (tag === "OPTION") x.selected = mine;
    else x.hidden = !mine;
  }
}

// ---------------------------------------------------------------- Daten (§5.6)
function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtWann(wann) {
  const w = String(wann ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(w);
  if (!m) return w;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const wd = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][d.getDay()];
  return `${wd}, ${m[3]}.${m[2]}.${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : " ganztägig"}`;
}

function fmtNum(n) {
  try { return Number(n || 0).toLocaleString("de-DE"); } catch { return String(n || 0); }
}

function emptyRow(text) {
  return el("p", "hint empty", text);
}

function row(main, sub, cmd, data) {
  const r = el("div", "data-row");
  const txt = el("div", "data-text-cell");
  txt.append(el("span", "data-main", main));
  if (sub) txt.append(el("span", "data-sub", sub));
  const x = el("button", "data-del", "✕");
  x.type = "button";
  x.dataset.cmd = cmd;
  for (const [k, v] of Object.entries(data)) x.dataset[k] = String(v);
  x.setAttribute("aria-label", "Löschen");
  r.append(txt, x);
  return r;
}

function fillData() {
  const facts = safe(() => store.facts(), []);
  const box = $("data-facts");
  if (box) {
    box.replaceChildren(...(facts.length ? facts.slice().reverse().map((f) => row(f.text, f.am ? `am ${f.am}` : "", "fact_delete", { id: f.id }))
      : [emptyRow("Noch nichts gemerkt. Sag z. B. „Merk dir, dass ich Kaffee schwarz trinke“.")]));
  }
  const shortcuts = safe(() => store.shortcuts(), []);
  const sb = $("data-shortcuts");
  if (sb) {
    sb.replaceChildren(...(shortcuts.length ? shortcuts.map((s) => row(`„${s.phrase}“`,
      `→ ${(Array.isArray(s.actions) ? s.actions : []).map((a) => a && a.type).filter(Boolean).join(", ")}`,
      "shortcut_delete", { phrase: s.phrase }))
      : [emptyRow("Keine Kurzbefehle. Sag z. B. „Wenn ich Feierabend sage, dann tauch ab“.")]));
  }
  const termine = safe(() => store.termine(), []);
  const tb = $("data-termine");
  if (tb) {
    tb.replaceChildren(...(termine.length ? termine.map((t) => row(String(t.titel ?? ""),
      `${fmtWann(t.wann)}${t.ort ? ` · ${t.ort}` : ""}`, "termin_delete", { id: t.id }))
      : [emptyRow("Keine Termine.")]));
  }
  const ta = $("data-konto");
  if (ta && document.activeElement !== ta) {
    const k = safe(() => store.konto(), null);
    ta.value = k ? JSON.stringify(k, null, 2) : "";
  }
  const hist = $("data-history");
  if (hist) {
    const n = safe(() => store.chatHistory().length, 0);
    const at = safe(() => store.lastTurnAt(), 0);
    setText(hist, n ? `${n} Nachrichten, zuletzt ${fmtDate(new Date(at || Date.now()))}` : "Kein laufendes Gespräch.");
  }
  const usage = $("data-usage");
  if (usage) {
    const u = safe(() => store.usageToday(), { input: 0, output: 0, requests: 0 }) || {};
    setText(usage, `Heute: ${fmtNum(u.input)} Tokens rein, ${fmtNum(u.output)} raus, ${fmtNum(u.requests)} Anfragen`);
  }
}

function safe(fn, fallback) {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- Setup-Link übernehmen? (security-privacy-1)
const KEY_NAMES = Object.freeze({ geminiKey: "Gemini-Schlüssel", anthropicKey: "Claude-Schlüssel", azureKey: "Azure-Schlüssel" });
const PROFILE_NAMES = Object.freeze({ anrede: "Anrede", vorname: "Vorname", firma: "Firma", wohnort: "Wohnort" });
const PROVIDER_NAMES = Object.freeze({ auto: "Automatisch", gemini: "Gemini", claude: "Claude" });

function hostOf(url) {
  try { return new URL(String(url)).hostname || String(url); } catch { return String(url || ""); }
}

/** Was der Link ändern würde, in kurzen deutschen Zeilen (wichtigstes zuerst). */
function importLines(payload) {
  const cur = settingsNow();
  const ns = payload && typeof payload.s === "object" && payload.s ? payload.s : {};
  const out = [];
  for (const [k, name] of Object.entries(KEY_NAMES)) {
    if (!(k in ns)) continue;
    const a = String(cur[k] ?? "").trim();
    const b = String(ns[k] ?? "").trim();
    if (a === b) continue;
    out.push({ warn: true, text: !b ? `${name} wird gelöscht.` : a ? `${name} wird ersetzt.` : `${name} wird eingetragen.` });
  }
  if ("brainProvider" in ns && ns.brainProvider !== cur.brainProvider) {
    out.push({ warn: false, text: `Gehirn: ${PROVIDER_NAMES[ns.brainProvider] || ns.brainProvider}.` });
  }
  const prof = Object.keys(PROFILE_NAMES).filter((k) => k in ns && String(ns[k] ?? "") !== String(cur[k] ?? ""));
  if (prof.length) out.push({ warn: false, text: `Profil: ${prof.map((k) => PROFILE_NAMES[k]).join(", ")}.` });
  if ("gedaechtnis" in ns && String(ns.gedaechtnis ?? "").trim() !== String(cur.gedaechtnis ?? "").trim()) {
    out.push({ warn: true, text: String(ns.gedaechtnis ?? "").trim() ? "Gedächtnis wird ersetzt." : "Gedächtnis wird geleert." });
  }
  const facts = Array.isArray(payload?.f) ? payload.f.filter((x) => typeof x === "string" && x.trim()) : [];
  if (facts.length) out.push({ warn: true, text: `${facts.length} ${facts.length === 1 ? "Notiz kommt" : "Notizen kommen"} dazu („${String(facts[0]).slice(0, 60)}“${facts.length > 1 ? " …" : ""}).` });
  const sc = Array.isArray(payload?.k) ? payload.k.filter((x) => x && typeof x.phrase === "string") : [];
  for (const k of sc.slice(0, 6)) {
    const acts = (Array.isArray(k.actions) ? k.actions : []).map((a) => {
      if (!a || typeof a !== "object") return "";
      return a.url ? `öffnet ${hostOf(a.url)}` : String(a.type || "");
    }).filter(Boolean).join(", ");
    out.push({ warn: true, text: `Kurzbefehl „${String(k.phrase).slice(0, 50)}“ → ${acts || "Aktion"}.` });
  }
  if (sc.length > 6) out.push({ warn: true, text: `… und ${sc.length - 6} weitere Kurzbefehle.` });
  const other = Object.keys(ns).filter((k) => !(k in KEY_NAMES) && !(k in PROFILE_NAMES)
    && !["brainProvider", "gedaechtnis", "deckPage"].includes(k) && JSON.stringify(ns[k]) !== JSON.stringify(cur[k]));
  if (other.length) out.push({ warn: false, text: `Weitere Einstellungen (${other.length}): Stimme, Weckwort, Anzeige …` });
  if (!out.length) out.push({ warn: false, text: "Nichts Neues – alles ist schon so eingestellt." });
  return out;
}

function fillImport(payload, source) {
  setText($("import-hint"), source === "code"
    ? "Dieser Setup-Code will Jarvis auf diesem Gerät so ändern. Übernimm ihn nur, wenn du ihn selbst kopiert hast."
    : "Dieser Link will Jarvis auf diesem Gerät so ändern. Übernimm ihn nur, wenn du ihn selbst erstellt hast.");
  const list = $("import-list");
  if (!list) return;
  list.replaceChildren(...importLines(payload).map((l) => el("li", l.warn ? "warn" : "", l.text)));
}

// ---------------------------------------------------------------- Links (§8.4)
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Ersatz unten */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.readOnly = true;
    ta.setAttribute("aria-hidden", "true");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Links tragen nie Schlüssel (sie landen im Browser-Verlauf); Schlüssel gehen nur mit dem Setup-Code (security-privacy-3)
async function copyLink(wake) {
  let link = "";
  try { link = store.setupLink({ wake }); } catch { link = ""; }
  if (!link) { toast("Den Link kann ich gerade nicht bauen."); return; }
  toast(await copyText(link) ? "Link kopiert." : "Kopieren ging nicht. Bitte noch einmal tippen.");
}

async function copyCode() {
  let code = "";
  try { code = store.setupCode(); } catch { code = ""; }
  if (!code) { toast("Den Setup-Code kann ich gerade nicht bauen."); return; }
  toast(await copyText(code) ? "Setup-Code kopiert. Er enthält deine Schlüssel – nicht weitergeben."
    : "Kopieren ging nicht. Bitte noch einmal tippen.");
}

function pasteCode() {
  const box = $("f-setup-code");
  const raw = String(box?.value ?? "").trim();
  if (!raw) {
    toast("Füge zuerst einen Setup-Code ein.");
    try { box?.focus(); } catch { /* ignore */ }
    return;
  }
  let payload = null;
  try { payload = store.readSetupCode(raw); } catch { payload = null; }
  if (!payload) { toast("Den Setup-Code verstehe ich nicht."); return; }
  if (box) box.value = "";
  open("import", { payload, source: "code" });     // erst zeigen, was sich ändert; nichts gilt vor „Übernehmen“
}

// ---------------------------------------------------------------- Befehle in den Blättern
function confirmed(text) {
  try { return typeof window.confirm === "function" ? window.confirm(text) : true; } catch { return true; }
}

async function brainTest() {
  if (testing) return;
  testing = true;
  const chip = $("key-state");
  setText(chip, "TESTE …");
  try {
    const draft = draftBrain();
    const res = await call("onCommand", "brain_test", { draft });
    const ok = !!res?.ok;
    const text = String(res?.text || (ok ? line("brainOk") : line("err.other")));
    if (ok) {                                    // verbunden: gleich speichern, ✕ darf ihn nicht mehr verlieren
      const patch = { brainProvider: draft.brainProvider };
      if (!draft.anthropicKey || CLAUDE_KEY_RX.test(draft.anthropicKey)) patch.anthropicKey = draft.anthropicKey;
      if (!draft.geminiKey || GEMINI_KEY_RX.test(draft.geminiKey)) patch.geminiKey = draft.geminiKey;
      try { await Promise.resolve(call("onSave", patch)); } catch (e) { console.error("sheets: save", e); }
    }
    setText(chip, ok ? "VERBUNDEN" : keyStateFromForm() === "UNGÜLTIG" ? "UNGÜLTIG" : "FEHLER");
    toast(text);
  } catch {
    setText(chip, "FEHLER");
    toast(line("err.other"));
  } finally {
    testing = false;
  }
}

function command(cmd, btn) {
  switch (cmd) {
    case "voice_test":
      call("onCommand", "voice_test", { draft: draftVoice() });
      return true;
    case "brain_test": case "test_brain": case "key_test": case "test_key":
      brainTest();
      return true;
    case "copy_setup_link":
      copyLink(false);
      return true;
    case "copy_shortcut_link":
      copyLink(true);
      return true;
    case "copy_setup_code":
      copyCode();
      return true;
    case "paste_setup_code":
      pasteCode();
      return true;
    case "open_help":
      open("help");
      return true;
    case "open_data":
      open("data");
      return true;
    case "open_setup":
      open("setup");
      return true;
    case "open_welcome":
      open("welcome", { step: 0 });
      return true;
    case "google_connect":
      googleConnect(false);
      return true;
    case "google_mail":
      googleConnect(true);
      return true;
    case "google_disconnect":
      if (!confirmed("Google trennen? Jarvis vergisst die Verbindung zu Kalender und Gmail auf diesem Gerät.")) return true;
      call("onCommand", "google_disconnect", {});
      toast("Google getrennt.");
      refresh();
      return true;
    case "wz_next":
      wzGo(wzStep + 1);
      return true;
    case "wz_back":
      wzGo(wzStep - 1);
      return true;
    case "wz_mic": case "wz_awake": case "wz_voice":
      wzRun(cmd.slice(3), call("onCommand", cmd, {}));
      return true;
    case "wz_brain":
      wzBrain();
      return true;
    case "wz_brain_more":
      wzReturn = true;
      open("setup", { section: "brain" });
      return true;
    case "wz_google":
      if (!GOOGLE_RX.test(String(settingsNow().googleClientId || ""))) {
        wzReturn = true;
        open("setup", { section: "google" });
        const d = $("google-howto");
        if (d) d.open = true;
        return true;
      }
      wzRun("google", call("onCommand", "google_connect", { mail: false }));
      return true;
    case "wz_google_more": {
      wzReturn = true;
      open("setup", { section: "google" });
      const d = $("google-howto");
      if (d) d.open = true;
      return true;
    }
    case "wz_finish": {
      const bg = !!$("wz-background")?.checked;
      wzEnding = true;
      close("welcome");
      wzEnding = false;
      call("onCommand", "wz_finish", { background: bg });
      return true;
    }
    case "konto_import": {
      const raw = String($("data-konto")?.value ?? "").trim();
      if (!raw) {
        safe(() => store.setKonto(null), "");
        toast("Konto geleert.");
        fillData();
        return true;
      }
      let obj;
      try { obj = JSON.parse(raw); } catch { toast("Das Konto-JSON verstehe ich nicht."); return true; }
      const err = safe(() => store.setKonto(obj), "Das Konto-JSON verstehe ich nicht.");
      toast(err || "Konto übernommen.");
      if (!err) fillData();
      return true;
    }
    case "konto_clear":
      if (!confirmed("Konto und Termine leeren?")) return true;
      safe(() => store.setKonto(null), "");
      toast("Konto geleert.");
      fillData();
      return true;
    case "history_clear":
      call("onCommand", "history_clear", {});
      toast("Gespräch gelöscht.");
      fillData();
      return true;
    case "log_clear":
      safe(() => store.clearLog(), null);
      call("onCommand", "log_clear", {});
      toast("Protokoll geleert.");
      return true;
    case "facts_clear":
      if (!confirmed("Alles vergessen, was ich mir gemerkt habe?")) return true;
      safe(() => store.clearFacts(), null);
      fillData();
      return true;
    case "shortcuts_clear":
      if (!confirmed("Alle Kurzbefehle löschen?")) return true;
      safe(() => store.wipe("shortcuts"), null);
      fillData();
      return true;
    case "wipe_all":
      if (!confirmed("Wirklich alles löschen? Schlüssel, Gedächtnis, Kurzbefehle, Konto und Verlauf sind dann weg.")) return true;
      safe(() => store.wipe("all"), null);
      // erst auch den Stimmen-Cache leeren (gesprochene Sätze), dann neu laden (security-privacy-5)
      Promise.race([Promise.resolve(safe(() => store.wipeDone(), null)), new Promise((r) => setTimeout(r, 1500))])
        .finally(() => { try { location.reload(); } catch { /* ignore */ } });
      return true;
    case "import_accept": {
      const payload = importPayload;
      importPayload = null;
      const ok = !!payload && !!safe(() => store.applySetup(payload), false);
      close("import");
      toast(ok ? "Einstellungen übernommen." : importSource === "code" ? "Der Setup-Code ist beschädigt." : "Der Setup-Link ist beschädigt.");
      call("onCommand", "import_done", { accepted: ok });
      return true;
    }
    case "import_decline":
      close("import");
      return true;
    case "fact_delete":
      safe(() => store.removeFact(btn?.dataset.id || ""), false);
      fillData();
      return true;
    case "shortcut_delete": {
      const err = safe(() => store.forgetShortcut(btn?.dataset.phrase || ""), "");
      if (err) toast(err);
      fillData();
      return true;
    }
    case "termin_delete":
      safe(() => store.removeTermin({ id: btn?.dataset.id || "" }), 0);
      fillData();
      return true;
    default:
      return false;
  }
}

async function onSubmit(e) {
  e.preventDefault();
  if (saving) return;
  const state = keyStateFromForm();
  if (state === "UNGÜLTIG") {
    setText($("key-state"), "UNGÜLTIG");
    $("key-state")?.classList.add("warn");
    toast("Der Schlüssel sieht nicht richtig aus. Bitte prüfen.");
    open("setup", { section: "brain" });
    return;
  }
  const gid = String($("f-google-client")?.value ?? "").trim();
  if (gid && !GOOGLE_RX.test(gid)) {
    toast("Die Google-Client-ID sieht nicht richtig aus. Sie endet auf „.apps.googleusercontent.com“.");
    open("setup", { section: "google" });
    return;
  }
  saving = true;
  try {
    const patch = readSetup();
    setupSnapshot = JSON.stringify(patch);
    const p = call("onSave", patch);           // synchron im Tippen: app darf hier das Mikrofon freischalten
    await Promise.resolve(p);
    close("setup");
    toast("Gespeichert.");
  } catch (err) {
    console.error("sheets: save", err);
    toast("Speichern ging nicht.");
  } finally {
    saving = false;
  }
}

function sheetOf(node) {
  const s = node?.closest?.(".sheet");
  if (!s) return null;
  return NAMES.find((n) => SHEET_IDS[n] === s.id) || null;
}

function onClick(e) {
  const t = e.target;
  if (!t || typeof t.closest !== "function") return;
  const x = t.closest("[data-close]");
  if (x && sheetOf(x)) {
    e.preventDefault();
    close(x.dataset.close || sheetOf(x));
    return;
  }
  const dev = t.closest("[data-device]");
  if (dev && sheetOf(dev) === "help" && (dev.tagName === "BUTTON" || dev.tagName === "INPUT" || dev.getAttribute("role") === "tab")) {
    selectDevice(dev.dataset.device);
    return;
  }
  const btn = t.closest("[data-cmd]");
  if (!btn || !sheetOf(btn)) return;
  if (command(btn.dataset.cmd, btn)) e.preventDefault();
}

function onInput(e) {
  const id = e.target?.id || "";
  if (id === "f-azure") updatePresetOptions();
  if (id === "f-google-client") {
    const v = String(e.target.value || "").trim();
    if (GOOGLE_RX.test(v)) call("onCommand", "google_preload", { clientId: v });   // Skript laden, bevor er tippt
    fillGoogle((call("status") || {}).google);
  }
  if (id === "f-anthropic" || id === "f-azure" || /gemini/i.test(id) || e.target?.type === "radio"
    || (e.target?.tagName === "SELECT" && [...e.target.options].some((o) => o.value === "gemini"))) {
    setText($("key-state"), keyStateFromForm());
    $("key-state")?.classList.toggle("warn", keyStateFromForm() === "UNGÜLTIG");
  }
}

function onKey(e) {
  if (e.key !== "Escape" || !current) return;
  e.preventDefault();
  close(current);
}

// ---------------------------------------------------------------- „Jarvis einrichten“ (v4)
function wzStatus(step, text, cls = "") {
  const box = document.querySelector(`#${SHEET_IDS.welcome} [data-status="${step}"]`);
  if (!box) return;
  setText(box, String(text || ""));
  box.classList.toggle("ok", cls === "ok");
  box.classList.toggle("warn", cls === "warn");
}

function fillWelcome() {
  const root = $(SHEET_IDS.welcome);
  if (!root) return;
  const step = WZ_STEPS[wzStep];
  for (const sec of root.querySelectorAll(".wz-step")) sec.hidden = sec.dataset.step !== step;
  setText($("wz-count"), `${wzStep + 1} / ${WZ_STEPS.length}`);
  const dots = [...root.querySelectorAll("#wz-dots i")];
  dots.forEach((d, i) => {
    d.classList.toggle("on", i === wzStep);
    d.classList.toggle("done", i < wzStep || wzOk.has(WZ_STEPS[i]));
  });
  const back = $("wz-back");
  if (back) back.hidden = wzStep === 0;
  const next = $("wz-next");
  if (next) {
    next.hidden = step === "done";
    const ok = wzOk.has(step);
    setText(next, ok ? "Weiter" : "Überspringen");
    next.classList.toggle("go", ok);
  }
  if (step === "brain") {
    const f = $("wz-gemini");
    if (f && !f.value) f.value = String(settingsNow().geminiKey || "");
    const st = call("status") || {};
    if (!wzOk.has("brain") && st.provider && st.provider !== "none") {   // in den Einstellungen eingetragen
      wzOk.add("brain");
      wzStatus("brain", "Gehirn eingetragen ✓", "ok");
      fillWelcome();
      return;
    }
  }
  if (step === "google" && !wzOk.has("google")) {
    const st = (call("status") || {}).google || {};
    if (st.connected) {
      wzOk.add("google");
      wzStatus("google", "Google ist verbunden ✓", "ok");
      fillWelcome();
      return;
    }
    if (!GOOGLE_RX.test(String(settingsNow().googleClientId || ""))) {
      wzStatus("google", "Noch keine Client-ID: „Google verbinden“ führt dich durch die Anleitung. Du kannst das auch später machen.");
    } else {
      call("onCommand", "google_preload", {});
    }
  }
  const body = root.querySelector(".sheet-body");
  if (body) body.scrollTop = 0;
}

function wzGo(i) {
  wzStep = Math.max(0, Math.min(WZ_STEPS.length - 1, i));
  fillWelcome();
}

function wzRun(step, p) {
  wzStatus(step, "…");
  Promise.resolve(p).then((res) => {
    const ok = !!res?.ok;
    if (ok) wzOk.add(step);
    wzStatus(step, String(res?.text || (ok ? "Erledigt ✓" : "Das hat nicht geklappt.")), ok ? "ok" : "warn");
    if (WZ_STEPS[wzStep] === step) fillWelcome();
  }, () => wzStatus(step, "Das hat nicht geklappt.", "warn"));
}

function wzBrain() {
  const key = String($("wz-gemini")?.value ?? "").trim();
  if (!key) {
    wzStatus("brain", "Ohne Schlüssel geht es auch – eintragen kannst du ihn jederzeit unter ⚙ Einstellungen.");
    return;
  }
  if (!GEMINI_KEY_RX.test(key)) {
    wzStatus("brain", "Der Schlüssel sieht nicht richtig aus. Er beginnt meist mit „AIza“.", "warn");
    return;
  }
  const s = settingsNow();
  const draft = { brainProvider: s.brainProvider || "auto", geminiKey: key, anthropicKey: String(s.anthropicKey || "") };
  wzStatus("brain", "Teste …");
  Promise.resolve(call("onCommand", "brain_test", { draft })).then(async (res) => {
    if (res?.ok) {
      try { await Promise.resolve(call("onSave", { geminiKey: key })); } catch (e) { console.error("sheets: save", e); }
      wzOk.add("brain");
      wzStatus("brain", "Gehirn verbunden ✓", "ok");
    } else {
      wzStatus("brain", String(res?.text || line("err.other")), "warn");
    }
    if (WZ_STEPS[wzStep] === "brain") fillWelcome();
  }, () => wzStatus("brain", line("err.other"), "warn"));
}

// ---------------------------------------------------------------- öffentliche Schnittstelle
/**
 * Knöpfe in den Blättern, Schließen-Knöpfe und das Absenden des Einstellungs-Formulars verdrahten.
 * @param {object} callbacks
 */
export function init(callbacks = {}) {
  cb = callbacks || {};
  if (inited || typeof document === "undefined") return;
  inited = true;
  for (const name of NAMES) {
    const s = $(SHEET_IDS[name]);
    if (!s) continue;
    s.addEventListener("click", onClick);
    s.addEventListener("input", onInput);
    s.addEventListener("change", onInput);
  }
  $("setup-form")?.addEventListener("submit", onSubmit);
  document.addEventListener("keydown", onKey);
}

/**
 * Blatt öffnen (vorher mit Werten füllen) und zu einem Abschnitt springen.
 * @param {"setup"|"help"|"data"} name
 * @param {{ section?: string }} [opts]
 */
export function open(name, { section, payload, source, step } = {}) {
  if (!SHEET_IDS[name]) return;
  if (name === "welcome" && Number.isInteger(step)) {
    wzStep = Math.max(0, Math.min(WZ_STEPS.length - 1, step));
    if (step === 0) wzOk.clear();
  }
  if (name !== "setup" && name !== "welcome") wzReturn = false;
  if (name !== "setup") saveIfDirty();          // aus den Einstellungen in „Hey Jarvis einrichten“: nichts verlieren
  for (const n of NAMES) {
    if (n !== name) {
      const other = $(SHEET_IDS[n]);
      if (other && !other.hidden) other.hidden = true;
    }
  }
  const s = $(SHEET_IDS[name]);
  if (!s) return;
  try {
    if (name === "setup") fillSetup();
    else if (name === "help") fillHelp();
    else if (name === "import") {
      if (payload) importSource = source === "code" ? "code" : "link";
      importPayload = payload || importPayload;
      fillImport(importPayload, importSource);
    } else if (name === "welcome") fillWelcome();
    else fillData();
  } catch (e) {
    console.error("sheets: fill", e);
  }
  const was = current;
  s.hidden = false;
  current = name;
  const sec = section ? $(`sec-${section}`) : null;
  if (sec) {
    if (sec.tagName === "DETAILS") sec.open = true;
    try { sec.scrollIntoView({ block: "start", behavior: "auto" }); } catch { /* ignore */ }
  } else {
    const body = s.querySelector(".sheet-body");
    if (body && was !== name) body.scrollTop = 0;
  }
  call("onOpenChange", name);
}

/**
 * @param {"setup"|"help"|"data"} [name] undefined = alle
 */
export function close(name) {
  const list = name ? [name] : NAMES;
  if (list.includes("setup")) saveIfDirty();
  if (list.includes("import") && isOpen("import") && importPayload) {     // ✕ / Zurück = nicht übernehmen
    importPayload = null;
    toast("Nicht übernommen.");
    call("onCommand", "import_done", { accepted: false });
  }
  const welcomeWasOpen = list.includes("welcome") && isOpen("welcome");
  const backToWizard = wzReturn && list.includes("setup") && isOpen("setup") && !list.includes("welcome");
  const leftWizard = wzReturn && !name && isOpen("setup");      // Zurück-Taste in den Einstellungen des Assistenten
  let changed = false;
  for (const n of list) {
    const s = $(SHEET_IDS[n]);
    if (s && !s.hidden) {
      s.hidden = true;
      changed = true;
    }
  }
  if (current && !isOpen(current)) current = null;
  if (!current) current = NAMES.find((n) => isOpen(n)) || null;
  if (backToWizard) {                                   // Gehirn/Google eingetragen: weiter im Assistenten
    wzReturn = false;
    open("welcome");
    return;
  }
  if (!name) wzReturn = false;
  if (changed) call("onOpenChange", current);
  if ((welcomeWasOpen || leftWizard) && !wzEnding) call("onCommand", "wz_closed", {});
}

/**
 * @param {"setup"|"help"|"data"} [name] undefined = irgendein Blatt offen
 * @returns {boolean}
 */
export function isOpen(name) {
  if (typeof document === "undefined") return false;
  const list = name ? [name] : NAMES;
  return list.some((n) => {
    const s = $(SHEET_IDS[n]);
    return !!s && !s.hidden;
  });
}

/** Status-Chips und Listen des offenen Blatts neu füllen. */
export function refresh() {
  try {
    if (isOpen("setup")) fillStatus();
    if (isOpen("data")) fillData();
    if (isOpen("help")) fillHelp();
  } catch (e) {
    console.error("sheets: refresh", e);
  }
}
