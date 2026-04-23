/** API response from parcel.app deliveries endpoint */
export interface ParcelApiResponse {
  /** Whether the request was successful */
  success: boolean;
  /** Error message if request failed */
  error_message?: string;
  /** Error code if request failed */
  error_code?: string;
  /** List of deliveries */
  deliveries?: ParcelDelivery[];
}

/** Single delivery from the parcel.app API */
export interface ParcelDelivery {
  /** Carrier identifier */
  carrier_code: string;
  /** User-defined description */
  description: string;
  /** Status code (0-8 as string) */
  status_code: string;
  /** Tracking number */
  tracking_number: string;
  /** Extra info (postal code, email) */
  extra_information?: string;
  /** Expected delivery date */
  date_expected?: string;
  /** Expected delivery date end */
  date_expected_end?: string;
  /** Expected delivery Unix timestamp */
  timestamp_expected?: number;
  /** Expected delivery end Unix timestamp */
  timestamp_expected_end?: number;
  /** Tracking events (newest first) */
  events?: ParcelEvent[];
}

/** Single tracking event */
export interface ParcelEvent {
  /** Event description */
  event: string;
  /** Event date string */
  date: string;
  /** Event location */
  location?: string;
  /** Additional details */
  additional?: string;
}

/** Request body for adding a delivery */
export interface AddDeliveryRequest {
  /** Tracking number to add */
  tracking_number: string;
  /** Carrier code */
  carrier_code: string;
  /** User description */
  description: string;
  /** Tracking language */
  language?: string;
  /** Send push confirmation */
  send_push_confirmation?: boolean;
}

/** Add delivery API response */
export interface AddDeliveryResponse {
  /** Whether the delivery was added */
  success: boolean;
  /** Error message if failed */
  error_message?: string;
}

/** Carrier names mapping (carrier_code → display name) */
export type CarrierMap = Record<string, string>;

/** Delivery status labels for status codes 0-8, keyed by ioBroker language code */
export const STATUS_LABELS: Record<string, Record<number, string>> = {
  de: {
    0: "Zugestellt",
    1: "Eingefroren",
    2: "Unterwegs",
    3: "Abholung erwartet",
    4: "In Zustellung",
    5: "Nicht gefunden",
    6: "Zustellversuch gescheitert",
    7: "Ausnahme",
    8: "Registriert",
  },
  en: {
    0: "Delivered",
    1: "Frozen",
    2: "In Transit",
    3: "Awaiting Pickup",
    4: "Out for Delivery",
    5: "Not Found",
    6: "Delivery Attempt Failed",
    7: "Exception",
    8: "Info Received",
  },
  ru: {
    0: "Доставлено",
    1: "Заморожено",
    2: "В пути",
    3: "Ожидает получения",
    4: "Доставляется",
    5: "Не найдено",
    6: "Неудачная доставка",
    7: "Исключение",
    8: "Зарегистрировано",
  },
  pt: {
    0: "Entregue",
    1: "Congelado",
    2: "Em trânsito",
    3: "Aguardando recolha",
    4: "Em entrega",
    5: "Não encontrado",
    6: "Tentativa de entrega falhou",
    7: "Exceção",
    8: "Registado",
  },
  nl: {
    0: "Bezorgd",
    1: "Bevroren",
    2: "Onderweg",
    3: "Wacht op ophaling",
    4: "Wordt bezorgd",
    5: "Niet gevonden",
    6: "Bezorgpoging mislukt",
    7: "Uitzondering",
    8: "Geregistreerd",
  },
  fr: {
    0: "Livré",
    1: "Gelé",
    2: "En transit",
    3: "En attente de retrait",
    4: "En cours de livraison",
    5: "Introuvable",
    6: "Échec de la livraison",
    7: "Exception",
    8: "Enregistré",
  },
  it: {
    0: "Consegnato",
    1: "Congelato",
    2: "In transito",
    3: "In attesa di ritiro",
    4: "In consegna",
    5: "Non trovato",
    6: "Consegna fallita",
    7: "Eccezione",
    8: "Registrato",
  },
  es: {
    0: "Entregado",
    1: "Congelado",
    2: "En tránsito",
    3: "Esperando recogida",
    4: "En reparto",
    5: "No encontrado",
    6: "Intento de entrega fallido",
    7: "Excepción",
    8: "Registrado",
  },
  pl: {
    0: "Dostarczone",
    1: "Zamrożone",
    2: "W drodze",
    3: "Oczekuje na odbiór",
    4: "W doręczeniu",
    5: "Nie znaleziono",
    6: "Nieudana próba doręczenia",
    7: "Wyjątek",
    8: "Zarejestrowane",
  },
  uk: {
    0: "Доставлено",
    1: "Заморожено",
    2: "В дорозі",
    3: "Очікує отримання",
    4: "Доставляється",
    5: "Не знайдено",
    6: "Невдала спроба доставки",
    7: "Виняток",
    8: "Зареєстровано",
  },
  "zh-cn": {
    0: "已送达",
    1: "已冻结",
    2: "运输中",
    3: "等待取件",
    4: "派送中",
    5: "未找到",
    6: "派送失败",
    7: "异常",
    8: "已登记",
  },
};

/** Backward-compatible aliases (used by tests and legacy imports) */
export const STATUS_LABELS_DE = STATUS_LABELS.de;
export const STATUS_LABELS_EN = STATUS_LABELS.en;

/** Language codes the adapter generates state labels for */
export const SUPPORTED_LANGUAGES = Object.keys(STATUS_LABELS);

/** Fallback language used when system.config.language is outside SUPPORTED_LANGUAGES */
export const FALLBACK_LANGUAGE = "en";

// Augment the ioBroker global namespace
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ioBroker {
    interface AdapterConfig {
      /** parcel.app API key */
      apiKey: string;
      /** Polling interval in minutes */
      pollInterval: number;
      /** Automatically remove delivered packages from states */
      autoRemoveDelivered: boolean;
    }
  }
}
