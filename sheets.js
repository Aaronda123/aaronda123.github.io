// ==============================================================================================================
// CONTRACT – sheets.js (owner: builder CORE). Spec: ARCHITECTURE.md §3.2.8, §3.5.4, §5.4-§5.6, §8.4, CHANGES-1 CR2/CR3.
// Logic of the three full-screen sheets whose static DOM lives in index.html (VISUAL):
//   "setup" (#sheet-setup, Einstellungen: fill/read/validate/save, Stimme testen, Gehirn testen, Setup-/Kurzbefehl-Link),
//   "help"  (#sheet-help, „Hey Jarvis“ einrichten: #help-url, #help-standalone, device switch preselected from the UA),
//   "data"  (#sheet-data, Gemerkt / Kurzbefehle / Termine / Konto / Gespräch / Verbrauch lists, delete, import).
// export function init(cb)        cb: { onSave(patch) → Promise, onCommand(cmd, detail) → any, onOpenChange(name|null),
//                                       status() → { keyState, voiceState, micState, wakeState, standalone }, toast(text) }
//                                 onCommand: "voice_test" {draft} · "history_clear" {} · "log_clear" {} ·
//                                            "brain_test" {draft} → Promise<{ ok: boolean, text: string }>
// export function open(name, { section }?)   "setup"|"help"|"data"; section → #sec-<section>
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

const SHEET_IDS = Object.freeze({ setup: "sheet-setup", help: "sheet-help", data: "sheet-data" });
const NAMES = Object.keys(SHEET_IDS);
const CLAUDE_KEY_RX = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const GEMINI_KEY_RX = /^[A-Za-z0-9_-]{30,}$/;
const PROVIDERS = new Set(["auto", "claude", "gemini"]);
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
  ["silenceSeconds", "f-silence", "float"], ["hesitationSeconds", "f-hesitation", "float"],
  ["maxRecordSeconds", "f-maxrecord", "int"], ["speakMaxSentences", "f-sentences", "int"],
  ["imageSeconds", "f-imageseconds", "int"],
]);

let cb = {};
let inited = false;
let current = null;            // offenes Blatt
let filledClosing = "";        // Abschlussfrage, wie sie beim Füllen im Feld stand (Standard = null bleibt null)
let filledClosingWasDefault = false;
let saving = false;
let testing = false;

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

async function copyLink(wake) {
  let link = "";
  try { link = store.setupLink({ wake }); } catch { link = ""; }
  if (!link) { toast("Den Link kann ich gerade nicht bauen."); return; }
  toast(await copyText(link) ? "Link kopiert." : "Kopieren ging nicht. Bitte noch einmal tippen.");
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
    const res = await call("onCommand", "brain_test", { draft: draftBrain() });
    const ok = !!res?.ok;
    const text = String(res?.text || (ok ? line("brainOk") : line("err.other")));
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
    case "open_help":
      open("help");
      return true;
    case "open_data":
      open("data");
      return true;
    case "open_setup":
      open("setup");
      return true;
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
      try { location.reload(); } catch { /* ignore */ }
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
  saving = true;
  try {
    const patch = readSetup();
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
export function open(name, { section } = {}) {
  if (!SHEET_IDS[name]) return;
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
  if (changed) call("onOpenChange", current);
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
