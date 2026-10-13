// ==============================================================================================================
// CONTRACT – intents.js (owner: builder CORE). Spec: ARCHITECTURE.md §3.2.4, §5.2, §7 (+ CHANGES-1 CR1.4).
// Pure functions: no DOM, no storage, imports nothing. Every regex ported from jarvis.py is built with ure().
// export const WEEKDAYS, MONTHS
// export function ure(src, flags?): RegExp            Unicode-aware \b \w \W, always the u flag (reference in §3.2.4)
// export function norm(text); export function line(key, vars?); export const LINES   (all spoken lines, §5.2)
// export function setAnrede(name)                      default {A} for line() when vars.A is not given
// export function setDevice(name); device()            default {G} (iPhone|iPad|Handy|Tablet|Computer) for line()/brain
// export function toDuForm(text)                       stored note (ich-Form) read back in the du-Form
// export function parseTermin(body, now?)              free-mode „trag … ein“ → { titel, wann, phrase } | { needTime } | null
// export function parseNumber(token); parseDuration(text); sayDuration(seconds); sayTime(date?); sayDate(date?)
// export const NAME_STRONG, NAME_WEAK, GREET
// export function matchWake(text): { rest, presence, greeted, raw } | null
// export function stripWakePrefix(text); cleanTranscript(text); isHesitant(text)
// export function isCloseCommand(text, strong?); stealthRest(text, strict?); isStealthCommand(text, strict?)
// export function stealthCombo(text); endsWithHide(text); isFarewell(text)
// export function weatherQuery(t): { place, day }
// export const SITES; export function openTarget(name, verb?, search?)
// export function quickIntent(text, ctx): { say, actions, followUp, special, ui, macOnly? } | null   (Mac quick_intent, §7.1 + §7.7)
//   ctx: { lastAnswer, findShortcut, anrede, wohnort, imageOpen, modelOpen, timers, now,
//          brain?: boolean (false = no brain configured → free-mode intents of CR1.4), facts?: () => [{text}] }
// export const LEARN_SIGNAL, MODEL_WORDS, DIM_WORDS; export function modelRequest(t, anrede?); modelSaid(spec, anrede?);
//                 timerStatus(timers, now?, anrede?)                                       (live Mac 13.10., §7.7)
// export function confirmText(actions, fallback?, anrede?); bossOkay(text, anrede?); withClosing(text, actions, closing)
// export const CLOSING_EXCLUDED
// export const SENTENCE_END; export function voiceText(text, opts?); export function splitFirst(text)
// ==============================================================================================================
// Sprachlogik von Jarvis: Weckwort, Schließen/Hintergrund, Zahlen und Zeiten, Schnellbefehle ohne KI und alle
// gesprochenen Sätze. Portiert aus jarvis.py (Mac, Stand 13.10.2026); die Regexe sind wörtlich übernommen und laufen
// über ure(), damit \b und \w auch Umlaute als Buchstaben behandeln (wie Pythons re).

export const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
export const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September",
  "Oktober", "November", "Dezember"];

// ---------------------------------------------------------------------------------------------- ure (§0.4 rule 4)
const WC = "\\p{L}\\p{N}_";
const UB = `(?:(?<=[${WC}])(?![${WC}])|(?<![${WC}])(?=[${WC}]))`;
const SYNTAX = new Set([..."^$\\.*+?()[]{}|/"]);
const KEEP = new Set([..."bBdDsSwWnrtfv0123456789uxcpPk"]);

export function ure(src, flags = "") {
  let out = "", inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[++i];
      if (n === "b" && !inClass) out += UB;
      else if (n === "w") out += inClass ? WC : `[${WC}]`;
      else if (n === "W" && !inClass) out += `[^${WC}]`;
      else if (KEEP.has(n) || SYNTAX.has(n) || (inClass && n === "-")) out += "\\" + n;
      else out += n;                       // \" \' \„ … are invalid under /u
      continue;
    }
    if (c === "[" && !inClass) inClass = true;
    else if (c === "]" && inClass) inClass = false;
    out += c;
  }
  if (out.startsWith("(?i)")) { out = out.slice(4); if (!flags.includes("i")) flags += "i"; }
  return new RegExp(out, flags.includes("u") ? flags : flags + "u");
}

// re.fullmatch(p, t) → full(p).test(t); re.match → start(p)
const full = (src, flags = "") => ure(`^(?:${src})$`, flags);
const start = (src, flags = "") => ure(`^(?:${src})`, flags);

// ---------------------------------------------------------------------------------------------- small helpers
function words(s) {
  const t = String(s ?? "").trim();
  return t ? t.split(/\s+/) : [];
}
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const pad2 = (n) => String(n).padStart(2, "0");

// Python str.capitalize()
function capitalize(s) {
  const t = String(s ?? "");
  return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : t;
}

// Mac nice(): Wörter > 2 Zeichen groß anfangen, kurze ganz groß („YouTube“ → „Youtube“, „x“ → „X“)
function nice(name) {
  return words(name).map((w) => (w.length > 2 ? capitalize(w) : w.toUpperCase())).join(" ");
}

function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return ""; }
}

// Mac re.sub(r"[^\wäöüß\s%]", " ", text.lower()) + Leerraum zusammenfassen
const NON_WORD = ure("[^\\wäöüß\\s%]", "g");
function plain(text) {
  return squash(String(text ?? "").toLowerCase().replace(NON_WORD, " "));
}

const TLD_WORDS = "de|com|net|org|io|ai|eu|at|ch|nl|be|fr|it|es|tv|me|app|shop|info|online|store|gg|fm";
const DOMAIN_DOT = ure(`\\b([a-z0-9äöü][a-z0-9äöü-]*)\\.(${TLD_WORDS})\\b`, "g");

/** Mac quick_intent-Normalisierung (jarvis.py L2766-2770): „bild.de“ → „bild punkt de“, nur Wörter, klein. */
export function norm(text) {
  const low = String(text ?? "").toLowerCase()
    .replace(DOMAIN_DOT, (_, name, tld) => `${name.replace(/-/g, " bindestrich ")} punkt ${tld}`);
  return plain(low);
}

// ---------------------------------------------------------------------------------------------- Sätze (§5)
export const LINES = Object.freeze({
  // §5.2 gesprochen
  presence: "Ja, {A}?",
  thanks: "Jederzeit, {A}.",
  byeNight: "Gute Nacht, {A}.",
  byeMorning: "Bis morgen, {A}.",
  byeLater: "Bis später, {A}.",
  show: "Hier bin ich, {A}.",
  newSession: "Alles klar, neues Gespräch.",
  time: "Es ist {h} Uhr {mm}.",
  date: "Heute ist {weekday}, der {d}. {month}.",
  timerSet: "Timer auf {dauer} gestellt.",
  alarmSet: "Wecker auf {h} Uhr {mm} gestellt.",
  timerDone: "{A}, dein Timer für {label} ist abgelaufen.",
  timerDonePlain: "{A}, dein Timer ist abgelaufen.",
  timerMissed: "{A}, dein Timer für {label} ist abgelaufen, während ich geschlossen war.",
  timerMissedPlain: "{A}, dein Timer ist abgelaufen, während ich geschlossen war.",
  timerStatusNone: "Gerade läuft kein Timer, {A}.",
  timerStopped: "Okay, {A}, Timer gestoppt.",
  noTimer: "Es läuft gerade kein Timer.",
  closingDefault: "{A}, kann ich sonst noch was für Sie tun?",
  // öffentliche Seite: kein Verweis auf einen Mac-Jarvis, den Besucher nicht haben (visual-ux-6)
  macOnly: "Das kann ich hier nicht, {A}.",
  macOnlyMusic: "Das kann ich hier nicht, {A}. Ton und Musik regelst du am {G} selbst.",
  macOnlyWhatsApp: "WhatsApp vorlesen kann ich hier nicht, {A}.",
  macOnlyMail: "Deine Mails kann ich hier nicht lesen, {A}.",
  macOnlyApps: "Programme schließen kann ich hier nicht, {A}.",
  macOnlyHotspot: "Den Hotspot kann ich hier nicht verbinden, {A}.",
  macOnlyTeach: "Neue Fähigkeiten kann ich mir hier nicht selbst beibringen, {A}.",
  nokey: "Ich bin noch nicht mit Claude verbunden. Trag bitte deinen Claude-Schlüssel in den Einstellungen ein.",
  noBrain: "Dafür brauche ich mein Gehirn, {A}. Mit einem kostenlosen Gemini-Schlüssel von Google denke ich mit. "
    + "Den trägst du in den Einstellungen ein.",
  "err.auth": "Der Claude-Schlüssel wird nicht angenommen, {A}. Schau bitte in die Einstellungen.",
  "err.credit": "Dein Claude-Guthaben ist aufgebraucht, {A}. Lade es in der Claude-Konsole auf.",
  "err.rate": "Kurz zu viele Anfragen, {A}. Gib mir einen Moment.",
  "err.network": "Ich erreiche Claude gerade nicht. Hast du Netz, {A}?",
  "err.timeout": "Claude braucht gerade zu lange, {A}. Versuch es gleich noch einmal.",
  "err.server": "Claude ist gerade überlastet. Versuch es gleich noch einmal.",
  "err.other": "Da ist etwas schiefgelaufen, {A}. Versuch es bitte noch einmal.",
  "err.gemini.auth": "Der Gemini-Schlüssel stimmt nicht, {A}. Schau bitte in den Einstellungen nach.",
  "err.gemini.rate": "Das kostenlose Kontingent ist gerade aufgebraucht, {A}. Versuch es gleich nochmal.",
  "err.gemini.cut": "Da kam keine Antwort durch, {A}. Versuch es bitte noch einmal, gern etwas kürzer.",
  "err.gemini.server": "Gemini ist gerade überlastet, {A}. Versuch es gleich noch einmal.",
  "err.gemini.network": "Ich erreiche Gemini gerade nicht. Hast du Netz, {A}?",
  "err.gemini.timeout": "Gemini braucht gerade zu lange, {A}. Versuch es gleich noch einmal.",
  refusal: "Dazu sage ich lieber nichts, {A}.",
  blockedAfterWeb: "Das löse ich wegen einer Webseite nicht automatisch aus, {A}. Sag es mir direkt, dann mache ich es.",
  actionFailed: "Das hat leider nicht geklappt.",
  weatherNoData: "Ich komme gerade nicht an die Wetterdaten.",
  weatherNoPlace: "Den Ort {place} finde ich nicht.",
  weatherNoHome: "Für das Wetter brauche ich deinen Wohnort, {A}. Trag ihn bitte in den Einstellungen ein.",
  imageNone: "Ich finde gerade kein Bild von {query}.",
  imageNoMore: "Ich finde kein weiteres Bild von {query}.",
  imageNoneYet: "Ich hab dir noch kein Bild gezeigt.",
  learnFail: "Den Kurzbefehl kann ich so nicht anlernen.",
  forgetUnknown: "Einen Kurzbefehl „{phrase}“ kenne ich nicht.",
  noteEmpty: "Was soll ich mir merken?",
  forgetEmpty: "Was soll ich vergessen?",
  noteUnknown: "Dazu habe ich mir nichts gemerkt.",
  noteAmbiguous: "Dazu habe ich mehrere Sachen gemerkt: {list}. Welche soll ich vergessen?",
  noteDone: "Okay, {A}, hab ich mir gemerkt.",
  forgetDone: "Okay, {A}, hab ich vergessen.",
  notesList: "Das habe ich mir gemerkt: {list}.",
  notesMore: "Und noch {n} weitere stehen unter ⚙ → Daten.",
  notesNone: "Ich habe mir noch nichts gemerkt, {A}.",
  learnOnlyOwn: "Das lerne ich nur, wenn du es mir selbst sagst.",
  modelShow: "Okay, {A}, ich zeige dir {name}{suffix}.",
  modelTitle: "Okay, {A}, hier ist dein 3D-Modell: {title}.",
  modelDims: "Okay, {A}, hier ist dein Modell in {dims}D.",
  modelAny: "Okay, {A}, hier ist dein 3D-Modell.",
  orbOk: "Okay, {A}.",
  settingUnknown: "Das kann ich bei mir nicht einstellen.",
  settingRange: "Für {what} geht nur {lo} bis {hi}.",
  settingValue: "Den Wert verstehe ich nicht.",
  kontoValue: "Den Betrag verstehe ich nicht, {A}.",
  terminValue: "Den Termin verstehe ich nicht, {A}. Sag mir Tag und Uhrzeit.",
  terminNone: "Diesen Termin finde ich nicht in deiner Liste.",
  kontoSaid: "Ich trage deinen Kontostand von {betrag} ein.",
  terminSaid: "Ich trage {titel} {wann} ein.",
  callNoNumber: "Dafür brauche ich eine Telefonnummer, {A}.",
  waReady: "Steht bereit für {to}. Tipp auf WhatsApp und dann auf Senden.",
  waReadyPlain: "Die Nachricht steht bereit. Tipp auf WhatsApp und wähl den Chat.",
  repeatNothing: "Ich habe noch nichts gesagt, {A}.",
  voiceTest: "{greeting}, {A}. Alle Systeme sind online und bereit. Womit fangen wir heute an?",
  connected: "Verbunden. Was kann ich tun, {A}?",
  brainOk: "Gehirn verbunden.",
  // §5.1 Anzeige (app via hud)
  idleBoot: "Bereit. Sag „Hey Jarvis“.",
  idleBootNoWake: "Bereit. Tipp auf die Kugel oder schreib unten.",
  followUpDetail: "Noch etwas, {A}?",
  // {T} = „zweimal tippen“ bzw. am Rechner „Doppelklick“ (visual-ux-11/13)
  veilStealth: "☾ Still im Hintergrund · „Jarvis“ oder {T} holt mich zurück",
  veilStealthPlain: "☾ Still im Hintergrund · „Jarvis“ holt mich zurück",
  veilHidden: "◐ Ausgeblendet · „Jarvis“ oder {T} holt mich zurück",
  veilHiddenPlain: "◐ Ausgeblendet · „Jarvis“ holt mich zurück",
  veilMuted: "✕ Stumm · „Jarvis“ oder {T} holt mich zurück",
  veilMutedPlain: "✕ Stumm · „Jarvis“ holt mich zurück",
  veilNoMic: "Mikrofon pausiert · {T} holt mich zurück",
  veilNoMicPlain: "Mikrofon pausiert · zweimal tippen",
  unlockStart: "Tippen, um Jarvis zu starten",
  unlockAnswer: "Tippen, um die Antwort zu hören",
  unlockAwake: "Tippen, um Jarvis wach zu halten",
  // §5.3 Protokoll
  readyLog: "Alle Systeme online. Sag „Hey Jarvis“.",
  readyLogNoWake: "Alle Systeme online.",
  stealthLog: "Still im Hintergrund. „Hey Jarvis“ oder einfach „Jarvis“ holt mich zurück.",
  micDenied: "Das Mikrofon ist für Jarvis gesperrt. Erlaube es in den iPhone-Einstellungen oder diktiere über die Tastatur.",
  micDeniedWeb: "Das Mikrofon ist gesperrt. Erlaube es für diese Seite oder diktiere über die Tastatur.",
  // service-not-allowed: Siri/Diktierfunktion aus (iOS) bzw. Sprachdienst nicht erreichbar – nicht das Mikrofon
  speechOff: "Die Spracherkennung ist aus: Einstellungen → Allgemein → Tastatur → Diktierfunktion (oder Siri) einschalten.",
  speechOffWeb: "Die Spracherkennung ist hier gerade nicht verfügbar. Tipp einfach, ich versuche es später wieder.",
  // CR3: Browser ohne Spracherkennung
  noListen: "In diesem Browser kann ich nicht zuhören. Tipp einfach, oder öffne mich in Chrome oder Safari.",
});

let defaultAnrede = "Boss";
let deviceName = "iPhone";

/** Anrede, die line() für {A} nimmt, wenn vars.A fehlt (app setzt sie beim Start und bei jeder Änderung). */
export function setAnrede(name) {
  defaultAnrede = String(name ?? "").trim() || "Boss";
}

/** Gerät für {G} in den Sätzen und im Gehirn („iPhone“, „iPad“, „Handy“, „Tablet“, „Computer“; CR3.1). */
export function setDevice(name) {
  deviceName = String(name ?? "").trim() || "Gerät";
}

/** @returns {string} */
export function device() {
  return deviceName;
}

const appleDevice = () => deviceName === "iPhone" || deviceName === "iPad";

const anredeOf = (a) => String(a ?? "").trim() || defaultAnrede;

/**
 * Satz aus LINES mit Platzhaltern ({A} = Anrede). Fehlt ein Platzhalter und gibt es eine Variante „<key>Plain“
 * (z. B. timerDone ohne Namen), wird diese genommen. Unbekannter Schlüssel → "".
 */
