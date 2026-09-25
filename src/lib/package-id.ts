/**
 * The package-id rule — how a parcel.app delivery becomes the id segment of its device
 * (`deliveries.<id>`). A pure module without I18n or adapter-core: `test/inventory.js` loads the
 * built copy (`build/lib/package-id.js`) to know which objects the fixtures must produce, and
 * adapter-core would end that process at import time (no js-controller behind it).
 *
 * Moved out of `StateManager` in v0.14.0 (audit 2026-09-25). Which delivery OWNS which id is state
 * and stays in the `StateManager`; this module only says which ids a delivery may have, in order.
 */
import type { ParcelDelivery } from "./types";

/** Max length of a sanitized package-id segment (the collision suffix handles truncation clashes). */
export const MAX_ID_LENGTH = 50;

/**
 * Sanitize a string for use as ioBroker object ID (see adapter.FORBIDDEN_CHARS).
 * API-drift guard: returns "unknown" for non-string input.
 *
 * @param name Raw value to sanitize (any type)
 * @returns the id segment
 */
export function sanitize(name: unknown): string {
  if (typeof name !== "string") {
    return "unknown";
  }
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, MAX_ID_LENGTH) || "unknown"
  );
}

/**
 * The three identity fields of a delivery, each "" where the API sent no string.
 *
 * @param delivery The delivery
 * @returns tracking number, extra information, carrier code
 */
export function identityOf(delivery: ParcelDelivery): [tracking: string, extra: string, carrier: string] {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return [text(delivery.tracking_number), text(delivery.extra_information), text(delivery.carrier_code)];
}

/**
 * v0.4.2 (S3), v0.13.0 (audit S1): the raw key that tells two deliveries apart — tracking number,
 * extra information AND carrier. Without the carrier the same number under two carriers produced
 * one key, one state id, and one of the two packages was invisible (a number added with the wrong
 * carrier and then added again correctly — the API has no DELETE).
 *
 * @param identity Tracking number, extra information, carrier code
 * @returns the key
 */
export function rawIdKey(identity: readonly [string, string, string]): string {
  return identity.join("\u0000");
}

/**
 * v0.13.0: the material of the FIRST collision suffix — deliberately without the carrier. That
 * suffix is part of state ids that exist on installations, and feeding the carrier into the hash
 * would rename those objects (a rename is a delete plus a create, and takes the user's recording
 * settings with it).
 *
 * @param identity Tracking number, extra information, carrier code
 * @returns the suffix material
 */
export function suffixKey(identity: readonly [string, string, string]): string {
  return `${identity[0]}\u0000${identity[1]}`;
}

/**
 * v0.4.2 (S3): FNV-1a 32-bit short hash → 6 hex chars.
 *
 * @param s Input string to hash
 * @returns six hex characters
 */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * The bare id: sanitized tracking number, plus the sanitized extra information when there is one.
 *
 * @param delivery The delivery
 * @returns the bare id
 */
export function bareId(delivery: ParcelDelivery): string {
  let id = sanitize(delivery.tracking_number);
  // API-drift guard: only string values extend the id
  if (typeof delivery.extra_information === "string" && delivery.extra_information.length > 0) {
    id += `_${sanitize(delivery.extra_information)}`;
  }
  return id;
}

/**
 * Every id a delivery may have, in the order they are tried (v0.14.0, audit S1/S3):
 *
 * 1. the bare id;
 * 2. the bare id with the carrier-less suffix — the only suffix before v0.14.0, kept first so the
 *    ids on existing installations stay where they are;
 * 3. the bare id with a suffix that includes the carrier — a third delivery with the same number
 *    (or a third one without any number) used to land on the second one's id and overwrite it;
 * 4. that id with `_2`, `_3`, … — a hash clash can never merge two packages.
 *
 * @param delivery The delivery
 * @yields {string} the candidate ids, endlessly
 */
export function* idCandidates(delivery: ParcelDelivery): Generator<string, never> {
  const identity = identityOf(delivery);
  const bare = bareId(delivery);
  yield bare;
  yield `${bare}__${shortHash(suffixKey(identity))}`;
  const withCarrier = `${bare}__${shortHash(rawIdKey(identity))}`;
  yield withCarrier;
  for (let n = 2; ; n++) {
    yield `${withCarrier}_${n}`;
  }
}

/**
 * Where an id sits in a delivery's candidate chain.
 *
 * @param id A package id
 * @param delivery The delivery
 * @returns the 0-based position in {@link idCandidates}, or -1 when the id is none of them
 */
export function candidateIndex(id: string, delivery: ParcelDelivery): number {
  const chain = idCandidates(delivery);
  const firstThree = [chain.next().value, chain.next().value, chain.next().value];
  const direct = firstThree.indexOf(id);
  if (direct >= 0) {
    return direct;
  }
  const prefix = `${firstThree[2]}_`;
  const n = id.startsWith(prefix) ? id.slice(prefix.length) : "";
  return /^[1-9]\d*$/.test(n) && Number(n) >= 2 ? Number(n) + 1 : -1;
}
