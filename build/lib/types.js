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
var types_exports = {};
__export(types_exports, {
  STATUS_LABELS_DE: () => STATUS_LABELS_DE,
  STATUS_LABELS_EN: () => STATUS_LABELS_EN
});
module.exports = __toCommonJS(types_exports);
const STATUS_LABELS_DE = {
  0: "Zugestellt",
  1: "Eingefroren",
  2: "Unterwegs",
  3: "Abholung erwartet",
  4: "In Zustellung",
  5: "Nicht gefunden",
  6: "Zustellversuch gescheitert",
  7: "Ausnahme",
  8: "Registriert"
};
const STATUS_LABELS_EN = {
  0: "Delivered",
  1: "Frozen",
  2: "In Transit",
  3: "Awaiting Pickup",
  4: "Out for Delivery",
  5: "Not Found",
  6: "Delivery Attempt Failed",
  7: "Exception",
  8: "Info Received"
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  STATUS_LABELS_DE,
  STATUS_LABELS_EN
});
//# sourceMappingURL=types.js.map
