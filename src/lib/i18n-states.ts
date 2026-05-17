/**
 * Localized state names for parcel deliveries in 11 ioBroker system languages.
 *
 * ioBroker accepts plain strings or `{ en, de, ... }` translation objects for
 * `common.name`. Admin, vis and the Object-Browser pick the user's language
 * automatically — we just hand them the object.
 *
 * Adapter logs (`this.log.*`) stay English by ioBroker convention so that
 * user bug reports remain readable for maintainers regardless of the user's
 * system language.
 */

type Lang = "en" | "de" | "ru" | "pt" | "nl" | "fr" | "it" | "es" | "pl" | "uk" | "zh-cn";

/** Translation object as ioBroker expects it. */
export type StateName = Record<Lang, string>;

/** State / channel display names (`common.name`). */
export const STATE_NAMES: Record<string, StateName> = {
  // ──────── Per-delivery states ────────
  carrier: {
    en: "Carrier",
    de: "Versanddienst",
    ru: "Перевозчик",
    pt: "Transportadora",
    nl: "Vervoerder",
    fr: "Transporteur",
    it: "Corriere",
    es: "Transportista",
    pl: "Przewoźnik",
    uk: "Перевізник",
    "zh-cn": "承运商",
  },
  status: {
    en: "Status",
    de: "Status",
    ru: "Статус",
    pt: "Estado",
    nl: "Status",
    fr: "État",
    it: "Stato",
    es: "Estado",
    pl: "Status",
    uk: "Статус",
    "zh-cn": "状态",
  },
  statusCode: {
    en: "Status Code",
    de: "Status-Code",
    ru: "Код статуса",
    pt: "Código de estado",
    nl: "Statuscode",
    fr: "Code d'état",
    it: "Codice di stato",
    es: "Código de estado",
    pl: "Kod statusu",
    uk: "Код статусу",
    "zh-cn": "状态代码",
  },
  description: {
    en: "Description",
    de: "Beschreibung",
    ru: "Описание",
    pt: "Descrição",
    nl: "Beschrijving",
    fr: "Description",
    it: "Descrizione",
    es: "Descripción",
    pl: "Opis",
    uk: "Опис",
    "zh-cn": "描述",
  },
  trackingNumber: {
    en: "Tracking Number",
    de: "Sendungsnummer",
    ru: "Трек-номер",
    pt: "Número de rastreio",
    nl: "Trackingnummer",
    fr: "Numéro de suivi",
    it: "Numero di tracciamento",
    es: "Número de seguimiento",
    pl: "Numer śledzenia",
    uk: "Номер відстеження",
    "zh-cn": "追踪号",
  },
  extraInfo: {
    en: "Extra Information",
    de: "Zusatz-Information",
    ru: "Дополнительная информация",
    pt: "Informação adicional",
    nl: "Extra informatie",
    fr: "Informations supplémentaires",
    it: "Informazioni aggiuntive",
    es: "Información adicional",
    pl: "Dodatkowe informacje",
    uk: "Додаткова інформація",
    "zh-cn": "附加信息",
  },
  deliveryWindow: {
    en: "Delivery Window",
    de: "Zustellfenster",
    ru: "Окно доставки",
    pt: "Janela de entrega",
    nl: "Bezorgvenster",
    fr: "Créneau de livraison",
    it: "Finestra di consegna",
    es: "Ventana de entrega",
    pl: "Okno dostawy",
    uk: "Вікно доставки",
    "zh-cn": "派送时段",
  },
  deliveryEstimate: {
    en: "Delivery Estimate",
    de: "Voraussichtliche Zustellung",
    ru: "Ожидаемая доставка",
    pt: "Previsão de entrega",
    nl: "Verwachte bezorging",
    fr: "Livraison estimée",
    it: "Consegna prevista",
    es: "Entrega estimada",
    pl: "Szacowana dostawa",
    uk: "Очікувана доставка",
    "zh-cn": "预计送达",
  },
  lastEvent: {
    en: "Last Event",
    de: "Letztes Ereignis",
    ru: "Последнее событие",
    pt: "Último evento",
    nl: "Laatste gebeurtenis",
    fr: "Dernier événement",
    it: "Ultimo evento",
    es: "Último evento",
    pl: "Ostatnie zdarzenie",
    uk: "Остання подія",
    "zh-cn": "最近事件",
  },
  lastLocation: {
    en: "Last Location",
    de: "Letzter Standort",
    ru: "Последнее местоположение",
    pt: "Última localização",
    nl: "Laatste locatie",
    fr: "Dernier emplacement",
    it: "Ultima posizione",
    es: "Última ubicación",
    pl: "Ostatnia lokalizacja",
    uk: "Останнє місцезнаходження",
    "zh-cn": "最近位置",
  },
  lastUpdated: {
    en: "Last Updated",
    de: "Zuletzt aktualisiert",
    ru: "Последнее обновление",
    pt: "Última atualização",
    nl: "Laatst bijgewerkt",
    fr: "Dernière mise à jour",
    it: "Ultimo aggiornamento",
    es: "Última actualización",
    pl: "Ostatnia aktualizacja",
    uk: "Останнє оновлення",
    "zh-cn": "最后更新",
  },

  // ──────── Summary states ────────
  activeCount: {
    en: "Active Deliveries",
    de: "Aktive Sendungen",
    ru: "Активные посылки",
    pt: "Entregas ativas",
    nl: "Actieve zendingen",
    fr: "Livraisons actives",
    it: "Spedizioni attive",
    es: "Envíos activos",
    pl: "Aktywne przesyłki",
    uk: "Активні відправлення",
    "zh-cn": "活动中的包裹",
  },
  todayCount: {
    en: "Deliveries Today",
    de: "Sendungen heute",
    ru: "Доставки сегодня",
    pt: "Entregas hoje",
    nl: "Zendingen vandaag",
    fr: "Livraisons aujourd'hui",
    it: "Spedizioni di oggi",
    es: "Entregas de hoy",
    pl: "Dostawy dzisiaj",
    uk: "Доставки сьогодні",
    "zh-cn": "今日送达",
  },
  summaryDeliveryWindow: {
    en: "Combined Delivery Window",
    de: "Kombiniertes Zustellfenster",
    ru: "Объединённое окно доставки",
    pt: "Janela de entrega combinada",
    nl: "Gecombineerd bezorgvenster",
    fr: "Créneau de livraison combiné",
    it: "Finestra di consegna combinata",
    es: "Ventana de entrega combinada",
    pl: "Łączne okno dostawy",
    uk: "Об'єднане вікно доставки",
    "zh-cn": "合并派送时段",
  },
};

