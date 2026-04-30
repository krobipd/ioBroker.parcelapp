"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === "object") || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
  }
  return to;
};
var __toCommonJS = mod => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var types_exports = {};
__export(types_exports, {
  FALLBACK_LANGUAGE: () => FALLBACK_LANGUAGE,
  STATUS_LABELS: () => STATUS_LABELS,
  SUPPORTED_LANGUAGES: () => SUPPORTED_LANGUAGES,
});
module.exports = __toCommonJS(types_exports);
const STATUS_LABELS = {
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
    0: "\u0414\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043E",
    1: "\u0417\u0430\u043C\u043E\u0440\u043E\u0436\u0435\u043D\u043E",
    2: "\u0412 \u043F\u0443\u0442\u0438",
    3: "\u041E\u0436\u0438\u0434\u0430\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0438\u044F",
    4: "\u0414\u043E\u0441\u0442\u0430\u0432\u043B\u044F\u0435\u0442\u0441\u044F",
    5: "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E",
    6: "\u041D\u0435\u0443\u0434\u0430\u0447\u043D\u0430\u044F \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0430",
    7: "\u0418\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435",
    8: "\u0417\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u043E",
  },
  pt: {
    0: "Entregue",
    1: "Congelado",
    2: "Em tr\xE2nsito",
    3: "Aguardando recolha",
    4: "Em entrega",
    5: "N\xE3o encontrado",
    6: "Tentativa de entrega falhou",
    7: "Exce\xE7\xE3o",
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
    0: "Livr\xE9",
    1: "Gel\xE9",
    2: "En transit",
    3: "En attente de retrait",
    4: "En cours de livraison",
    5: "Introuvable",
    6: "\xC9chec de la livraison",
    7: "Exception",
    8: "Enregistr\xE9",
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
    2: "En tr\xE1nsito",
    3: "Esperando recogida",
    4: "En reparto",
    5: "No encontrado",
    6: "Intento de entrega fallido",
    7: "Excepci\xF3n",
    8: "Registrado",
  },
  pl: {
    0: "Dostarczone",
    1: "Zamro\u017Cone",
    2: "W drodze",
    3: "Oczekuje na odbi\xF3r",
    4: "W dor\u0119czeniu",
    5: "Nie znaleziono",
    6: "Nieudana pr\xF3ba dor\u0119czenia",
    7: "Wyj\u0105tek",
    8: "Zarejestrowane",
  },
  uk: {
    0: "\u0414\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043E",
    1: "\u0417\u0430\u043C\u043E\u0440\u043E\u0436\u0435\u043D\u043E",
    2: "\u0412 \u0434\u043E\u0440\u043E\u0437\u0456",
    3: "\u041E\u0447\u0456\u043A\u0443\u0454 \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043D\u044F",
    4: "\u0414\u043E\u0441\u0442\u0430\u0432\u043B\u044F\u0454\u0442\u044C\u0441\u044F",
    5: "\u041D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E",
    6: "\u041D\u0435\u0432\u0434\u0430\u043B\u0430 \u0441\u043F\u0440\u043E\u0431\u0430 \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0438",
    7: "\u0412\u0438\u043D\u044F\u0442\u043E\u043A",
    8: "\u0417\u0430\u0440\u0435\u0454\u0441\u0442\u0440\u043E\u0432\u0430\u043D\u043E",
  },
  "zh-cn": {
    0: "\u5DF2\u9001\u8FBE",
    1: "\u5DF2\u51BB\u7ED3",
    2: "\u8FD0\u8F93\u4E2D",
    3: "\u7B49\u5F85\u53D6\u4EF6",
    4: "\u6D3E\u9001\u4E2D",
    5: "\u672A\u627E\u5230",
    6: "\u6D3E\u9001\u5931\u8D25",
    7: "\u5F02\u5E38",
    8: "\u5DF2\u767B\u8BB0",
  },
};
const SUPPORTED_LANGUAGES = Object.keys(STATUS_LABELS);
const FALLBACK_LANGUAGE = "en";
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    FALLBACK_LANGUAGE,
    STATUS_LABELS,
    SUPPORTED_LANGUAGES,
  });
//# sourceMappingURL=types.js.map
