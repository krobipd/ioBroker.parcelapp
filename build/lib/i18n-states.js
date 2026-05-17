"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var i18n_states_exports = {};
__export(i18n_states_exports, {
  ESTIMATE_LABELS: () => ESTIMATE_LABELS,
  STATE_NAMES: () => STATE_NAMES,
  tName: () => tName
});
module.exports = __toCommonJS(i18n_states_exports);
const STATE_NAMES = {
  // ──────── instanceObjects (synced to io-package.json) ────────
  info: {
    en: "Adapter Information",
    de: "Adapter-Informationen",
    ru: "\u0418\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044F \u043E\u0431 \u0430\u0434\u0430\u043F\u0442\u0435\u0440\u0435",
    pt: "Informa\xE7\xF5es do adaptador",
    nl: "Adapterinformatie",
    fr: "Informations sur l'adaptateur",
    it: "Informazioni sull'adattatore",
    es: "Informaci\xF3n del adaptador",
    pl: "Informacje o adapterze",
    uk: "\u0406\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0456\u044F \u043F\u0440\u043E \u0430\u0434\u0430\u043F\u0442\u0435\u0440",
    "zh-cn": "\u9002\u914D\u5668\u4FE1\u606F"
  },
  infoConnection: {
    en: "Connection status",
    de: "Verbindungsstatus",
    ru: "\u0421\u0442\u0430\u0442\u0443\u0441 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F",
    pt: "Estado da liga\xE7\xE3o",
    nl: "Verbindingsstatus",
    fr: "\xC9tat de la connexion",
    it: "Stato della connessione",
    es: "Estado de la conexi\xF3n",
    pl: "Status po\u0142\u0105czenia",
    uk: "\u0421\u0442\u0430\u043D \u0437'\u0454\u0434\u043D\u0430\u043D\u043D\u044F",
    "zh-cn": "\u8FDE\u63A5\u72B6\u6001"
  },
  deliveries: {
    en: "Deliveries",
    de: "Sendungen",
    ru: "\u0414\u043E\u0441\u0442\u0430\u0432\u043A\u0438",
    pt: "Entregas",
    nl: "Zendingen",
    fr: "Livraisons",
    it: "Consegne",
    es: "Env\xEDos",
    pl: "Przesy\u0142ki",
    uk: "\u0414\u043E\u0441\u0442\u0430\u0432\u043A\u0438",
    "zh-cn": "\u5305\u88F9"
  },
  summary: {
    en: "Summary",
    de: "Zusammenfassung",
    ru: "\u0421\u0432\u043E\u0434\u043A\u0430",
    pt: "Resumo",
    nl: "Samenvatting",
    fr: "R\xE9sum\xE9",
    it: "Riepilogo",
    es: "Resumen",
    pl: "Podsumowanie",
    uk: "\u041F\u0456\u0434\u0441\u0443\u043C\u043E\u043A",
    "zh-cn": "\u6C47\u603B"
  },
  // ──────── Per-delivery states ────────
  carrier: {
    en: "Carrier",
    de: "Versanddienst",
    ru: "\u041F\u0435\u0440\u0435\u0432\u043E\u0437\u0447\u0438\u043A",
    pt: "Transportadora",
    nl: "Vervoerder",
    fr: "Transporteur",
    it: "Corriere",
    es: "Transportista",
    pl: "Przewo\u017Anik",
    uk: "\u041F\u0435\u0440\u0435\u0432\u0456\u0437\u043D\u0438\u043A",
    "zh-cn": "\u627F\u8FD0\u5546"
  },
  status: {
    en: "Status",
    de: "Status",
    ru: "\u0421\u0442\u0430\u0442\u0443\u0441",
    pt: "Estado",
    nl: "Status",
    fr: "\xC9tat",
    it: "Stato",
    es: "Estado",
    pl: "Status",
    uk: "\u0421\u0442\u0430\u0442\u0443\u0441",
    "zh-cn": "\u72B6\u6001"
  },
  statusCode: {
    en: "Status Code",
    de: "Status-Code",
    ru: "\u041A\u043E\u0434 \u0441\u0442\u0430\u0442\u0443\u0441\u0430",
    pt: "C\xF3digo de estado",
    nl: "Statuscode",
    fr: "Code d'\xE9tat",
    it: "Codice di stato",
    es: "C\xF3digo de estado",
    pl: "Kod statusu",
    uk: "\u041A\u043E\u0434 \u0441\u0442\u0430\u0442\u0443\u0441\u0443",
    "zh-cn": "\u72B6\u6001\u4EE3\u7801"
  },
  description: {
    en: "Description",
    de: "Beschreibung",
    ru: "\u041E\u043F\u0438\u0441\u0430\u043D\u0438\u0435",
    pt: "Descri\xE7\xE3o",
    nl: "Beschrijving",
    fr: "Description",
    it: "Descrizione",
    es: "Descripci\xF3n",
    pl: "Opis",
    uk: "\u041E\u043F\u0438\u0441",
    "zh-cn": "\u63CF\u8FF0"
  },
  trackingNumber: {
    en: "Tracking Number",
    de: "Sendungsnummer",
    ru: "\u0422\u0440\u0435\u043A-\u043D\u043E\u043C\u0435\u0440",
    pt: "N\xFAmero de rastreio",
    nl: "Trackingnummer",
    fr: "Num\xE9ro de suivi",
    it: "Numero di tracciamento",
    es: "N\xFAmero de seguimiento",
    pl: "Numer \u015Bledzenia",
    uk: "\u041D\u043E\u043C\u0435\u0440 \u0432\u0456\u0434\u0441\u0442\u0435\u0436\u0435\u043D\u043D\u044F",
    "zh-cn": "\u8FFD\u8E2A\u53F7"
  },
  extraInfo: {
    en: "Extra Information",
    de: "Zusatz-Information",
    ru: "\u0414\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044F",
    pt: "Informa\xE7\xE3o adicional",
    nl: "Extra informatie",
    fr: "Informations suppl\xE9mentaires",
    it: "Informazioni aggiuntive",
    es: "Informaci\xF3n adicional",
    pl: "Dodatkowe informacje",
    uk: "\u0414\u043E\u0434\u0430\u0442\u043A\u043E\u0432\u0430 \u0456\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0456\u044F",
    "zh-cn": "\u9644\u52A0\u4FE1\u606F"
  },
  deliveryWindow: {
    en: "Delivery Window",
    de: "Zustellfenster",
    ru: "\u041E\u043A\u043D\u043E \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0438",
    pt: "Janela de entrega",
    nl: "Bezorgvenster",
    fr: "Cr\xE9neau de livraison",
    it: "Finestra di consegna",
    es: "Ventana de entrega",
    pl: "Okno dostawy",
    uk: "\u0412\u0456\u043A\u043D\u043E \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0438",
    "zh-cn": "\u6D3E\u9001\u65F6\u6BB5"
  },
  deliveryEstimate: {
    en: "Delivery Estimate",
    de: "Voraussichtliche Zustellung",
    ru: "\u041E\u0436\u0438\u0434\u0430\u0435\u043C\u0430\u044F \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0430",
    pt: "Previs\xE3o de entrega",
    nl: "Verwachte bezorging",
    fr: "Livraison estim\xE9e",
    it: "Consegna prevista",
    es: "Entrega estimada",
    pl: "Szacowana dostawa",
    uk: "\u041E\u0447\u0456\u043A\u0443\u0432\u0430\u043D\u0430 \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0430",
    "zh-cn": "\u9884\u8BA1\u9001\u8FBE"
  },
  lastEvent: {
    en: "Last Event",
    de: "Letztes Ereignis",
    ru: "\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0435 \u0441\u043E\u0431\u044B\u0442\u0438\u0435",
    pt: "\xDAltimo evento",
    nl: "Laatste gebeurtenis",
    fr: "Dernier \xE9v\xE9nement",
    it: "Ultimo evento",
    es: "\xDAltimo evento",
    pl: "Ostatnie zdarzenie",
    uk: "\u041E\u0441\u0442\u0430\u043D\u043D\u044F \u043F\u043E\u0434\u0456\u044F",
    "zh-cn": "\u6700\u8FD1\u4E8B\u4EF6"
  },
  lastLocation: {
    en: "Last Location",
    de: "Letzter Standort",
    ru: "\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0435 \u043C\u0435\u0441\u0442\u043E\u043F\u043E\u043B\u043E\u0436\u0435\u043D\u0438\u0435",
    pt: "\xDAltima localiza\xE7\xE3o",
    nl: "Laatste locatie",
    fr: "Dernier emplacement",
    it: "Ultima posizione",
    es: "\xDAltima ubicaci\xF3n",
    pl: "Ostatnia lokalizacja",
    uk: "\u041E\u0441\u0442\u0430\u043D\u043D\u0454 \u043C\u0456\u0441\u0446\u0435\u0437\u043D\u0430\u0445\u043E\u0434\u0436\u0435\u043D\u043D\u044F",
    "zh-cn": "\u6700\u8FD1\u4F4D\u7F6E"
  },
  lastUpdated: {
    en: "Last Updated",
    de: "Zuletzt aktualisiert",
    ru: "\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0435 \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435",
    pt: "\xDAltima atualiza\xE7\xE3o",
    nl: "Laatst bijgewerkt",
    fr: "Derni\xE8re mise \xE0 jour",
    it: "Ultimo aggiornamento",
    es: "\xDAltima actualizaci\xF3n",
    pl: "Ostatnia aktualizacja",
    uk: "\u041E\u0441\u0442\u0430\u043D\u043D\u0454 \u043E\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044F",
    "zh-cn": "\u6700\u540E\u66F4\u65B0"
  },
  // ──────── Summary states ────────
  activeCount: {
    en: "Active Deliveries",
    de: "Aktive Sendungen",
    ru: "\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0435 \u043F\u043E\u0441\u044B\u043B\u043A\u0438",
    pt: "Entregas ativas",
    nl: "Actieve zendingen",
    fr: "Livraisons actives",
    it: "Spedizioni attive",
    es: "Env\xEDos activos",
    pl: "Aktywne przesy\u0142ki",
    uk: "\u0410\u043A\u0442\u0438\u0432\u043D\u0456 \u0432\u0456\u0434\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044F",
    "zh-cn": "\u6D3B\u52A8\u4E2D\u7684\u5305\u88F9"
  },
  todayCount: {
    en: "Deliveries Today",
    de: "Sendungen heute",
    ru: "\u0414\u043E\u0441\u0442\u0430\u0432\u043A\u0438 \u0441\u0435\u0433\u043E\u0434\u043D\u044F",
    pt: "Entregas hoje",
    nl: "Zendingen vandaag",
    fr: "Livraisons aujourd'hui",
    it: "Spedizioni di oggi",
    es: "Entregas de hoy",
    pl: "Dostawy dzisiaj",
    uk: "\u0414\u043E\u0441\u0442\u0430\u0432\u043A\u0438 \u0441\u044C\u043E\u0433\u043E\u0434\u043D\u0456",
    "zh-cn": "\u4ECA\u65E5\u9001\u8FBE"
  },
  summaryDeliveryWindow: {
    en: "Combined Delivery Window",
    de: "Kombiniertes Zustellfenster",
    ru: "\u041E\u0431\u044A\u0435\u0434\u0438\u043D\u0451\u043D\u043D\u043E\u0435 \u043E\u043A\u043D\u043E \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0438",
    pt: "Janela de entrega combinada",
    nl: "Gecombineerd bezorgvenster",
    fr: "Cr\xE9neau de livraison combin\xE9",
    it: "Finestra di consegna combinata",
    es: "Ventana de entrega combinada",
    pl: "\u0141\u0105czne okno dostawy",
    uk: "\u041E\u0431'\u0454\u0434\u043D\u0430\u043D\u0435 \u0432\u0456\u043A\u043D\u043E \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0438",
    "zh-cn": "\u5408\u5E76\u6D3E\u9001\u65F6\u6BB5"
  }
};
const ESTIMATE_LABELS = {
  de: {
    overdue: "\xFCberf\xE4llig",
    today: "heute",
    tomorrow: "morgen",
    days: "in %d Tagen"
  },
  en: {
    overdue: "overdue",
    today: "today",
    tomorrow: "tomorrow",
    days: "in %d days"
  },
  ru: {
    overdue: "\u043F\u0440\u043E\u0441\u0440\u043E\u0447\u0435\u043D\u043E",
    today: "\u0441\u0435\u0433\u043E\u0434\u043D\u044F",
    tomorrow: "\u0437\u0430\u0432\u0442\u0440\u0430",
    days: "\u0447\u0435\u0440\u0435\u0437 %d \u0434\u043D."
  },
  pt: {
    overdue: "atrasado",
    today: "hoje",
    tomorrow: "amanh\xE3",
    days: "em %d dias"
  },
  nl: {
    overdue: "te laat",
    today: "vandaag",
    tomorrow: "morgen",
    days: "over %d dagen"
  },
  fr: {
    overdue: "en retard",
    today: "aujourd'hui",
    tomorrow: "demain",
    days: "dans %d jours"
  },
  it: {
    overdue: "in ritardo",
    today: "oggi",
    tomorrow: "domani",
    days: "tra %d giorni"
  },
  es: {
    overdue: "atrasado",
    today: "hoy",
    tomorrow: "ma\xF1ana",
    days: "en %d d\xEDas"
  },
  pl: {
    overdue: "zaleg\u0142e",
    today: "dzisiaj",
    tomorrow: "jutro",
    days: "za %d dni"
  },
  uk: {
    overdue: "\u043F\u0440\u043E\u0441\u0442\u0440\u043E\u0447\u0435\u043D\u043E",
    today: "\u0441\u044C\u043E\u0433\u043E\u0434\u043D\u0456",
    tomorrow: "\u0437\u0430\u0432\u0442\u0440\u0430",
    days: "\u0447\u0435\u0440\u0435\u0437 %d \u0434\u043D."
  },
  "zh-cn": {
    overdue: "\u5DF2\u903E\u671F",
    today: "\u4ECA\u5929",
    tomorrow: "\u660E\u5929",
    days: "%d \u5929\u540E"
  }
};
function tName(key) {
  return STATE_NAMES[key];
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ESTIMATE_LABELS,
  STATE_NAMES,
  tName
});
//# sourceMappingURL=i18n-states.js.map