/** Delivery-estimate labels keyed by language code. */
export const ESTIMATE_LABELS: Record<string, Record<string, string>> = {
  de: {
    overdue: "überfällig",
    today: "heute",
    tomorrow: "morgen",
    days: "in %d Tagen",
  },
  en: {
    overdue: "overdue",
    today: "today",
    tomorrow: "tomorrow",
    days: "in %d days",
  },
  ru: {
    overdue: "просрочено",
    today: "сегодня",
    tomorrow: "завтра",
    days: "через %d дн.",
  },
  pt: {
    overdue: "atrasado",
    today: "hoje",
    tomorrow: "amanhã",
    days: "em %d dias",
  },
  nl: {
    overdue: "te laat",
    today: "vandaag",
    tomorrow: "morgen",
    days: "over %d dagen",
  },
  fr: {
    overdue: "en retard",
    today: "aujourd'hui",
    tomorrow: "demain",
    days: "dans %d jours",
  },
  it: {
    overdue: "in ritardo",
    today: "oggi",
    tomorrow: "domani",
    days: "tra %d giorni",
  },
  es: {
    overdue: "atrasado",
    today: "hoy",
    tomorrow: "mañana",
    days: "en %d días",
  },
  pl: {
    overdue: "zaległe",
    today: "dzisiaj",
    tomorrow: "jutro",
    days: "za %d dni",
  },
  uk: {
    overdue: "прострочено",
    today: "сьогодні",
    tomorrow: "завтра",
    days: "через %d дн.",
  },
  "zh-cn": {
    overdue: "已逾期",
    today: "今天",
    tomorrow: "明天",
    days: "%d 天后",
  },
};

/**
 * Translation object for a state name. Pass into `common.name`; ioBroker
 * Admin/vis/Object-Browser localizes automatically.
 *
 * @param key Translation key in {@link STATE_NAMES}.
 */
export function tName(key: keyof typeof STATE_NAMES): StateName {
  return STATE_NAMES[key];
}
