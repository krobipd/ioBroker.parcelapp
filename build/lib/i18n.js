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
var i18n_exports = {};
__export(i18n_exports, {
  packageName: () => packageName,
  statusLabel: () => statusLabel,
  tName: () => tName,
  tText: () => tText
});
module.exports = __toCommonJS(i18n_exports);
var import_adapter_core = require("@iobroker/adapter-core");
function tName(key) {
  return import_adapter_core.I18n.getTranslatedObject(key);
}
function tText(key, ...args) {
  return import_adapter_core.I18n.translate(key, ...args);
}
const STATUS_KEYS = {
  0: "status_0",
  1: "status_1",
  2: "status_2",
  3: "status_3",
  4: "status_4",
  5: "status_5",
  6: "status_6",
  7: "status_7",
  8: "status_8"
};
function statusLabel(code) {
  const key = STATUS_KEYS[code];
  return key === void 0 ? void 0 : import_adapter_core.I18n.translate(key);
}
function packageName(trackingNumber) {
  return import_adapter_core.I18n.getTranslatedObject("packageName", trackingNumber);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  packageName,
  statusLabel,
  tName,
  tText
});
//# sourceMappingURL=i18n.js.map