export function line(key, vars = {}) {
  let tpl = LINES[key];
  if (tpl == null) return "";
  const v = { ...(vars || {}) };
  v.A = anredeOf(v.A);
  if (v.G == null || String(v.G).trim() === "") v.G = deviceName;
  const plainTpl = LINES[`${key}Plain`];
  if (plainTpl != null) {
    const needed = [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((n) => n !== "A");
    if (needed.some((n) => v[n] == null || String(v[n]).trim() === "")) tpl = plainTpl;
  }
  let out = tpl.replace(/\{(\w+)\}/g, (_, n) => (v[n] == null ? "" : String(v[n])));
  if (key === "time" || key === "alarmSet") out = out.replace(" Uhr 00", " Uhr");
  return out;
}

// ---------------------------------------------------------------------------------------------- Zahlen und Zeiten
const NUMBER_WORDS = Object.freeze({
  null: 0, ein: 1, eins: 1, eine: 1, einen: 1, einer: 1, zwei: 2, drei: 3,
  vier: 4, "fünf": 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11,
  "zwölf": 12, dreizehn: 13, vierzehn: 14, "fünfzehn": 15, sechzehn: 16, siebzehn: 17,
  achtzehn: 18, neunzehn: 19, zwanzig: 20, "dreißig": 30, vierzig: 40, "fünfzig": 50,
  sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90, hundert: 100,
});
const TENS_RX = full("(\\w+?)und(zwanzig|dreißig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig)");
const HALF_RX = full("(\\w+?)einhalb");

/** jarvis.py parse_number; phone-only (bug 38): „anderthalb“ = 1,5, „<zahl>einhalb“ = zahl + 0,5. */
export function parseNumber(token) {
  const t = String(token ?? "").trim().toLowerCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (own(NUMBER_WORDS, t)) return NUMBER_WORDS[t];
  let m = TENS_RX.exec(t);
  if (m && own(NUMBER_WORDS, m[1])) return NUMBER_WORDS[m[1]] + NUMBER_WORDS[m[2]];
  if (t === "anderthalb") return 1.5;
  m = HALF_RX.exec(t);
  if (m) {
    const n = m[1] === "ein" ? 1 : parseNumber(m[1]);
    if (n != null) return n + 0.5;
  }
  return null;
}

const HALF_HOUR = ure("halbe[n]? stunde");
const QUARTER_HOUR = ure("viertel ?stunde");
const DURATION = ure("(\\S+)\\s+(sekunden?|minuten?|stunden?)\\b", "g");
const UNIT_SECONDS = { sekunde: 1, minute: 60, stunde: 3600 };

/** 'fünf minuten', 'eine halbe stunde', '1 stunde und 20 minuten', 'eineinhalb stunden' -> Sekunden (oder null). */
export function parseDuration(text) {
  const t = String(text ?? "");
  if (HALF_HOUR.test(t)) return 1800;
  if (QUARTER_HOUR.test(t)) return 900;
  let total = 0;
  for (const m of t.matchAll(DURATION)) {
    const n = parseNumber(m[1]);
    if (n == null) continue;
    total += n * UNIT_SECONDS[m[2].replace(/n+$/, "")];
  }
  return total ? Math.round(total) : null;
}

export function sayDuration(seconds) {
  const sec = Math.trunc(Number(seconds) || 0);
  const h = Math.floor(sec / 3600), rest = sec % 3600;
  const m = Math.floor(rest / 60), s = rest % 60;
  const parts = [];
  if (h) parts.push(`${h} Stunde${h > 1 ? "n" : ""}`);
  if (m) parts.push(`${m} Minute${m > 1 ? "n" : ""}`);
  if (s && !h) parts.push(`${s} Sekunde${s > 1 ? "n" : ""}`);
  return parts.join(" und ") || "0 Sekunden";
}

const asDate = (d) => (d instanceof Date ? d : new Date(d ?? Date.now()));

export function sayTime(date = new Date()) {
  const d = asDate(date);
  return line("time", { h: d.getHours(), mm: pad2(d.getMinutes()) });
}

export function sayDate(date = new Date()) {
  const d = asDate(date);
  return line("date", { weekday: WEEKDAYS[d.getDay()], d: d.getDate(), month: MONTHS[d.getMonth()] });
}

// ---------------------------------------------------------------------------------------------- Weckwort (§7.2)
export const NAME_STRONG = "(?:jarvis|jarwis|jervis|jarvi|javis|jarves|jarvys|charvis|tscharvis|dscharwis|dschawis|tschawis|dschavis|garvis)";
export const NAME_WEAK = "(?:java)";                       // iOS-Diktat macht aus „Jarvis“ oft „Java“ – nur nach einem Gruß
export const GREET = "(?:hey|hi|hallo|hello|okay|ok|yo|morning|moin|he|hei|servus)";
const SEP = "[\\s,.!?:;-]+";
const WAKE_SRC = `(?:\\b${GREET}${SEP})?\\b${NAME_STRONG}\\b|\\b${GREET}${SEP}${NAME_WEAK}\\b`;
const WAKE_RX = ure(WAKE_SRC, "gi");
const GREET_START = start(`${GREET}\\b`, "i");
// Mac PRESENCE (jarvis.py L78-79)
const PRESENCE_RX = ure("\\b(bist|ist du|hörst|hörst du|wach|aufwachen|aufgewacht|online|bereit|"
  + "anwesend|brauche? dich|noch da|wieder da|bist du da|kannst du mich)\\b");
const LEAD_SEP = /^[\s,.!?:;-]+/u;

/** Letzter Weckwort-Treffer im Text; rest = was danach kommt. */
export function matchWake(text) {
  const raw = String(text ?? "");
  let m, last = null;
  WAKE_RX.lastIndex = 0;
  while ((m = WAKE_RX.exec(raw))) {
    last = m;
    if (m[0] === "") WAKE_RX.lastIndex++;
  }
  WAKE_RX.lastIndex = 0;
  if (!last) return null;
  const rest = raw.slice(last.index + last[0].length).replace(LEAD_SEP, "").trim();
  const presence = rest !== "" && PRESENCE_RX.test(norm(rest)) && words(rest).length <= 6;
  return { rest, presence, greeted: GREET_START.test(last[0]), raw };
}

// Mac WAKE_PREFIX (L362-364) mit den erweiterten Listen; „service“ nur hier, nie in WAKE_RX
const WAKE_PREFIX = ure(`^\\W*(${GREET}\\W+)?(${NAME_STRONG}|${NAME_WEAK}|service)\\b[\\s,.!?:;-]*`, "i");

export function stripWakePrefix(text) {
  return String(text ?? "").replace(WAKE_PREFIX, "");
}

// jarvis.py FILLERS + clean_transcript (L383, L400-405)
const FILLERS = ure("(?i)(^|[\\s,.;!?])(äh+m*|ähm+|öh+m*|hm+|mhm|uh+m*|ehm+|äm+)(?=$|[\\s,.;!?])", "g");
const COMMA_IM = ure(",\\s*im\\s*,", "g");
const SPACE_PUNCT = ure("\\s+([,.!?])", "g");
const LEAD_TRAIL = ure("^[\\s,.;]+|(?<=[,.;])[,.;]+", "g");

export function cleanTranscript(text) {
  let t = String(text ?? "").replace(FILLERS, "$1");
  t = t.replace(COMMA_IM, ",");
  t = t.replace(/\s{2,}/g, " ").replace(SPACE_PUNCT, "$1");
  return t.replace(LEAD_TRAIL, "").trim();
}

// jarvis.py HESITATE / HESITATE_VERB (L378-382)
const HESITATE = ure("\\b(und|oder|aber|dass|weil|wenn|ob|der|die|den|dem|des|ein|eine|einen|einem|einer|mein|meine|"
  + "meinen|meinem|meiner|mit|von|vom|zum|zur|für|bei|über|unter|im|in|nach|am|also|äh|ähm|hm)$");
const HESITATE_VERB = ure("^(spiel|spiele|spieler|schreib|schreibe|sag|sage|mach|mache|öffne|zeig|zeige|such|suche|"
  + "starte?|ruf|rufe|stell|schick|schicke|erinnere|check|checke|scheck|schau|guck|google|"
  + "navigier\\w*)( mal| mir| mich| bitte| kurz| äh| ähm)*$");

/** Klingt der Satz noch nicht fertig („spiel …“, „… und“)? */
export function isHesitant(text) {
  const h = norm(text);
  return HESITATE.test(h) || HESITATE_VERB.test(h);
}

// ---------------------------------------------------------------------------------------------- Schließen / Hintergrund
// jarvis.py L2952-3073 (live), wörtlich
const CLOSE_FILLER = ure("\\b(bitte|mal|jetzt|doch|einfach|sofort|jarvis|boss|kannst du|könntest du|"
  + "würdest du|du kannst|du darfst|ok|okay|so|ich)\\b", "g");
const CLOSE_PHRASE = "(schlie(ß|ss)e? dich|mach dich (zu|weg|aus)|beende? dich|blende? dich aus|versteck dich|"
  + "schalte? dich (aus|ab)|dich (ausschalten|abschalten|beenden|schließen|schliessen|ausblenden)|"
  + "geh (weg|schlafen|offline)|verzieh dich|verschwinde|overlay (aus|zu|schließen|ausblenden|beenden)|"
  + "verpiss dich|verpisst dich|verbiss dich|hau ab|zieh ab|mach die fliege|abflug|ab mit dir|"
  + "halt die klappe|klappe|schnauze|leg dich schlafen)";
const CLOSE_ONLY = full("(schließen|schliessen|schließ|schliess|schließe|schließlich|schliesslich|"
  + "schließt dich|schließ mich|schließt mich|ausschalten|abschalten|ausblenden|"
  + "beenden|beende|zumachen|aus|weg|ende|schluss|schalt ab|schalte ab|mach aus|mach zu|"
  + CLOSE_PHRASE + ")");
const CLOSE_IN = ure("\\b" + CLOSE_PHRASE + "\\b");
const CLOSE_IN_G = ure("\\b" + CLOSE_PHRASE + "\\b", "g");
const CLOSE_AT_START = start("\\b" + CLOSE_PHRASE + "\\b");
const CLOSE_STRONG = new Set(["ausschalten", "abschalten", "ausblenden", "beenden", "schließen", "schliessen", "verschwinde",
  "abflug", "schließlich", "schliesslich", "zumachen"]);

/** Ist der ganze Satz nur „schließ dich“, „verpiss dich“, „Jarvis aus“ …? strong: nur eindeutige Befehle (live). */
export function isCloseCommand(text, strong = false) {
  const t = plain(text);
  const c = squash(t.replace(CLOSE_FILLER, " "));
  return !!(c && CLOSE_ONLY.test(c) && (!strong || words(c).length >= 2 || CLOSE_STRONG.has(c)));
}

const SOFT = "(?:(?:still|stil|leise|ruhig|stumm|unsichtbar|versteckt|einfach|bitte|jetzt|mal|nur|ganz|schön|weiter) )*";
const STEALTH_STRONG = "(bleib\\w* " + SOFT + "(?:im|in dem|in den) hintergrund(?: (?:offen|an|aktiv|wach|da|weiter))?"
  + "|(?:geh|gehe|verschwinde?|verzieh dich|zieh dich zurück|zieh dich|ab) " + SOFT
  + "(?:in den|ins|in) hintergrund(?: zurück)?"
  + "|(?:lauf|laufe|arbeite|warte|lausche|hör|höre) " + SOFT + "im hintergrund(?: (?:weiter|zu|mit))?"
  + "|tauch\\w* " + SOFT + "ab"
  + "|(?:blende?|mach|versteck|verstecke) dich (?:komplett|ganz|vollständig|total) (?:aus|weg|unsichtbar)"
  + "|versteck\\w* dich (?:komplett|ganz|vollständig|total)"
  + "|verschwinde? (?:komplett|ganz|vollständig|total)"
  + "|(?:mach dich|sei|werd|werde) unsichtbar"
  + "|(?:geh|gehe|wechsel|wechsle|schalt|schalte) (?:in den |in )?(?:tarn ?modus|stealth ?(?:modus|mode)|"
  + "hintergrund ?modus|unsichtbar ?modus))";
const STEALTH_SOFT = "((?:still|leise|ruhig|unsichtbar) im hintergrund(?: (?:offen|an|aktiv|wach|weiter))?"
  + "|im hintergrund (?:offen |an |aktiv |wach |still |leise )?bleiben|abtauchen|unsichtbar"
  + "|(?:in den |in )?(?:tarn ?modus|stealth ?(?:modus|mode)|hintergrund ?modus|unsichtbar ?modus))";
const STEALTH_STRONG_IN = ure("\\b" + STEALTH_STRONG + "\\b");
const STEALTH_STRONG_IN_G = ure("\\b" + STEALTH_STRONG + "\\b", "g");
const STEALTH_IN = ure("\\b(?:" + STEALTH_STRONG + "|" + STEALTH_SOFT + ")\\b");
const STEALTH_IN_G = ure("\\b(?:" + STEALTH_STRONG + "|" + STEALTH_SOFT + ")\\b", "g");
const STEALTH_FILLER = ure("\\b(und|dann|danach|aber|bitte|jetzt|mal|einfach|sofort|jarvis|boss|ok|okay|so|doch|"
  + "ganz|komplett|still|stil|leise|ruhig|stumm|sei|bleib|bleibe|offen|da|danke(?: schön| dir)?|"
  + "alles klar|ab jetzt|ab sofort|erstmal|erst mal|hey|hallo|"
  + "bis ich (?:dich )?(?:wieder )?(?:rufe|brauche|hole))\\b", "g");
const STAY_WORDS = new Set(["bleib", "bleibe", "sei", "still", "stil", "leise", "ruhig", "stumm", "im", "in", "hintergrund",
  "offen", "an", "aktiv", "wach", "aber", "hör", "hörst", "hören", "weiter", "zu", "mal", "da", "einfach", "dort"]);
const STAY_REAL = new Set(["bleib", "bleibe", "hintergrund", "offen", "still", "stil", "leise", "ruhig", "stumm", "wach",
  "aktiv"]);
const STILL_EM = ure("\\bstill(?:em|en) hintergrund\\b", "g");
const HINTERGRUND_OFEN = ure("\\bhintergrund ofen\\b", "g");
const CLOSE_REST_FILLER = ure("\\b(und|dann|danach|jetzt|ich|bitte|jarvis|boss|so)\\b", "g");

/**
 * Steckt „bleib still im Hintergrund“ & Co. im Satz? Rest ohne Befehl und Füllwörter ("" = nur der Befehl) oder
 * null. strict: nur Befehle mit eigenem Verb (Kombis, Live-Erkennung). jarvis.py stealth_rest.
 */
export function stealthRest(text, strict = false) {
  let t = plain(text);
  t = t.split("hinter grund").join("hintergrund").replace(STILL_EM, "still im hintergrund");
  t = t.replace(HINTERGRUND_OFEN, "hintergrund offen");
  const found = strict ? STEALTH_STRONG_IN : STEALTH_IN;
  const foundG = strict ? STEALTH_STRONG_IN_G : STEALTH_IN_G;
  if (found.test(t)) {
    const rest = squash(t.replace(foundG, " ").replace(CLOSE_IN_G, " ").replace(STEALTH_FILLER, " "));
    return rest && words(rest).every((w) => STAY_WORDS.has(w)) ? "" : rest;
  }
  if (CLOSE_IN.test(t)) {
    const rest = words(t.replace(CLOSE_IN_G, " ").replace(CLOSE_REST_FILLER, " "));
    if (rest.length && rest.every((w) => STAY_WORDS.has(w)) && rest.some((w) => STAY_REAL.has(w))) return "";
  }
  return null;
}

export function isStealthCommand(text, strict = false) {
  return stealthRest(text, strict) === "";
}

const AND_THEN = ure("\\b(und|dann|danach)\\b");

/** „Mach die Musik aus und tauch ab“: echter zweiter Satzteil mit eigenem Verb, durch und/dann getrennt. */
export function stealthCombo(text) {
  const t = plain(text);
  return STEALTH_STRONG_IN.test(t) && AND_THEN.test(t);
}

/** Live-Zwischenstand ist ein eindeutiger Schließ- oder Hintergrund-Befehl. */
export function endsWithHide(text) {
  return isCloseCommand(text, true) || isStealthCommand(text, true);
}

const FAREWELL = full("((danke( schön| dir)?|okay|ok|gut|alles klar|super) )*"
  + "(das wars|das war s|das war alles|das wärs|das wär s|das wäre alles|tschüss|tschüs|ciao|tschau|bye( bye)?|"
  + "bis später|bis dann|bis morgen|bis bald|bis gleich|auf wiedersehen|gute nacht|"
  + "(ich mach|machen wir|mach) feierabend|feierabend)"
  + "( (für heute|erstmal|boss|jarvis|danke|dir))*");

export function isFarewell(text) {
  return FAREWELL.test(norm(text));
}

// ---------------------------------------------------------------------------------------------- Wetter (L3111-3184)
const WEATHER_Q = ure("\\b(wetter\\w*|wie warm|wie kalt|wie viel grad|wieviel grad|temperatur\\w*|regnet es|"
  + "wird es regnen|regnet s|gibt es regen|gibt s regen|regenschirm|brauch\\w* ich (?:einen |nen )?"
  + "(?:regen)?schirm|scheint (?:die )?sonne|sonne scheinen)\\b");
const WEATHER_BLOCK = ure("^(spiel|spiele|google|googel|such|suche|schreib|schreibe|schick|schicke|erinnere|mach|mache|"
  + "schließ|schließe|beende|öffne|öffnen|starte|start|stell|übersetz\\w*|erklär\\w*)\\b|"
  + "\\b(unterschied|klima\\w*|backofen|ofen|cpu|prozessor|mac|rechner|computer|akku|wasser|"
  + "kühlschrank|raum|zimmer|wohnung|dusche|kaffee|tee|pizza|grill)\\b");
const WEATHER_WORD = ure("\\b(wetter\\w*|regn\\w*|regen\\w*|schirm|sonne)\\b");
const WEATHER_CONTEXT = ure("\\b(es|draußen|heute|morgen|übermorgen|wochenende|in|im|auf|bei)\\b");
const PLACE_STOP = new Set(("heute morgen übermorgen montag dienstag mittwoch donnerstag freitag samstag sonntag wochenende woche "
  + "jetzt gerade grade aktuell abend nacht früh mittag nachmittag vormittag am an diese dieses diesen "
  + "nächste nächsten nächster kommende kommenden bitte mal so aus wird ist sein werden es aussehen "
  + "aussieht sieht regnen regnet scheinen sonnig warm kalt und oder wie grad da los heut tage tagen "
  + "noch eigentlich denn gibt geben").split(" "));
const PLACE_BAD = new Set(["moment", "augenblick", "allgemeinen", "freien", "nähe", "hier", "draußen", "garten", "zukunft",
  "zuhause", "hause", "mir", "mich", "uns", "dir", "euch", "gegend", "stadt", "ordnung", "boss", "jarvis",
  "wohnung", "arbeit", "büro", "wohnzimmer", "schlafzimmer", "küche", "keller", "urlaub", "haus", "laden",
  "schule", "auto", "bett"]);
const PLACE_NUMBERS = new Set(["ein", "eine", "einer", "einem", "einen", "zwei", "drei", "vier", "fünf", "sechs", "sieben",
  "acht", "neun", "zehn", "elf", "zwölf", "paar"]);
const TIME_WORDS = new Set(["tag", "tage", "tagen", "stunde", "stunden", "woche", "wochen", "minuten", "laufe", "uhr",
  "später", "gleich", "gegen", "um", "abends", "morgens", "mittags", "nachts", "nachher", "bald"]);
const WEEKDAY_SRC = "\\b(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)"
  + "(?:morgen|früh|vormittag|mittag|nachmittag|abend|nacht)?\\b";
const WEEKDAY_RX = ure(WEEKDAY_SRC);
const WEEKDAY_FULL = full(WEEKDAY_SRC);
const PLACE_PREPS = ["in", "im", "für", "bei", "auf", "an"];
const DAYS_AHEAD = { zwei: 2, drei: 3, vier: 4, "fünf": 5, sechs: 6, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
const GUTEN_MORGEN = ure("\\bguten morgen\\b", "g");
const IN_DAYS = ure("\\bin (zwei|drei|vier|fünf|sechs|[2-6]) tagen\\b");
const RX_UEBERMORGEN = ure("\\bübermorgen\\b");
const RX_HEUTE = ure("\\b(heute|heut)\\b");
const RX_MORGEN = ure("\\bmorgen\\b");
const RX_WOCHE = ure("\\b(woche|(?:nächsten|kommenden) tag(?:e|en)|die tage)\\b");
const RX_WETTER_PLACE = ure("\\bwetter(?:bericht|vorhersage|lage)?\\s+(.+)$");
const ARTICLES = new Set(["der", "die", "das", "dem", "den"]);

/** Ort und Tag aus einer Wetterfrage („wie wird das Wetter morgen in Köln“ → {place: "köln", day: "morgen"}). */
export function weatherQuery(t0) {
  const t = squash(String(t0 ?? "").replace(GUTEN_MORGEN, " "));
  const wd = WEEKDAY_RX.exec(t);
  const ahead = IN_DAYS.exec(t);
  const day = RX_UEBERMORGEN.test(t) ? "übermorgen" : RX_HEUTE.test(t) ? "heute"
    : wd ? wd[1] : ahead ? `in${DAYS_AHEAD[ahead[1]]}`
      : RX_MORGEN.test(t) ? "morgen" : t.includes("wochenende") ? "wochenende"
        : RX_WOCHE.test(t) ? "woche" : "heute";
  let ws = words(t);
  let place = "";
  const grab = (j0) => {
    let j = j0;
    while (j < ws.length && ARTICLES.has(ws[j])) j++;
    const out = [];
    while (j < ws.length && !PLACE_STOP.has(ws[j]) && !PLACE_PREPS.includes(ws[j])
      && !WEEKDAY_FULL.test(ws[j]) && out.length < 4) {
      out.push(ws[j]);
      j++;
    }
    const cand = out.join(" ");
    if (!cand || PLACE_BAD.has(cand) || PLACE_BAD.has(out[0]) || PLACE_NUMBERS.has(out[0]) || /^\d/.test(cand)
      || out.some((w) => TIME_WORDS.has(w))) return "";
    return cand;
  };
  for (let i = 0; i < ws.length; i++) {
    if (PLACE_PREPS.includes(ws[i]) && grab(i + 1)) {
      place = grab(i + 1);
      break;                                   // der erste Ort zählt
    }
  }
  if (!place) {
    const m = RX_WETTER_PLACE.exec(t);
    if (m) {                                    // „Wetter Köln“, „Wetter morgen Köln“
      ws = words(m[1]);
      const s = ws.findIndex((w) => !PLACE_STOP.has(w) && !PLACE_PREPS.includes(w));
      place = s >= 0 ? grab(s) : "";
    }
  }
  return { place, day };
}

// ---------------------------------------------------------------------------------------------- Seiten (§7.4)
// Mac DEFAULTS["sites"] (jarvis.py L116-153) wörtlich; Telefon: maps/karten → Apple Karten (nur iPhone/iPad, sonst
// Google Maps wie am Mac, siehe siteFor), WhatsApp → wa.me, Snapchat ohne „web.“.
export const SITES = Object.freeze({
  "youtube": "https://www.youtube.com", "google": "https://www.google.com",
  "gmail": "https://mail.google.com", "mails": "https://mail.google.com",
  "kalender": "https://calendar.google.com", "google drive": "https://drive.google.com",
  "tiktok": "https://www.tiktok.com", "instagram": "https://www.instagram.com",
  "netflix": "https://www.netflix.com", "amazon": "https://www.amazon.de",
  "maps": "https://maps.apple.com", "karten": "https://maps.apple.com", "google maps": "https://maps.google.com",
  "whatsapp": "https://wa.me/", "twitter": "https://x.com", "x": "https://x.com",
  "facebook": "https://www.facebook.com", "linkedin": "https://www.linkedin.com",
  "twitch": "https://www.twitch.tv", "github": "https://github.com",
  "claude": "https://claude.ai", "revenuecat": "https://app.revenuecat.com",
  "buffer": "https://publish.buffer.com", "fish audio": "https://fish.audio",
  "spotify": "https://open.spotify.com",
  "ebay": "https://www.ebay.de", "kleinanzeigen": "https://www.kleinanzeigen.de",
  "ebay kleinanzeigen": "https://www.kleinanzeigen.de", "paypal": "https://www.paypal.com/de",
  "chatgpt": "https://chatgpt.com", "wikipedia": "https://de.wikipedia.org",
  "spiegel": "https://www.spiegel.de", "bild": "https://www.bild.de", "tagesschau": "https://www.tagesschau.de",
  "n tv": "https://www.n-tv.de", "ntv": "https://www.n-tv.de", "welt": "https://www.welt.de",
  "t online": "https://www.t-online.de", "rp online": "https://rp-online.de", "kicker": "https://www.kicker.de",
  "otto": "https://www.otto.de", "zalando": "https://www.zalando.de", "booking": "https://www.booking.com",
  "airbnb": "https://www.airbnb.de", "reddit": "https://www.reddit.com", "pinterest": "https://www.pinterest.de",
  "snapchat": "https://www.snapchat.com", "chefkoch": "https://www.chefkoch.de",
  "mobile de": "https://www.mobile.de", "autoscout": "https://www.autoscout24.de",
  "idealo": "https://www.idealo.de", "check24": "https://www.check24.de", "dhl": "https://www.dhl.de",
  "sparkasse": "https://www.sparkasse.de", "tradingview": "https://www.tradingview.com",
  "pepperstone": "https://pepperstone.com", "dazn": "https://www.dazn.com",
  "disney plus": "https://www.disneyplus.com", "prime video": "https://www.primevideo.com",
  "icloud": "https://www.icloud.com", "outlook": "https://outlook.live.com", "web de": "https://web.de",
  "gmx": "https://www.gmx.net", "lieferando": "https://www.lieferando.de", "vinted": "https://www.vinted.de",
  "ikea": "https://www.ikea.com/de/de/", "mediamarkt": "https://www.mediamarkt.de",
  "deutsche bahn": "https://www.bahn.de", "bahn": "https://www.bahn.de", "flixbus": "https://www.flixbus.de",
  "übersetzer": "https://translate.google.com", "google übersetzer": "https://translate.google.com",
  "deepl": "https://www.deepl.com/translator", "canva": "https://www.canva.com",
  "notion": "https://www.notion.so", "vapi": "https://dashboard.vapi.ai", "elster": "https://www.elster.de",
  "indeed": "https://de.indeed.com", "stepstone": "https://www.stepstone.de",
  "arbeitsagentur": "https://www.arbeitsagentur.de",
});

const NORM_NAME_LEAD = ure("^(den|die|das|dem|der|mein(en|e)?)\\s+");
const NORM_NAME_TAIL = ure("\\s+(app|programm|seite|webseite|website|ordner)$");

function normName(name) {
  const n = String(name ?? "").trim().toLowerCase().replace(NORM_NAME_LEAD, "");
  return n.replace(NORM_NAME_TAIL, "");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const similarity = (a, b) => (!a.length && !b.length ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length));

/** Mac close_key: exakter Schlüssel oder ähnlichster mit normalisierter Levenshtein-Ähnlichkeit ≥ cutoff (§7.4). */
function closeKey(name, mapping, cutoff = 0.9) {
  if (own(mapping, name)) return [name, mapping[name]];
  let best = null, score = cutoff;
  for (const key of Object.keys(mapping)) {
    const s = similarity(name, key);
    if (s >= score && (best === null || s > score)) { best = key; score = s; }
  }
  return best === null ? [null, null] : [best, mapping[best]];
}

const SPOKEN_DOMAIN = ure(`\\b((?:[a-z0-9äöü-]+ ){0,3}[a-z0-9äöü-]+) (?:punkt|dot) (${TLD_WORDS})\\b`);
const BARE_TLD = ure(` (?:punkt|dot) (?:${TLD_WORDS})$`);
const HYPHEN_WORD = ure(" ?(?:bindestrich|minus) ?", "g");

/** Mac spoken_host ohne DNS-Prüfung: „beispiel bindestrich firma“ → beispiel-firma; sonst Wörter zusammen. */
function spokenHost(spoken, tld) {
  const ws = words(spoken).filter((w) => w !== "www");
  if (!ws.length) return null;
  const joined = ws.join(" ");
  const host = (/\b(bindestrich|minus)\b/.test(joined) ? joined.replace(HYPHEN_WORD, "-").replace(/ /g, "") : ws.join(""))
    .replace(/^-+|-+$/g, "");
  return host ? `${host}.${tld}` : null;
}

/** Mac site_url ohne Suchmaschine: bekannte Seite oder gesprochene Domain (www.<name>.<tld>). */
function siteUrl(name) {
  const nm = normName(name);
  const bare = nm.replace(BARE_TLD, "");
  const [, url] = closeKey(bare, SITES);
  if (url) return siteFor(url);
  const m = SPOKEN_DOMAIN.exec(nm);
  if (m) {
    const host = spokenHost(m[1], m[2]);
    if (host) return `https://${host.startsWith("www.") ? host : `www.${host}`}`;
  }
  return null;
}

function siteLabel(url) {
  const key = Object.keys(SITES).find((k) => SITES[k] === url || (k === "maps" && url === GOOGLE_MAPS));
  return key ? nice(key) : hostOf(url).replace(/^www\./, "");
}

// „öffne Karten“: Apple Karten nur auf Apple-Geräten; Android/Rechner bekommen Google Maps (öffnet dort die App)
const GOOGLE_MAPS = "https://www.google.com/maps";
function siteFor(url) {
  return url === SITES.maps && !appleDevice() ? GOOGLE_MAPS : url;
}

const FOLDER_RX = full("(?:den |die |das |meinen |mein )?(?:ordner|verzeichnis)\\s+(.+)|(.+?)\\s+(?:ordner|verzeichnis)");
const SITE_OF = ure("^(?:die |der |den )?(?:webseite|website|homepage|internetseite|seite)\\s+(?:von|vom)\\s+");
const ENDS_ZU_AUS = ure("\\s(zu|aus)$");
const OPEN_BLOCK = ure("\\b(mail\\w*|e mail|nachricht\\w*|termin\\w*|datei\\w*|dokument\\w*|rechnung\\w*|chat\\w*|foto\\w*|"
  + "bild von|letzte\\w*|neueste\\w*|tab|fenster|licht|lampe|heizung|tür|zu|aus|spiel\\w*|"
  + "schreib\\w*|such\\w*|mach\\w*|schick\\w*|lies|playlist|lieblings\\w*)\\b");

/**
 * Was soll „öffne …“ öffnen? Port von Mac open_target ohne Programme/Ordner (§7.4):
 * Ordner → {macOnly: true}; Seite → open_url; unbekannt (öffne/geh/ruf, ≤ 4 Wörter) → web_search; sonst null.
 */
export function openTarget(name, verb = "öffne", search = true) {
  const raw = String(name ?? "").trim();
  if (FOLDER_RX.test(raw)) return { macOnly: true };
  const nm = normName(raw).replace(SITE_OF, "");
  if (!nm || ENDS_ZU_AUS.test(nm)) return null;
  const bare = nm.replace(BARE_TLD, "");
  if (own(SITES, bare)) return { type: "open_url", url: siteFor(SITES[bare]), label: nice(bare) };
  if (SPOKEN_DOMAIN.test(nm)) {
    const url = siteUrl(nm);
    if (url) return { type: "open_url", url, label: siteLabel(url) };
  }
  const [key, url] = closeKey(bare, SITES);
  if (url) return { type: "open_url", url: siteFor(url), label: nice(key) };
  if (search && /^(öffne|geh|ruf)/.test(String(verb)) && words(nm).length <= 4 && !OPEN_BLOCK.test(nm)) {
    return { type: "web_search", query: nm };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- 3D-Modelle (§7.7)
// gesprochenes Wort → Form, wie Jarvis sie nennt (live jarvis.py L1774-1799)
export const MODEL_WORDS = Object.freeze([
  ["tesserakt\\w*|tesseract|hyper ?würfel\\w*|hyperkubus", "hypercube", 4, "einen Tesserakt, einen Würfel in 4D"],
  ["penterakt\\w*|penteract", "hypercube", 5, "einen Penterakt, einen Würfel in 5D"],
  ["pentachoron|fünfzeller|5 zeller|hyper ?tetraeder", "simplex", 4, "ein Pentachoron, einen Tetraeder in 4D"],
  ["16 zeller|sechzehnzeller|hexadekachor|kreuzpolytop|orthoplex|hyper ?oktaeder", "orthoplex", 4,
    "einen 16-Zeller, einen Oktaeder in 4D"],
  ["24 zeller|vierundzwanzigzeller|ikositetrachor", "cell24", 4, "einen 24-Zeller"],
  ["hyper ?kugel|hypersphäre|glome|drei ?sphäre", "hypersphere", 4, "eine Hyperkugel, eine Kugel in 4D"],
  ["clifford ?torus|hyper ?torus|duo ?zylinder", "clifford", 4, "einen Clifford-Torus, einen Torus in 4D"],
  ["würfel|kubus|cube|wuerfel", "cube", 0, "einen Würfel"],
  ["quader|kiste|box|schachtel", "box", 0, "einen Quader"],
  ["globus|erdkugel|planet", "globe", 0, "einen Globus"],
  ["kugel|ball|sphäre", "sphere", 0, "eine Kugel"],
  ["zylinder|säule|dose|rohr", "cylinder", 0, "einen Zylinder"],
  ["kegel|eistüte", "cone", 0, "einen Kegel"],
  ["pyramide", "pyramid", 0, "eine Pyramide"],
  ["prisma", "prism", 0, "ein Prisma"],
  ["tetraeder", "tetrahedron", 0, "einen Tetraeder"],
  ["oktaeder", "octahedron", 0, "einen Oktaeder"],
  ["dodekaeder", "dodecahedron", 0, "einen Dodekaeder"],
  ["ikosaeder", "icosahedron", 0, "einen Ikosaeder"],
  ["torus|donut|doughnut|ring|reifen", "torus", 0, "einen Torus"],
  ["doppel ?helix|dna|erbgut|dns", "dna", 0, "eine DNA-Doppelhelix"],
  ["helix|spirale|feder", "helix", 0, "eine Helix"],
  ["atom", "atom", 0, "ein Atom"],
].map((row) => Object.freeze(row)));
const MODEL_WORD_RX = MODEL_WORDS.map(([rx]) => full(`(?:${rx})(?:n|s|e|en|es)?`));
export const DIM_WORDS = Object.freeze({ drei: 3, 3: 3, vier: 4, 4: 4, "fünf": 5, 5: 5, sechs: 6, 6: 6, sieben: 7, 7: 7 });
const DIM = ure("(?:(drei|vier|fünf|sechs|sieben|[3-7]) ?d\\b|(drei|vier|fünf|sechs|sieben)dimensional\\w*|([3-7])dimensional\\w*)");
const MODEL_ND = new Set(["hypercube", "simplex", "orthoplex", "cell24", "hypersphere", "clifford", "nd"]);
const MODEL_FILL = ure("\\b(?:modell|model|hologramm|holo|als|bitte|mal|kurz|eben|schnell|in|im|davon|"
  + "(?:drei|vier|fünf|sechs|sieben)dimensional\\w*|[3-7]dimensional\\w*|[3-7]d|"
  + "einem|einer|einen|eine|ein|dem|der|den|die|das)\\b", "g");
const MODEL_NOT = ure("\\b(webseite|website|homepage|landing ?page|seite|app|spiel|game|programm|tool|dashboard|"
  + "animation|video|bild|bilder|foto|fotos|photo|amazon|youtube|google|ebay|kaufen|bestell\\w*|"
  + "shop|größer|kleiner|schneller|langsamer)\\b");
const DIGIT_D = ure("\\b(\\d) d\\b", "g");
const MODEL_LEAD = ure("^(?:(?:ey|eh|hey|he|okay|ok|jarvis|boss|so|also|und|äh|ähm|ja|bitte|jetzt)\\s+)+");
const MODEL_VERB = ure("^(?:kannst du (?:mir )?)?(?:zeig|zeige|mach|bau|baue|erstell\\w*|render\\w*|generier\\w*|"
  + "projizier\\w*|holo\\w*)\\s+(.*)$");
const MODEL_ASK_WORD = ure("\\b(modell|model|hologramm|holo)\\b");
const MODEL_LOOK = ure("^wie sieht (?:(?:einen|eine|ein|der|die|das)\\s+)?(.+?) aus$");
const MODEL_OF = ure("\\b(?:von|vom)\\s+(.+)$");
const MODEL_OBJ_LEAD = ure("^(?:(?:mir|uns|mal|kurz|bitte|doch|eben|schnell|nen|ne)\\s+)*");

/**
 * „zeig mir einen 4D-Würfel“, „zeig mir ein 3D-Modell von einem Würfel“, „wie sieht ein Tesserakt aus“ →
 * {say, actions:[show_model]}; Zusammengesetztes → null (das baut Claude). live jarvis.py model_request.
 */
export function modelRequest(t0, anrede) {
  const A = anredeOf(anrede);
  let t = String(t0 ?? "").replace(DIGIT_D, "$1d");
  t = t.replace(MODEL_LEAD, "");
  if (MODEL_NOT.test(t)) return null;
  const dm = DIM.exec(t);
  const verb = MODEL_VERB.exec(t);
  const asked = !!verb && !!(dm || MODEL_ASK_WORD.test(t));
  const nd = MODEL_LOOK.exec(t);
  if (!asked && !nd) return null;
  let obj;
  if (asked) {
    const m = MODEL_OF.exec(t);
    obj = m ? m[1] : verb[1].replace(MODEL_OBJ_LEAD, "");
  } else {
    obj = nd[1];
  }
  obj = squash(obj.replace(MODEL_FILL, " "));
  const dimKey = dm ? (dm[1] || dm[2] || dm[3] || "") : "";
  const dims = own(DIM_WORDS, dimKey) ? DIM_WORDS[dimKey] : 0;
  for (let i = 0; i < MODEL_WORDS.length; i++) {
    if (!MODEL_WORD_RX[i].test(obj)) continue;
    let [, shape, sd, name] = MODEL_WORDS[i];
    if (nd && !asked && !sd && dims < 4) return null;   // „wie sieht eine Kugel aus“: dafür reicht ein Bild
    if (dims >= 4 && (shape === "cube" || shape === "box")) {
      shape = "hypercube"; sd = dims; name = `einen Würfel in ${dims}D`;
    } else if (dims >= 4 && shape === "tetrahedron") {
      shape = "simplex"; sd = dims; name = `einen Tetraeder in ${dims}D`;
    } else if (dims >= 4 && shape === "octahedron") {
      shape = "orthoplex"; sd = dims; name = `einen Oktaeder in ${dims}D`;
    } else if (dims === 4 && (shape === "sphere" || shape === "globe")) {
      shape = "hypersphere"; sd = 4; name = "eine Kugel in 4D";
    } else if (dims === 4 && shape === "torus") {
      shape = "clifford"; sd = 4; name = "einen Torus in 4D";
    } else if (dims >= 4 && !MODEL_ND.has(shape)) {
      return null;                                         // „5D-Kugel“ & Co.: das überlegt Claude
    }
    const act = { type: "show_model", shape };
    if (sd) act.dims = sd;
    return { say: line("modelShow", { A, name, suffix: sd ? "" : " in 3D" }), actions: [act] };
  }
  return null;
}

/** „Okay, Boss, hier ist …“ für ein Modell ohne eigenen Satz (live jarvis.py model_said). */
export function modelSaid(spec, anrede) {
  const A = anredeOf(anrede);
  const s = spec && typeof spec === "object" ? spec : {};
  const title = String(s.title ?? "").trim();
  if (title) return line("modelTitle", { A, title });
  const shape = String(s.shape ?? "").trim().toLowerCase();
  const dims = s.dims == null || s.dims === "" ? 4 : Number(s.dims);
  for (const [, sh, sd, name] of MODEL_WORDS) {
    if (sh === shape && ((sh !== "hypercube" && sh !== "simplex") || sd === dims)) {
      return line("modelShow", { A, name, suffix: sd ? "" : " in 3D" });
    }
  }
  if (MODEL_ND.has(shape)) return line("modelDims", { A, dims: Number.isFinite(dims) ? dims : 4 });
  return line("modelAny", { A });
}

// ---------------------------------------------------------------------------------------------- Lernen (live L2067-2072)
export const LEARN_SIGNAL = ure("\\b(merk\\w*|lern\\w*|bring\\w* dir|beibring\\w*|bei ?bringen|beizubringen|vergiss\\w*|vergess\\w*|"
  + "ab jetzt|ab sofort|in zukunft|künftig|immer|nie|niemals|sollst|soll|kurzbefehl\\w*|"
  + "wenn ich|sobald ich|falls ich|änder\\w*|stell\\w*|bau dir|einstell\\w*|nenn\\w*|antworte\\w*|"
  + "warte\\w*|sprich|sprech\\w*|lass\\w*|mach\\w*|zeig\\w*|bild\\w*|länger|kürzer|schneller|"
  + "langsamer|wohn\\w*|heiß\\w*|mag|liebe|hasse)\\b");

// ---------------------------------------------------------------------------------------------- Timer-Status (live L2387-2396)
export function timerStatus(timers, now = Date.now(), anrede) {
  const A = anredeOf(anrede);
  const t0 = now instanceof Date ? now.getTime() : (Number.isFinite(Number(now)) ? Number(now) : Date.now());
  const list = (Array.isArray(timers) ? timers : []).filter((t) => t && Number.isFinite(Number(t.ends)));
  if (!list.length) return line("timerStatusNone", { A });
  const parts = list.slice().sort((a, b) => Number(a.ends) - Number(b.ends)).slice(0, 3).map((t) => {
    const left = Math.max(1, Math.round((Number(t.ends) - t0) / 1000));
    const label = String(t.label ?? "").trim();
    return `${label ? `der Timer für ${label}` : "dein Timer"} läuft noch ${sayDuration(left)}`;
  });
  const text = parts.join(", ");
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

// ---------------------------------------------------------------------------------------------- Bestätigen (§7.5)
function spotifyQuery(a) {
  const title = String(a.title ?? "").trim(), artist = String(a.artist ?? "").trim();
  if (title) return artist ? `${title} von ${artist}` : title;
  return String(a.query ?? "").trim();
}

/** Kurze Bestätigung für einen Befehl („Okay, ich öffne Spotify.“). Port von Mac confirm_text (§7.5). */
export function confirmText(actions, fallback = "", anrede) {
  const A = anredeOf(anrede);
  const opens = [];
  let said = "";
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || typeof a !== "object") continue;
    const kind = a.type;
    const q = String(a.query ?? "").trim();
    if (kind === "open_url") {
      if (q) said = said || `Okay, ich suche ${q}.`;                 // Mac site_search („such auf Amazon nach …“)
      else opens.push(siteLabel(String(a.url ?? "")));
    } else if (kind === "youtube") {
      said = said || `Okay, ich suche ${q} auf YouTube.`;
    } else if (kind === "web_search") {
      said = said || `Okay, ich zeige dir die Treffer für ${q}.`;
    } else if (kind === "spotify") {
      said = said || `Okay, ich suche ${spotifyQuery(a)} auf Spotify.`;
    } else if (kind === "maps") {
      said = said || `Okay, ich zeige dir ${q} auf der Karte.`;
    } else if (kind === "route") {
      said = said || `Okay, ich zeige dir den Weg nach ${nice(String(a.destination ?? ""))}.`;
    } else if (kind === "amazon") {
      said = said || `Okay, ich suche ${q} auf Amazon.`;
    } else if (kind === "show_image") {
      said = said || `Okay, hier ist ein Bild von ${nice(q)}.`;
    } else if (kind === "call") {
      said = said || `Okay, der Anruf an ${String(a.name ?? "").trim() || String(a.number ?? "").trim()} ist vorbereitet.`;
    } else if (kind === "show_model") {
      said = said || modelSaid(a, A);
    } else if (kind === "remember") {
      said = said || line("noteDone", { A });
    } else if (kind === "forget_note") {
      said = said || line("forgetDone", { A });
    }
  }
  if (opens.length) {
    return `Okay, ich öffne ${opens.length > 1 ? `${opens.slice(0, -1).join(", ")} und ${opens[opens.length - 1]}` : opens[0]}.`;
  }
  if (said) return said;
  const fb = String(fallback ?? "").trim();
  if (fb && !fb.toLowerCase().startsWith("okay")) return `Okay, ${fb.startsWith("Ich ") ? `ich ${fb.slice(4)}` : fb}`;
  return fb;
}

/** „Okay, ich spiele …“ → „Okay, Boss, ich spiele …“ (jarvis.py boss_okay). */
export function bossOkay(text, anrede) {
  const A = anredeOf(anrede);
  const rx = ure(`^Okay,\\s+(?!${escapeRx(A)}\\b)`);
  return String(text ?? "").trim().replace(rx, () => `Okay, ${A}, `);
}

// Mac with_closing (live L3293-3303): nach diesen Aktionen keine Abschlussfrage
export const CLOSING_EXCLUDED = Object.freeze(new Set(["tiktok_mode", "next_image", "image_adjust", "hide_image",
  "image_chrome", "hide_jarvis", "show_model", "hide_model", "model_adjust", "orb_reset", "orb_zoom"]));

/** Nach einem erledigten Befehl die Abschlussfrage anhängen (nicht nach Rückfragen). */
export function withClosing(text, actions, closing) {
  const c = String(closing ?? "").trim();
  const t = String(text ?? "").trim();
  const acts = Array.isArray(actions) ? actions : [];
  if (!c || !t || t.endsWith("?") || !acts.length || t.includes(c)
    || acts.some((a) => a && typeof a === "object" && CLOSING_EXCLUDED.has(a.type))) return t;
  return `${t} ${c}`;
}

// ---------------------------------------------------------------------------------------------- Vorlesen (L4036-4072)
export const SENTENCE_END = ure("(?<=[^\\s.]{3}[.!?])\\s+(?=[A-ZÄÖÜ0-9„\\\"])");
const SENTENCE_END_G = ure("(?<=[^\\s.]{3}[.!?])\\s+(?=[A-ZÄÖÜ0-9„\\\"])", "g");

/** Nur die ersten Sätze vorlesen (Mac voice_text); die Abschlussfrage bleibt dran. */
export function voiceText(text, { maxSentences = 3, maxChars = 380, closing = "" } = {}) {
  let t = String(text ?? "").trim();
  const c = String(closing ?? "").trim();
  let tail = "";
  if (c && t.endsWith(` ${c}`)) {
    t = t.slice(0, -(c.length + 1)).trim();
    tail = c;
  }
  let n = Math.max(1, Math.trunc(Number(maxSentences) || 3));
  const limit = Math.max(1, Math.trunc(Number(maxChars) || 380));
  const parts = t.split(SENTENCE_END);
  let short = parts.slice(0, n).join(" ");
  while (short.length > limit && n > 1) {
    n -= 1;
    short = parts.slice(0, n).join(" ");
  }
  if (short.length > limit) {
    const cut = short.slice(0, limit);
    const sp = cut.lastIndexOf(" ");
    short = `${(sp >= 0 ? cut.slice(0, sp) : cut).replace(/[,;:–-]+$/u, "")} …`;
  }
  return `${short}${tail ? ` ${tail}` : ""}`.trim();
}

/** Erster Satz zuerst, damit Jarvis schon spricht, während der Rest vertont wird (Mac split_first). */
export function splitFirst(text) {
  const t = String(text ?? "");
  if (t.length < 90) return [t, ""];
  let first = t, rest = "";
  SENTENCE_END_G.lastIndex = 0;
  for (const m of t.matchAll(SENTENCE_END_G)) {
    if (m.index >= 25) {
      first = t.slice(0, m.index).trim();
      rest = t.slice(m.index + m[0].length).trim();
      break;
    }
  }
  if (first.length > 140) {
    const cut = first.indexOf(", ", 40);
    if (cut > 0 && cut + 2 <= 140) return [first.slice(0, cut + 1).trim(), `${first.slice(cut + 2)} ${rest}`.trim()];
  }
  return [first, rest];
}

// ---------------------------------------------------------------------------------------------- Schnellbefehle (§7.1)
// Telefon-Mengen (§6.4.3, §6.5); intents.js importiert nichts, darum hier eigene Kopien.
const SHORTCUT_TYPES = new Set(["timer", "timer_stop", "weather", "show_image", "hide_image", "open_url", "web_search",
  "youtube", "spotify", "maps", "route", "amazon", "hide_jarvis", "show_model", "hide_model", "model_adjust",
  "orb_reset", "orb_zoom"]);
const NOT_IN_STEALTH = new Set(["show_image", "next_image", "weather", "show_model", "model_adjust",
  "open_url", "web_search", "youtube", "spotify", "maps", "route", "amazon", "call", "whatsapp"]);
const CLOSE_COMBO_TYPES = new Set(["timer", "timer_stop", "hide_model"]);
const CLOSE_COMBO_FILLER = ure("\\b(und|dann|danach|jetzt|ich|bitte|jarvis|boss)\\b", "g");
const CLOSE_LEAD = ure("^((jarvis|boss|bitte|jetzt|ok|okay) )+");

// #2 Lern-Wächter (live L3315-3325)
const LEARN_LEAD = ure("^(?:(?:ey|eh|hey|okay|ok|also|so|jarvis|boss|und)\\s+)+");
const LEARN_1 = start("(?:und )?(?:wenn|sobald|immer wenn|jedes mal wenn) ich\\b.*\\b(?:sage|sag|rufe)\\b");
const LEARN_2 = start("(?:lern|lerne|merk dir|ändere? bei dir|stell bei dir|vergiss den kurzbefehl)\\b");
const LEARN_3 = ure("\\bbau dir (?:eine?n? )?(?:neue?n? )?(?:funktion|fähigkeit|befehl)\\b|^(?:vergiss|vergesse),? das mit\\b");
const LEARN_4 = ure("\\b(?:bring|bringe) dir\\b.{0,120}\\bbei\\b|\\bbei ?bringen\\b|\\bbeizubringen\\b|^(?:vergiss|vergesse),? dass\\b");
const LEARN_5A = ure("\\b(?:wenn|sobald|falls) ich (?:\\w+ ){0,2}(?:sage|sag|rufe)\\b");
const LEARN_5B = ure("\\b(?:beibringen|bring\\w* dir|lern\\w*|merk\\w*|kurzbefehl\\w*|dann|sollst du)\\b");

// #8b 3D-Modell weg (live L3364-3375)
const MH_WORD = ure("\\b(modell\\w*|model|hologramm|3d|objekt|würfel|kugel|teil|ding)\\b");
const MH_QUESTION = start("(?:welche\\w*|was|wie|wo|wer|warum|wieso|gibt|such\\w*|zeig\\w*|bau\\w*|erstell\\w*)\\b");
const MH_SIZE = ure("\\b(klein\\w*|groß\\w*|schnell\\w*|langsam\\w*|dreh\\w*|rotier\\w*)\\b");
const MH_HIDE = ure("\\b(weg|verschwind\\w*|schließ\\w*|ausblenden|entfern\\w*|lösch\\w*|zumachen)\\b|\\b(aus|zu)(?: bitte)?$");
const MH_FULL = full("(?:okay |ok )?(?:(?:mach|tu|nimm) (?:das|es|ihn|sie) (?:wieder )?weg|weg damit|(?:das|es) kann weg)(?: bitte)?");

// #11-#16
const THANKS = full("(danke( dir| schön| sehr)?|vielen dank|passt|super danke)");
const PRESENCE_Q = full("(bist du (noch |wieder )?(da|wach|online|bereit|anwesend)|hörst du( mich)?|"
  + "kannst du mich hören|bist du da boss)");
const STOP_WORDS = ure("\\b(stopp|stop|abbrechen|sei still|ruhe|halt)\\b");
const SPIN_WORDS = ure("\\b(dreh\\w*|rotier\\w*)\\b");
const MUSIC_WORDS = /musik|lied|song/u;
const NEW_SESSION = ure("\\b(neues gespräch|neues thema)\\b");
const FORGET_THAT = full("(?:okay |ok )?vergiss das(?: wieder| bitte| jarvis| boss)*");
const REPEAT = ure("\\b(wiederhol|was hast du gesagt|sag das nochmal)");
const TIME_Q = ure("\\b(wie spät|wie ?viel uhr|uhrzeit)\\b");
const DATE_Q = ure("\\b(welcher tag|welches datum|was für ein tag|den wievielten|welchen tag)\\b");
const WA_WORD = ure("\\b(whats ?app|watsapp|whatsup)\\b");
const WA_UNREAD = ure("\\b(nachricht\\w*|ungelesen\\w*|neu\\w*|vor|lies|lese|was gibt|wer hat|geschrieben|check\\w*|"
  + "schau|guck)\\b");
const COMPOSE_START = start("(?:schreib|schreibe|schick|schicke|sende)\\b");

// #17b / #18 / #18b Timer
const TIMER_WORD = ure("\\b(timer|wecker)\\b");
const TIMER_SET_WORD = ure("\\b(stell\\w*|gestellt|setz\\w*|mach\\w*|weck mich|wecke mich|erinner\\w*|lösch\\w*|stopp\\w*|"
  + "brich|abbrechen|beende\\w*|um|uhr|halb|auf)\\b");
const TIMER_STATUS_WORD = ure("\\b(wie lange|wie ?viel|läuft|laufen|restzeit|übrig|wann|status|klingelt)\\b");
const TIMER_ANY = ure("\\b(timer|wecker|erinnere mich in)\\b");
const TIMER_LABEL = ure("\\b(?:für|zum|zur)\\s+(?:die |den |das )?(\\w+)$");
const TIMER_UNITS = new Set(["minuten", "minute", "sekunden", "stunde", "stunden"]);
const TIMER_OFF_RX = ure("^(?:timer|wecker)\\s+(?:aus|stopp|stop|stoppen|abbrechen|löschen)$", "i");
const TIMER_STOP_RX = full("(?:stopp?|stoppe|lösch|lösche|beende|brich|mach)\\s+(?:mal\\s+)?(?:bitte\\s+)?"
  + "(?:den |die |alle |meinen |meine )?(?:timer|wecker)(?:\\s+(?:für|zum|zur)\\s+(?:die |den |das )?(\\S+(?: \\S+)?))?"
  + "(?:\\s+(?:ab|aus|bitte))*");

// #20 Spotify (L3445-3540) – auf dem Telefon nicht verbunden: Suche als Link, Steuerung → macOnlyMusic
const SP_TRANSFER = ure("^(?:spiel|spiele|mach|mache|hol|wechsel|wechsle|schieb|übertrag\\w*|leg)\\s+(?:mal\\s+)?(?:bitte\\s+)?"
  + "(?:die musik|das|spotify|es|musik|das lied)?\\s*(?:mal\\s+)?(?:bitte\\s+)?(?:wieder\\s+)?"
  + "(?:auf|am|an|über|zum|zu|aufs|hier)\\s*(?:den |dem |der |das |die |meinem |mein |meinen |meine |meiner )?"
  + "(mac|computer|rechner|handy|iphone|telefon|ps5|playstation|fernseher|tv|boxen|box)?"
  + "(?:\\s+(?:ab|an|weiter|rüber|bitte|jetzt))*$");
const SP_HERE = full("(?:spiel|spiele|mach)\\s+(?:das|es|die musik|musik|spotify|das lied|den song)\\s+(?:mal\\s+)?hier(?:\\s+ab)?");
const SP_NOW = ure("\\b(was läuft (da )?(gerade|grad)|welches lied|wie heißt (das|dieses) lied|was ist das für ein lied)\\b");
const SP_LIEBLINGS = ure("\\blieblings (songs?|lieder|lied|musik)\\b", "g");
const SP_ZUFALLS = ure("\\bzufalls (wiedergabe|modus)\\b", "g");
const SP_SHUFFLE = full("(?:mach |stell |schalt |schalte )?(?:die |den )?(zufallswiedergabe|zufallsmodus|shuffle)"
  + "(?: (an|ein|aus))?(?: bitte)?");
const SP_MIX_TAIL = ure("\\s+(zufällig|durcheinander|gemischt|durchgemischt|im zufallsmodus)(\\s+ab)?$");
const SP_SPOTIFY_TAIL = ure("(?:\\s+(?:auf|bei|über)\\s+spotify|\\s+bitte|\\s+an|\\s+ab)+$");
const SP_PLAY = full("(?:spiel|spiele)\\s+(?:mal\\s+)?(?:bitte\\s+)?(?:wieder\\s+)?(?:die\\s+)?(?:spotify|musik|mukke)"
  + "(?:\\s+(?:auf|am|über|vom)\\s+(?:meinem\\s+|dem\\s+|mein\\s+)?(?:handy|iphone|telefon|smartphone))?"
  + "(?:\\s+(?:ab|weiter))?");
const SP_LIKED = full("(?:spiel|spiele|starte?|mach)\\s+(?:mir\\s+)?(?:mal\\s+)?(?:bitte\\s+)?(?:meine\\s+|die\\s+)?"
  + "(?:lieblingssongs?|lieblingslieder|lieblingslied|lieblingsmusik|gespeicherten songs|meine songs)");
const SP_PLAYLIST_1 = full("(?:spiel|spiele)\\s+(?:mir\\s+)?(?:mal\\s+)?(?:bitte\\s+)?(?:meine|die|eine)?\\s*"
  + "(?:playlist|play list)\\s+(.+)");
const SP_PLAYLIST_2 = full("(?:spiel|spiele)\\s+(?:mir\\s+)?(?:mal\\s+)?(?:bitte\\s+)?(?:meine|die)\\s+(.+?)\\s+"
  + "(?:playlist|play list)");
const SP_PLAYLIST_3 = full("(?:mach|mache|starte?)\\s+(?:mir\\s+)?(?:mal\\s+)?(?:bitte\\s+)?(?:meine|die)\\s+(.+?)\\s+"
  + "(?:playlist|play list)\\s+an");
const SP_PLAYLIST_BAD = ure("\\b(lauter|leiser|aus|weiter|fertig)$");
const SP_ARTIST = full("(?:spiel|spiele)\\s+(?:mir\\s+)?(?:mal\\s+)?(?:bitte\\s+)?(?:was|etwas|musik|songs|lieder)\\s+"
  + "(?:von|vom)\\s+(.+)");
const SP_SPIEL = ure("^(?:spiel|spiele)\\s+(?:mir\\s+)?(?:mal\\s+)?(?:bitte\\s+)?(?!weiter\\b)(.+?)$");
const SP_NEXT = full("(?:das |ein |)(?:nächste[srn]?|andere[srn]?) (?:lied|song|titel|track)|(?:was|etwas) anderes");
const SP_PREV = full("(?:das )?(?:vorherige[srn]?|letzte[srn]?) (?:lied|song|titel|track)");
const SP_VAGUE = ure("\\b(das lied|den song|das eine|irgendwas|irgendein|was ruhiges|was zum|was schönes|was gutes|"
  + "mit dem|wo er|wo sie|das so geht|neue von|neuen von|bekannt)\\b");
const SP_SONG = full("(.+?)\\s+(?:von|vom)\\s+(.+)");
const SP_IGNORE = new Set(["mal", "bitte", "musik", "was", "etwas", "lied", "song"]);
// #20 phone-only exclusion (bug 36), tested on the rest after „spiel“
const SPIEL_EXCLUDE_RX = ure("^(?:ein |eine |einen |mit mir|was mit mir)|\\b(?:quiz|spiel|schach|runde)\\b", "i");
const SP_VOLUME = ure("\\b(spotify|musik|mucke|mukke|lautstärke)\\b.*?\\b(auf\\s+)?(\\d+|[a-zäöüß]+)\\s*(prozent|%)?$");
// #21 Lautstärke / Medien
const VOL_SET = ure("\\blautstärke\\b.*?\\b(?:auf\\s+)?(\\S+)\\s*(?:prozent|%)?$");
const LOUDER = ure("\\blauter\\b");
const QUIETER = ure("\\bleiser\\b");
const MUTE = ure("\\b(stumm|stummschalten|ton aus|mute)\\b");
const NEXT_SONG = ure("\\b(nächste[srn]? (lied|song|titel|track)|skip\\w*|überspring\\w*|"
  + "(ein |das )?(lied|song|track) weiter|weiter ?skippen)\\b");
const NEXT_FULL = full("(nächstes|next)");
const PREV_SONG = ure("\\b((vorherige[srn]?|letzte[srn]?) (lied|song|titel|track)|(ein |das )?(lied|song) zurück)\\b");
const PAUSE = ure("\\b(pause|pausieren|pausier|musik (aus|stoppen|anhalten)|stopp die musik)\\b");
const PLAY_FULL = full("(musik (an|weiter)|spiel weiter|weiter abspielen|play|abspielen)");
// #22 YouTube
const YT_1 = ure("^(?:spiel|spiele|zeig|zeige|such|suche|öffne|mach)\\s+(?:mir\\s+)?(?:mal\\s+)?(?:bitte\\s+)?"
  + "(.+?)\\s+(?:auf|bei|in)\\s+youtube$");
const YT_2 = ure("^(?:youtube|such auf youtube nach|suche auf youtube nach|auf youtube)\\s+(.+)$");
// #24 Kugel, Hotspot, Bilder (live L3557-3660)
const ORB_WORD = ure("\\b(kugel|jarvis kugel)\\b");
const ORB_CENTER = ure("\\b(mitte|mittig|zentrier\\w*|ausgangsposition)\\b");
const HOTSPOT_WORD = ure("\\b(hot ?spot\\w*|iphone wlan|iphone wifi|handy wlan|handy hotspot)\\b");
const HOTSPOT_VERB = ure("\\b(verbind\\w*|geh\\w*|nimm|wechsel\\w*|schalt\\w*|mach|benutz\\w*|nutz\\w*|rein|an)\\b");
const HOTSPOT_OFF = ure("\\b(trenn\\w*|aus|weg)\\b");
const ORB_ZOOM_WORD = ure("\\b(kugel|gehirn|ball|neuronen\\w*|jarvis)\\b");
const BIGGER = ure("\\b(größer|groesser|vergrößer\\w*)\\b");
const SMALLER = ure("\\b(kleiner|verkleiner\\w*)\\b");
const NORMAL_WORD = ure("\\b(normal\\w*|standard\\w*|ursprünglich\\w*)\\b");
const SIZE_WORD = ure("\\b(groß|größe)\\b");
const MA_EXCLUDE = ure("\\b(bild|foto|musik|lied|spotify|lauter|leiser|lautstärke|ton|sound|volume|helligkeit|"
  + "bildschirm|display|licht|lampe|heizung|temperatur|schrift|fenster|sprich|rede|stimme|timer|"
  + "wecker|gespräch|video|handy|box|sei|bleib)\\b");
const MA_WORD = ure("\\b(modell\\w*|model|würfel|kugel|objekt|ding|3d|ihn|es|sie)\\b");
const MA_TOO_SMALL = ure("\\bzu (?:klein|winzig)\\b");
const MA_TOO_BIG = ure("\\bzu (?:groß|riesig)\\b");
const MA_TOO_FAST = ure("\\bzu schnell\\b");
const MA_TOO_SLOW = ure("\\bzu langsam\\b");
const MA_RESET = ure("\\b(zurücksetzen|zurück setzen|setz\\w* (?:es |ihn |sie |das \\w+ |die \\w+ |den \\w+ )?zurück|"
  + "ausgangs\\w*|wie vorher|von vorne)\\b");
const MA_MOVE = ure("\\b(dreh\\w*|rotier\\w*|kipp\\w*|beweg\\w*|schneller|langsamer|stopp|stop|anhalten|halt an|"
  + "stehen|still)\\b");
const MA_FASTER = ure("\\b(schneller)\\b");
const MA_SLOWER = ure("\\b(langsamer)\\b");
const MA_STOP = ure("\\b(hör auf|aufhören|nicht mehr|stopp|stop|anhalten|halt an|stehen|still)\\b");
const MA_LEFT = ure("\\blinks\\b");
const MA_RIGHT = ure("\\brechts\\b");
const MA_UP = ure("\\b(oben|hoch)\\b");
const MA_DOWN = ure("\\b(unten|runter)\\b");
const IMG_SHOW_1 = ure("^(?:zeig|zeige)\\s+(?:mir\\s+|uns\\s+)?(?:mal\\s+)?(?:bitte\\s+)?(?:ein(?:e|en)?\\s+|das\\s+|paar\\s+)?"
  + "(?:bild|bilder|foto|fotos|photo)\\s+(?:von|vom|eines|einer|einem|zu|zum|zur)\\s+(.+)$");
const IMG_SHOW_2 = ure("^wie sieht (?:(?:einen|eine|ein|der|die|das)\\s+)?(.+?) aus$");
const IMG_ARTICLE = ure("^(?:einem|einer|einen|eine|ein|dem|der|den|die|das)\\s+");
const IMG_CHROME = ure("\\s+(?:in|auf|über|mit) (?:google )?chrome$");
const IMG_HIDE = full("(?:(?:mach|schließ|schließe|nimm|lösch|lösche|tu|tue)\\s+)?(?:nur\\s+)?(?:das\\s+)?(?:bild|foto)"
  + "\\s*(?:weg|zu|aus|raus)?");
const IMG_HIDE_WORD = ure("\\b(weg|zu|aus|raus|schließ\\w*|lösch\\w*)\\b");
const IMG_NEXT = ure("\\b(noch ein|noch eins|ein anderes|anderes|nächstes|weiteres|neues)\\s*(bild|foto)?\\b");
const IMG_WORD = ure("\\b(bild|foto)\\b");
const IMG_NEXT_SHORT = ure("\\b(noch eins|anderes|nächstes)\\b");
// #26 BUILD_RX / „sag Claude …“ (live L3142-3146)
const BUILD_RX = ure("^(?:bau|baue|bauen|erstell|erstelle|erstellen|programmier\\w*|entwickel\\w*|entwickle|code|coden|mach|mache)\\s+"
  + "(?:mir\\s+|uns\\s+)?(?:mal\\s+)?(?:bitte\\s+)?(?:schnell\\s+)?(?:eine?n?\\s+|das\\s+|die\\s+|den\\s+)?(?:neue[nrs]?\\s+)?"
  + "(?:\\w+\\s+)?(webseite|website|homepage|landing ?page|internetseite|onlineshop|online shop|web ?app|app|"
  + "programm|tool|spiel|game|skript|script|bot|dashboard|plugin|software)\\b");
const ASK_CLAUDE = ure("^(?:sag|frag|beauftrag\\w*)\\s+claude\\b|^(?:mit|über)\\s+claude\\s+");
// #27 SITE_SEARCH (L3075-3092)
const SITE_SEARCH = Object.freeze({
  "amazon": "https://www.amazon.de/s?k={q}", "ebay": "https://www.ebay.de/sch/i.html?_nkw={q}",
  "kleinanzeigen": "https://www.kleinanzeigen.de/s-{slug}/k0",
  "ebay kleinanzeigen": "https://www.kleinanzeigen.de/s-{slug}/k0",
  "wikipedia": "https://de.wikipedia.org/w/index.php?search={q}",
  "google maps": "https://www.google.com/maps/search/{q}", "maps": "https://www.google.com/maps/search/{q}",
  "google": "https://www.google.com/search?q={q}", "tiktok": "https://www.tiktok.com/search?q={q}",
  "idealo": "https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q={q}",
  "chefkoch": "https://www.chefkoch.de/rs/s0/{q}/Rezepte.html", "github": "https://github.com/search?q={q}",
  "pinterest": "https://www.pinterest.de/search/pins/?q={q}", "reddit": "https://www.reddit.com/search/?q={q}",
  "netflix": "https://www.netflix.com/search?q={q}", "zalando": "https://www.zalando.de/katalog/?q={q}",
  "otto": "https://www.otto.de/suche/{q}/",
});
const SITES_RX = Object.keys(SITE_SEARCH).sort((a, b) => b.length - a.length).map(escapeRx).join("|");
const SEARCH_ON = ure("^(?:such|suche|zeig|zeige|finde?|guck|schau)\\s+(?:mir\\s+)?(?:mal\\s+)?(?:bitte\\s+)?"
  + "(?:auf|bei|in)\\s+(" + SITES_RX + ")\\s+(?:nach\\s+)?(.+)$");
const SEARCH_ON2 = ure("^(?:such|suche|zeig|zeige|finde?)\\s+(?:mir\\s+)?(?:mal\\s+)?(?:bitte\\s+)?(?:nach\\s+)?(.+?)\\s+"
  + "(?:auf|bei|in)\\s+(" + SITES_RX + ")$");
// #28 „bring mich auf …“
const BRING_ME = ure("^(?:bring|bringe|leite|führ|führe)\\s+(?:mich\\s+)?(?:mal\\s+)?(?:bitte\\s+)?(?:auf|zu|zur|zum|in|an)?\\s*"
  + "(?:die |der |den |das |eine |einer |einen )?(?:offizielle |richtige )?(?:webseite |website |seite |"
  + "homepage |internetseite )?(?:von |vom |für |zu |wo )?(.+?)(?:\\s+(?:bitte|mal|hin|weiter))*$");
const WHERE_GET = ure("^wo (?:kann|krieg|bekomm)\\w* (?:ich|man) (.+?) (?:runter|herunter)?(?:laden|downloaden|kaufen|"
  + "bestellen|finden)$");
// #29 ROUTE, #30 google
const ROUTE = ure("^(?:zeig mir |zeige mir )?(?:die |den )?(?:route|weg|navigation|navigier\\w*|navi)\\s+(?:mich\\s+)?"
  + "(?:mal\\s+)?(?:bitte\\s+)?(?:nach|zu|zur|zum)\\s+(.+)$|^wie komme? ich (?:nach|zu|zur|zum)\\s+(.+)$");
const GOOGLE = ure("^(?:google|googel|such im internet nach|suche im internet nach|such online nach)\\s+"
  + "(?:mal\\s+)?(?:nach\\s+)?(.+)$");
const SEARCH_FOR = ure("^(?:such|suche)\\s+(?:mal\\s+)?(?:bitte\\s+)?(?:mir\\s+)?nach\\s+(.+)$");   // CR1.4, free mode
// #31 CHECK_RX / WHAT_ON (Mac peek) → Claude
const CHECK_RX = ure("^(?:check|checke|checkt|chek|tscheck|scheck|schecke|schau|schaue|guck|gucke|kuck|zeig mir kurz|zeige mir kurz|"
  + "zeig kurz)\\s+(?:mal\\s+)?(?:bitte\\s+)?(?:kurz\\s+)?(?:mal\\s+)?(?:auf\\s+|bei\\s+|in\\s+)?(.+?)"
  + "(?:\\s+(?:nach|für mich|bitte|mal|durch|rein|an|ab))*$");
const WHAT_ON = ure("^was (?:steht|gibt es|gibts|gibt s|läuft|ist los|ist neu)\\s+(?:gerade\\s+|heute\\s+|neues\\s+|so\\s+)*"
  + "(?:auf|bei)\\s+(.+?)(?:\\s+(?:gerade|heute|so|bitte))*$");
const CHECK_TOPIC = ure("\\b(mail\\w*|e mail|termin\\w*|kalender|kosten|rechnung\\w*|konto\\w*|whats ?app|nachricht\\w*|"
  + "kurs\\w*|preis\\w*|aktie\\w*|bitcoin|krypto\\w*|nasdaq|nas ?100|dax|gold|silber|news|"
  + "ergebnis\\w*|tabelle|bundesliga|wetter\\w*|ob|wie|was|wann|wo|wer|warum|wieso|mein|meine|"
  + "meinen|meiner|spotify|lied|musik|da|hier|das|dies|dich|mich|akku|batterie|speicher|"
  + "cpu|internet|wlan|verbindung|lautstärke|timer|uhr|zeit|dein\\w*|mir|dir|uns|euch|plan|"
  + "programm|agenda|liste|email\\w*|postfach|posteingang|bestellung\\w*|sendung\\w*|paket\\w*|"
  + "link|seite|code|fehler|log\\w*|mal|bitte|kurz|video\\w*|foto\\w*|bild(?:er)?|datei\\w*)\\b");
const CHECK_SITE_LEAD = ure("^(?:die |der |den |das )?(?:webseite|website|seite|homepage|internetseite)\\s+(?:von\\s+|vom\\s+)?");
const CHECK_EXPLICIT = start("(?:check|chek|tscheck|scheck)");
// #32 QUIT_RX (live L3137-3141; Python (?P<a>) → JS (?<a>))
const QUIT_RX = full("(?:kannst du |könntest du |würdest du |du kannst )?(?:mal |bitte |jetzt |doch |einfach )*"
  + "(?:(?:schließ|schließe|schliess|schliesse|beende|beenden)\\s+(?<a>.+?)"
  + "|(?:mach|mache)\\s+(?<b>.+?)\\s+(?:zu|aus)"
  + "|(?<c>.+?)\\s+(?:schließen|schliessen|zumachen|zu machen|beenden|ausmachen))(?:\\s+(?:bitte|jetzt|mal))*");
const QUIT_LEAD = ure("^(?:(?:ey|hey|okay|ok|jarvis|boss|so|und)\\s+)+");
const QUIT_SPOKEN_LEAD = ure("^(?:mal|bitte|jetzt|doch|einfach|kurz)\\s+");
const QUIT_ALL = ure("\\b(alle|alles)\\b");
const QUIT_SPLIT = ure("\\s*(?:,|\\bund\\b|\\bsowie\\b|\\bplus\\b|\\bauch\\b)\\s*");
const QUIT_APP_LEAD = ure("^(?:die |das |den )?(?:apps?|programme?|anwendung(?:en)?)\\s+");
const QUIT_APP_TAIL = ure("\\s+(?:apps?|programme?)$");
const QUIT_NOT = new Set(["musik", "browser", "uhr", "dich", "mich", "das", "es", "alles", "mac", "computer", "laptop", "pc",
  "app", "apps", "tv", "fernseher", "bluetooth", "wlan", "internet", "licht", "ton", "fenster", "tab", "tabs",
  "tür", "auto", "heizung",
  "seite", "bild", "foto", "modell", "model", "kugel", "overlay", "jarvis", "timer", "wecker", "gespräch"]);
const QUIT_PLACE = ure("\\b(im|in|am|an|auf|von|vom|zum|zur|der|die|das|dem|den|mit)\\b");
// Telefon-Ersatz für die laufenden Mac-Programme (live quit_targets: nur, was wirklich ein Programm ist). Alles andere
// („mach die Taschenlampe aus“, „beende den Anruf“) geht wie am Mac an die KI.
const APP_NAMES = Object.freeze(Object.fromEntries([
  "spotify", "chrome", "google chrome", "safari", "firefox", "brave", "edge", "microsoft edge", "opera", "arc",
  "whatsapp", "telegram", "signal", "discord", "slack", "zoom", "teams", "microsoft teams", "skype", "facetime",
  "nachrichten", "messages", "mail", "outlook", "thunderbird", "word", "excel", "powerpoint", "keynote", "pages",
  "numbers", "notion", "obsidian", "evernote", "notizen", "notes", "erinnerungen", "kalender", "finder", "vorschau",
  "preview", "terminal", "iterm", "xcode", "vs code", "visual studio code", "cursor", "figma", "photoshop",
  "illustrator", "premiere", "final cut", "logic", "garageband", "imovie", "capcut", "itunes", "apple music",
  "podcasts", "fotos", "photos", "quicktime", "vlc", "obs", "steam", "app store", "systemeinstellungen", "dropbox",
  "onedrive", "1password", "bitwarden", "docker", "postman", "chatgpt", "claude", "tradingview", "netflix",
  "youtube", "instagram", "tiktok", "twitch", "prime video", "disney plus",
].map((n) => [n, true])));

function isKnownApp(name) {
  const nm = String(name ?? "").trim();
  if (!nm) return false;
  return !!closeKey(nm, APP_NAMES)[1] || !!closeKey(nm, SITES)[1];
}
// #33 öffne …, #35 ruf <Nummer> an, #34 zeig dich
const OPEN_RX = ure("^(öffne|öffnen|öffnet|öffnest|starte|start|zeig mir|zeige mir|mach|mache|geh auf|gehe auf|ruf|rufe)"
  + "\\s+(?:mir\\s+)?(?:mal\\s+)?(?:bitte\\s+)?(?:mal\\s+)?(?:kurz\\s+)?(.+?)(?:\\s+(?:auf|an|bitte|mal))*$");
const OPEN_SPLIT = ure("\\s*(?:\\bund\\b|\\bsowie\\b)\\s*");
const CALL_RX = ure("^(?:ruf|rufe)\\s+(?:mal\\s+)?(?:bitte\\s+)?(.+?)\\s+an$");
const SHOW_ME = ure("\\b(zeig dich|overlay an|komm zurück)\\b");

// CR1.4 Gratis-Modus (ohne Gehirn): „merk dir …“, „vergiss …“, „was hast du dir gemerkt“, WhatsApp-Entwurf
const LEAD_WORDS = "(?:(?:ey|eh|hey|okay|ok|also|so|jarvis|boss|und|bitte)[\\s,.!?:;-]+)*";
// „dass …“ bleibt am Notizsatz (sonst „Ich meinen Kaffee schwarz trinke“); vorgelesen wird er in der Du-Form
const NOTE_REMEMBER = ure(`^\\W*${LEAD_WORDS}(?:merk|merke)\\s+dir\\b[\\s,.:;-]*(.*)$`, "i");
const NOTE_TEACH_1 = ure(`^\\W*${LEAD_WORDS}(?:bring|bringe)\\s+dir\\s+bei\\b[\\s,.:;-]*(.*)$`, "i");
const NOTE_TEACH_2 = ure(`^\\W*${LEAD_WORDS}(?:bring|bringe)\\s+dir\\s+(.+?)\\s+bei\\W*$`, "i");
const NOTE_FORGET = ure(`^\\W*${LEAD_WORDS}(?:vergiss|vergesse)\\b[\\s,.:;-]*(?:bitte\\s+)?(?:die\\s+notiz\\b[\\s,.:;-]*|dass\\s+|`
  + "was ich (?:dir )?(?:über|zu)\\s+)?(.*)$", "i");
const NOTE_FORGET_NOT = full("das|es|das wieder|alles|das mit .*|den kurzbefehl.*|die kurzbefehle.*|es wieder|das bitte|"
  + "das jarvis|das boss|dass .*");
const NOTE_LIST = ure("\\b(was hast du dir (?:alles )?gemerkt|was weißt du (?:alles )?(?:über|von) mich|"
  + "was hast du (?:dir )?(?:über mich )?gespeichert|was hast du dir gemerkt)\\b");
const NOTE_VAGUE = new Set(["das", "es", "dies", "das hier", "folgendes", "was", "etwas"]);
const WA_COMPOSE = [
  // „schreib (eine) WhatsApp (an Tom): Ich komme später“
  [ure("^\\W*(?:bitte\\s+)?(?:schreib|schreibe|schick|schicke|sende)\\s+(?:mal\\s+)?(?:bitte\\s+)?(?:eine?n?\\s+)?"
    + "(?:whats\\s?app|watsapp)(?:[\\s-]*nachricht)?(?:\\s+an\\s+([^:,]+?))?\\s*[:,]\\s*(.+)$", "i"), 1, 2],
  // „WhatsApp an Tom: Ich komme später“
  [ure("^\\W*(?:eine?n?\\s+)?(?:whats\\s?app|watsapp)(?:[\\s-]*nachricht)?\\s+an\\s+([^:,]+?)\\s*[:,]\\s*(.+)$", "i"), 1, 2],
  // „schreib Tom auf WhatsApp, dass ich später komme“
  [ure("^\\W*(?:schreib|schreibe|schick|schicke)\\s+(?:mal\\s+)?(?:bitte\\s+)?(\\S+(?:\\s\\S+)?)\\s+(?:auf|per|über|bei|in)\\s+"
    + "(?:whats\\s?app|watsapp)\\s*,?\\s*(?:dass\\s+|:\\s*)(.+)$", "i"), 1, 2],
  // „schreib eine WhatsApp Ich komme später“
  [ure("^\\W*(?:schreib|schreibe|schick|schicke)\\s+(?:mal\\s+)?(?:bitte\\s+)?(?:eine?n?\\s+)?(?:whats\\s?app|watsapp)"
    + "(?:[\\s-]*nachricht)?\\s+(?!an\\s)(.+)$", "i"), 0, 1],
];

function firstUpper(s) {
  const t = String(s ?? "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function cleanSpoken(s) {
  return String(s ?? "").replace(/^[\s,.:;–-]+/u, "").replace(/[\s,;:–-]+$/u, "").trim();
}

// ---- Ich-Form → Du-Form fürs Vorlesen gemerkter Sätze („dass ich meinen Kaffee schwarz trinke“ → „dass du deinen
// Kaffee schwarz trinkst“). Nur Pronomen und das Verb zu „ich“; alles andere bleibt, wie er es gesagt hat.
const PRONOUN_DU = Object.freeze({ ich: "du", mich: "dich", mir: "dir", mein: "dein", meine: "deine", meinen: "deinen",
  meinem: "deinem", meiner: "deiner", meines: "deines", meins: "deins" });
const VERB_DU = Object.freeze({ bin: "bist", habe: "hast", hab: "hast", kann: "kannst", will: "willst", muss: "musst",
  darf: "darfst", soll: "sollst", mag: "magst", weiß: "weißt", werde: "wirst", möchte: "möchtest", tue: "tust", tu: "tust",
  war: "warst", hatte: "hattest", esse: "isst", lese: "liest", sehe: "siehst", spreche: "sprichst", nehme: "nimmst",
  gebe: "gibst", helfe: "hilfst", treffe: "triffst", vergesse: "vergisst", fahre: "fährst", schlafe: "schläfst",
  laufe: "läufst", trage: "trägst", halte: "hältst", lasse: "lässt", falle: "fällst", fange: "fängst", wasche: "wäschst",
  werfe: "wirfst", breche: "brichst", empfehle: "empfiehlst", trete: "trittst", lade: "lädst", rate: "rätst",
  brate: "brätst", stoße: "stößt", wachse: "wächst", verlasse: "verlässt", erfahre: "erfährst", weiss: "weisst" });
const SUBORDINATE = new Set(["dass", "wenn", "weil", "ob", "obwohl", "damit", "als", "falls", "sobald", "nachdem", "bevor",
  "während", "da", "seit", "seitdem", "bis", "wie", "wo", "was"]);
const CONJ_DU = new Set(["und", "oder", "aber", "sowie"]);
const DETERMINER_DU = /^(?:der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines|mein\p{L}*|dein\p{L}*|sein\p{L}*|ihr\p{L}*|unser\p{L}*|kein\p{L}*|dies\p{L}*|jed\p{L}*|viel\p{L}*|all\p{L}*)$/u;
const VERB_PREFIXES = ["zurück", "weiter", "zusammen", "auf", "an", "ab", "aus", "ein", "mit", "nach", "vor", "zu", "weg",
  "los", "fest", "her", "hin", "fern", "dabei", "um", "be", "ver", "er", "ent", "ge", "über", "unter"];

function verbDu(word) {
  const w = String(word ?? "");
  const low = w.toLowerCase();
  if (own(VERB_DU, low)) return keepCase(w, VERB_DU[low]);
  for (const p of VERB_PREFIXES) {                       // „anfange“ → „anfängst“, „mitnehme“ → „mitnimmst“
    if (low.startsWith(p) && own(VERB_DU, low.slice(p.length))) return keepCase(w, p + VERB_DU[low.slice(p.length)]);
  }
  if (!/^[a-zäöüß]{3,}e$/u.test(low)) return null;        // nur „…e“ ist sicher die ich-Form
  const stem = low.slice(0, -1);
  let du;
  if (/(s|ß|z|x)$/u.test(stem)) du = `${stem}t`;          // heiße → heißt
  else if (/(t|d)$/u.test(stem) || /(ch|[^aeiouäöülrhmn])[mn]$/u.test(stem)) du = `${stem}est`;   // arbeite, finde, atme, rechne
  else du = `${stem}st`;                                   // trinke → trinkst
  return keepCase(w, du);
}

function keepCase(orig, repl) {
  return /^[A-ZÄÖÜ]/u.test(orig) ? repl[0].toUpperCase() + repl.slice(1) : repl;
}

/** Notiz in der Du-Form vorlesen (Pronomen ich/mein → du/dein, Verb zu „ich“ angepasst). */
export function toDuForm(text) {
  const src = String(text ?? "").trim();
  if (!src) return src;
  const toks = src.split(/(\s+|[,;:.!?]+)/u);
  const isWord = (t) => /^[\p{L}]+$/u.test(t);
  const lower = (i) => toks[i].toLowerCase();
  const wordIdx = toks.map((t, i) => (isWord(t) ? i : -1)).filter((i) => i >= 0);
  const dass = wordIdx.length && lower(wordIdx[0]) === "dass";
  // je Teilsatz (bis Komma/Semikolon): Nebensatz → Verb am Ende, „Ich trinke“ → 2. Wort, „Morgen arbeite ich“ → davor
  const verbAt = new Set();
  let seg = [];
  const flush = () => {
    const ich = seg.findIndex((i) => lower(i) === "ich");
    if (ich >= 0) {
      if (SUBORDINATE.has(lower(seg[0])) && seg.length > ich + 1) {
        verbAt.add(seg[seg.length - 1]);
        // „dass ich X trinke und Y höre“: auch das Verb vor „und/oder“ (visual-ux-7) – aber nicht in Reihen wie
        // „große und kleine Hunde“ oder „Tee und Kaffee“
        for (let k = ich + 2; k < seg.length - 1; k++) {
          if (!CONJ_DU.has(lower(seg[k]))) continue;
          const cand = seg[k - 1];
          const next = seg[k + 1];
          if (/^[A-ZÄÖÜ]/u.test(toks[cand])) continue;                       // Nomen
          if (k - 2 >= 0 && DETERMINER_DU.test(lower(seg[k - 2]))) continue;   // „die große und …“
          if (/e$/u.test(lower(next)) && next !== seg[seg.length - 1]) continue;   // „… und kleine Hunde“
          verbAt.add(cand);
        }
      } else if (ich === 0 && seg.length > 1) verbAt.add(seg[1]);
      else if (ich > 0) verbAt.add(seg[ich - 1]);
    }
    seg = [];
  };
  toks.forEach((t, i) => {
    if (isWord(t)) seg.push(i);
    else if (/[,;:.!?]/u.test(t)) flush();
  });
  flush();
  for (const i of wordIdx) {
    const low = lower(i);
    if (verbAt.has(i)) {
      const v = verbDu(toks[i]);
      if (v) { toks[i] = v; continue; }
    }
    if (own(PRONOUN_DU, low)) toks[i] = keepCase(toks[i], PRONOUN_DU[low]);
  }
  let out = toks.join("");
  if (dass) out = out.replace(/^Dass\b/u, "dass");
  return out;
}

/** Gratis-Modus „merk dir …“ & Co.; null = kein Treffer. */
function freeNotes(text, t, ctx, A, r) {
  let m = NOTE_REMEMBER.exec(text) || NOTE_TEACH_1.exec(text) || NOTE_TEACH_2.exec(text);
  if (m) {
    const what = cleanSpoken(m[1]).replace(/[.!?]+$/u, "");
    const core = what.replace(/^dass\b\s*/iu, "");
    if (!core || NOTE_VAGUE.has(core.toLowerCase()) || NOTE_VAGUE.has(what.toLowerCase())) return r(line("noteEmpty", { A }));
    return r("", [{ type: "remember", text: firstUpper(what) }]);
  }
  m = NOTE_FORGET.exec(text);
  if (m && !FORGET_THAT.test(t)) {
    const what = cleanSpoken(m[1]).replace(/[.!?]+$/u, "");
    const w = norm(what);
    if (w && !NOTE_FORGET_NOT.test(w)) return r("", [{ type: "forget_note", text: what }]);
    if (!w && !t.includes("kurzbefehl")) return r(line("forgetEmpty", { A }));
  }
  if (NOTE_LIST.test(t)) {
    let facts = [];
    try { facts = typeof ctx.facts === "function" ? ctx.facts() : (Array.isArray(ctx.facts) ? ctx.facts : []); } catch { facts = []; }
    const texts = (Array.isArray(facts) ? facts : []).map((f) => String((f && f.text) ?? f ?? "").trim()).filter(Boolean);
    if (!texts.length) return r(line("notesNone", { A }));
    const recent = texts.slice(-5).map((x) => toDuForm(x.replace(/[.!?]+$/u, "")));
    let say = line("notesList", { A, list: recent.join("; ") });
    if (texts.length > recent.length) say += ` ${line("notesMore", { A, n: texts.length - recent.length })}`;
    return r(say);
  }
  return null;
}

// ---- CR1.4 Konto und Termine ohne Gehirn: genau die Sätze, die die leeren Panels vorschlagen
const AMOUNT = "([-+−]?\\s?\\d[\\d.,]*(?:\\s\\d{3})*)\\s*(?:€|euro|eur)?";
const KONTO_SET = [
  ure(`^\\W*(?:bitte\\s+)?(?:(?:mein|der)\\s+)?kontostand\\s*(?:ist|beträgt|liegt\\s+bei|steht\\s+(?:bei|auf)|sind|:)?\\s*`
    + `(?:jetzt|gerade|aktuell|heute)?\\s*(?:bei\\s+)?${AMOUNT}\\W*$`, "i"),
  ure(`^\\W*(?:bitte\\s+)?(?:setz|setze|stell|stelle|trag|trage)\\s+(?:mir\\s+)?(?:meinen|den)\\s+kontostand\\s+(?:auf|mit)\\s+${AMOUNT}`
    + `(?:\\s+ein)?\\W*$`, "i"),
];
const TERMIN_RX = [
  ure("^\\W*(?:bitte\\s+)?(?:trag|trage)\\s+(?:mir\\s+)?(?:bitte\\s+)?(?:mal\\s+)?(?:einen\\s+|den\\s+)?termin\\s+ein\\s*[:,]?\\s+(.+?)\\W*$", "i"),
  ure("^\\W*(?:bitte\\s+)?(?:trag|trage)\\s+(?:mir\\s+)?(?:bitte\\s+)?(?:mal\\s+)?(.+?)\\s+(?:in\\s+(?:den|meinen)\\s+kalender\\s+|"
    + "in\\s+(?:die|meine)\\s+termin(?:e|liste)\\s+)?ein\\W*$", "i"),
  ure("^\\W*(?:neuer|neuen)\\s+termin\\s*[:,]?\\s+(.+?)\\W*$", "i"),
  ure("^\\W*(?:mach|mache|leg|lege)\\s+(?:mir\\s+)?(?:bitte\\s+)?(?:einen\\s+)?termin\\s+(?:an\\s+)?[:,]?\\s*(.+?)(?:\\s+an)?\\W*$", "i"),
];
const DAY_WORDS = Object.freeze({ heute: 0, morgen: 1, "übermorgen": 2 });
const MONTH_RX = MONTHS.map((m) => m.toLowerCase()).join("|");
const NUM_WORD_RX = "(?:null|ein|eins|eine|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|dreizehn|vierzehn|"
  + "fünfzehn|sechzehn|siebzehn|achtzehn|neunzehn|zwanzig|einundzwanzig|zweiundzwanzig|dreiundzwanzig|dreißig|"
  + "vierzig|fünfzig|\\d{1,2})";
const T_ALLDAY = ure("\\b(?:ganztägig|ganztags|den ganzen tag)\\b", "i");
const T_TIME = ure(`\\b(?:um|gegen|ab)?\\s*(${NUM_WORD_RX})(?:[:.](\\d{2}))?\\s*uhr(?:\\s+(${NUM_WORD_RX}))?\\b`, "i");
const T_TIME_UM = ure("\\bum\\s+(\\d{1,2})(?:[:.](\\d{2}))?\\b", "i");
const T_PM = ure("\\b(?:nachmittags|abends|am nachmittag|am abend|pm)\\b", "i");
const T_DAYWORD = ure("\\b(übermorgen|morgen|heute)\\b", "i");
const T_WEEKDAY = ure(`\\b(?:am\\s+|nächsten\\s+|kommenden\\s+|diesen\\s+)?(${WEEKDAYS.map((w) => w.toLowerCase()).join("|")})\\b`, "i");
const T_DATE_NUM = ure("\\b(?:am\\s+)?(\\d{1,2})\\.\\s?(\\d{1,2})\\.(?:\\s?(\\d{4}|\\d{2})\\b)?", "i");
const T_DATE_MON = ure(`\\b(?:am\\s+)?(\\d{1,2})\\.?\\s+(${MONTH_RX})(?:\\s+(\\d{4}))?\\b`, "i");
const T_EDGE = ure("^(?:(?:einen|ein|den|die|das|termin|am|um|für|beim|bei|zum|zur|mir|bitte|mal|und|,)\\s+)+|"
  + "(?:\\s+(?:am|um|für|und|bitte|termin|ein))+$", "gi");

function parseAmountSpoken(raw) {
  let s = String(raw ?? "").replace(/−/g, "-").replace(/\s+/g, "");
  if (!s) return null;
  if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  s = s.replace(/[.,]$/, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function euroText(n) {
  const frac = Math.round(Math.abs(n) * 100) % 100 !== 0;
  return `${n.toLocaleString("de-DE", { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: 2 })} Euro`;
}

/** „Zahnarzt Donnerstag um 15 Uhr“ → { titel, wann, phrase } | { needTime: true } | null (kein Termin). */
export function parseTermin(body, now = new Date()) {
  let rest = ` ${String(body ?? "").trim()} `;
  let m;
  let allDay = false;
  if (T_ALLDAY.test(rest)) { allDay = true; rest = rest.replace(T_ALLDAY, " "); }
  let h = null, mi = 0;
  if ((m = T_TIME.exec(rest))) {
    h = parseNumber(m[1]);
    mi = m[2] ? Number(m[2]) : m[3] ? parseNumber(m[3]) : 0;
    rest = rest.replace(m[0], " ");
  } else if ((m = T_TIME_UM.exec(rest))) {
    h = Number(m[1]);
    mi = m[2] ? Number(m[2]) : 0;
    rest = rest.replace(m[0], " ");
  }
  if (h != null && T_PM.test(rest) && h < 12) h += 12;
  rest = rest.replace(T_PM, " ");
  if (h != null && (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59))) return null;
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let date = null;
  let byWeekday = false;
  if ((m = T_DATE_MON.exec(rest))) {
    const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    let y = m[3] ? Number(m[3]) : now.getFullYear();
    date = new Date(y, mon, Number(m[1]));
    if (!m[3] && date < base) date = new Date(y + 1, mon, Number(m[1]));
    rest = rest.replace(m[0], " ");
  } else if ((m = T_DATE_NUM.exec(rest))) {
    let y = m[3] ? Number(m[3]) : now.getFullYear();
    if (y < 100) y += 2000;
    date = new Date(y, Number(m[2]) - 1, Number(m[1]));
    if (!m[3] && date < base) date = new Date(y + 1, Number(m[2]) - 1, Number(m[1]));
    if (date.getMonth() !== Number(m[2]) - 1) return null;
    rest = rest.replace(m[0], " ");
  } else if ((m = T_DAYWORD.exec(rest))) {
    date = new Date(base.getTime());
    date.setDate(date.getDate() + DAY_WORDS[m[1].toLowerCase()]);
    rest = rest.replace(m[0], " ");
  } else if ((m = T_WEEKDAY.exec(rest))) {
    const wd = WEEKDAYS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
    let diff = (wd - now.getDay() + 7) % 7;
    if (diff === 0) {
      const later = h != null && (h * 60 + mi) > (now.getHours() * 60 + now.getMinutes());
      if (!later) diff = 7;
    }
    date = new Date(base.getTime());
    date.setDate(date.getDate() + diff);
    byWeekday = true;
    rest = rest.replace(m[0], " ");
  }
  if (!date && h == null) return null;                    // weder Tag noch Uhrzeit: kein Termin-Satz
  if (!date) {                                            // nur Uhrzeit: heute, sonst morgen
    date = new Date(base.getTime());
    if (h * 60 + mi <= now.getHours() * 60 + now.getMinutes()) date.setDate(date.getDate() + 1);
  }
  if (h == null && !allDay) return { needTime: true };
  let titel = squash(rest.replace(/[,;:]/g, " ")).replace(T_EDGE, "").trim();
  titel = titel ? titel[0].toUpperCase() + titel.slice(1) : "Termin";
  const ymd = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const wann = allDay && h == null ? ymd : `${ymd}T${pad2(h)}:${pad2(mi)}`;
  const days = Math.round((date - base) / 86400e3);
  const day = days === 0 ? "heute" : days === 1 ? "morgen" : byWeekday && days === 7 ? `nächsten ${WEEKDAYS[date.getDay()]}`
    : days > 0 && days < 7 && (byWeekday || days > 2) ? `am ${WEEKDAYS[date.getDay()]}` : days === 2 ? "übermorgen"
      : `am ${date.getDate()}. ${MONTHS[date.getMonth()]}`;
  const time = h == null ? "ganztägig" : `um ${h} Uhr${mi ? ` ${mi}` : ""}`;
  return { titel: titel.slice(0, 80), wann, phrase: `${day} ${time}` };
}

/** Gratis-Modus: Kontostand setzen, Termin eintragen; null = kein Treffer. */
function freeKontoTermin(raw, now, A, r) {
  const text = String(raw ?? "").trim();
  for (const rx of KONTO_SET) {
    const m = rx.exec(text);
    if (!m) continue;
    const n = parseAmountSpoken(m[1]);
    if (n == null) return r(line("kontoValue", { A }));
    return r(line("kontoSaid", { A, betrag: euroText(n) }), [{ type: "kontostand", betrag: n }]);
  }
  for (const rx of TERMIN_RX) {
    const m = rx.exec(text);
    if (!m) continue;
    const t = parseTermin(m[1], now);
    if (!t) continue;
    if (t.needTime) return r(line("terminValue", { A }));
    return r(line("terminSaid", { A, titel: t.titel, wann: t.phrase }), [{ type: "termin", titel: t.titel, wann: t.wann }]);
  }
  return null;
}

/** Gratis-Modus WhatsApp-Entwurf (Link zum Antippen); null = kein Treffer. */
function freeWhatsApp(text, r) {
  for (const [rx, toIdx, textIdx] of WA_COMPOSE) {
    const m = rx.exec(String(text ?? "").trim());
    if (!m) continue;
    const msg = firstUpper(cleanSpoken(m[textIdx]));
    if (!msg) continue;
    const to = toIdx ? cleanSpoken(m[toIdx]) : "";
    const act = { type: "whatsapp", text: msg };
    if (to) act.to = nice(to);
    return r("", [act]);
  }
  return null;
}

/** Telefon-Ersatz für Mac quit_targets: genannte Programme ohne Dinge, die keine Programme sind (QUIT_NOT). */
function quitNames(spoken) {
  const out = [];
  for (const part of String(spoken ?? "").toLowerCase().split(QUIT_SPLIT)) {
    let nm = normName(part.trim().replace(QUIT_APP_LEAD, ""));
    nm = nm.replace(QUIT_APP_TAIL, "").trim();
    if (!nm || QUIT_NOT.has(nm) || words(nm).length > 3 || QUIT_PLACE.test(nm) || !isKnownApp(nm)) continue;
    out.push(nm);
  }
  return out;
}

function numberIn(text) {
  const m = String(text ?? "").match(/\+?\d[\d\s/().-]*\d/u);
  if (!m) return "";
  const digits = m[0].replace(/\D/g, "");
  return digits.length >= 3 ? m[0].trim() : "";
}

/**
 * Häufige Befehle sofort erledigen, ohne KI (Port von Mac quick_intent, §7.1 + §7.7 + CR1.4).
 * @returns {{say: string, actions: object[], followUp: boolean, special: null|"stop"|"reset"|"repeat"|"show",
 *            ui: null|"hide"|"hide_fast"} | null}
 */
export function quickIntent(text, ctx = {}) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const A = anredeOf(c.anrede);
  const r = (say = "", actions = [], extra = {}) => ({
    say, actions, followUp: false, special: null, ui: null, ...extra,
  });
  const music = () => r(line("macOnlyMusic", { A }), [], { macOnly: "music" });
  const raw = String(text ?? "");
  let t = norm(raw);
  if (!t) return null;
  const ws = words(t);
  const free = c.brain === false;                      // kein Gehirn eingerichtet: CR1.4-Schnellbefehle
  let m;

  // CR1.4: „merk dir …“, „vergiss …“, „was hast du dir gemerkt“ ohne Gehirn (mit Gehirn überlegt das die KI, Mac)
  if (free) {
    const n = freeNotes(raw, t, c, A, r);
    if (n) return n;
  }

  // #2 Anlernen und Einstellen: das überlegt die KI
  const tl = t.replace(LEARN_LEAD, "");
  if (LEARN_1.test(tl) || LEARN_2.test(tl) || LEARN_3.test(tl) || LEARN_4.test(tl)
    || (LEARN_5A.test(t) && LEARN_5B.test(t))) return null;

  // #3 angelernte Kurzbefehle zuerst
  if (typeof c.findShortcut === "function") {
    let sc = null;
    try { sc = c.findShortcut(raw); } catch { sc = null; }
    if (sc && Array.isArray(sc.actions)) {
      const acts = sc.actions.filter((a) => a && typeof a === "object" && SHORTCUT_TYPES.has(a.type)).map((a) => ({ ...a }));
      if (acts.length) return r("", acts);
    }
  }

  // #4 still im Hintergrund (auch „tschüss und tauch ab“)
  const rest = stealthRest(t);
  if (rest === "" || (rest && FAREWELL.test(rest))) return r("", [{ type: "hide_jarvis" }]);
  // #5 „mach die Musik aus und tauch ab“: erst das, dann weg
  if (rest && words(rest).length <= 8 && stealthCombo(t)) {
    const sub = quickIntent(rest, c);
    if (sub !== null && !sub.actions.some((a) => NOT_IN_STEALTH.has(a.type))) {
      return r("", [...sub.actions, { type: "hide_jarvis" }], { special: sub.special === "reset" ? "reset" : null });
    }
  }
  // #6 „schließ dich“, „Jarvis aus“: sofort ausblenden, ohne Worte
  if (isCloseCommand(t)) return r("", [], { ui: "hide_fast" });
  // #7 Tschüss
  if (FAREWELL.test(t)) {
    const key = t.includes("nacht") ? "byeNight" : t.includes("morgen") ? "byeMorning" : "byeLater";
    return r(line(key, { A }), [], { ui: "hide" });
  }
  // #8 Schließen-Kombis („stell einen Wecker auf acht Stunden und geh schlafen“)
  if (CLOSE_IN.test(t)) {
    const rest2 = squash(t.replace(CLOSE_IN_G, " ").replace(CLOSE_COMBO_FILLER, " "));
    const sub = rest2 ? quickIntent(rest2, c) : null;
    if (sub && sub.actions.length && sub.actions.every((a) => CLOSE_COMBO_TYPES.has(a.type))) {
      return r(sub.say, sub.actions, { ui: "hide" });
    }
    // „mach die Musik aus und geh schlafen“: Mac erledigt Ton/Medien und blendet aus (live L3353); das Telefon sagt
    // ehrlich, dass Musik der Mac macht, und blendet trotzdem aus
    if (sub && sub.macOnly === "music") return r(sub.say, [], { ui: "hide" });
    if (sub === null && CLOSE_AT_START.test(t.replace(CLOSE_LEAD, ""))
      && words(rest2).length <= 3) return r("", [], { ui: "hide_fast" });
    return null;
  }
  // #8b 3D-Modell weg (nur, wenn eins offen ist)
  if (c.modelOpen && ws.length <= 9 && MH_WORD.test(t) && !MH_QUESTION.test(t) && !MH_SIZE.test(t) && MH_HIDE.test(t)) {
    return r("", [{ type: "hide_model" }]);
  }
  if (c.modelOpen && MH_FULL.test(t)) return r("", [{ type: "hide_model" }]);
  // #11 Danke
  if (THANKS.test(t)) return r(line("thanks", { A }));
  // #12 „bist du da?“: kurz bestätigen, weiter zuhören
  if (PRESENCE_Q.test(t)) return r(line("presence", { A }), [], { followUp: true });
  // #18b Timer stoppen (phone-only; vor „stopp“, sonst hält „Timer stopp“ nur Jarvis an)
  if (TIMER_OFF_RX.test(t)) return r("", [{ type: "timer_stop" }]);
  m = TIMER_STOP_RX.exec(t);
  if (m) return r("", [m[1] ? { type: "timer_stop", label: capitalize(m[1]) } : { type: "timer_stop" }]);
  // #13 Stopp (≤ 3 Wörter)
  if (ws.length <= 3 && STOP_WORDS.test(t) && !(c.modelOpen && SPIN_WORDS.test(t)) && !MUSIC_WORDS.test(t)) {
    return r("", [], { special: "stop" });
  }
  // #14 neues Gespräch
  if (NEW_SESSION.test(t) || FORGET_THAT.test(t)) return r(line("newSession", { A }), [], { special: "reset" });
  // #15 wiederholen
  if (REPEAT.test(t) && String(c.lastAnswer ?? "").trim()) return r(String(c.lastAnswer), [], { special: "repeat" });
  // #16 Uhrzeit / Datum
  const now = c.now instanceof Date ? c.now : new Date(c.now ?? Date.now());
  if (TIME_Q.test(t)) return r(sayTime(now));
  if (DATE_Q.test(t)) return r(sayDate(now));
  // CR1.4 Kontostand und Termine ohne Gehirn (mit Gehirn überlegt das die KI, wie am Mac)
  if (free) {
    const kt = freeKontoTermin(raw, now, A, r);
    if (kt) return kt;
  }
  // CR1.4 WhatsApp-Entwurf ohne Gehirn
  if (free && WA_WORD.test(t)) {
    const wa = freeWhatsApp(raw, r);
    if (wa) return wa;
  }
  // #17 WhatsApp vorlesen → Mac (Schreiben geht an die KI)
  if (WA_WORD.test(t) && WA_UNREAD.test(t) && !COMPOSE_START.test(t)) return r(line("macOnlyWhatsApp", { A }));
  // #17b wie lange läuft der Timer noch
  if (TIMER_WORD.test(t) && !parseDuration(t) && !TIMER_SET_WORD.test(t) && TIMER_STATUS_WORD.test(t)) {
    return r(timerStatus(c.timers, now, A));
  }
  // #18 Timer / Wecker / erinnere mich in
  if (TIMER_ANY.test(t)) {
    const seconds = parseDuration(t);
    if (seconds) {
      let label = "";
      const lm = TIMER_LABEL.exec(t);
      if (lm && !TIMER_UNITS.has(lm[1])) label = capitalize(lm[1]);
      return r(line("timerSet", { A, dauer: sayDuration(seconds) }), [{ type: "timer", seconds, label }]);
    }
  }
  // #19 Wetter für jeden Ort sofort
  let weather = WEATHER_Q.test(t) && !WEATHER_BLOCK.test(t);
  if (weather && !WEATHER_WORD.test(t)) weather = WEATHER_CONTEXT.test(t);
  if (weather) {
    const { place, day } = weatherQuery(t);
    return r("", [{ type: "weather", place, day }]);
  }
  // #20 Spotify: auf dem Telefon nur Suche als Link; Steuerung macht der Mac
  if (SP_HERE.test(t) || ((m = SP_TRANSFER.exec(t)) && m[1])) return music();
  if (SP_NOW.test(t)) return music();
  t = t.replace(SP_LIEBLINGS, "lieblings$1").replace(SP_ZUFALLS, "zufalls$1");
  if (SP_SHUFFLE.test(t)) return music();
  if (!t.includes("youtube")) {
    let p = t.replace(SP_MIX_TAIL, "");
    p = p.replace(SP_SPOTIFY_TAIL, "");
    if (SP_PLAY.test(p)) return music();
    if (SP_LIKED.test(p)) return r("", [{ type: "spotify", query: "Lieblingssongs" }]);
    m = SP_PLAYLIST_1.exec(p) || SP_PLAYLIST_2.exec(p) || SP_PLAYLIST_3.exec(t);
    if (m && !SP_PLAYLIST_BAD.test(m[1])) return r("", [{ type: "spotify", query: m[1] }]);
    m = SP_ARTIST.exec(p);
    if (m) return r("", [{ type: "spotify", query: m[1] }]);
    m = SP_SPIEL.exec(p);
    if (m && (SP_NEXT.test(m[1]) || SP_PREV.test(m[1]))) return music();
    if (m && SPIEL_EXCLUDE_RX.test(m[1])) return null;            // „spiel ein Quiz mit mir“ → KI
    const vague = !!m && (words(m[1]).length > 5 || SP_VAGUE.test(m[1]));
    if (m && !vague && !SP_IGNORE.has(m[1])) {
      const song = SP_SONG.exec(m[1]);
      if (song) return r("", [{ type: "spotify", title: song[1], artist: song[2] }]);
      return r("", [{ type: "spotify", query: m[1] }]);
    }
  }
  m = SP_VOLUME.exec(t);
  if (m && (m[2] || m[4] || m[1] === "lautstärke") && parseNumber(m[3]) != null && parseNumber(m[3]) <= 100) return music();
  // #21 Lautstärke und Medientasten → Mac
  m = VOL_SET.exec(t);
  if (m && parseNumber(m[1]) != null) return music();
  if (LOUDER.test(t) || QUIETER.test(t) || MUTE.test(t)) return music();
  if (NEXT_SONG.test(t) || NEXT_FULL.test(t) || PREV_SONG.test(t)) return music();
  if (PAUSE.test(t) || PLAY_FULL.test(t)) return music();
  // #22 YouTube
  m = YT_1.exec(t) || YT_2.exec(t);
  if (m && m[1] !== "mal" && m[1] !== "bitte") {
    return r(`Ich suche ${m[1]} auf YouTube.`, [{ type: "youtube", query: m[1] }]);
  }
  // #24b „Kugel zurück in die Mitte“
  if (ORB_WORD.test(t) && ORB_CENTER.test(t) && ws.length <= 10) return r(line("orbOk", { A }), [{ type: "orb_reset" }]);
  // #24c Hotspot → Mac
  if (HOTSPOT_WORD.test(t) && HOTSPOT_VERB.test(t) && !HOTSPOT_OFF.test(t)) return r(line("macOnlyHotspot", { A }));
  // #24d Kugel größer/kleiner (ohne offenes 3D-Modell)
  if (!c.modelOpen && ws.length <= 10 && ORB_ZOOM_WORD.test(t)) {
    if (BIGGER.test(t)) return r("", [{ type: "orb_zoom", op: "bigger" }]);
    if (SMALLER.test(t)) return r("", [{ type: "orb_zoom", op: "smaller" }]);
    if (NORMAL_WORD.test(t) && SIZE_WORD.test(t)) return r("", [{ type: "orb_zoom", op: "reset" }]);
  }
  // #24e 3D-Modell ohne KI
  const mr = modelRequest(t, A);
  if (mr) return r(mr.say, mr.actions);
  // #24f offenes Modell verändern
  if (c.modelOpen && !c.imageOpen && ws.length <= 10 && !MA_EXCLUDE.test(t) && (MA_WORD.test(t) || ws.length <= 4)) {
    let op = null;
    if (MA_TOO_SMALL.test(t)) op = "bigger";
    else if (MA_TOO_BIG.test(t)) op = "smaller";
    else if (MA_TOO_FAST.test(t)) op = "slower";
    else if (MA_TOO_SLOW.test(t)) op = "faster";
    else if (BIGGER.test(t)) op = "bigger";
    else if (SMALLER.test(t)) op = "smaller";
    else if (MA_RESET.test(t)) op = "reset";
    else if (MA_MOVE.test(t)) {
      if (MA_FASTER.test(t)) op = "faster";
      else if (MA_SLOWER.test(t)) op = "slower";
      else if (MA_STOP.test(t)) op = "stop";
      else if (MA_LEFT.test(t)) op = "left";
      else if (MA_RIGHT.test(t)) op = "right";
      else if (MA_UP.test(t)) op = "up";
      else if (MA_DOWN.test(t)) op = "down";
      else if (SPIN_WORDS.test(t)) op = "spin";
    }
    if (op) return r("", [{ type: "model_adjust", op }]);
  }
  // #24 Bilder: zeigen, wegmachen, nächstes
  m = IMG_SHOW_1.exec(t) || IMG_SHOW_2.exec(t);
  if (m) {
    const query = m[1].replace(IMG_ARTICLE, "").trim().replace(IMG_CHROME, "").trim();
    if (query) return r("", [{ type: "show_image", query }]);
  }
  if (IMG_HIDE.test(t) && IMG_HIDE_WORD.test(t)) return r("", [{ type: "hide_image" }]);
  if (IMG_NEXT.test(t) && (IMG_WORD.test(t) || (c.imageOpen && IMG_NEXT_SHORT.test(t)))) {
    return r("", [{ type: "next_image" }]);
  }
  // #26 bauen lassen / Claude beauftragen → Mac
  if (BUILD_RX.test(t) || ASK_CLAUDE.test(t)) return r(line("macOnly", { A }));
  // #27 „such auf Amazon nach Kopfhörern“: Suche direkt auf der Seite
  let site = null, query = null;
  m = SEARCH_ON.exec(t);
  if (m) { site = m[1]; query = m[2]; }
  if (!site) {
    m = SEARCH_ON2.exec(t);
    if (m) { site = m[2]; query = m[1]; }
  }
  if (site === "amazon" && query && words(query).length > 2) return null;   // genaues Produkt überlegt die KI
  if (site && query && !["mal", "bitte", "nach"].includes(query)) {
    const url = SITE_SEARCH[site].replace("{q}", encodeURIComponent(query))
      .replace("{slug}", encodeURIComponent(query.replace(/ /g, "-")));
    return r(`Ich suche ${query} auf ${nice(site)}.`,
      [{ type: "open_url", url, label: `${nice(site)}: ${query}`, query }]);
  }
  // #28 „bring mich auf …“
  m = BRING_ME.exec(t) || WHERE_GET.exec(t);
  if (m && m[1].trim() && !["mal", "bitte", "da", "hin"].includes(m[1].trim())
    && !m[1].startsWith("nach ") && !m[1].startsWith("heim")) {
    let target = m[1].trim();
    if (t.startsWith("wo ") && /(laden|downloaden)$/u.test(t)) target += " download";
    if (SPOKEN_DOMAIN.test(target)) {
      const url = siteUrl(target);
      if (url) return r("", [{ type: "open_url", url, label: siteLabel(url) }]);
    }
    return r("", [{ type: "web_search", query: target }]);
  }
  // #29 Route (zuhause: Wohnort)
  m = ROUTE.exec(t);
  if (m) {
    const dest = (m[1] || m[2] || "").trim();
    if (["hause", "zuhause", "heim"].includes(dest)) {
      const home = String(c.wohnort ?? "").trim();
      if (!home) return null;
      return r(`Route nach ${home}.`, [{ type: "route", destination: home }]);
    }
    if (dest) return r(`Route nach ${dest}.`, [{ type: "route", destination: dest }]);
  }
  // #30 google
  m = GOOGLE.exec(t) || (free ? SEARCH_FOR.exec(t) : null);
  if (m) return r(`Ich suche nach ${m[1]}.`, [{ type: "web_search", query: m[1] }]);
  // #31 „check mal Tagesschau“: Seite lesen und zusammenfassen kann nur die KI
  m = CHECK_RX.exec(t) || WHAT_ON.exec(t);
  if (m) {
    const target = m[1].replace(CHECK_SITE_LEAD, "").trim();
    const marked = target !== m[1];
    const nm = normName(target);
    const known = SPOKEN_DOMAIN.test(nm) || !!closeKey(nm, SITES)[1];
    const explicit = CHECK_EXPLICIT.test(t) && words(nm).length <= 2;
    const topic = CHECK_TOPIC.test(m[1]) || CHECK_TOPIC.test(nm);
    if (nm.length >= 3 && (known || (!topic && (marked || explicit)))) return null;
  }
  // #32 Programme beenden → Mac
  m = QUIT_RX.exec(t.replace(QUIT_LEAD, ""));
  if (m) {
    const spoken = (m.groups.a || m.groups.b || m.groups.c || "").replace(QUIT_SPOKEN_LEAD, "");
    if (!QUIT_ALL.test(spoken) && quitNames(spoken).length) return r(line("macOnlyApps", { A }));
  }
  // #35 „ruf 0171 … an“ → Anruf vorbereiten; „ruf Mama an“ → KI (Nummer aus dem Gedächtnis)
  m = CALL_RX.exec(t);
  if (m) {
    const number = /^[\d\s]+$/u.test(m[1]) ? numberIn(raw) : "";
    if (number) return r("", [{ type: "call", number }]);
    if (!t.endsWith(" auf")) return null;
  }
  // #33 öffne / starte / zeig mir / geh auf …
  m = OPEN_RX.exec(t);
  if (m && !((m[1] === "ruf" || m[1] === "rufe") && !t.endsWith(" auf"))) {
    const verb = m[1], name = m[2];
    const parts = name.split(OPEN_SPLIT).filter((x) => x.trim());
    if (parts.length > 1) {                       // „öffne Spotify und YouTube“: nur, wenn jedes Teil eindeutig ist
      const acts = parts.map((x) => openTarget(x, verb, false));
      if (acts.every((a) => a && !a.macOnly)) return r("", acts);
      return null;
    }
    const act = openTarget(name, verb);
    if (act) {
      if (act.macOnly) return r(line("macOnly", { A }));
      return r(`Ich öffne ${nice(act.label || act.query || hostOf(act.url))}.`, [act]);
    }
  }
  // #34 zeig dich
  if (SHOW_ME.test(t)) return r(line("show", { A }), [], { special: "show" });
  return null;
}
