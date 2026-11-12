var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main/memory-core/repository.ts
var repository_exports = {};
__export(repository_exports, {
  MemoryRepository: () => MemoryRepository,
  openMemoryRepository: () => openMemoryRepository
});
module.exports = __toCommonJS(repository_exports);
var import_node_path3 = __toESM(require("node:path"));
var import_node_crypto11 = require("node:crypto");

// src/main/memory-core/jobs.ts
var import_node_crypto6 = require("node:crypto");

// src/main/memory-core/repository-types.ts
var ENTITY_TABLES = ["sources", "evidence", "candidates", "fact_revisions", "current_facts", "jobs", "deletion_markers", "index_state"];
function internalId(value) {
  if (typeof value !== "string" || !/[a-zA-Z0-9_-]/.test(value) || !/^[-a-zA-Z0-9_]{1,96}$/.test(value)) throw new Error("MEMORY_INPUT_INVALID");
}
function entityTable(value) {
  if (!ENTITY_TABLES.includes(value)) throw new Error("MEMORY_INPUT_INVALID");
}
function canonicalJson(value, depth = 0) {
  if (depth > 64) throw new Error("MEMORY_INPUT_INVALID");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error("MEMORY_INPUT_INVALID");
    return "[" + value.map((v) => canonicalJson(v, depth + 1)).join(",") + "]";
  }
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k], depth + 1)).join(",") + "}";
  }
  throw new Error("MEMORY_INPUT_INVALID");
}

// src/main/memory-core/command-validation.ts
function objectFields(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("MEMORY_INPUT_INVALID");
  const keys = Reflect.ownKeys(value), allowed = [...required, ...optional];
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new Error("MEMORY_INPUT_INVALID");
  for (const key of keys) if (!Object.getOwnPropertyDescriptor(value, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")) throw new Error("MEMORY_INPUT_INVALID");
  return value;
}
function parseInternalId(value) {
  internalId(value);
  return value;
}
function positiveRevision(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("MEMORY_INPUT_INVALID");
  return value;
}
function parseSourceRef(value) {
  const input = objectFields(value, ["sourceId", "revision"], ["span", "binding"]), sourceId = parseInternalId(input.sourceId), revision = positiveRevision(input.revision);
  let binding;
  if (input.binding !== void 0) {
    const b = objectFields(input.binding, ["providerId", "sessionId", "messageId", "contentRevision", "generation"]);
    binding = { providerId: parseInternalId(b.providerId), sessionId: parseInternalId(b.sessionId), messageId: parseInternalId(b.messageId), contentRevision: positiveRevision(b.contentRevision), generation: parseInternalId(b.generation) };
  }
  const ref = { sourceId, revision, ...binding ? { binding } : {} };
  if (input.span === void 0) return ref;
  const span = objectFields(input.span, ["start", "end"]);
  if (typeof span.start !== "number" || typeof span.end !== "number" || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start) throw new Error("MEMORY_INPUT_INVALID");
  return { ...ref, span: { start: span.start, end: span.end } };
}
function textField(value) {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value) > 65536) throw new Error("MEMORY_INPUT_INVALID");
  return value;
}
function parseFact(value) {
  const fact = objectFields(value, ["subjectKey", "assertion", "assertionKind", "time"]);
  if (!["user-statement", "inference"].includes(fact.assertionKind)) throw new Error("MEMORY_INPUT_INVALID");
  const time = objectFields(fact.time, ["validFrom", "validTo", "referenceTime"]);
  for (const value2 of Object.values(time)) if (value2 !== null && (typeof value2 !== "number" || !Number.isSafeInteger(value2))) throw new Error("MEMORY_TIME_INVALID");
  const parsed = time;
  if (parsed.validFrom !== null && parsed.validTo !== null && parsed.validFrom >= parsed.validTo) throw new Error("MEMORY_TIME_INVALID");
  return { subjectKey: textField(fact.subjectKey), assertion: textField(fact.assertion), assertionKind: fact.assertionKind, time: { ...parsed } };
}

// src/main/memory-core/command-transactions.ts
var import_node_crypto2 = require("node:crypto");

// src/main/memory-core/payload-codec.ts
var import_node_crypto = require("node:crypto");
var MAGIC = Buffer.from("FMM1");
var HEADER = 12;
var NONCE = 12;
var TAG = 16;
var MAX = 8 * 1024 * 1024;
function aad(binding) {
  if (!binding || typeof binding !== "object" || typeof binding.recordType !== "string" || !/^\w[\w-]{0,47}$/.test(binding.recordType) || typeof binding.id !== "string" || binding.id.length === 0 || binding.id.length > 256 || !Number.isInteger(binding.schemaVersion) || binding.schemaVersion < 1 || binding.schemaVersion > 4294967295 || !Number.isInteger(binding.keyVersion) || binding.keyVersion < 1 || binding.keyVersion > 4294967295) throw new Error("MEMORY_AAD_INVALID");
  return Buffer.from(JSON.stringify([binding.recordType, binding.id, binding.schemaVersion, binding.keyVersion]));
}
function checkedKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("MEMORY_KEY_INVALID");
  return key;
}
function sealPayload(key, binding, plaintext) {
  const associated = aad(binding);
  if (!(plaintext instanceof Uint8Array) || plaintext.length > MAX) throw new Error("MEMORY_PAYLOAD_INVALID");
  const nonce = (0, import_node_crypto.randomBytes)(NONCE), cipher = (0, import_node_crypto.createCipheriv)("aes-256-gcm", checkedKey(key), nonce);
  cipher.setAAD(associated);
  const header = Buffer.alloc(HEADER);
  MAGIC.copy(header);
  header.writeUInt32LE(binding.schemaVersion, 4);
  header.writeUInt32LE(binding.keyVersion, 8);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, nonce, cipher.getAuthTag(), ciphertext]);
}
function openPayload(key, binding, envelope) {
  const associated = aad(binding);
  checkedKey(key);
  if (!(envelope instanceof Uint8Array) || envelope.length < HEADER + NONCE + TAG || envelope.length > HEADER + NONCE + TAG + MAX) throw new Error("MEMORY_ENVELOPE_INVALID");
  const value = Buffer.from(envelope);
  if (!value.subarray(0, 4).equals(MAGIC)) throw new Error("MEMORY_ENVELOPE_INVALID");
  let part;
  try {
    if (value.readUInt32LE(4) !== binding.schemaVersion || value.readUInt32LE(8) !== binding.keyVersion) throw new Error("version mismatch");
    const decipher = (0, import_node_crypto.createDecipheriv)("aes-256-gcm", key, value.subarray(HEADER, HEADER + NONCE));
    decipher.setAAD(associated);
    decipher.setAuthTag(value.subarray(HEADER + NONCE, HEADER + NONCE + TAG));
    part = decipher.update(value.subarray(HEADER + NONCE + TAG));
    return Buffer.concat([part, decipher.final()]);
  } catch {
    throw new Error("MEMORY_AUTH_FAILED");
  } finally {
    part?.fill(0);
  }
}

// src/main/memory-core/command-transactions.ts
function executeTransaction(input) {
  internalId(input.scope);
  internalId(input.commandId);
  const request = Buffer.from(canonicalJson(input.request));
  let derived, digest;
  try {
    if (request.length > 8 * 1024 * 1024) throw new Error("MEMORY_INPUT_INVALID");
    derived = Buffer.from((0, import_node_crypto2.hkdfSync)("sha256", input.key, Buffer.alloc(0), "FireflyMemoryReceiptDigest-v1", 32));
    digest = (0, import_node_crypto2.createHmac)("sha256", derived).update(request).digest();
  } finally {
    request.fill(0);
    derived?.fill(0);
  }
  const binding = { recordType: "command-receipt", id: JSON.stringify([input.scope, input.commandId]), schemaVersion: 1, keyVersion: 1 };
  input.db.exec("BEGIN IMMEDIATE");
  try {
    const receipt = input.db.prepare("SELECT scope_key,request_digest,result FROM command_receipts WHERE command_id=?").get(input.commandId);
    if (receipt) {
      if (receipt.scope_key !== input.scope || !(receipt.request_digest instanceof Uint8Array) || receipt.request_digest.length !== digest.length || !(0, import_node_crypto2.timingSafeEqual)(digest, receipt.request_digest)) throw new Error("MEMORY_COMMAND_CONFLICT");
      const plain2 = openPayload(input.key, binding, receipt.result);
      let result2;
      try {
        result2 = JSON.parse(plain2.toString("utf8"));
      } finally {
        plain2.fill(0);
      }
      input.db.exec("COMMIT");
      return result2;
    }
    const result = input.apply();
    input.fault?.("before-receipt");
    const plain = Buffer.from(canonicalJson(result));
    let encrypted;
    try {
      encrypted = sealPayload(input.key, binding, plain);
    } finally {
      plain.fill(0);
    }
    input.db.prepare("INSERT INTO command_receipts VALUES (?,?,?,?)").run(input.commandId, input.scope, digest, encrypted);
    input.db.exec("COMMIT");
    return result;
  } catch (error) {
    input.db.exec("ROLLBACK");
    throw error;
  }
}

// src/main/memory-core/record-codec.ts
var RecordCodec = class {
  constructor(key) {
    this.key = key;
  }
  key;
  binding(table, scope, id) {
    return { recordType: table, id: JSON.stringify([scope, id]), schemaVersion: 1, keyVersion: 1 };
  }
  seal(table, scope, id, value) {
    const plain = Buffer.from(canonicalJson(value));
    try {
      return sealPayload(this.key, this.binding(table, scope, id), plain);
    } finally {
      plain.fill(0);
    }
  }
  open(table, scope, id, value) {
    if (!(value instanceof Uint8Array)) throw new Error("MEMORY_DATA_INVALID");
    const plain = openPayload(this.key, this.binding(table, scope, id), value);
    try {
      return JSON.parse(plain.toString("utf8"));
    } finally {
      plain.fill(0);
    }
  }
};

// src/main/memory-core/suppression.ts
var import_node_crypto3 = require("node:crypto");
var Suppression = class {
  constructor(db, key) {
    this.db = db;
    this.codec = new RecordCodec(key);
  }
  db;
  codec;
  assertions(scope, factId) {
    return this.db.prepare("SELECT id,payload FROM fact_revisions WHERE scope_key=? AND fact_id=? AND event_kind='assertion'").all(scope, factId).map((row) => this.codec.open("fact_revisions", scope, row.id, row.payload));
  }
  markers(scope) {
    return this.db.prepare("SELECT id,payload FROM deletion_markers WHERE scope_key=?").all(scope).map((row) => {
      const marker = this.codec.open("deletion_markers", scope, row.id, row.payload);
      if (typeof marker.factId !== "string" || !marker.sourceRef) throw new Error("MEMORY_DATA_INVALID");
      if (!marker.origins || !marker.subjects) {
        const views = this.assertions(scope, marker.factId);
        marker.origins = views.flatMap((v) => [v.sourceRef, v.provenance.activationSourceRef]);
        marker.subjects = views.map((v) => v.subjectKey);
      }
      return marker;
    });
  }
  generation(scope) {
    const row = this.db.prepare("SELECT generation,payload FROM scope_suppression WHERE scope_key=?").get(scope);
    if (!row) return this.markers(scope).length;
    const value = this.codec.open("scope_suppression", scope, scope, row.payload);
    if (!Number.isSafeInteger(value.generation) || value.generation < 0 || row.generation !== value.generation) throw new Error("MEMORY_DATA_INVALID");
    return value.generation;
  }
  advance(scope) {
    if (!this.db.isTransaction) throw new Error("MEMORY_TRANSACTION_REQUIRED");
    const generation2 = this.generation(scope) + 1;
    if (!Number.isSafeInteger(generation2)) throw new Error("MEMORY_DATA_INVALID");
    this.db.prepare("INSERT INTO scope_suppression VALUES(?,?,?) ON CONFLICT(scope_key) DO UPDATE SET generation=excluded.generation,payload=excluded.payload").run(scope, generation2, this.codec.seal("scope_suppression", scope, scope, { generation: generation2 }));
    return generation2;
  }
  sourceBlocked(scope, ref) {
    return this.markers(scope).some((m) => m.origins.some((o) => o.sourceId === ref.sourceId && ref.revision <= o.revision));
  }
  subjectBlocked(scope, subject2) {
    return this.markers(scope).some((m) => m.subjects.includes(subject2));
  }
  /** Add all alternative support origins to the already-created forget barrier. */
  includeOrigins(scope, factId, refs2) {
    if (!this.db.isTransaction) throw new Error("MEMORY_TRANSACTION_REQUIRED");
    for (const row of this.db.prepare("SELECT id,payload FROM deletion_markers WHERE scope_key=?").all(scope)) {
      const marker = this.codec.open("deletion_markers", scope, row.id, row.payload);
      if (marker.factId !== factId) continue;
      const origins = marker.origins ?? this.assertions(scope, factId).flatMap((v) => [v.sourceRef, v.provenance.activationSourceRef]);
      marker.origins = [...new Map([...origins, ...refs2].map((ref) => [canonicalJson(ref), ref])).values()];
      this.db.prepare("UPDATE deletion_markers SET payload=? WHERE scope_key=? AND id=?").run(this.codec.seal("deletion_markers", scope, row.id, marker), scope, row.id);
    }
  }
  forget(scope, view, event, at) {
    const views = this.assertions(scope, view.factId), generation2 = this.advance(scope), id = (0, import_node_crypto3.randomUUID)();
    const marker = {
      factId: view.factId,
      sourceRef: view.sourceRef,
      forgetEvent: event,
      at,
      generation: generation2,
      origins: views.flatMap((v) => [v.sourceRef, v.provenance.activationSourceRef]),
      subjects: [...new Set(views.map((v) => v.subjectKey))]
    };
    this.db.prepare("INSERT INTO deletion_markers (id,scope_key,revision,source_id,parent_id,state,payload) VALUES(?,?,?,NULL,NULL,'forgotten',?)").run(id, scope, view.revision, this.codec.seal("deletion_markers", scope, id, marker));
  }
};

// src/main/memory-core/fact-repository.ts
var import_node_crypto5 = require("node:crypto");

// src/main/memory-core/source-ledger.ts
var import_node_crypto4 = require("node:crypto");
function parseSourceIdentity(value) {
  const v = objectFields(value, ["providerId", "sessionId", "messageId"]);
  return { providerId: parseInternalId(v.providerId), sessionId: parseInternalId(v.sessionId), messageId: parseInternalId(v.messageId) };
}
function parseSourceObservation(value) {
  const v = objectFields(value, ["providerId", "sessionId", "messageId", "contentRevision", "generation", "state", "role", "trust", "fingerprint"], ["occurredAt"]);
  const identity = parseSourceIdentity({ providerId: v.providerId, sessionId: v.sessionId, messageId: v.messageId });
  if (v.occurredAt !== void 0 && (!Number.isSafeInteger(v.occurredAt) || v.occurredAt < 0)) throw new Error("MEMORY_TIME_INVALID");
  if (!["live", "deleted"].includes(v.state) || !["user", "assistant", "system"].includes(v.role) || !["direct-user-event", "history", "imported", "model", "system"].includes(v.trust) || typeof v.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(v.fingerprint)) throw new Error("MEMORY_SOURCE_INVALID");
  return {
    ...identity,
    contentRevision: positiveRevision(v.contentRevision),
    generation: parseInternalId(v.generation),
    state: v.state,
    role: v.role,
    trust: v.trust,
    fingerprint: v.fingerprint,
    ...v.occurredAt !== void 0 ? { occurredAt: v.occurredAt } : {}
  };
}
function referenceIdentity(ref) {
  const { span, ...identity } = parseSourceRef(ref);
  return canonicalJson(identity);
}
var SourceLedger = class {
  constructor(db, key, fault) {
    this.db = db;
    this.key = key;
    this.fault = fault;
    this.codec = new RecordCodec(key);
  }
  db;
  key;
  fault;
  codec;
  locatorIndex(scope, identity) {
    const derived = Buffer.from((0, import_node_crypto4.hkdfSync)("sha256", this.key, Buffer.alloc(0), "FireflyMemorySourceLocator-v1", 32));
    try {
      return (0, import_node_crypto4.createHmac)("sha256", derived).update(canonicalJson({ scope, identity })).digest();
    } finally {
      derived.fill(0);
    }
  }
  generationIndex(scope, sourceId, generation2) {
    const derived = Buffer.from((0, import_node_crypto4.hkdfSync)("sha256", this.key, Buffer.alloc(0), "FireflyMemorySourceGeneration-v1", 32));
    try {
      return (0, import_node_crypto4.createHmac)("sha256", derived).update(canonicalJson({ scope, sourceId, generation: generation2 })).digest();
    } finally {
      derived.fill(0);
    }
  }
  decode(scope, row) {
    const head = this.codec.open("source-head", scope, row.source_id, row.payload);
    if (head.sourceId !== row.source_id || head.state !== row.state || !["ready", "pending", "deleted"].includes(head.state)) throw new Error("MEMORY_DATA_INVALID");
    const index = this.locatorIndex(scope, parseSourceIdentity(head.identity));
    if (!(row.locator_index instanceof Uint8Array) || !Buffer.from(row.locator_index).equals(index)) throw new Error("MEMORY_DATA_INVALID");
    if (head.ref !== null) {
      const ref = parseSourceRef(head.ref);
      if (!ref.binding || ref.sourceId !== head.sourceId) throw new Error("MEMORY_DATA_INVALID");
    }
    if (head.published !== null) parseSourceObservation(head.published);
    for (const value of [head.captureSuppressionGeneration, head.observedSuppressionGeneration, head.firstObservedSuppressionGeneration]) if (value !== void 0 && (!Number.isSafeInteger(value) || value < 0)) throw new Error("MEMORY_DATA_INVALID");
    if (head.state === "pending") {
      parseInternalId(head.operationId);
    } else if (head.operationId !== null) throw new Error("MEMORY_DATA_INVALID");
    return head;
  }
  byIdentity(scope, identity) {
    const row = this.db.prepare("SELECT * FROM source_heads WHERE scope_key=? AND locator_index=?").get(scope, this.locatorIndex(scope, identity));
    return row ? this.decode(scope, row) : null;
  }
  bySource(scope, sourceId) {
    const row = this.db.prepare("SELECT * FROM source_heads WHERE scope_key=? AND source_id=?").get(scope, sourceId);
    return row ? this.decode(scope, row) : null;
  }
  save(scope, head) {
    this.db.prepare("INSERT INTO source_heads(scope_key,locator_index,source_id,state,payload) VALUES(?,?,?,?,?) ON CONFLICT(scope_key,locator_index) DO UPDATE SET state=excluded.state,payload=excluded.payload").run(scope, this.locatorIndex(scope, head.identity), head.sourceId, head.state, this.codec.seal("source-head", scope, head.sourceId, head));
    this.fault?.("after-record");
  }
  isManaged(scope, sourceId) {
    return this.bySource(scope, sourceId) !== null;
  }
  /** Legacy sources are allowed only when no managed ledger exists. */
  assertCurrent(scope, value) {
    parseInternalId(scope);
    const ref = parseSourceRef(value), head = this.bySource(scope, ref.sourceId);
    if (!head) {
      if (ref.binding) throw new Error("MEMORY_SOURCE_INVALID");
      return null;
    }
    if (head.state === "pending") throw new Error("MEMORY_SOURCE_PENDING");
    if (head.state === "deleted") throw new Error("MEMORY_SOURCE_DELETED");
    if (!ref.binding) throw new Error("MEMORY_SOURCE_BINDING_REQUIRED");
    if (!head.ref || referenceIdentity(ref) !== referenceIdentity(head.ref)) throw new Error("MEMORY_SOURCE_STALE");
    return head;
  }
  execute(value) {
    const cmd = objectFields(value, ["kind", "scopeKey", "body"], ["commandId"]), scope = parseInternalId(cmd.scopeKey);
    if (cmd.kind === "pending") {
      const body = objectFields(cmd.body, ["identity"]), head = this.byIdentity(scope, parseSourceIdentity(body.identity));
      if (!head || head.state !== "pending") throw new Error("MEMORY_SOURCE_NOT_PENDING");
      return head;
    }
    if (cmd.kind === "validate") {
      const body = objectFields(cmd.body, ["sourceRef"]), head = this.assertCurrent(scope, parseSourceRef(body.sourceRef));
      if (!head || !head.published) throw new Error("MEMORY_SOURCE_INVALID");
      return head.published;
    }
    if (cmd.kind !== "reserve" && cmd.kind !== "finish") throw new Error("MEMORY_INPUT_INVALID");
    const commandId = parseInternalId(cmd.commandId);
    return executeTransaction({ db: this.db, key: this.key, scope, commandId, request: value, fault: this.fault, apply: () => cmd.kind === "reserve" ? this.reserve(scope, cmd.body) : this.finish(scope, cmd.body) });
  }
  reserve(scope, value) {
    const v = objectFields(value, ["identity", "expectedRef"]), identity = parseSourceIdentity(v.identity);
    let head = this.byIdentity(scope, identity);
    if (head?.state === "pending") throw new Error("MEMORY_SOURCE_PENDING");
    if (v.expectedRef !== null) {
      const ref = parseSourceRef(v.expectedRef);
      this.assertCurrent(scope, ref);
      if (!head || !head.ref || referenceIdentity(ref) !== referenceIdentity(head.ref)) throw new Error("MEMORY_SOURCE_STALE");
    }
    if (!head) {
      const sourceId = (0, import_node_crypto4.randomUUID)();
      head = { sourceId, identity, state: "pending", ref: null, published: null, operationId: null };
      const sourceRef = { sourceId, revision: 1 };
      this.db.prepare("INSERT INTO sources(id,scope_key,revision,source_id,parent_id,state,payload) VALUES(?,?,1,NULL,NULL,'pending',?)").run(sourceId, scope, this.codec.seal("sources", scope, sourceId, { sourceRef, kind: "system", intent: "statement", candidateId: null, factId: null }));
    } else this.db.prepare("UPDATE sources SET state='pending' WHERE id=? AND scope_key=?").run(head.sourceId, scope);
    head = { ...head, state: "pending", operationId: (0, import_node_crypto4.randomUUID)(), captureSuppressionGeneration: new Suppression(this.db, this.key).generation(scope) };
    this.save(scope, head);
    return head;
  }
  finish(scope, value) {
    const v = objectFields(value, ["sourceId", "operationId", "observation"]), sourceId = parseInternalId(v.sourceId), operationId = parseInternalId(v.operationId);
    const head = this.bySource(scope, sourceId), observation = parseSourceObservation(v.observation);
    if (!head || head.state !== "pending" || head.operationId !== operationId) throw new Error("MEMORY_SOURCE_OPERATION_CONFLICT");
    if (canonicalJson(head.identity) !== canonicalJson(parseSourceIdentity({ providerId: observation.providerId, sessionId: observation.sessionId, messageId: observation.messageId }))) throw new Error("MEMORY_SOURCE_INVALID");
    const previous = head.published;
    const generationIndex = this.generationIndex(scope, sourceId, observation.generation);
    if (previous?.generation !== observation.generation && this.db.prepare("SELECT 1 FROM source_generations WHERE scope_key=? AND source_id=? AND generation_index=?").get(scope, sourceId, generationIndex)) throw new Error("MEMORY_SOURCE_GENERATION_REUSED");
    if (previous && previous.generation === observation.generation) {
      if (previous.state === "deleted" && observation.state === "live") throw new Error("MEMORY_SOURCE_GENERATION_REUSED");
      if (observation.contentRevision < previous.contentRevision) throw new Error("MEMORY_SOURCE_STALE");
      if (observation.contentRevision === previous.contentRevision && canonicalJson(previous) !== canonicalJson(observation)) throw new Error("MEMORY_SOURCE_VERSION_MISMATCH");
    }
    const same = previous && canonicalJson(previous) === canonicalJson(observation);
    const revision = head.ref ? same ? head.ref.revision : head.ref.revision + 1 : 1;
    if (!Number.isSafeInteger(revision)) throw new Error("MEMORY_SOURCE_VERSION_MISMATCH");
    const ref = { sourceId, revision, binding: { ...head.identity, contentRevision: observation.contentRevision, generation: observation.generation } };
    const state = observation.state === "deleted" ? "deleted" : "ready";
    const observedSuppressionGeneration = same ? head.observedSuppressionGeneration : head.captureSuppressionGeneration;
    const published = {
      ...head,
      ref,
      published: observation,
      state,
      operationId: null,
      firstObservedSuppressionGeneration: head.firstObservedSuppressionGeneration ?? (previous ? 0 : head.captureSuppressionGeneration ?? 0),
      ...observedSuppressionGeneration === void 0 ? {} : { observedSuppressionGeneration }
    };
    this.db.prepare("UPDATE sources SET revision=?,state=?,payload=? WHERE id=? AND scope_key=?").run(revision, state === "ready" ? "recorded" : "invalidated", this.codec.seal("sources", scope, sourceId, { sourceRef: ref, kind: observation.role, intent: "statement", candidateId: null, factId: null }), sourceId, scope);
    this.save(scope, published);
    this.db.prepare("INSERT OR IGNORE INTO source_generations(scope_key,source_id,generation_index) VALUES(?,?,?)").run(scope, sourceId, generationIndex);
    return ref;
  }
};

// src/main/memory-core/fact-repository.ts
var FactRepository = class {
  constructor(db, key, fault) {
    this.db = db;
    this.key = key;
    this.fault = fault;
  }
  db;
  key;
  fault;
  seal(table, scope, id, value) {
    const plain = Buffer.from(canonicalJson(value));
    try {
      return sealPayload(this.key, { recordType: table, id: JSON.stringify([scope, id]), schemaVersion: 1, keyVersion: 1 }, plain);
    } finally {
      plain.fill(0);
    }
  }
  open(table, scope, id, value) {
    if (!(value instanceof Uint8Array)) throw new Error("MEMORY_DATA_INVALID");
    const plain = openPayload(this.key, { recordType: table, id: JSON.stringify([scope, id]), schemaVersion: 1, keyVersion: 1 }, value);
    try {
      return JSON.parse(plain.toString("utf8"));
    } finally {
      plain.fill(0);
    }
  }
  row(table, scope, id) {
    return this.db.prepare("SELECT * FROM " + table + " WHERE id=? AND scope_key=?").get(id, scope);
  }
  source(scope, ref) {
    new SourceLedger(this.db, this.key).assertCurrent(scope, ref);
    const row = this.row("sources", scope, ref.sourceId);
    if (!row) throw new Error("MEMORY_SOURCE_INVALID");
    const source = this.open("sources", scope, ref.sourceId, row.payload);
    if (row.revision !== source.sourceRef.revision || source.sourceRef.sourceId !== ref.sourceId) throw new Error("MEMORY_DATA_INVALID");
    if (source.sourceRef.revision !== ref.revision) throw new Error("MEMORY_SOURCE_STALE");
    return source;
  }
  insert(table, scope, id, revision, state, payload, sourceId = null, parentId = null) {
    this.db.prepare("INSERT INTO " + table + " (id,scope_key,revision,source_id,parent_id,state,payload) VALUES (?,?,?,?,?,?,?)").run(id, scope, revision, sourceId, parentId, state, this.seal(table, scope, id, payload));
    this.fault?.("after-record");
  }
  subjectIndex(subject2) {
    const derived = Buffer.from((0, import_node_crypto5.hkdfSync)("sha256", this.key, Buffer.alloc(0), "FireflyMemorySubjectIndex-v1", 32));
    try {
      return (0, import_node_crypto5.createHmac)("sha256", derived).update(subject2, "utf8").digest();
    } finally {
      derived.fill(0);
    }
  }
  projection(scope, factId) {
    const row = this.row("current_facts", scope, factId);
    if (!row || row.state !== "active") throw new Error("MEMORY_FACT_NOT_FOUND");
    const projection = this.open("current_facts", scope, factId, row.payload);
    const index = this.subjectIndex(projection.view.subjectKey);
    if (projection.visibility !== "active" || projection.view.factId !== factId || projection.view.revision !== row.revision || !(row.subject_index instanceof Uint8Array) || row.subject_index.length !== index.length || !(0, import_node_crypto5.timingSafeEqual)(index, row.subject_index)) throw new Error("MEMORY_DATA_INVALID");
    return projection;
  }
  appendRevision(scope, view) {
    const id = (0, import_node_crypto5.randomUUID)();
    this.db.prepare("INSERT INTO fact_revisions (id,scope_key,revision,source_id,parent_id,state,payload,fact_id,event_kind) VALUES (?,?,?,?,?,?,?,?,?)").run(id, scope, view.revision, view.sourceRef.sourceId, null, "recorded", this.seal("fact_revisions", scope, id, view), view.factId, "assertion");
    this.fault?.("after-record");
    return id;
  }
  lifecycle(scope, view, target, kind, at) {
    const id = (0, import_node_crypto5.randomUUID)(), payload = { factId: view.factId, targetRevision: view.revision, at };
    this.db.prepare("INSERT INTO fact_revisions (id,scope_key,revision,source_id,parent_id,state,payload,fact_id,event_kind) VALUES (?,?,?,?,?,?,?,?,?)").run(id, scope, view.revision, view.sourceRef.sourceId, target, kind === "forget" ? "forgotten" : "superseded", this.seal("fact_revisions", scope, id, payload), view.factId, kind);
    this.fault?.("after-record");
  }
  invalidate(scope, factId, revision) {
    this.insert("index_state", scope, (0, import_node_crypto5.randomUUID)(), revision, "invalidated", { factId, revision });
  }
  execute(value) {
    const command = objectFields(value, ["kind", "scopeKey", "commandId", "body"]);
    const scope = parseInternalId(command.scopeKey), commandId = parseInternalId(command.commandId);
    if (!["registerSource", "appendEvidence", "proposeCandidate", "activateCandidate", "correctFact", "forgetFact"].includes(command.kind)) throw new Error("MEMORY_INPUT_INVALID");
    return executeTransaction({ db: this.db, key: this.key, scope, commandId, request: value, fault: this.fault, apply: () => this.applyWithinTransaction(scope, command.kind, command.body) });
  }
  applyWithinTransaction(scope, kind, body) {
    if (!this.db.isTransaction) throw new Error("MEMORY_TRANSACTION_REQUIRED");
    const command = { kind, body }, suppression = new Suppression(this.db, this.key);
    switch (command.kind) {
      case "registerSource": {
        const body2 = objectFields(command.body, ["sourceRef", "kind"], ["intent", "candidateId", "factId"]), ref = parseSourceRef(body2.sourceRef);
        if (new SourceLedger(this.db, this.key).isManaged(scope, ref.sourceId)) throw new Error("MEMORY_SOURCE_MANAGED");
        const intent = body2.intent ?? "statement", candidateId = body2.candidateId ?? null, factId = body2.factId ?? null;
        if (!["statement", "confirmation", "correction", "forget", "remember"].includes(intent)) throw new Error("MEMORY_SOURCE_INVALID");
        if (candidateId !== null) parseInternalId(candidateId);
        if (factId !== null) parseInternalId(factId);
        const registered = { sourceRef: ref, kind: body2.kind, intent, candidateId, factId };
        if (!["user", "assistant", "system"].includes(body2.kind)) throw new Error("MEMORY_SOURCE_INVALID");
        const old = this.row("sources", scope, ref.sourceId);
        if (old) {
          const previous = this.open("sources", scope, ref.sourceId, old.payload);
          if (previous.kind !== body2.kind || ref.revision === old.revision && ((previous.intent ?? "statement") !== intent || (previous.candidateId ?? null) !== candidateId || (previous.factId ?? null) !== factId)) throw new Error("MEMORY_SOURCE_INVALID");
          if (ref.revision < old.revision) throw new Error("MEMORY_SOURCE_STALE");
          if (ref.revision > old.revision) this.db.prepare("UPDATE sources SET revision=?,payload=? WHERE id=? AND scope_key=?").run(ref.revision, this.seal("sources", scope, ref.sourceId, registered), ref.sourceId, scope);
        } else this.insert("sources", scope, ref.sourceId, ref.revision, "recorded", registered);
        return { id: ref.sourceId, revision: ref.revision };
      }
      case "appendEvidence": {
        const body2 = objectFields(command.body, ["evidenceId", "sourceRef", "text"]), id = parseInternalId(body2.evidenceId), sourceRef = parseSourceRef(body2.sourceRef);
        this.source(scope, sourceRef);
        this.insert("evidence", scope, id, 1, "recorded", { sourceRef, text: textField(body2.text) }, sourceRef.sourceId);
        return { id, revision: 1 };
      }
      case "proposeCandidate": {
        const body2 = objectFields(command.body, ["candidateId", "evidenceId", "fact"]), id = parseInternalId(body2.candidateId), evidenceId = parseInternalId(body2.evidenceId);
        const evidence = this.row("evidence", scope, evidenceId);
        if (!evidence) throw new Error("MEMORY_EVIDENCE_NOT_FOUND");
        const sourceRef = parseSourceRef(this.open("evidence", scope, evidenceId, evidence.payload).sourceRef);
        this.source(scope, sourceRef);
        this.insert("candidates", scope, id, 1, "proposed", { sourceRef, fact: parseFact(body2.fact) }, sourceRef.sourceId, evidenceId);
        return { id, revision: 1 };
      }
      case "activateCandidate": {
        const body2 = objectFields(command.body, ["candidateId", "authorization"]), candidateId = parseInternalId(body2.candidateId);
        const row = this.row("candidates", scope, candidateId);
        if (!row || row.state !== "proposed") throw new Error("MEMORY_CANDIDATE_NOT_FOUND");
        const proposal = this.open("candidates", scope, candidateId, row.payload), sourceRef = parseSourceRef(proposal.sourceRef), source = this.source(scope, sourceRef), fact = parseFact(proposal.fact);
        const auth = objectFields(body2.authorization, ["reason", "sourceRef", "policyVersion"]), eventRef = parseSourceRef(auth.sourceRef), event = this.source(scope, eventRef);
        if (event.kind !== "user" || !["policyAccepted", "explicitUserConfirmed"].includes(auth.reason)) throw new Error("MEMORY_ACTIVATION_DENIED");
        if (auth.reason === "policyAccepted" && (source.kind !== "user" || fact.assertionKind !== "user-statement" || eventRef.sourceId !== sourceRef.sourceId || eventRef.revision !== sourceRef.revision || typeof auth.policyVersion !== "string")) throw new Error("MEMORY_ACTIVATION_DENIED");
        if (auth.reason === "explicitUserConfirmed" && (auth.policyVersion !== null || !["confirmation", "remember"].includes(event.intent ?? "") || event.candidateId !== candidateId)) throw new Error("MEMORY_ACTIVATION_DENIED");
        if (auth.reason === "policyAccepted" && event.intent !== "statement") throw new Error("MEMORY_ACTIVATION_DENIED");
        if (suppression.subjectBlocked(scope, fact.subjectKey)) {
          if (event.intent !== "remember" || auth.reason !== "explicitUserConfirmed" || suppression.sourceBlocked(scope, eventRef) || suppression.sourceBlocked(scope, sourceRef)) throw new Error("MEMORY_SUBJECT_SUPPRESSED");
          suppression.advance(scope);
        } else if (suppression.sourceBlocked(scope, sourceRef)) throw new Error("MEMORY_SOURCE_SUPPRESSED");
        const index = this.subjectIndex(fact.subjectKey);
        if (this.db.prepare("SELECT id FROM current_facts WHERE scope_key=? AND subject_index=? AND state='active'").get(scope, index)) throw new Error("MEMORY_FACT_CONFLICT");
        const id = (0, import_node_crypto5.randomUUID)(), at = Date.now(), view = { ...fact, factId: id, revision: 1, sourceRef, recordedAt: at, acceptedAt: at, supersededAt: null, activationReason: auth.reason, policyVersion: auth.policyVersion, provenance: { candidateId, evidenceId: row.parent_id, activationSourceRef: eventRef } };
        const revisionId = this.appendRevision(scope, view);
        this.db.prepare("INSERT INTO current_facts (id,scope_key,revision,source_id,parent_id,state,payload,subject_index) VALUES (?,?,?,?,?,?,?,?)").run(id, scope, 1, sourceRef.sourceId, revisionId, "active", this.seal("current_facts", scope, id, { view, visibility: "active" }), index);
        this.db.prepare("UPDATE candidates SET state='active' WHERE id=? AND scope_key=?").run(candidateId, scope);
        this.invalidate(scope, id, 1);
        return { id, revision: 1 };
      }
      case "correctFact": {
        const body2 = objectFields(command.body, ["factId", "expectedRevision", "sourceRef", "fact"], ["policyVersion"]), id = parseInternalId(body2.factId), expected = positiveRevision(body2.expectedRevision), sourceRef = parseSourceRef(body2.sourceRef), fact = parseFact(body2.fact);
        const previous = this.projection(scope, id).view;
        if (previous.revision !== expected) throw new Error("MEMORY_REVISION_CONFLICT");
        if (this.source(scope, sourceRef).kind !== "user") throw new Error("MEMORY_ACCESS_DENIED");
        if (fact.subjectKey !== previous.subjectKey && suppression.subjectBlocked(scope, fact.subjectKey)) throw new Error("MEMORY_SUBJECT_SUPPRESSED");
        const index = this.subjectIndex(fact.subjectKey), conflict = this.db.prepare("SELECT id FROM current_facts WHERE scope_key=? AND subject_index=? AND state='active' AND id<>?").get(scope, index, id);
        if (conflict) throw new Error("MEMORY_FACT_CONFLICT");
        if (body2.policyVersion !== void 0) {
          const observation = new SourceLedger(this.db, this.key).assertCurrent(scope, sourceRef)?.published;
          if (body2.policyVersion !== "main-maintenance-v1" || observation?.role !== "user" || observation.trust !== "direct-user-event" || fact.assertionKind !== "user-statement" || fact.subjectKey !== previous.subjectKey) throw new Error("MEMORY_ACTIVATION_DENIED");
        }
        const target = this.row("current_facts", scope, id).parent_id, at = Date.now(), view = { ...fact, factId: id, revision: expected + 1, sourceRef, recordedAt: at, acceptedAt: at, supersededAt: null, activationReason: body2.policyVersion === void 0 ? "explicitUserConfirmed" : "policyAccepted", policyVersion: typeof body2.policyVersion === "string" ? body2.policyVersion : null, provenance: { candidateId: null, evidenceId: null, activationSourceRef: sourceRef } };
        this.lifecycle(scope, previous, target, "supersession", at);
        const revisionId = this.appendRevision(scope, view);
        this.db.prepare("UPDATE current_facts SET revision=?,source_id=?,parent_id=?,subject_index=?,payload=? WHERE id=? AND scope_key=?").run(view.revision, sourceRef.sourceId, revisionId, index, this.seal("current_facts", scope, id, { view, visibility: "active" }), id, scope);
        this.invalidate(scope, id, view.revision);
        return { id, revision: view.revision };
      }
      case "forgetFact": {
        const body2 = objectFields(command.body, ["factId", "expectedRevision", "sourceRef"]), id = parseInternalId(body2.factId), expected = positiveRevision(body2.expectedRevision), sourceRef = parseSourceRef(body2.sourceRef);
        const view = this.projection(scope, id).view;
        if (view.revision !== expected) throw new Error("MEMORY_REVISION_CONFLICT");
        if (this.source(scope, sourceRef).kind !== "user") throw new Error("MEMORY_ACCESS_DENIED");
        const at = Date.now();
        this.lifecycle(scope, view, this.row("current_facts", scope, id).parent_id, "forget", at);
        this.db.prepare("UPDATE current_facts SET state='forgotten',payload=? WHERE id=? AND scope_key=?").run(this.seal("current_facts", scope, id, { view, visibility: "forgotten" }), id, scope);
        suppression.forget(scope, view, sourceRef, at);
        this.invalidate(scope, id, expected);
        return { id, revision: expected };
      }
    }
    throw new Error("MEMORY_INPUT_INVALID");
  }
  current(scope) {
    parseInternalId(scope);
    return this.db.prepare("SELECT id FROM current_facts WHERE scope_key=? AND state='active' ORDER BY id").all(scope).map((row) => this.projection(scope, row.id).view);
  }
  history(scope, factId) {
    parseInternalId(scope);
    parseInternalId(factId);
    this.projection(scope, factId);
    const rows = this.db.prepare("SELECT id,revision,event_kind,payload FROM fact_revisions WHERE scope_key=? AND fact_id=? ORDER BY revision,id").all(scope, factId);
    const superseded = /* @__PURE__ */ new Map(), views = [];
    for (const row of rows) {
      if (row.event_kind === "assertion") {
        const view = this.open("fact_revisions", scope, row.id, row.payload);
        if (view.factId !== factId || view.revision !== row.revision) throw new Error("MEMORY_DATA_INVALID");
        views.push(view);
      } else if (row.event_kind === "supersession") {
        const event = this.open("fact_revisions", scope, row.id, row.payload);
        if (event.factId !== factId || event.targetRevision !== row.revision) throw new Error("MEMORY_DATA_INVALID");
        superseded.set(event.targetRevision, event.at);
      }
    }
    return views.sort((a, b) => a.revision - b.revision).map((view) => ({ ...view, supersededAt: superseded.get(view.revision) ?? null }));
  }
};

// src/main/memory-core/jobs.ts
function parseJobBody(kind, value) {
  if (kind === "enqueue") {
    const b = objectFields(value, ["jobId", "sourceRef"]);
    return { jobId: parseInternalId(b.jobId), sourceRef: parseSourceRef(b.sourceRef) };
  }
  if (kind === "claim") {
    const b = objectFields(value, ["jobId", "leaseMs"]);
    if (typeof b.leaseMs !== "number" || !Number.isSafeInteger(b.leaseMs) || b.leaseMs < 1 || b.leaseMs > 6e4) throw new Error("MEMORY_INPUT_INVALID");
    return { jobId: parseInternalId(b.jobId), leaseMs: b.leaseMs };
  }
  if (kind === "commit") {
    const b = objectFields(value, ["jobId", "leaseToken", "proposals"]);
    if (!Array.isArray(b.proposals) || b.proposals.length === 0 || b.proposals.length > 100) throw new Error("MEMORY_INPUT_INVALID");
    const proposals = b.proposals.map((value2) => {
      const v = objectFields(value2, ["candidateId", "evidenceId", "text", "fact"]);
      return { candidateId: parseInternalId(v.candidateId), evidenceId: parseInternalId(v.evidenceId), text: textField(v.text), fact: parseFact(v.fact) };
    });
    return { jobId: parseInternalId(b.jobId), leaseToken: parseInternalId(b.leaseToken), proposals };
  }
  throw new Error("MEMORY_INPUT_INVALID");
}
var JobRepository = class {
  constructor(db, key, clock2, fault) {
    this.db = db;
    this.key = key;
    this.clock = clock2;
    this.fault = fault;
    this.codec = new RecordCodec(key);
    this.suppression = new Suppression(db, key);
  }
  db;
  key;
  clock;
  fault;
  codec;
  suppression;
  now() {
    const n = this.clock();
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("MEMORY_CLOCK_INVALID");
    return n;
  }
  source(scope, ref) {
    new SourceLedger(this.db, this.key).assertCurrent(scope, ref);
    const row = this.db.prepare("SELECT revision,payload FROM sources WHERE id=? AND scope_key=?").get(ref.sourceId, scope);
    if (!row) throw new Error("MEMORY_SOURCE_INVALID");
    const source = this.codec.open("sources", scope, ref.sourceId, row.payload);
    if (source.sourceRef.sourceId !== ref.sourceId || source.sourceRef.revision !== row.revision) throw new Error("MEMORY_DATA_INVALID");
    if (row.revision !== ref.revision) throw new Error("MEMORY_JOB_SOURCE_STALE");
  }
  job(scope, id) {
    const row = this.db.prepare("SELECT revision,state,payload FROM jobs WHERE id=? AND scope_key=?").get(id, scope);
    if (!row) throw new Error("MEMORY_JOB_NOT_FOUND");
    const value = this.codec.open("jobs", scope, id, row.payload);
    if (value.revision !== row.revision || value.state !== row.state || !Number.isSafeInteger(value.suppressionGeneration) || value.suppressionGeneration < 0) throw new Error("MEMORY_DATA_INVALID");
    parseSourceRef(value.sourceRef);
    return value;
  }
  validate(scope, job) {
    if (job.suppressionGeneration !== this.suppression.generation(scope) || this.suppression.sourceBlocked(scope, job.sourceRef)) throw new Error("MEMORY_JOB_SUPPRESSED");
    this.source(scope, job.sourceRef);
  }
  update(scope, id, job) {
    job.revision++;
    this.db.prepare("UPDATE jobs SET revision=?,state=?,payload=? WHERE id=? AND scope_key=?").run(job.revision, job.state, this.codec.seal("jobs", scope, id, job), id, scope);
    this.fault?.("after-record");
  }
  execute(value) {
    const cmd = objectFields(value, ["kind", "scopeKey", "commandId", "body"]), scope = parseInternalId(cmd.scopeKey), commandId = parseInternalId(cmd.commandId);
    if (typeof cmd.kind !== "string") throw new Error("MEMORY_INPUT_INVALID");
    const body = parseJobBody(cmd.kind, cmd.body), id = body.jobId;
    return executeTransaction({ db: this.db, key: this.key, scope, commandId, request: { ...cmd, body }, fault: this.fault, apply: () => {
      if (cmd.kind === "enqueue") {
        const ref = body.sourceRef;
        this.source(scope, ref);
        if (this.suppression.sourceBlocked(scope, ref)) throw new Error("MEMORY_SOURCE_SUPPRESSED");
        const job2 = { sourceRef: ref, suppressionGeneration: this.suppression.generation(scope), state: "pending", revision: 1, leaseToken: null, leaseExpiresAt: null };
        this.db.prepare("INSERT INTO jobs (id,scope_key,revision,source_id,parent_id,state,payload) VALUES(?,?,1,?,NULL,'pending',?)").run(id, scope, ref.sourceId, this.codec.seal("jobs", scope, id, job2));
        this.fault?.("after-record");
        return { id, revision: 1 };
      }
      const job = this.job(scope, id);
      this.validate(scope, job);
      const now = this.now();
      if (cmd.kind === "claim") {
        if (job.state === "complete") throw new Error("MEMORY_JOB_COMPLETE");
        if (job.state === "running" && job.leaseExpiresAt !== null && now < job.leaseExpiresAt) throw new Error("MEMORY_JOB_BUSY");
        const expires = now + body.leaseMs;
        if (!Number.isSafeInteger(expires)) throw new Error("MEMORY_CLOCK_INVALID");
        job.state = "running";
        job.leaseToken = (0, import_node_crypto6.randomUUID)();
        job.leaseExpiresAt = expires;
        this.update(scope, id, job);
        return { jobId: id, leaseToken: job.leaseToken, leaseExpiresAt: expires, sourceRef: job.sourceRef, suppressionGeneration: job.suppressionGeneration };
      }
      if (job.state !== "running" || job.leaseToken !== body.leaseToken || job.leaseExpiresAt === null || now >= job.leaseExpiresAt) throw new Error("MEMORY_JOB_LEASE_INVALID");
      const facts = new FactRepository(this.db, this.key, this.fault);
      for (const proposal of body.proposals) {
        facts.applyWithinTransaction(scope, "appendEvidence", { evidenceId: proposal.evidenceId, sourceRef: job.sourceRef, text: proposal.text });
        facts.applyWithinTransaction(scope, "proposeCandidate", { candidateId: proposal.candidateId, evidenceId: proposal.evidenceId, fact: proposal.fact });
      }
      job.state = "complete";
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      this.update(scope, id, job);
      return { id, revision: job.revision };
    } });
  }
};

// src/main/memory-policy/extractor.ts
function extractPreference(text) {
  if (typeof text !== "string" || text.length > 1e5) throw new Error("MEMORY_INPUT_INVALID");
  if (/password|passwd|passphrase|credential|api[ _-]?key|(?:access|refresh|session|id|auth)[ _-]?token|bearer\s|\btoken\s*[:=]|(?:client[ _-]?)?secret\s*[:=]|private[ _-]?key|\b(?:ghp_|sk-)[A-Za-z0-9_-]{16,}|密码|口令|私钥|密钥|令牌/i.test(text.normalize("NFKC"))) return { kind: "rejected", reason: "secret" };
  const candidate = (reason) => ({ kind: "candidate", attribute: "unclassified", value: null, reason, text });
  const normalized = text.normalize("NFKC").trim();
  if (/糖尿病|疾病|病史|银行|账户|工资|身份证|cancer|medical|diagnos|bank|salary|social security/i.test(normalized)) return candidate("sensitive");
  if (/[\r\n?？;；:："“”「」]/.test(normalized)) return candidate("ambiguous");
  if (/临时|暂时|今天|今晚|本次|这次|本会话|for now|today|tonight|tomorrow|this session/i.test(normalized)) return candidate("temporary");
  const clean = normalized.replace(/[。.!！]$/u, "").trim();
  const address = /^(?:请叫我\s*|Call me\s+)([\p{L}\p{N}\p{Extended_Pictographic} _-]{1,32})$/iu.exec(clean);
  if (address) return { kind: "direct", attribute: "address", value: address[1].trim(), reason: "direct-preference", text };
  const match = /^(?:我(?:默认(?:用|使用)|偏好)\s*|I (?:prefer\s+|use\s+)|My preferred (?:shell|language) is\s+)(.+)$/iu.exec(clean);
  if (!match) return candidate("unknown");
  const value = match[1].replace(/ by default$/i, "").trim().toLowerCase();
  const values = {
    powershell: ["shell", "powershell"],
    cmd: ["shell", "cmd"],
    bash: ["shell", "bash"],
    \u4E2D\u6587: ["language", "zh"],
    chinese: ["language", "zh"],
    \u82F1\u6587: ["language", "en"],
    english: ["language", "en"],
    \u4E2D\u82F1\u6DF7\u5408: ["language", "mixed"],
    "bilingual responses": ["language", "mixed"],
    \u7B80\u6D01\u56DE\u590D: ["response-style", "concise"],
    "concise responses": ["response-style", "concise"],
    \u8BE6\u7EC6\u56DE\u590D: ["response-style", "detailed"],
    "detailed responses": ["response-style", "detailed"]
  };
  const entry = values[value];
  const declared = /^My preferred (shell|language) is\s+/i.exec(clean)?.[1].toLowerCase();
  return entry && (!declared || declared === entry[0]) ? { kind: "direct", attribute: entry[0], value: entry[1], reason: "direct-preference", text } : candidate("unknown");
}

// src/main/memory-policy/maintenance-extractor.ts
var MAINTENANCE_VERSION = "main-maintenance-v1";
function extractMaintenance(text) {
  const base = extractPreference(text);
  if (base.kind === "rejected") return base;
  const candidate = (reason) => ({ kind: "candidate", attribute: "unclassified", value: null, reason, text });
  const clean = text.normalize("NFKC").trim().replace(/[。.!！]$/u, "").trim();
  if (base.kind === "candidate" && base.reason === "sensitive") return { ...base, kind: "candidate" };
  if (/[\r\n?？;；:："“”‘’]/u.test(clean) || /^(?:If |Suppose |Maybe |Alice |They |He |She |如果|假如|可能|他|她)/iu.test(clean)) return candidate("ambiguous");
  if (/^(?:From |Starting |从|明天|下周)|(?:tomorrow|next week|will use)/iu.test(clean)) return candidate("future-effective");
  const claim = (attribute, value2, context = "default", cardinality = "one", operation = "assert", previousValue) => ({ attribute, value: value2, context, cardinality, operation, ...previousValue ? { previousValue } : {} });
  const claims = (items) => ({ kind: "claims", text, claims: items });
  const value = (raw) => raw.trim().toLowerCase();
  const attr = (raw) => /^(?:python|rust|typescript|javascript|go)$/iu.test(raw) ? "programming-usage" : "shell";
  const tools = "(Python|Rust|TypeScript|JavaScript|Go|bash|cmd|PowerShell)";
  const paired = new RegExp("^\u6211\u5DE5\u4F5C\u7528\\s*" + tools + "[\uFF0C,]\\s*\u4E2A\u4EBA\u7528\\s*" + tools + "$", "iu").exec(clean);
  if (paired) return claims([claim(attr(paired[1]), value(paired[1]), "work", attr(paired[1]) === "shell" ? "one" : "many"), claim(attr(paired[2]), value(paired[2]), "personal", attr(paired[2]) === "shell" ? "one" : "many")]);
  const abilities = /^(?:I know |我会\s*)(Python|Rust|TypeScript|JavaScript|Go)(?:(?: and | 和 |和)(Python|Rust|TypeScript|JavaScript|Go))?$/iu.exec(clean);
  if (abilities) return claims([...new Set(abilities.slice(1).filter(Boolean).map(value))].map((v) => claim("programming-ability", v, "default", "many")));
  const contextual = new RegExp("^I (now )?use " + tools + " (for work|personally)$", "iu").exec(clean);
  const zhContext = new RegExp("^\u6211(\u5DE5\u4F5C|\u4E2A\u4EBA)(\u73B0\u5728\u6539\u7528|\u7528)\\s*" + tools + "$", "iu").exec(clean);
  if (contextual) {
    const attribute = attr(contextual[2]);
    return claims([claim(attribute, value(contextual[2]), contextual[3].toLowerCase() === "for work" ? "work" : "personal", attribute === "shell" ? "one" : "many", contextual[1] ? "change" : "assert")]);
  }
  if (zhContext) {
    const attribute = attr(zhContext[3]);
    return claims([claim(attribute, value(zhContext[3]), zhContext[1] === "\u5DE5\u4F5C" ? "work" : "personal", attribute === "shell" ? "one" : "many", zhContext[2] === "\u73B0\u5728\u6539\u7528" ? "change" : "assert")]);
  }
  const address = /^(?:Please now call me |现在请叫我\s*)(.+)$/iu.exec(clean);
  if (address) {
    const parsed = extractPreference("Call me " + address[1]);
    if (parsed.kind === "direct") return claims([claim(parsed.attribute, parsed.value, "default", "one", "change")]);
    return candidate("ambiguous");
  }
  const change = /^(?:I now (?:prefer|use) |我现在(?:默认)?(?:改用|偏好)\s*)(.+?)(?: instead of (.+))?$/iu.exec(clean);
  if (change) {
    const parsed = extractPreference("I prefer " + change[1]), previous = change[2] ? extractPreference("I prefer " + change[2]) : null;
    if (parsed.kind === "direct" && (!previous || previous.kind === "direct" && previous.attribute === parsed.attribute)) return claims([claim(parsed.attribute, parsed.value, "default", "one", "change", previous?.kind === "direct" ? previous.value : void 0)]);
    return candidate("ambiguous");
  }
  const denied = /^(?:I no longer use |我不再用\s*)(bash|cmd|PowerShell)$/iu.exec(clean);
  if (denied) return claims([claim("shell", value(denied[1]), "default", "one", "deny")]);
  if (base.kind === "direct") return claims([claim(base.attribute, base.value)]);
  return { ...base, kind: "candidate" };
}

// src/main/memory-policy/policy-repository.ts
var import_node_crypto8 = require("node:crypto");

// src/main/memory-policy/fact-supports.ts
var import_node_crypto7 = require("node:crypto");
var FactSupports = class {
  constructor(db, key) {
    this.db = db;
    this.codec = new RecordCodec(key);
    this.ledger = new SourceLedger(db, key);
    this.suppression = new Suppression(db, key);
  }
  db;
  codec;
  ledger;
  suppression;
  transaction() {
    if (!this.db.isTransaction) throw new Error("MEMORY_TRANSACTION_REQUIRED");
  }
  read(scope, factId) {
    return this.db.prepare("SELECT id,fact_id,fact_revision,payload FROM fact_supports WHERE scope_key=? AND fact_id=? ORDER BY id").all(scope, factId).map((row) => {
      const r = this.codec.open("fact-support", scope, row.id, row.payload);
      if (r.id !== row.id || r.factId !== row.fact_id || r.factRevision !== row.fact_revision || !["automatic", "explicitUserConfirmed"].includes(r.kind) || !["supported", "suppressed"].includes(r.state) || r.kind === "explicitUserConfirmed" !== (r.proof !== null)) throw new Error("MEMORY_DATA_INVALID");
      return r;
    });
  }
  save(scope, r) {
    this.transaction();
    this.db.prepare("INSERT INTO fact_supports(id,scope_key,fact_id,fact_revision,payload) VALUES(?,?,?,?,?) ON CONFLICT(id,scope_key) DO UPDATE SET payload=excluded.payload").run(r.id, scope, r.factId, r.factRevision, this.codec.seal("fact-support", scope, r.id, r));
  }
  validity(scope, r) {
    if (r.state === "suppressed" || this.suppression.sourceBlocked(scope, r.sourceRef)) return "suppressed";
    try {
      const head = this.ledger.assertCurrent(scope, r.sourceRef);
      if (!head?.published || head.published.role !== "user" || head.published.trust !== "direct-user-event") return "untrusted";
      if (head.published.occurredAt !== void 0 && head.published.occurredAt > Date.now()) return "future";
      return "valid";
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "MEMORY_SOURCE_PENDING") return "pending";
      if (code === "MEMORY_SOURCE_DELETED") return "deleted";
      if (code === "MEMORY_SOURCE_STALE") return "stale";
      throw error;
    }
  }
  add(scope, actorKey, fact, sourceRef, kind, proof = null) {
    this.transaction();
    const head = this.ledger.assertCurrent(scope, sourceRef);
    if (!head?.published || head.published.role !== "user" || head.published.trust !== "direct-user-event" || this.suppression.sourceBlocked(scope, sourceRef)) throw new Error("MEMORY_EVENT_DENIED");
    if (head.published.occurredAt !== void 0 && head.published.occurredAt > Date.now()) throw new Error("MEMORY_POLICY_FUTURE");
    if (kind === "explicitUserConfirmed" !== (proof !== null)) throw new Error("MEMORY_EVENT_DENIED");
    const records = this.read(scope, fact.factId);
    if (kind === "explicitUserConfirmed" && ["confirm", "confirmFact"].includes(proof.action) && records.some((r) => r.actorKey === actorKey && r.kind === "automatic" && r.sourceRef.sourceId === sourceRef.sourceId)) throw new Error("MEMORY_CONFIRMATION_NOT_INDEPENDENT");
    const id = (0, import_node_crypto7.createHash)("sha256").update(canonicalJson({ actorKey, factId: fact.factId, revision: fact.revision, sourceRef })).digest("hex");
    const old = records.find((r) => r.id === id);
    if (old) {
      if (old.state === "suppressed") throw new Error("MEMORY_POLICY_SUPPRESSED");
      return;
    }
    this.save(scope, { id, actorKey, factId: fact.factId, factRevision: fact.revision, subjectKey: fact.subjectKey, sourceRef, kind, proof, state: "supported", generation: this.suppression.generation(scope) });
  }
  bootstrap(scope, actorKey, fact) {
    this.transaction();
    if (this.read(scope, fact.factId).length || fact.activationReason !== "policyAccepted" || !fact.sourceRef.binding) return;
    const id = (0, import_node_crypto7.createHash)("sha256").update(canonicalJson({ actorKey, factId: fact.factId, revision: fact.revision, sourceRef: fact.sourceRef })).digest("hex");
    this.save(scope, { id, actorKey, factId: fact.factId, factRevision: fact.revision, subjectKey: fact.subjectKey, sourceRef: fact.sourceRef, kind: "automatic", proof: null, state: "supported", generation: this.suppression.generation(scope) });
  }
  deny(scope, actorKey, fact, sourceRef, nonce) {
    this.transaction();
    const head = this.ledger.assertCurrent(scope, sourceRef);
    if (!head?.published || head.published.role !== "user" || head.published.trust !== "direct-user-event" || this.suppression.sourceBlocked(scope, sourceRef)) throw new Error("MEMORY_EVENT_DENIED");
    if (head.published.occurredAt !== void 0 && head.published.occurredAt > Date.now()) throw new Error("MEMORY_POLICY_FUTURE");
    const id = (0, import_node_crypto7.createHash)("sha256").update(canonicalJson({ actorKey, factId: fact.factId, revision: fact.revision, sourceRef, nonce })).digest("hex");
    const value = { actorKey, factId: fact.factId, factRevision: fact.revision, sourceRef, nonce, generation: this.suppression.generation(scope), state: "recorded" };
    this.db.prepare("INSERT INTO fact_reviews(id,scope_key,fact_id,payload) VALUES(?,?,?,?)").run(id, scope, fact.factId, this.codec.seal("fact-review", scope, id, value));
  }
  audit(scope, actorKey, factId, current) {
    this.transaction();
    if (current) this.bootstrap(scope, actorKey, current);
    const records = this.read(scope, factId).filter((r) => r.actorKey === actorKey);
    const reviews = this.db.prepare("SELECT id,payload FROM fact_reviews WHERE scope_key=? AND fact_id=? ORDER BY id").all(scope, factId).map((row) => this.codec.open("fact-review", scope, row.id, row.payload)).filter((r) => r.actorKey === actorKey);
    const valid = records.some((r) => r.factRevision === current?.revision && this.validity(scope, r) === "valid");
    const denied = reviews.some((r) => r.factRevision === current?.revision);
    return {
      factId,
      revision: current?.revision ?? null,
      status: !current ? "forgotten" : denied || !valid ? "pending-review" : "eligible",
      reason: !current ? "forgotten" : denied ? "explicit-denial" : valid ? "valid-support" : "no-valid-support",
      supports: records.map((r) => ({ sourceRef: r.sourceRef, kind: r.kind, factRevision: r.factRevision, validity: this.validity(scope, r), proof: r.proof })),
      reviews: reviews.map((r) => ({ sourceRef: r.sourceRef, factRevision: r.factRevision }))
    };
  }
  reconcile(scope, actorKey, facts) {
    this.transaction();
    for (const f of facts) {
      this.bootstrap(scope, actorKey, f);
      for (const r of this.read(scope, f.factId).filter((r2) => r2.actorKey === actorKey)) {
        r.checkedValidity = this.validity(scope, r);
        this.save(scope, r);
      }
    }
  }
  forget(scope, actorKey, factId) {
    this.transaction();
    const refs2 = [];
    for (const r of this.read(scope, factId).filter((r2) => r2.actorKey === actorKey)) {
      r.state = "suppressed";
      r.checkedValidity = "suppressed";
      this.save(scope, r);
      refs2.push(r.sourceRef);
    }
    for (const row of this.db.prepare("SELECT id,payload FROM fact_reviews WHERE scope_key=? AND fact_id=?").all(scope, factId)) {
      const r = this.codec.open("fact-review", scope, row.id, row.payload);
      if (r.actorKey !== actorKey) continue;
      r.state = "suppressed";
      this.db.prepare("UPDATE fact_reviews SET payload=? WHERE scope_key=? AND id=?").run(this.codec.seal("fact-review", scope, row.id, r), scope, row.id);
      refs2.push(r.sourceRef);
    }
    return refs2;
  }
};

// src/main/memory-policy/policy-repository.ts
var POLICY_VERSION = "main-preferences-v1";
function generation(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("MEMORY_INPUT_INVALID");
  return value;
}
function subject(actor, attribute, context = "default", cardinality = "one", value = null) {
  return "actor-attribute-" + (0, import_node_crypto8.createHash)("sha256").update(canonicalJson({ actor, attribute, ...context !== "default" ? { context } : {}, ...cardinality === "many" ? { cardinality, value } : {} })).digest("hex");
}
function extraction(value) {
  const base = objectFields(value, ["kind", "reason"], ["attribute", "value", "text"]);
  if (base.kind === "rejected") {
    objectFields(value, ["kind", "reason"]);
    if (base.reason !== "secret") throw new Error("MEMORY_INPUT_INVALID");
    return { kind: "rejected", reason: "secret" };
  }
  const parsed = extractPreference(base.text);
  if (canonicalJson(value) !== canonicalJson(parsed)) throw new Error("MEMORY_INPUT_INVALID");
  return parsed;
}
function parseBaseline(value) {
  if (!Array.isArray(value) || value.length > 1e4) throw new Error("MEMORY_INPUT_INVALID");
  return value.map((item) => {
    const r = objectFields(item, ["factId", "revision", "subjectKey"]);
    return { factId: parseInternalId(r.factId), revision: positiveRevision(r.revision), subjectKey: textField(r.subjectKey) };
  });
}
function matchesBaseline(previous, baseline) {
  const expected = baseline.find((f) => f.subjectKey === previous.subjectKey);
  return expected?.factId === previous.factId && expected.revision === previous.revision;
}
var PolicyRepository = class {
  constructor(db, key, fault) {
    this.db = db;
    this.key = key;
    this.fault = fault;
    this.codec = new RecordCodec(key);
    this.suppression = new Suppression(db, key);
    this.ledger = new SourceLedger(db, key);
    this.facts = new FactRepository(db, key, fault);
    this.supports = new FactSupports(db, key);
  }
  db;
  key;
  fault;
  codec;
  suppression;
  ledger;
  facts;
  supports;
  /** Context worker reuses policy eligibility in its own transaction; no nested BEGIN. */
  eligibleFactsWithinTransaction(scope, actor) {
    if (!this.db.isTransaction) throw new Error("MEMORY_TRANSACTION_REQUIRED");
    const owners = this.records(scope).filter((r) => r.actorKey === actor && r.factId !== null);
    return this.facts.current(scope).filter((f) => owners.some((r) => r.factId === f.factId) && this.supports.audit(scope, actor, f.factId, f).status === "eligible");
  }
  records(scope) {
    return this.db.prepare("SELECT id,revision,payload FROM policy_records WHERE scope_key=? ORDER BY id").all(scope).map((row) => {
      const record = this.codec.open("policy-record", scope, row.id, row.payload);
      if (record.id !== row.id || record.revision !== row.revision || record.fact.subjectKey !== subject(record.actorKey, record.extraction.attribute, record.contextKey, record.cardinality, record.extraction.value)) throw new Error("MEMORY_DATA_INVALID");
      return record;
    });
  }
  save(scope, record) {
    this.db.prepare("INSERT INTO policy_records(id,scope_key,revision,payload) VALUES(?,?,?,?) ON CONFLICT(id,scope_key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload").run(record.id, scope, record.revision, this.codec.seal("policy-record", scope, record.id, record));
    this.fault?.("after-record");
  }
  source(scope, value, text) {
    const ref = parseSourceRef(value);
    if (!ref.binding || ref.span) throw new Error("MEMORY_POLICY_FULL_SOURCE_REQUIRED");
    const head = this.ledger.assertCurrent(scope, ref);
    if (!head?.published) throw new Error("MEMORY_SOURCE_INVALID");
    if (text !== void 0) {
      const fingerprint = (0, import_node_crypto8.createHash)("sha256").update(canonicalJson({ text, state: head.published.state, role: head.published.role, trust: head.published.trust })).digest("hex");
      if (fingerprint !== head.published.fingerprint) throw new Error("MEMORY_SOURCE_QUOTE_MISMATCH");
    }
    return ref;
  }
  currentGeneration(scope, expected) {
    const value = generation(expected);
    if (value !== this.suppression.generation(scope)) throw new Error("MEMORY_POLICY_SUPPRESSED");
    return value;
  }
  candidate(scope, actor, id, revision) {
    const record = this.records(scope).find((c) => c.id === parseInternalId(id) && c.actorKey === actor);
    if (!record) throw new Error("MEMORY_CANDIDATE_NOT_FOUND");
    this.currentGeneration(scope, record.generation);
    if (record.revision !== positiveRevision(revision)) throw new Error("MEMORY_REVISION_CONFLICT");
    if (record.state !== "candidate") throw new Error("MEMORY_CANDIDATE_NOT_FOUND");
    this.source(scope, record.sourceRef);
    return record;
  }
  draft(actor, parsed, context = "default", cardinality = "one", referenceTime = null, validFrom = null) {
    return { subjectKey: subject(actor, parsed.attribute, context, cardinality, parsed.value), assertion: parsed.kind === "direct" ? parsed.text : "", assertionKind: parsed.kind === "direct" ? "user-statement" : "inference", time: { validFrom, validTo: null, referenceTime } };
  }
  insert(scope, actor, gen, ref, parsed, reason, context = "default", cardinality = "one", referenceTime = null) {
    const id = (0, import_node_crypto8.randomUUID)(), evidenceId = parsed.kind === "direct" ? (0, import_node_crypto8.randomUUID)() : null, fact = this.draft(actor, parsed, context, cardinality, referenceTime);
    if (evidenceId !== null) {
      this.facts.applyWithinTransaction(scope, "appendEvidence", { evidenceId, sourceRef: ref, text: parsed.text });
      this.facts.applyWithinTransaction(scope, "proposeCandidate", { candidateId: id, evidenceId, fact });
    }
    const stored = parsed.kind === "direct" ? parsed : { ...parsed, text: "" };
    const record = { id, revision: 1, actorKey: actor, generation: gen, state: "candidate", sourceRef: ref, extraction: stored, contextKey: context, cardinality, fact, evidenceId, reason, factId: null };
    this.save(scope, record);
    return record;
  }
  active(scope, record, reason, event, support, policyVersion = POLICY_VERSION) {
    if (record.extraction.kind !== "direct") throw new Error("MEMORY_POLICY_UNRESOLVED");
    const occurredAt = this.ledger.assertCurrent(scope, record.sourceRef)?.published?.occurredAt;
    if (occurredAt !== void 0 && occurredAt > Date.now()) throw new Error("MEMORY_POLICY_FUTURE");
    const result = this.facts.applyWithinTransaction(scope, "activateCandidate", { candidateId: record.id, authorization: { reason, sourceRef: event, policyVersion: reason === "policyAccepted" ? policyVersion : null } });
    record.state = "active";
    record.factId = result.id;
    record.revision++;
    this.save(scope, record);
    const view = this.facts.current(scope).find((f) => f.factId === result.id);
    if (reason === "policyAccepted") this.supports.add(scope, record.actorKey, view, record.sourceRef, "automatic");
    else {
      if (!support) throw new Error("MEMORY_EVENT_DENIED");
      this.supports.add(scope, record.actorKey, view, support.sourceRef, "explicitUserConfirmed", support.proof);
    }
    return { status: "active", candidateId: record.id, candidateRevision: record.revision, factId: result.id, factRevision: result.revision };
  }
  eventSource(scope, commandId, intent, target) {
    const sourceRef = { sourceId: commandId, revision: 1 };
    this.facts.applyWithinTransaction(scope, "registerSource", { sourceRef, kind: "user", intent, ...target });
    return sourceRef;
  }
  integrate(scope, actor, gen, input) {
    const b = objectFields(input, ["actorKey", "generation", "sourceRef", "extraction", "baseline", "policyVersion"]);
    if (b.policyVersion !== MAINTENANCE_VERSION) throw new Error("MEMORY_POLICY_VERSION_INVALID");
    const e = objectFields(b.extraction, ["kind"], ["reason", "attribute", "value", "text", "claims"]);
    let parsed;
    if (e.kind === "rejected") {
      const rejected = extraction(b.extraction);
      if (rejected.kind !== "rejected") throw new Error("MEMORY_INPUT_INVALID");
      parsed = rejected;
    } else parsed = extractMaintenance(e.text);
    if (canonicalJson(parsed) !== canonicalJson(b.extraction)) throw new Error("MEMORY_INPUT_INVALID");
    const ref = this.source(scope, b.sourceRef, parsed.kind === "rejected" ? void 0 : parsed.text);
    const baseline = parseBaseline(b.baseline);
    if (parsed.kind === "rejected") return { items: [{ status: "rejected", reason: "secret" }] };
    if (parsed.kind === "candidate") {
      if (this.suppression.sourceBlocked(scope, ref)) return { items: [{ status: "suppressed", reason: "forgotten" }] };
      const record = this.insert(scope, actor, gen, ref, parsed, parsed.reason);
      return { items: [{ status: "candidate", candidateId: record.id, candidateRevision: 1, reason: parsed.reason }] };
    }
    const observed = this.ledger.assertCurrent(scope, ref).published;
    return { items: parsed.claims.map((claim) => this.integrateClaim(scope, actor, gen, ref, parsed.text, claim, observed.occurredAt ?? null, observed.role === "user" && observed.trust === "direct-user-event", baseline)) };
  }
  integrateClaim(scope, actor, gen, ref, text, claim, at, trusted, baseline) {
    const parsed = { kind: "direct", attribute: claim.attribute, value: claim.value, reason: "direct-preference", text };
    const key = subject(actor, claim.attribute, claim.context, claim.cardinality, claim.value);
    if (this.suppression.sourceBlocked(scope, ref) || this.suppression.subjectBlocked(scope, key)) return { status: "suppressed", reason: "forgotten" };
    const previous = this.facts.current(scope).find((f) => f.subjectKey === key);
    const owner = previous ? this.records(scope).find((r) => r.actorKey === actor && r.factId === previous.factId && r.state === "active") : void 0;
    const candidate = (reason) => {
      const record2 = this.insert(scope, actor, gen, ref, parsed, reason, claim.context, claim.cardinality, at);
      return { status: "candidate", candidateId: record2.id, candidateRevision: 1, reason };
    };
    if (!trusted) return candidate("untrusted-origin");
    if (at !== null && at > Date.now()) return candidate("future-source");
    if (previous && !matchesBaseline(previous, baseline)) return candidate("stale-base");
    if (claim.operation === "change" && previous) {
      if (at === null) return candidate("unknown-time");
      if (previous.time.referenceTime === null) return candidate("unknown-prior-time");
      if (at <= previous.time.referenceTime) return candidate("out-of-order");
    }
    if (claim.operation === "deny") {
      if (!previous || !owner || owner.extraction.value !== claim.value) return candidate("denial-unmatched");
      if (at === null) return candidate("unknown-time");
      if (previous.time.referenceTime === null) return candidate("unknown-prior-time");
      if (at <= previous.time.referenceTime) return candidate("out-of-order");
      this.supports.deny(scope, actor, previous, ref, (0, import_node_crypto8.randomUUID)());
      return { status: "pending-review", factId: previous.factId, factRevision: previous.revision, reason: "explicit-denial" };
    }
    if (previous && owner?.extraction.value === claim.value) {
      this.supports.add(scope, actor, previous, ref, "automatic");
      return { status: "active", factId: previous.factId, factRevision: previous.revision, reason: "duplicate-support" };
    }
    if (previous) {
      if (claim.operation !== "change" || claim.cardinality !== "one" || !owner) return candidate("conflict");
      if (claim.previousValue && claim.previousValue !== owner.extraction.value) return candidate("change-old-mismatch");
      if (this.supports.audit(scope, actor, previous.factId, previous).status !== "eligible") return candidate("prior-needs-review");
      const fact = this.draft(actor, parsed, claim.context, claim.cardinality, at, at);
      const changed = this.facts.applyWithinTransaction(scope, "correctFact", { factId: previous.factId, expectedRevision: previous.revision, sourceRef: ref, fact, policyVersion: MAINTENANCE_VERSION });
      owner.fact = fact;
      owner.sourceRef = ref;
      owner.extraction = parsed;
      owner.revision++;
      this.save(scope, owner);
      this.supports.add(scope, actor, this.facts.current(scope).find((f) => f.factId === previous.factId), ref, "automatic");
      return { status: "active", factId: previous.factId, factRevision: changed.revision, reason: "clear-current-change" };
    }
    if (claim.operation === "change") return candidate("change-without-prior");
    const record = this.insert(scope, actor, gen, ref, parsed, "direct-preference", claim.context, claim.cardinality, at);
    return this.active(scope, record, "policyAccepted", ref, void 0, MAINTENANCE_VERSION);
  }
  execute(value) {
    const cmd = objectFields(value, ["kind", "scopeKey", "body"], ["commandId"]), scope = parseInternalId(cmd.scopeKey);
    const input = objectFields(cmd.body, ["actorKey"], ["generation", "sourceRef", "extraction", "policyVersion", "kind", "nonce", "candidateId", "factId", "revision", "limit", "after", "baseline"]), actor = parseInternalId(input.actorKey);
    if (cmd.kind === "generation") {
      objectFields(input, ["actorKey"]);
      return this.suppression.generation(scope);
    }
    if (cmd.kind === "baseline") {
      objectFields(input, ["actorKey"]);
      this.db.exec("BEGIN");
      try {
        const ids = new Set(this.records(scope).filter((r) => r.actorKey === actor && r.factId !== null).map((r) => r.factId));
        const result = this.facts.current(scope).filter((f) => ids.has(f.factId)).map((f) => ({ factId: f.factId, revision: f.revision, subjectKey: f.subjectKey }));
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (cmd.kind === "recall" || cmd.kind === "audit") {
      objectFields(input, ["actorKey", ...cmd.kind === "audit" ? ["factId"] : []]);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const owners = this.records(scope).filter((r) => r.actorKey === actor && r.factId !== null), facts = this.facts.current(scope);
        let result;
        if (cmd.kind === "audit") {
          const id = parseInternalId(input.factId);
          if (!owners.some((r) => r.factId === id)) throw new Error("MEMORY_FACT_NOT_FOUND");
          result = this.supports.audit(scope, actor, id, facts.find((f) => f.factId === id));
        } else result = this.eligibleFactsWithinTransaction(scope, actor);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (cmd.kind === "candidates") {
      const body = objectFields(input, ["actorKey", "generation", "limit", "after"]), gen = this.currentGeneration(scope, body.generation);
      if (!Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 101 || typeof body.after !== "string") throw new Error("MEMORY_INPUT_INVALID");
      if (body.after) parseInternalId(body.after);
      return this.records(scope).filter((r) => r.actorKey === actor && r.generation === gen && r.state === "candidate" && r.id > body.after).filter((r) => {
        try {
          this.source(scope, r.sourceRef);
          return !this.suppression.subjectBlocked(scope, r.fact.subjectKey) && !this.suppression.sourceBlocked(scope, r.sourceRef);
        } catch {
          return false;
        }
      }).slice(0, body.limit).map((r) => ({ candidateId: r.id, revision: r.revision, attribute: r.extraction.attribute, value: r.extraction.value, reason: r.reason, sourceRef: r.sourceRef, assertion: r.fact.assertion }));
    }
    if (cmd.kind !== "ingest" && cmd.kind !== "event" && cmd.kind !== "reconcileSupports" && cmd.kind !== "integrate") throw new Error("MEMORY_INPUT_INVALID");
    const commandId = parseInternalId(cmd.commandId);
    const { baseline: ignoredBaseline, ...intentBody } = input;
    const request = cmd.kind === "ingest" || cmd.kind === "integrate" ? { ...cmd, body: intentBody } : value;
    return executeTransaction({ db: this.db, key: this.key, scope, commandId, request, fault: this.fault, apply: () => {
      const gen = this.currentGeneration(scope, input.generation);
      if (cmd.kind === "reconcileSupports") {
        objectFields(input, ["actorKey", "generation"]);
        const ids = new Set(this.records(scope).filter((r) => r.actorKey === actor && r.factId !== null).map((r) => r.factId));
        const facts = this.facts.current(scope).filter((f) => ids.has(f.factId));
        this.supports.reconcile(scope, actor, facts);
        return { reconciled: facts.length };
      }
      if (cmd.kind === "integrate") return this.integrate(scope, actor, gen, input);
      if (cmd.kind === "ingest") {
        const b = objectFields(input, ["actorKey", "sourceRef", "generation", "extraction", "policyVersion", "baseline"]);
        if (b.policyVersion !== POLICY_VERSION) throw new Error("MEMORY_POLICY_VERSION_INVALID");
        const baseline = parseBaseline(b.baseline);
        const parsed = extraction(b.extraction), ref = this.source(scope, b.sourceRef, parsed.kind === "rejected" ? void 0 : parsed.text);
        if (parsed.kind === "rejected") return { status: "rejected", reason: "secret" };
        const fact = this.draft(actor, parsed);
        if (this.suppression.sourceBlocked(scope, ref) || this.suppression.subjectBlocked(scope, fact.subjectKey)) return { status: "suppressed", reason: "forgotten" };
        const previous = this.facts.current(scope).find((f) => f.subjectKey === fact.subjectKey), conflict = previous !== void 0;
        const stale = previous && !matchesBaseline(previous, baseline);
        const observed = this.ledger.assertCurrent(scope, ref).published;
        const at = observed.occurredAt ?? null;
        if (at !== null && at > Date.now()) {
          const record2 = this.insert(scope, actor, gen, ref, parsed, "future-source", "default", "one", at);
          return { status: "candidate", candidateId: record2.id, candidateRevision: 1, reason: "future-source" };
        }
        const direct = parsed.kind === "direct" && observed.role === "user" && observed.trust === "direct-user-event";
        const duplicate = direct && !stale ? this.records(scope).find((r) => r.actorKey === actor && r.state === "active" && r.fact.subjectKey === fact.subjectKey && r.extraction.value === parsed.value) : void 0;
        if (duplicate?.factId) {
          const current = this.facts.current(scope).find((f) => f.factId === duplicate.factId);
          if (current) {
            this.supports.add(scope, actor, current, ref, "automatic");
            return { status: "active", factId: current.factId, factRevision: current.revision, reason: "duplicate-support" };
          }
        }
        const reason = stale ? "stale-base" : conflict ? "conflict" : !direct && parsed.kind === "direct" ? "untrusted-origin" : parsed.reason;
        const record = this.insert(scope, actor, gen, ref, parsed, reason, "default", "one", at);
        return direct && !conflict ? this.active(scope, record, "policyAccepted", ref) : { status: "candidate", candidateId: record.id, candidateRevision: 1, reason };
      }
      const kind = input.kind, nonce = parseInternalId(input.nonce);
      if (kind === "confirm" || kind === "reject" || kind === "revise") {
        objectFields(input, ["actorKey", "generation", "kind", "nonce", "candidateId", "revision", ...kind === "confirm" ? ["sourceRef"] : []], kind === "revise" ? ["sourceRef", "extraction"] : []);
        const record = this.candidate(scope, actor, input.candidateId, input.revision);
        if (kind === "confirm") {
          if (record.fact.time.referenceTime !== null && record.fact.time.referenceTime > Date.now()) throw new Error("MEMORY_POLICY_FUTURE");
          const ref2 = this.source(scope, input.sourceRef);
          if (ref2.sourceId === record.sourceRef.sourceId) throw new Error("MEMORY_CONFIRMATION_NOT_INDEPENDENT");
          return this.active(scope, record, "explicitUserConfirmed", this.eventSource(scope, commandId, "confirmation", { candidateId: record.id }), { sourceRef: ref2, proof: { nonce, targetId: record.id, targetRevision: record.revision, action: "confirm" } });
        }
        if (kind === "reject") {
          record.state = "rejected";
          record.revision++;
          this.save(scope, record);
          this.db.prepare("UPDATE candidates SET state='invalidated',revision=? WHERE scope_key=? AND id=?").run(record.revision, scope, record.id);
          return { status: "rejected", candidateId: record.id, candidateRevision: record.revision };
        }
        const parsed = extraction(input.extraction);
        if (parsed.kind !== "direct") throw new Error("MEMORY_POLICY_UNRESOLVED");
        const ref = this.source(scope, input.sourceRef, parsed.text), observed = this.ledger.assertCurrent(scope, ref).published;
        if (observed.role !== "user" || observed.trust !== "direct-user-event") throw new Error("MEMORY_EVENT_DENIED");
        if (parsed.attribute !== record.extraction.attribute) throw new Error("MEMORY_POLICY_ATTRIBUTE_MISMATCH");
        if (this.suppression.sourceBlocked(scope, ref) || this.suppression.subjectBlocked(scope, record.fact.subjectKey)) throw new Error("MEMORY_POLICY_SUPPRESSED");
        record.revision++;
        record.sourceRef = ref;
        record.extraction = parsed;
        record.fact = this.draft(actor, parsed, record.contextKey, record.cardinality, observed.occurredAt ?? null);
        record.reason = "explicit-revision";
        record.evidenceId = (0, import_node_crypto8.randomUUID)();
        this.facts.applyWithinTransaction(scope, "appendEvidence", { evidenceId: record.evidenceId, sourceRef: ref, text: parsed.text });
        this.db.prepare("UPDATE candidates SET revision=?,source_id=?,parent_id=?,payload=? WHERE scope_key=? AND id=?").run(record.revision, ref.sourceId, record.evidenceId, this.codec.seal("candidates", scope, record.id, { sourceRef: ref, fact: record.fact }), scope, record.id);
        this.save(scope, record);
        return { status: "candidate", candidateId: record.id, candidateRevision: record.revision };
      }
      if (kind === "correct" || kind === "forget" || kind === "confirmFact" || kind === "deny") {
        objectFields(input, ["actorKey", "generation", "kind", "nonce", "factId", "revision"], kind === "correct" ? ["sourceRef", "extraction"] : ["confirmFact", "deny"].includes(kind) ? ["sourceRef"] : []);
        const factId = parseInternalId(input.factId), revision = positiveRevision(input.revision);
        const owner = this.records(scope).find((r) => r.actorKey === actor && r.factId === factId && r.state === "active");
        if (!owner) throw new Error("MEMORY_FACT_NOT_FOUND");
        const previous = this.facts.current(scope).find((f) => f.factId === factId);
        if (!previous) throw new Error("MEMORY_FACT_NOT_FOUND");
        if (previous.revision !== revision) throw new Error("MEMORY_REVISION_CONFLICT");
        if (kind === "confirmFact" || kind === "deny") {
          const ref = this.source(scope, input.sourceRef);
          if (ref.sourceId === owner.sourceRef.sourceId) throw new Error("MEMORY_CONFIRMATION_NOT_INDEPENDENT");
          if (kind === "deny") {
            this.supports.deny(scope, actor, previous, ref, nonce);
            return { status: "pending-review", factId, factRevision: revision, reason: "explicit-denial" };
          }
          this.supports.add(scope, actor, previous, ref, "explicitUserConfirmed", { nonce, targetId: factId, targetRevision: revision, action: "confirmFact" });
          return { status: "active", factId, factRevision: revision, reason: "explicit-support" };
        }
        if (kind === "forget") {
          const ref = this.eventSource(scope, commandId, "forget", { factId });
          this.facts.applyWithinTransaction(scope, "forgetFact", { factId, expectedRevision: revision, sourceRef: ref });
          this.suppression.includeOrigins(scope, factId, this.supports.forget(scope, actor, factId));
          for (const r of this.records(scope)) {
            if (r.fact.subjectKey === owner.fact.subjectKey) {
              r.state = "invalidated";
              r.revision++;
              this.save(scope, r);
              this.db.prepare("UPDATE candidates SET state='invalidated' WHERE scope_key=? AND id=?").run(scope, r.id);
            }
          }
          return { status: "forgotten", factId, factRevision: revision };
        }
        const parsed = extraction(input.extraction);
        if (parsed.kind !== "direct" || parsed.attribute !== owner.extraction.attribute) throw new Error("MEMORY_POLICY_UNRESOLVED");
        const source = this.source(scope, input.sourceRef, parsed.text), observation = this.ledger.assertCurrent(scope, source).published;
        if (observation.role !== "user" || observation.trust !== "direct-user-event") throw new Error("MEMORY_EVENT_DENIED");
        if (this.suppression.sourceBlocked(scope, source)) throw new Error("MEMORY_POLICY_SUPPRESSED");
        const changed = this.facts.applyWithinTransaction(scope, "correctFact", { factId, expectedRevision: revision, sourceRef: source, fact: this.draft(actor, parsed, owner.contextKey, owner.cardinality, observation.occurredAt ?? null) });
        owner.fact = this.draft(actor, parsed, owner.contextKey, owner.cardinality, observation.occurredAt ?? null);
        owner.sourceRef = source;
        owner.extraction = parsed;
        owner.revision++;
        this.save(scope, owner);
        this.supports.add(scope, actor, this.facts.current(scope).find((f) => f.factId === factId), source, "explicitUserConfirmed", { nonce, targetId: factId, targetRevision: revision, action: "correct" });
        return { status: "active", factId, factRevision: changed.revision };
      }
      if (kind === "remember") {
        objectFields(input, ["actorKey", "generation", "kind", "nonce", "sourceRef", "extraction"]);
        const parsed = extraction(input.extraction);
        if (parsed.kind !== "direct") throw new Error("MEMORY_POLICY_UNRESOLVED");
        const ref = this.source(scope, input.sourceRef, parsed.text), observation = this.ledger.assertCurrent(scope, ref).published;
        if (observation.role !== "user" || observation.trust !== "direct-user-event") throw new Error("MEMORY_EVENT_DENIED");
        if (!this.suppression.subjectBlocked(scope, subject(actor, parsed.attribute)) || this.suppression.sourceBlocked(scope, ref) || this.ledger.assertCurrent(scope, ref).observedSuppressionGeneration !== gen || this.records(scope).some((r) => r.sourceRef.sourceId === ref.sourceId && r.generation < gen)) throw new Error("MEMORY_POLICY_SUPPRESSED");
        const record = this.insert(scope, actor, gen, ref, parsed, "explicit-remember");
        return this.active(scope, record, "explicitUserConfirmed", this.eventSource(scope, commandId, "remember", { candidateId: record.id }), { sourceRef: ref, proof: { nonce, targetId: record.id, targetRevision: 1, action: "remember" } });
      }
      throw new Error("MEMORY_EVENT_DENIED");
    } });
  }
};

// src/main/memory-context/context-contracts.ts
var CONTEXT_CLAIM_WINDOW_MS = 5e3;
var ContextError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ContextError";
  }
  code;
};
function contextFail(code) {
  throw new ContextError(code);
}

// src/main/memory-context/transcript-ledger.ts
var TranscriptLedger = class {
  constructor(db, key, fault) {
    this.db = db;
    this.fault = fault;
    this.codec = new RecordCodec(key);
  }
  db;
  fault;
  codec;
  save(scope, head) {
    if (!this.db.isTransaction) contextFail("MEMORY_TRANSACTION_REQUIRED");
    this.db.prepare("INSERT INTO context_records VALUES(?,?,'transcript',1,?) ON CONFLICT(id,scope_key) DO UPDATE SET revision=revision+1,payload=excluded.payload WHERE kind='transcript'").run(head.id, scope, this.codec.seal("context-transcript", scope, head.id, head));
    this.fault?.("after-record");
  }
  head(scope, owner, id) {
    const row = this.db.prepare("SELECT kind,payload FROM context_records WHERE scope_key=? AND id=?").get(scope, id);
    if (!row) return null;
    if (row.kind !== "transcript") contextFail("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
    const head = this.codec.open("context-transcript", scope, id, row.payload);
    if (head.id !== id || head.actorKey !== owner.actorKey || head.providerId !== owner.providerId || head.sessionId !== owner.sessionId) contextFail("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
    return head;
  }
  current(scope, owner, ref) {
    const head = this.head(scope, owner, ref.headId);
    if (!head) contextFail("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
    if (head.state === "pending") contextFail("MEMORY_CONTEXT_TRANSCRIPT_PENDING");
    if (head.state === "deleted") contextFail("MEMORY_CONTEXT_TRANSCRIPT_DELETED");
    if (canonicalJson(head.ref) !== canonicalJson(ref)) contextFail("MEMORY_CONTEXT_TRANSCRIPT_STALE");
    return head;
  }
  reserve(scope, owner, id, operationId, generation2, expected) {
    let head = this.head(scope, owner, id);
    if (expected) this.current(scope, owner, expected);
    if (!head) head = { ...owner, id, generation: generation2, state: "pending", operationId, ref: null, incarnation: null, contentRevision: 0, throughSeq: 0, sourceRefs: [], retired: [] };
    this.save(scope, { ...head, ...owner, state: "pending", operationId });
  }
  publish(scope, owner, id, operationId, data) {
    const head = this.head(scope, owner, id);
    if (!head || head.state !== "pending" || head.operationId !== operationId) contextFail("MEMORY_CONTEXT_TRANSCRIPT_OPERATION_CONFLICT");
    if (head.retired.includes(data.incarnation)) contextFail("MEMORY_CONTEXT_TRANSCRIPT_REUSED");
    if (head.incarnation === data.incarnation && (data.contentRevision < head.contentRevision || data.throughSeq < head.throughSeq)) contextFail("MEMORY_CONTEXT_TRANSCRIPT_STALE");
    const same = head.incarnation === data.incarnation && head.contentRevision === data.contentRevision && head.ref?.digest === data.digest;
    if (head.incarnation === data.incarnation && head.contentRevision === data.contentRevision && !same) contextFail("MEMORY_CONTEXT_TRANSCRIPT_VERSION_MISMATCH");
    const ref = { headId: id, revision: head.ref ? same ? head.ref.revision : head.ref.revision + 1 : 1, digest: data.digest };
    const retired = head.incarnation && head.incarnation !== data.incarnation ? [...head.retired, head.incarnation] : head.retired;
    if (retired.length > 1e3) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    this.save(scope, { ...head, ...owner, ...data, ref, retired, state: "ready", operationId: null });
    return ref;
  }
  remove(scope, owner, ref) {
    const head = this.current(scope, owner, ref);
    this.save(scope, { ...head, state: "deleted", retired: [.../* @__PURE__ */ new Set([...head.retired, ...head.incarnation ? [head.incarnation] : []])] });
  }
};

// src/main/memory-recall/recall-repository.ts
var import_node_crypto9 = require("node:crypto");

// src/main/memory-recall/recall-contracts.ts
function recallFail(code) {
  throw new Error(code);
}

// src/main/memory-recall/recall-decay.ts
var DAY = 864e5;
var DEFAULT_RECALL_POLICY = Object.freeze({ version: "recall-decay-v1", halfLifeMs: 30 * DAY, archiveThreshold: 0.125, minIdleMs: 90 * DAY, protectExplicitConfirmation: true, maintenanceMode: "dry-run", batchSize: 100 });
function clock(value) {
  if (!Number.isSafeInteger(value) || value < 0) recallFail("MEMORY_RECALL_TIME_INVALID");
  return value;
}
function validateRecallPolicy(value) {
  const p = objectFields(value, ["version", "halfLifeMs", "archiveThreshold", "minIdleMs", "protectExplicitConfirmation", "maintenanceMode", "batchSize"]);
  const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
  if (typeof p.version !== "string" || !/^[-a-zA-Z0-9_]{1,96}$/.test(p.version) || !integer(p.halfLifeMs, DAY, 3650 * DAY) || typeof p.archiveThreshold !== "number" || !Number.isFinite(p.archiveThreshold) || p.archiveThreshold <= 0 || p.archiveThreshold >= 1 || !integer(p.minIdleMs, 0, 36500 * DAY) || typeof p.protectExplicitConfirmation !== "boolean" || !["disabled", "dry-run", "enabled"].includes(p.maintenanceMode) || !integer(p.batchSize, 1, 200)) recallFail("MEMORY_RECALL_POLICY_INVALID");
  return Object.freeze({ version: parseInternalId(p.version), halfLifeMs: p.halfLifeMs, archiveThreshold: p.archiveThreshold, minIdleMs: p.minIdleMs, protectExplicitConfirmation: p.protectExplicitConfirmation, maintenanceMode: p.maintenanceMode, batchSize: p.batchSize });
}
function checked(value, now) {
  clock(now);
  const s = objectFields(value, ["lastAccessAt", "decayAnchorAt", "lastCalculatedAt", "strengthAtLastCalculation"]);
  const lastAccessAt = s.lastAccessAt === null ? null : clock(s.lastAccessAt), decayAnchorAt = clock(s.decayAnchorAt), lastCalculatedAt = clock(s.lastCalculatedAt), strength2 = s.strengthAtLastCalculation;
  if (typeof strength2 !== "number" || !Number.isFinite(strength2) || strength2 < 0 || strength2 > 1) recallFail("MEMORY_RECALL_STATE_INVALID");
  if (lastCalculatedAt > now || decayAnchorAt > lastCalculatedAt || lastAccessAt !== null && (lastAccessAt > lastCalculatedAt || lastAccessAt > decayAnchorAt)) recallFail("MEMORY_RECALL_CLOCK_INVALID");
  return { lastAccessAt, decayAnchorAt, lastCalculatedAt, strengthAtLastCalculation: strength2 };
}
function initializeStrength(now) {
  clock(now);
  return { lastAccessAt: null, decayAnchorAt: now, lastCalculatedAt: now, strengthAtLastCalculation: 1 };
}
function calculateStrength(value, now, policy) {
  const s = checked(value, now), p = validateRecallPolicy(policy);
  return { ...s, lastCalculatedAt: now, strengthAtLastCalculation: s.strengthAtLastCalculation * 2 ** (-(now - s.lastCalculatedAt) / p.halfLifeMs) };
}
function refreshStrength(value, now) {
  return { ...checked(value, now), decayAnchorAt: now, lastCalculatedAt: now, strengthAtLastCalculation: 1 };
}
function recordAccess(value, now) {
  return { ...refreshStrength(value, now), lastAccessAt: now };
}
function transitionPolicy(value, now, oldPolicy, newPolicy) {
  const previous = validateRecallPolicy(oldPolicy), next = validateRecallPolicy(newPolicy);
  if (previous.version === next.version && canonicalJson(previous) !== canonicalJson(next)) recallFail("MEMORY_RECALL_POLICY_CONFLICT");
  return calculateStrength(value, now, previous);
}
function isArchiveCandidate(value, now, policy, protection) {
  const s = calculateStrength(value, now, policy), p = validateRecallPolicy(policy), flags = objectFields(protection, ["pinned", "explicitConfirmation", "required"]);
  if (Object.values(flags).some((v) => typeof v !== "boolean")) recallFail("MEMORY_RECALL_STATE_INVALID");
  const protectedFact = flags.pinned || flags.required || p.protectExplicitConfirmation && flags.explicitConfirmation;
  const tolerance = 16 * Number.EPSILON * Math.max(1, p.archiveThreshold, s.strengthAtLastCalculation);
  return !protectedFact && now - s.decayAnchorAt >= p.minIdleMs && s.strengthAtLastCalculation <= p.archiveThreshold + tolerance;
}

// src/main/memory-recall/recall-repository.ts
function natural(value) {
  if (!Number.isSafeInteger(value) || value < 0) recallFail("MEMORY_RECALL_STATE_INVALID");
  return value;
}
function strength(s) {
  return { lastAccessAt: s.lastAccessAt, decayAnchorAt: s.decayAnchorAt, lastCalculatedAt: s.lastCalculatedAt, strengthAtLastCalculation: s.strengthAtLastCalculation };
}
function opaque(kind, values) {
  return "recall-" + kind + "-" + (0, import_node_crypto9.createHash)("sha256").update(canonicalJson(values)).digest("hex");
}
function refs(value) {
  if (!Array.isArray(value) || value.length > 200) recallFail("MEMORY_RECALL_INPUT_INVALID");
  const result = value.map((raw) => {
    const r = objectFields(raw, ["factId", "revision"]);
    return { factId: parseInternalId(r.factId), revision: positiveRevision(r.revision) };
  });
  if (new Set(result.map((r) => canonicalJson(r))).size !== result.length) recallFail("MEMORY_RECALL_INPUT_INVALID");
  return result;
}
function action(value) {
  if (!["archive", "restore", "pin", "unpin", "maintenance"].includes(value)) recallFail("MEMORY_RECALL_INPUT_INVALID");
  return value;
}
function parseRecallDependencies(value) {
  if (!Array.isArray(value) || value.length > 200) recallFail("MEMORY_RECALL_INPUT_INVALID");
  const result = value.map((raw) => {
    const r = objectFields(raw, ["factId", "revision", "visibilityRevision"]);
    return { factId: parseInternalId(r.factId), revision: positiveRevision(r.revision), visibilityRevision: natural(r.visibilityRevision) };
  });
  refs(result.map(({ factId, revision }) => ({ factId, revision })));
  return result;
}
function preview(value) {
  const p = objectFields(value, ["action", "generation", "policyVersion", "policyRevision", "expiresAt", "targets", "requiredFactRefs", "candidates", "mode"]);
  if (!Array.isArray(p.targets) || p.targets.length > 200 || !["disabled", "dry-run", "enabled"].includes(p.mode)) recallFail("MEMORY_RECALL_INPUT_INVALID");
  const targets = p.targets.map((raw) => {
    const r = objectFields(raw, ["factId", "revision", "projectionRevision", "visibilityRevision"]);
    return { factId: parseInternalId(r.factId), revision: positiveRevision(r.revision), projectionRevision: positiveRevision(r.projectionRevision), visibilityRevision: natural(r.visibilityRevision) };
  });
  refs(targets.map(({ factId, revision }) => ({ factId, revision })));
  return { action: action(p.action), generation: natural(p.generation), policyVersion: parseInternalId(p.policyVersion), policyRevision: positiveRevision(p.policyRevision), expiresAt: natural(p.expiresAt), targets, requiredFactRefs: refs(p.requiredFactRefs), candidates: natural(p.candidates), mode: p.mode };
}
var RecallRepository = class {
  constructor(db, key, clock2 = Date.now, fault) {
    this.db = db;
    this.key = key;
    this.clock = clock2;
    this.fault = fault;
    this.codec = new RecordCodec(key);
    this.facts = new PolicyRepository(db, key);
    this.supports = new FactSupports(db, key);
    this.suppression = new Suppression(db, key);
  }
  db;
  key;
  clock;
  fault;
  codec;
  facts;
  supports;
  suppression;
  transaction() {
    if (!this.db.isTransaction) recallFail("MEMORY_TRANSACTION_REQUIRED");
  }
  now() {
    return natural(this.clock());
  }
  read(scope, id, kind, actor) {
    this.transaction();
    const row = this.db.prepare("SELECT kind,revision,payload FROM recall_records WHERE scope_key=? AND id=?").get(scope, id);
    if (!row) return;
    if (row.kind !== kind) recallFail("MEMORY_DATA_INVALID");
    const record = this.codec.open("recall-" + kind, scope, id, row.payload);
    if (record.id !== id || record.actorKey !== actor) recallFail("MEMORY_DATA_INVALID");
    if (kind === "state" && record.projectionRevision !== row.revision) recallFail("MEMORY_DATA_INVALID");
    if ((kind === "policy" || kind === "use") && record.revision !== row.revision) recallFail("MEMORY_DATA_INVALID");
    return record;
  }
  save(scope, kind, r) {
    this.transaction();
    const revision = "projectionRevision" in r ? r.projectionRevision : r.revision;
    this.db.prepare("INSERT INTO recall_records VALUES(?,?,?,?,?) ON CONFLICT(id,scope_key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload WHERE kind=excluded.kind").run(r.id, scope, kind, revision, this.codec.seal("recall-" + kind, scope, r.id, r));
    this.fault?.("after-record");
  }
  policy(scope, actor, now) {
    const id = opaque("policy", actor), r = this.read(scope, id, "policy", actor);
    if (r) {
      objectFields(r, ["id", "actorKey", "revision", "configuredAt", "policy"]);
      positiveRevision(r.revision);
      if (natural(r.configuredAt) > now) recallFail("MEMORY_RECALL_CLOCK_INVALID");
      return { ...r, policy: validateRecallPolicy(r.policy) };
    }
    const initial = { id, actorKey: actor, revision: 1, configuredAt: now, policy: { ...DEFAULT_RECALL_POLICY } };
    this.save(scope, "policy", initial);
    return initial;
  }
  checkedState(r, now, policy) {
    objectFields(r, ["id", "actorKey", "factId", "factRevision", "projectionRevision", "visibilityRevision", "visibility", "pinned", "policyVersion", "archivedAt", "archiveReason", "accessCount", "lastAccessAt", "decayAnchorAt", "lastCalculatedAt", "strengthAtLastCalculation"]);
    if (r.id !== opaque("state", { actor: r.actorKey, factId: r.factId, revision: r.factRevision })) recallFail("MEMORY_DATA_INVALID");
    parseInternalId(r.factId);
    positiveRevision(r.factRevision);
    positiveRevision(r.projectionRevision);
    natural(r.visibilityRevision);
    natural(r.accessCount);
    if (!["normal", "archived"].includes(r.visibility) || typeof r.pinned !== "boolean" || r.policyVersion !== policy.version || r.visibility === "normal" !== (r.archivedAt === null && r.archiveReason === null)) recallFail("MEMORY_DATA_INVALID");
    if (r.visibility === "archived" && (!["manual", "decay"].includes(r.archiveReason) || r.archivedAt === null || natural(r.archivedAt) > now)) recallFail("MEMORY_DATA_INVALID");
    calculateStrength(strength(r), now, policy);
    return r;
  }
  state(scope, actor, fact, policy, now) {
    const id = opaque("state", { actor, factId: fact.factId, revision: fact.revision }), old = this.read(scope, id, "state", actor);
    if (old) {
      this.checkedState(old, now, policy);
      if (old.factId !== fact.factId || old.factRevision !== fact.revision) recallFail("MEMORY_DATA_INVALID");
      if (old.lastCalculatedAt === now) return old;
      const next = { ...old, ...calculateStrength(strength(old), now, policy), projectionRevision: old.projectionRevision + 1 };
      this.save(scope, "state", next);
      return next;
    }
    const initial = { id, actorKey: actor, factId: fact.factId, factRevision: fact.revision, projectionRevision: 1, visibilityRevision: 0, visibility: "normal", pinned: false, policyVersion: policy.version, archivedAt: null, archiveReason: null, accessCount: 0, ...initializeStrength(now) };
    this.save(scope, "state", initial);
    return initial;
  }
  protection(scope, actor, fact, state) {
    const audit = this.supports.audit(scope, actor, fact.factId, fact), pending = this.db.prepare("SELECT id,payload FROM recall_records WHERE scope_key=? AND kind='use'").all(scope).some((row) => {
      const r = this.codec.open("recall-use", scope, row.id, row.payload);
      return r.actorKey === actor && r.state === "pending" && r.dependencies.some((d) => d.factId === fact.factId && d.revision === fact.revision);
    });
    return { pinned: state.pinned, required: pending, explicitConfirmation: audit.status === "eligible" && audit.supports.some((s) => s.factRevision === fact.revision && s.validity === "valid" && s.kind === "explicitUserConfirmed" && s.proof !== null) };
  }
  visibleFactsWithinTransaction(scope, actor, factRefs2, expected) {
    this.transaction();
    const selected = refs(factRefs2), deps = expected === void 0 ? void 0 : parseRecallDependencies(expected), now = this.now(), policy = this.policy(scope, actor, now).policy, available = this.facts.eligibleFactsWithinTransaction(scope, actor);
    if (deps && canonicalJson(deps.map(({ factId, revision }) => ({ factId, revision }))) !== canonicalJson(selected)) recallFail("MEMORY_RECALL_VISIBILITY_STALE");
    const facts = selected.map((ref) => {
      const f = available.find((f2) => f2.factId === ref.factId && f2.revision === ref.revision);
      if (!f) recallFail("MEMORY_RECALL_FACT_UNAVAILABLE");
      return f;
    });
    const recallDeps = facts.map((fact, index) => {
      const state = this.state(scope, actor, fact, policy, now);
      if (state.visibility !== "normal") recallFail("MEMORY_RECALL_FACT_ARCHIVED");
      if (deps && deps[index].visibilityRevision !== state.visibilityRevision) recallFail("MEMORY_RECALL_VISIBILITY_STALE");
      return { factId: fact.factId, revision: fact.revision, visibilityRevision: state.visibilityRevision };
    });
    return { facts, recallDeps };
  }
  use(scope, owner, id) {
    const r = this.read(scope, parseInternalId(id), "use", owner.actorKey);
    if (!r) recallFail("MEMORY_RECALL_USE_DENIED");
    objectFields(r, ["id", "actorKey", "providerId", "sessionId", "bootId", "revision", "state", "createdAt", "invokedAt", "dependencies", "recorded"]);
    for (const k of ["actorKey", "providerId", "sessionId", "bootId"]) if (r[k] !== owner[k]) recallFail("MEMORY_RECALL_USE_DENIED");
    positiveRevision(r.revision);
    if (!["pending", "invoked", "unknown"].includes(r.state) || natural(r.createdAt) > this.now()) recallFail("MEMORY_DATA_INVALID");
    parseRecallDependencies(r.dependencies);
    if (natural(r.recorded) > r.dependencies.length || r.state === "invoked" !== (r.invokedAt !== null) || r.state !== "invoked" && r.recorded !== 0) recallFail("MEMORY_DATA_INVALID");
    if (r.invokedAt !== null && (natural(r.invokedAt) < r.createdAt || r.invokedAt > this.now())) recallFail("MEMORY_RECALL_CLOCK_INVALID");
    return r;
  }
  prepareUseWithinTransaction(scope, owner, id, dependencies) {
    this.transaction();
    for (const k of ["actorKey", "providerId", "sessionId", "bootId"]) parseInternalId(owner[k]);
    parseInternalId(id);
    if (this.db.prepare("SELECT id FROM recall_records WHERE scope_key=? AND id=?").get(scope, id)) recallFail("MEMORY_RECALL_USE_DENIED");
    const deps = parseRecallDependencies(dependencies);
    this.visibleFactsWithinTransaction(scope, owner.actorKey, deps.map(({ factId, revision }) => ({ factId, revision })), deps);
    this.save(scope, "use", { ...owner, id, revision: 1, state: "pending", createdAt: this.now(), invokedAt: null, dependencies: deps, recorded: 0 });
  }
  confirmUseWithinTransaction(scope, owner, id, invokedAt) {
    this.transaction();
    const ticket = this.use(scope, owner, id), now = this.now();
    if (ticket.state === "unknown") recallFail("MEMORY_RECALL_USE_UNKNOWN");
    if (ticket.state === "invoked") return { useStatus: "invoked", recorded: ticket.recorded };
    if (natural(invokedAt) < ticket.createdAt || invokedAt > now) recallFail("MEMORY_RECALL_CLOCK_INVALID");
    const policy = this.policy(scope, owner.actorKey, now).policy, available = this.facts.eligibleFactsWithinTransaction(scope, owner.actorKey);
    let recorded = 0;
    for (const dep of ticket.dependencies) {
      const fact = available.find((f) => f.factId === dep.factId && f.revision === dep.revision);
      if (!fact) continue;
      const state = this.state(scope, owner.actorKey, fact, policy, now);
      if (state.visibility !== "normal" || state.visibilityRevision !== dep.visibilityRevision) continue;
      if (state.lastAccessAt !== null && invokedAt < state.lastAccessAt) recallFail("MEMORY_RECALL_CLOCK_INVALID");
      const observed = calculateStrength(recordAccess(initializeStrength(invokedAt), invokedAt), now, policy);
      this.save(scope, "state", { ...state, ...observed, projectionRevision: state.projectionRevision + 1, accessCount: state.accessCount + 1 });
      recorded++;
    }
    this.save(scope, "use", { ...ticket, state: "invoked", invokedAt, recorded, revision: ticket.revision + 1 });
    return { useStatus: "invoked", recorded };
  }
  unknownUseWithinTransaction(scope, owner, id) {
    this.transaction();
    const ticket = this.use(scope, owner, id);
    if (ticket.state === "invoked") return { useStatus: "invoked" };
    if (ticket.state === "pending") this.save(scope, "use", { ...ticket, state: "unknown", revision: ticket.revision + 1 });
    return { useStatus: "unknown" };
  }
  execute(value) {
    const c = objectFields(value, ["kind", "scopeKey", "body"], ["commandId"]), scope = parseInternalId(c.scopeKey), identity = ["actorKey", "providerId", "sessionId", "bootId"];
    const b = objectFields(c.body, identity, ["factRefs", "policy", "action", "preview", "requiredFactRefs"]), actor = parseInternalId(b.actorKey);
    for (const k of identity) parseInternalId(b[k]);
    if (!["rank", "metadata", "configure", "preview", "maintenancePreview", "commit", "recover"].includes(c.kind)) recallFail("MEMORY_RECALL_INPUT_INVALID");
    const fields = { rank: [], metadata: ["factRefs"], configure: ["policy"], preview: ["factRefs", "action"], maintenancePreview: ["requiredFactRefs"], commit: ["preview"], recover: [] };
    objectFields(b, [...identity, ...fields[c.kind]]);
    const mutation = ["configure", "commit", "recover"].includes(c.kind);
    if (!mutation && c.commandId !== void 0) recallFail("MEMORY_RECALL_INPUT_INVALID");
    const apply = () => {
      const now = this.now(), stored = this.policy(scope, actor, now), policy = stored.policy;
      if (c.kind === "recover") {
        let unknown = 0;
        for (const row of this.db.prepare("SELECT id,payload FROM recall_records WHERE scope_key=? AND kind='use'").all(scope)) {
          const r = this.codec.open("recall-use", scope, row.id, row.payload);
          if (r.actorKey === actor && r.bootId !== b.bootId && r.state === "pending") {
            this.use(scope, r, r.id);
            this.save(scope, "use", { ...r, state: "unknown", revision: r.revision + 1 });
            unknown++;
          }
        }
        return { unknown };
      }
      if (c.kind === "configure") {
        const next = validateRecallPolicy(b.policy);
        if (policy.version === next.version && canonicalJson(policy) !== canonicalJson(next)) recallFail("MEMORY_RECALL_POLICY_CONFLICT");
        for (const row of this.db.prepare("SELECT id,payload FROM recall_records WHERE scope_key=? AND kind='state' ORDER BY id").all(scope)) {
          const state = this.codec.open("recall-state", scope, row.id, row.payload);
          if (state.actorKey !== actor) continue;
          const r = this.read(scope, row.id, "state", actor);
          this.checkedState(r, now, policy);
          this.save(scope, "state", { ...r, ...transitionPolicy(strength(r), now, policy, next), policyVersion: next.version, projectionRevision: r.projectionRevision + 1 });
        }
        this.save(scope, "policy", { ...stored, revision: stored.revision + 1, configuredAt: now, policy: { ...next } });
        return { policyVersion: next.version };
      }
      const available = this.facts.eligibleFactsWithinTransaction(scope, actor), generation2 = this.suppression.generation(scope);
      if (c.kind === "preview" || c.kind === "maintenancePreview") {
        const kind = c.kind === "maintenancePreview" ? "maintenance" : action(b.action);
        if (c.kind === "preview" && kind === "maintenance") recallFail("MEMORY_RECALL_INPUT_INVALID");
        const requiredFactRefs = c.kind === "maintenancePreview" ? refs(b.requiredFactRefs) : [], selected = c.kind === "maintenancePreview" ? available.map((f) => ({ factId: f.factId, revision: f.revision })) : refs(b.factRefs);
        for (const r of requiredFactRefs) if (!available.some((f) => f.factId === r.factId && f.revision === r.revision)) recallFail("MEMORY_RECALL_FACT_UNAVAILABLE");
        const states = selected.map((ref) => {
          const fact = available.find((f) => f.factId === ref.factId && f.revision === ref.revision);
          if (!fact) recallFail("MEMORY_RECALL_FACT_UNAVAILABLE");
          const state = this.state(scope, actor, ref, policy, now);
          if (kind !== "maintenance") return state;
          const existing = this.protection(scope, actor, fact, state), protection = { ...existing, required: existing.required || requiredFactRefs.some((r) => r.factId === ref.factId && r.revision === ref.revision) };
          return state.visibility === "normal" && isArchiveCandidate(strength(state), now, policy, protection) ? state : null;
        }).filter((s) => s !== null);
        const targets = (kind === "maintenance" ? states.slice(0, policy.batchSize) : states).map((s) => ({ factId: s.factId, revision: s.factRevision, projectionRevision: s.projectionRevision, visibilityRevision: s.visibilityRevision }));
        return { action: kind, generation: generation2, policyVersion: policy.version, policyRevision: stored.revision, expiresAt: now + 6e4, targets, requiredFactRefs, candidates: states.length, mode: policy.maintenanceMode };
      }
      if (c.kind === "commit") {
        const p = preview(b.preview);
        if (p.generation !== generation2 || p.policyVersion !== policy.version || p.policyRevision !== stored.revision) recallFail("MEMORY_RECALL_STALE");
        if (now >= p.expiresAt) recallFail("MEMORY_RECALL_PREVIEW_EXPIRED");
        if (p.expiresAt > now + 6e4) recallFail("MEMORY_RECALL_CLOCK_INVALID");
        if (p.action === "maintenance" && (policy.maintenanceMode !== "enabled" || p.mode !== "enabled" || p.targets.length > policy.batchSize)) recallFail("MEMORY_RECALL_MAINTENANCE_DENIED");
        let changed = 0;
        for (const target of p.targets) {
          const fact = available.find((f) => f.factId === target.factId && f.revision === target.revision);
          if (!fact) recallFail("MEMORY_RECALL_FACT_UNAVAILABLE");
          const id = opaque("state", { actor, factId: target.factId, revision: target.revision }), old = this.read(scope, id, "state", actor);
          if (!old) recallFail("MEMORY_RECALL_STALE");
          this.checkedState(old, now, policy);
          if (old.projectionRevision !== target.projectionRevision || old.visibilityRevision !== target.visibilityRevision) recallFail("MEMORY_RECALL_STALE");
          if (p.action === "maintenance") {
            const existing = this.protection(scope, actor, fact, old), protection = { ...existing, required: existing.required || p.requiredFactRefs.some((r) => r.factId === fact.factId && r.revision === fact.revision) };
            if (old.visibility !== "normal" || !isArchiveCandidate(strength(old), now, policy, protection)) recallFail("MEMORY_RECALL_STALE");
          }
          let next = { ...old, ...calculateStrength(strength(old), now, policy) };
          const archive = p.action === "archive" || p.action === "maintenance";
          if (archive && old.visibility === "normal") next = { ...next, visibility: "archived", visibilityRevision: old.visibilityRevision + 1, archivedAt: now, archiveReason: p.action === "maintenance" ? "decay" : "manual" };
          else if (p.action === "restore" && old.visibility === "archived") next = { ...next, ...refreshStrength(strength(old), now), visibility: "normal", visibilityRevision: old.visibilityRevision + 1, archivedAt: null, archiveReason: null };
          else if (p.action === "pin" || p.action === "unpin") next = { ...next, pinned: p.action === "pin" };
          if (canonicalJson(next) !== canonicalJson(old)) {
            next.projectionRevision++;
            this.save(scope, "state", next);
            changed++;
          }
        }
        return { changed };
      }
      if (c.kind === "metadata") {
        const targets = refs(b.factRefs).map((ref) => {
          if (!available.some((f) => f.factId === ref.factId && f.revision === ref.revision)) recallFail("MEMORY_RECALL_FACT_UNAVAILABLE");
          return this.state(scope, actor, ref, policy, now);
        });
        return { generation: generation2, policy, targets };
      }
      const items = available.map((fact) => {
        const state = this.state(scope, actor, fact, policy, now);
        return { fact, state, protection: this.protection(scope, actor, fact, state), score: state.strengthAtLastCalculation };
      }).filter((item) => item.state.visibility === "normal");
      items.sort((a, b2) => b2.score - a.score || a.fact.factId.localeCompare(b2.fact.factId));
      return { generation: generation2, policy, items };
    };
    if (mutation) return executeTransaction({ db: this.db, key: this.key, scope, commandId: parseInternalId(c.commandId), request: c, fault: this.fault, apply });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = apply();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
};

// src/main/memory-context/context-repository.ts
function natural2(value) {
  if (!Number.isSafeInteger(value) || value < 0) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  return value;
}
function list(value, max = 1e3) {
  if (!Array.isArray(value) || value.length > max) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  return value;
}
function bound(value) {
  const ref = parseSourceRef(value);
  if (!ref.binding || ref.span) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  return ref;
}
function parseSourceDependencies(value) {
  return list(value).map((raw) => {
    const d = objectFields(raw, ["sourceRef", "subjectKeys", "derivedRefs"], ["excludeReason"]), sourceRef = bound(d.sourceRef);
    const subjectKeys = d.subjectKeys === null ? null : list(d.subjectKeys, 64).map((s) => {
      if (typeof s !== "string" || !/^actor-attribute-[a-f0-9]{64}$/.test(s)) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
      return s;
    });
    const derivedRefs = d.derivedRefs === null ? null : list(d.derivedRefs, 64).map(bound);
    if (d.excludeReason !== void 0 && d.excludeReason !== "secret") contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    return { sourceRef, subjectKeys, derivedRefs, ...d.excludeReason ? { excludeReason: "secret" } : {} };
  });
}
function factRefs(value) {
  return list(value, 200).map((raw) => {
    const d = objectFields(raw, ["factId", "revision"]);
    return { factId: parseInternalId(d.factId), revision: positiveRevision(d.revision) };
  });
}
function transcripts(value) {
  return list(value).map((raw) => {
    const d = objectFields(raw, ["headId", "revision", "digest"]);
    if (typeof d.digest !== "string" || !/^[a-f0-9]{64}$/.test(d.digest)) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    return { headId: parseInternalId(d.headId), revision: positiveRevision(d.revision), digest: d.digest };
  });
}
function counterIdentity(value) {
  const c = objectFields(value, ["providerId", "model", "transport", "framingVersion", "mode", "inputTypes"]);
  if (c.mode !== "exact") contextFail("MEMORY_CONTEXT_BUDGET_UNPROVEN");
  const text = (value2) => {
    if (typeof value2 !== "string" || !value2 || value2.length > 1024) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    return value2;
  };
  return { providerId: text(c.providerId), model: text(c.model), transport: text(c.transport), framingVersion: text(c.framingVersion), mode: "exact", inputTypes: list(c.inputTypes, 64).map(text) };
}
var ContextRepository = class {
  constructor(db, key, fault, clock2 = Date.now) {
    this.db = db;
    this.key = key;
    this.fault = fault;
    this.clock = clock2;
    this.codec = new RecordCodec(key);
    this.ledger = new SourceLedger(db, key);
    this.suppression = new Suppression(db, key);
    this.policy = new PolicyRepository(db, key);
    this.transcript = new TranscriptLedger(db, key, fault);
  }
  db;
  key;
  fault;
  clock;
  codec;
  ledger;
  suppression;
  policy;
  transcript;
  owner(body) {
    return { actorKey: parseInternalId(body.actorKey), providerId: parseInternalId(body.providerId), sessionId: parseInternalId(body.sessionId), bootId: parseInternalId(body.bootId) };
  }
  sameOwner(a, b, boot = true) {
    if (a.actorKey !== b.actorKey || a.providerId !== b.providerId || a.sessionId !== b.sessionId || boot && a.bootId !== b.bootId) contextFail("MEMORY_CONTEXT_ACCESS_DENIED");
  }
  read(scope, id, kind, owner, boot = true) {
    const row = this.db.prepare("SELECT id,kind,payload FROM context_records WHERE scope_key=? AND id=?").get(scope, id);
    if (!row || row.kind !== kind) contextFail("MEMORY_CONTEXT_RECORD_DENIED");
    const record = this.codec.open("context-" + kind, scope, id, row.payload);
    if (record.id !== id) contextFail("MEMORY_DATA_INVALID");
    this.sameOwner(record, owner, boot);
    return record;
  }
  save(scope, kind, record) {
    this.db.prepare("INSERT INTO context_records VALUES(?,?,?,1,?) ON CONFLICT(id,scope_key) DO UPDATE SET revision=revision+1,payload=excluded.payload WHERE kind=excluded.kind").run(record.id, scope, kind, this.codec.seal("context-" + kind, scope, record.id, record));
    this.fault?.("after-record");
  }
  assertGeneration(scope, value) {
    const g = natural2(value);
    if (g !== this.suppression.generation(scope)) contextFail("MEMORY_CONTEXT_STALE");
    return g;
  }
  assertSource(scope, owner, ref) {
    if (ref.binding.providerId !== owner.providerId || ref.binding.sessionId !== owner.sessionId) contextFail("MEMORY_CONTEXT_ACCESS_DENIED");
    const head = this.ledger.assertCurrent(scope, ref);
    if (!head?.published) contextFail("MEMORY_SOURCE_INVALID");
    return head;
  }
  sourceState(scope, owner, dep, deps, seen = /* @__PURE__ */ new Set()) {
    const head = this.assertSource(scope, owner, dep.sourceRef), id = dep.sourceRef.sourceId;
    if (seen.has(id)) return "untraceable-derived";
    seen = /* @__PURE__ */ new Set([...seen, id]);
    if (dep.excludeReason) return dep.excludeReason;
    if (this.suppression.sourceBlocked(scope, dep.sourceRef)) return "suppressed-source";
    const gen = this.suppression.generation(scope), old = (head.firstObservedSuppressionGeneration ?? 0) < gen;
    if (head.published.role !== "user" || head.published.trust !== "direct-user-event") {
      if (gen === 0) return "allowed";
      if (!dep.derivedRefs?.length) return "untraceable-derived";
      return dep.derivedRefs.every((ref) => {
        const origin = deps.find((d) => canonicalJson(d.sourceRef) === canonicalJson(ref));
        return origin && this.sourceState(scope, owner, origin, deps, seen) === "allowed";
      }) ? "allowed" : "untraceable-derived";
    }
    if (!old) return "allowed";
    if (!dep.subjectKeys?.length) return "untraceable-source";
    return dep.subjectKeys.some((subject2) => this.suppression.subjectBlocked(scope, subject2)) ? "suppressed-subject" : "allowed";
  }
  checkedFacts(scope, owner, refs2, expected) {
    const available = this.policy.eligibleFactsWithinTransaction(scope, owner.actorKey);
    for (const ref of refs2) if (!available.some((f) => f.factId === ref.factId && f.revision === ref.revision)) contextFail("MEMORY_CONTEXT_FACT_STALE");
    return new RecallRepository(this.db, this.key, this.clock, this.fault).visibleFactsWithinTransaction(scope, owner.actorKey, refs2, expected);
  }
  transcriptState(scope, owner, ref, deps) {
    const head = this.transcript.current(scope, owner, ref);
    for (const sourceRef of head.sourceRefs) this.assertSource(scope, owner, sourceRef);
    if (head.sourceRefs.some((ref2) => {
      const dep = deps.find((d) => canonicalJson(d.sourceRef) === canonicalJson(ref2));
      return !dep || this.sourceState(scope, owner, dep, deps) !== "allowed";
    })) return "unavailable-root";
    if (this.suppression.generation(scope) === 0) return "allowed";
    if (!head.sourceRefs.length) return "untraceable-derived";
    return head.sourceRefs.every((ref2) => {
      const dep = deps.find((d) => canonicalJson(d.sourceRef) === canonicalJson(ref2));
      return dep && this.sourceState(scope, owner, dep, deps) === "allowed";
    }) ? "allowed" : "untraceable-derived";
  }
  checkSnapshot(scope, owner, snapshot) {
    this.sameOwner(snapshot, owner);
    this.assertGeneration(scope, snapshot.generation);
    for (const dep of snapshot.sourceDeps) {
      const status = this.sourceState(scope, owner, dep, snapshot.sourceDeps);
      if (snapshot.requiredSources.includes(dep.sourceRef.sourceId) && status !== "allowed") contextFail("MEMORY_CONTEXT_SOURCE_UNAVAILABLE");
    }
    this.checkedFacts(scope, owner, snapshot.factRefs, parseRecallDependencies(snapshot.recallDeps ?? []));
    for (const ref of snapshot.transcriptRefs) {
      const status = this.transcriptState(scope, owner, ref, snapshot.sourceDeps);
      if (snapshot.requiredTranscripts.includes(ref.headId) && status !== "allowed") contextFail("MEMORY_CONTEXT_SOURCE_UNAVAILABLE");
    }
    for (const id of snapshot.requiredSummaries) this.checkSummary(scope, owner, this.read(scope, id, "summary", owner, false));
  }
  checkSummary(scope, owner, summary) {
    for (const dep of summary.sourceDeps) if (this.sourceState(scope, owner, dep, summary.sourceDeps) !== "allowed") contextFail("MEMORY_CONTEXT_SOURCE_UNAVAILABLE");
  }
  checkLease(scope, owner, lease) {
    this.assertGeneration(scope, lease.generation);
    if (this.clock() >= lease.expiresAt) contextFail("MEMORY_CONTEXT_LEASE_EXPIRED");
    this.checkSummary(scope, owner, lease);
  }
  execute(value) {
    const command = objectFields(value, ["kind", "scopeKey", "body"], ["commandId"]), scope = parseInternalId(command.scopeKey);
    const body = objectFields(command.body, ["actorKey", "providerId", "sessionId", "bootId"], ["sourceRefs", "sourceDeps", "factRefs", "generation", "snapshotId", "permitId", "requestDigest", "promptTokens", "inputLimit", "requiredSources", "transcriptRefs", "requiredTranscripts", "headId", "operationId", "expectedRef", "incarnation", "contentRevision", "throughSeq", "digest", "counterIdentity", "requiredSummaries", "leaseId", "leaseMs", "inputRefs", "summaryId", "intent", "segments", "beforeTokens", "afterTokens", "summaryLimit", "recallDeps", "useTicketId", "processBootId", "invokedAt", "attemptAt"]), owner = this.owner(body);
    const identity = ["actorKey", "providerId", "sessionId", "bootId"];
    const apply = () => {
      if (command.kind === "summaryGet") {
        objectFields(body, [...identity, "summaryId"]);
        const summary = this.read(scope, parseInternalId(body.summaryId), "summary", owner, false);
        try {
          this.checkSummary(scope, owner, summary);
        } catch (error) {
          if (error instanceof Error && ["MEMORY_SOURCE_PENDING", "MEMORY_SOURCE_STALE", "MEMORY_SOURCE_DELETED", "MEMORY_SOURCE_INVALID", "MEMORY_CONTEXT_SOURCE_UNAVAILABLE"].includes(error.message)) return { available: false, reason: error.message };
          throw error;
        }
        return { available: true, summary };
      }
      if (command.kind === "summaryLease") {
        objectFields(body, [...identity, "leaseId", "generation", "sourceDeps", "inputRefs", "leaseMs"]);
        const duration = natural2(body.leaseMs);
        if (duration < 1 || duration > 3e5) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
        const inputRefs = list(body.inputRefs).map(bound), sourceDeps = parseSourceDependencies(body.sourceDeps);
        if (!inputRefs.length || new Set(inputRefs.map((r) => r.sourceId)).size !== inputRefs.length || inputRefs.some((r) => !sourceDeps.some((d) => canonicalJson(r) === canonicalJson(d.sourceRef)))) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
        const lease = { ...owner, id: parseInternalId(body.leaseId), generation: this.assertGeneration(scope, body.generation), sourceDeps, inputRefs, expiresAt: this.clock() + duration };
        this.checkLease(scope, owner, lease);
        this.save(scope, "summary-lease", lease);
        return { leaseId: lease.id };
      }
      if (command.kind === "summaryLeaseState" || command.kind === "summaryCommit") {
        objectFields(body, [...identity, "leaseId", "intent"], command.kind === "summaryCommit" ? ["summaryId", "segments", "beforeTokens", "afterTokens", "summaryLimit"] : []);
        if (typeof body.intent !== "string" || !/^[a-f0-9]{64}$/.test(body.intent)) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
        const lease = this.read(scope, parseInternalId(body.leaseId), "summary-lease", owner);
        if (lease.completed) {
          if (lease.completed.intent !== body.intent) contextFail("MEMORY_CONTEXT_LEASE_USED");
          return { receipt: lease.completed.receipt };
        }
        this.checkLease(scope, owner, lease);
        if (command.kind === "summaryLeaseState") return { ready: true };
        let previous = -1;
        const segments = list(body.segments).map((raw) => {
          const segment = objectFields(raw, ["sourceRef", "span", "role"]), sourceRef = bound(segment.sourceRef), span = objectFields(segment.span, ["start", "end"]), start = natural2(span.start), end = natural2(span.end);
          const index = lease.inputRefs.findIndex((r) => canonicalJson(r) === canonicalJson(sourceRef));
          if (index <= previous || index < 0) contextFail("MEMORY_CONTEXT_SUMMARY_ORDER_INVALID");
          previous = index;
          const head = this.assertSource(scope, owner, sourceRef);
          if (segment.role !== head.published.role || start !== 0 || end < 1) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
          return { sourceRef, span: { start, end }, role: segment.role };
        });
        const before = natural2(body.beforeTokens), after = natural2(body.afterTokens), limit = natural2(body.summaryLimit), id = parseInternalId(body.summaryId);
        const receipt = segments.length && after < before && after <= limit ? { status: "committed", summaryId: id } : { status: "no-benefit", summaryId: null };
        if (receipt.status === "committed") this.save(scope, "summary", { ...owner, id, generation: lease.generation, sourceDeps: lease.sourceDeps, inputRefs: lease.inputRefs, segments });
        lease.completed = { intent: body.intent, receipt };
        this.save(scope, "summary-lease", lease);
        return { receipt };
      }
      if (command.kind === "confirmUse" || command.kind === "useUnknown") {
        objectFields(body, [...identity, "useTicketId", "processBootId", ...command.kind === "confirmUse" ? ["invokedAt"] : []]);
        const useOwner = { ...owner, bootId: parseInternalId(body.processBootId) }, recall = new RecallRepository(this.db, this.key, this.clock, this.fault), id = parseInternalId(body.useTicketId);
        return command.kind === "confirmUse" ? recall.confirmUseWithinTransaction(scope, useOwner, id, natural2(body.invokedAt)) : recall.unknownUseWithinTransaction(scope, useOwner, id);
      }
      if (command.kind === "validateSnapshot") {
        objectFields(body, [...identity, "snapshotId"]);
        const snapshot = this.read(scope, parseInternalId(body.snapshotId), "snapshot", owner);
        this.checkSnapshot(scope, owner, snapshot);
        if (snapshot.state !== "ready") contextFail("MEMORY_CONTEXT_PERMIT_USED");
        return { valid: true };
      }
      if (command.kind === "transcriptReserve") {
        objectFields(body, [...identity, "generation", "headId", "operationId", "expectedRef"]);
        const g = this.assertGeneration(scope, body.generation);
        this.transcript.reserve(scope, owner, parseInternalId(body.headId), parseInternalId(body.operationId), g, body.expectedRef === null ? null : transcripts([body.expectedRef])[0]);
        return { reserved: true };
      }
      if (command.kind === "transcriptPublish") {
        objectFields(body, [...identity, "generation", "headId", "operationId", "incarnation", "contentRevision", "throughSeq", "digest", "sourceRefs"]);
        this.assertGeneration(scope, body.generation);
        if (typeof body.digest !== "string" || !/^[a-f0-9]{64}$/.test(body.digest)) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
        const refs2 = list(body.sourceRefs).map(bound);
        for (const ref of refs2) this.assertSource(scope, owner, ref);
        return this.transcript.publish(scope, owner, parseInternalId(body.headId), parseInternalId(body.operationId), { incarnation: parseInternalId(body.incarnation), contentRevision: positiveRevision(body.contentRevision), throughSeq: natural2(body.throughSeq), digest: body.digest, sourceRefs: refs2 });
      }
      if (command.kind === "transcriptDelete") {
        objectFields(body, [...identity, "generation", "expectedRef"]);
        this.assertGeneration(scope, body.generation);
        this.transcript.remove(scope, owner, transcripts([body.expectedRef])[0]);
        return { deleted: true };
      }
      if (command.kind === "baseline") {
        objectFields(body, [...identity, "sourceRefs", "factRefs"], ["transcriptRefs"]);
        for (const ref of list(body.sourceRefs).map(bound)) this.assertSource(scope, owner, ref);
        for (const ref of transcripts(body.transcriptRefs ?? [])) this.transcript.current(scope, owner, ref);
        return { generation: this.suppression.generation(scope), ...this.checkedFacts(scope, owner, factRefs(body.factRefs)) };
      }
      if (command.kind === "inspect") {
        objectFields(body, [...identity, "generation", "sourceDeps", "factRefs"], ["transcriptRefs", "recallDeps"]);
        this.assertGeneration(scope, body.generation);
        const deps = parseSourceDependencies(body.sourceDeps);
        return { generation: body.generation, sourceStates: [...deps.map((dep) => ({ sourceId: dep.sourceRef.sourceId, reason: this.sourceState(scope, owner, dep, deps) })), ...transcripts(body.transcriptRefs ?? []).map((ref) => ({ sourceId: ref.headId, reason: this.transcriptState(scope, owner, ref, deps) }))], ...this.checkedFacts(scope, owner, factRefs(body.factRefs), parseRecallDependencies(body.recallDeps ?? [])) };
      }
      if (command.kind === "snapshot") {
        objectFields(body, [...identity, "generation", "sourceDeps", "factRefs", "snapshotId", "requiredSources", "requestDigest", "promptTokens", "inputLimit", "counterIdentity"], ["transcriptRefs", "requiredTranscripts", "requiredSummaries", "recallDeps"]);
        if (typeof body.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.requestDigest)) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
        const record = {
          ...owner,
          id: parseInternalId(body.snapshotId),
          generation: natural2(body.generation),
          sourceDeps: parseSourceDependencies(body.sourceDeps),
          factRefs: factRefs(body.factRefs),
          recallDeps: parseRecallDependencies(body.recallDeps ?? []),
          requiredSources: list(body.requiredSources).map(parseInternalId),
          transcriptRefs: transcripts(body.transcriptRefs ?? []),
          requiredTranscripts: list(body.requiredTranscripts ?? []).map(parseInternalId),
          requiredSummaries: list(body.requiredSummaries ?? []).map(parseInternalId),
          counterIdentity: counterIdentity(body.counterIdentity),
          requestDigest: body.requestDigest,
          promptTokens: natural2(body.promptTokens),
          inputLimit: natural2(body.inputLimit),
          state: "ready"
        };
        if (record.promptTokens > record.inputLimit) contextFail("MEMORY_CONTEXT_OVER_BUDGET");
        if (record.requiredSources.some((id) => !record.sourceDeps.some((d) => d.sourceRef.sourceId === id))) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
        if (record.requiredTranscripts.some((id) => !record.transcriptRefs.some((r) => r.headId === id))) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
        this.checkSnapshot(scope, owner, record);
        this.save(scope, "snapshot", record);
        return { snapshotId: record.id, generation: record.generation };
      }
      if (command.kind === "permit" || command.kind === "claim") {
        objectFields(body, [...identity, "snapshotId", "permitId", "requestDigest", ...command.kind === "claim" ? ["useTicketId", "processBootId", "attemptAt"] : []]);
        const snapshot = this.read(scope, parseInternalId(body.snapshotId), "snapshot", owner);
        this.checkSnapshot(scope, owner, snapshot);
        if (snapshot.state !== "ready") contextFail("MEMORY_CONTEXT_PERMIT_USED");
        if (body.requestDigest !== snapshot.requestDigest) contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
        const id = parseInternalId(body.permitId);
        if (command.kind === "permit") {
          this.save(scope, "permit", { ...owner, id, snapshotId: snapshot.id, state: "ready" });
          return { permitId: id };
        }
        const permit = this.read(scope, id, "permit", owner);
        if (permit.snapshotId !== snapshot.id || permit.state !== "ready") contextFail("MEMORY_CONTEXT_PERMIT_USED");
        const claimedAt = this.clock();
        if (!Number.isSafeInteger(body.attemptAt) || body.attemptAt < 0 || body.attemptAt > claimedAt || claimedAt - body.attemptAt > CONTEXT_CLAIM_WINDOW_MS) contextFail("MEMORY_RECALL_CLOCK_INVALID");
        new RecallRepository(this.db, this.key, this.clock, this.fault).prepareUseWithinTransaction(scope, { ...owner, bootId: parseInternalId(body.processBootId) }, parseInternalId(body.useTicketId), snapshot.recallDeps);
        permit.state = "claimed";
        snapshot.state = "claimed";
        this.save(scope, "permit", permit);
        this.save(scope, "snapshot", snapshot);
        return { claimed: true, claimedAt };
      }
      contextFail("MEMORY_CONTEXT_COMMAND_INVALID");
    };
    if (["baseline", "inspect", "validateSnapshot", "summaryGet", "summaryLeaseState"].includes(command.kind)) {
      if (command.commandId !== void 0) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = apply();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    return executeTransaction({ db: this.db, key: this.key, scope, commandId: parseInternalId(command.commandId), request: value, fault: this.fault, apply });
  }
};

// src/main/memory-core/repository.ts
var import_node_sqlite2 = require("node:sqlite");

// src/main/memory-core/database-auth.ts
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_crypto10 = require("node:crypto");
var MAGIC2 = Buffer.from("FMA1");
var HEADER2 = 28;
var MARKER = Buffer.from("FireflyMemoryDatabaseAuth-v1");
function decode(bytes, key) {
  if (bytes.length < HEADER2 + 40 || bytes.length > 256 || !bytes.subarray(0, 4).equals(MAGIC2)) throw new Error("MEMORY_AUTH_INVALID");
  if (bytes.readUInt32LE(4) !== 1 || bytes.readUInt32LE(8) !== 1) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  const id = bytes.subarray(12, 28).toString("hex");
  const value = openPayload(key, { recordType: "database-auth", id, schemaVersion: 1, keyVersion: 1 }, bytes.subarray(HEADER2));
  try {
    if (!value.equals(MARKER)) throw new Error("MEMORY_AUTH_FAILED");
  } finally {
    value.fill(0);
  }
  return id;
}
function read(file) {
  const stat = import_node_fs.default.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error("MEMORY_AUTH_INVALID");
  return import_node_fs.default.readFileSync(file);
}
function flush(file) {
  const fd = import_node_fs.default.openSync(file, "r+");
  try {
    import_node_fs.default.fsyncSync(fd);
  } finally {
    import_node_fs.default.closeSync(fd);
  }
}
function ensureDatabaseAuth(databasePath, key) {
  const file = databasePath + ".auth", pending = file + ".pending";
  if (import_node_fs.default.existsSync(file)) {
    const bytes2 = read(file), id2 = decode(bytes2, key);
    if (import_node_fs.default.existsSync(pending)) {
      const other = read(pending);
      decode(other, key);
      if (bytes2.length !== other.length || !(0, import_node_crypto10.timingSafeEqual)(bytes2, other)) throw new Error("MEMORY_AUTH_PUBLICATION_CONFLICT");
      flush(file);
      import_node_fs.default.unlinkSync(pending);
    }
    return id2;
  }
  if (["", "-wal", "-shm"].some((s) => import_node_fs.default.existsSync(databasePath + s))) throw new Error("MEMORY_AUTH_UNAVAILABLE");
  import_node_fs.default.mkdirSync(import_node_path.default.dirname(file), { recursive: true });
  if (!import_node_fs.default.existsSync(pending)) {
    const header = Buffer.alloc(HEADER2);
    MAGIC2.copy(header);
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(1, 8);
    (0, import_node_crypto10.randomBytes)(16).copy(header, 12);
    const id2 = header.subarray(12, 28).toString("hex"), bytes2 = Buffer.concat([header, sealPayload(key, { recordType: "database-auth", id: id2, schemaVersion: 1, keyVersion: 1 }, MARKER)]);
    const fd = import_node_fs.default.openSync(pending, "wx");
    try {
      import_node_fs.default.writeFileSync(fd, bytes2);
      import_node_fs.default.fsyncSync(fd);
    } finally {
      import_node_fs.default.closeSync(fd);
    }
  }
  const bytes = read(pending), id = decode(bytes, key);
  flush(pending);
  import_node_fs.default.linkSync(pending, file);
  flush(file);
  decode(read(file), key);
  import_node_fs.default.unlinkSync(pending);
  return id;
}

// src/main/memory-core/backups.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
var import_node_sqlite = require("node:sqlite");
function flush2(file) {
  const fd = import_node_fs2.default.openSync(file, "r+");
  try {
    import_node_fs2.default.fsyncSync(fd);
  } finally {
    import_node_fs2.default.closeSync(fd);
  }
}
async function createMemoryBackup(input) {
  try {
    internalId(input.backupId);
  } catch {
    throw new Error("MEMORY_BACKUP_INVALID");
  }
  if (process.platform !== "win32") throw new Error("MEMORY_WINDOWS_REQUIRED");
  if (ensureDatabaseAuth(input.databasePath, input.key) !== input.databaseId) throw new Error("MEMORY_DATABASE_AUTH_MISMATCH");
  const dataRoot = import_node_fs2.default.realpathSync.native(import_node_path2.default.dirname(input.databasePath)), root = import_node_path2.default.join(dataRoot, "backups");
  if (import_node_fs2.default.existsSync(root) && (import_node_fs2.default.lstatSync(root).isSymbolicLink() || import_node_fs2.default.realpathSync.native(root).toLowerCase() !== root.toLowerCase())) throw new Error("MEMORY_BACKUP_INVALID");
  import_node_fs2.default.mkdirSync(root, { recursive: true });
  const destination = import_node_path2.default.join(root, input.backupId);
  if (import_node_fs2.default.existsSync(destination)) throw new Error("MEMORY_BACKUP_EXISTS");
  const staging = import_node_fs2.default.mkdtempSync(import_node_path2.default.join(root, ".pending-")), database = import_node_path2.default.join(staging, "memory.sqlite");
  try {
    await (0, import_node_sqlite.backup)(input.db, database);
    const auth = import_node_fs2.default.readFileSync(input.databasePath + ".auth"), fd = import_node_fs2.default.openSync(database + ".auth", "wx");
    try {
      import_node_fs2.default.writeFileSync(fd, auth);
      import_node_fs2.default.fsyncSync(fd);
    } finally {
      import_node_fs2.default.closeSync(fd);
    }
    if (ensureDatabaseAuth(database, input.key) !== input.databaseId) throw new Error("MEMORY_DATABASE_AUTH_MISMATCH");
    flush2(database);
    import_node_fs2.default.renameSync(staging, destination);
    return { backupId: input.backupId };
  } finally {
    if (import_node_fs2.default.existsSync(staging)) {
      const stat = import_node_fs2.default.lstatSync(staging);
      if (stat.isSymbolicLink()) import_node_fs2.default.unlinkSync(staging);
      else if (import_node_fs2.default.realpathSync.native(staging).toLowerCase() === staging.toLowerCase()) import_node_fs2.default.rmSync(staging, { recursive: true, force: true });
    }
  }
}

// src/main/memory-core/schema.ts
function baseSchema(db, databaseId) {
  db.exec("CREATE TABLE memory_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), database_id TEXT NOT NULL, key_version INTEGER NOT NULL CHECK(key_version=1)) STRICT");
  db.prepare("INSERT INTO memory_metadata VALUES (1,?,1)").run(databaseId);
  for (const table of ENTITY_TABLES) {
    const parent = table === "candidates" ? "evidence" : table === "current_facts" ? "fact_revisions" : null;
    db.exec("CREATE TABLE " + table + " (id TEXT NOT NULL,scope_key TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),source_id TEXT,parent_id TEXT,state TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(id,scope_key),FOREIGN KEY(source_id,scope_key) REFERENCES sources(id,scope_key)" + (parent ? ",FOREIGN KEY(parent_id,scope_key) REFERENCES " + parent + "(id,scope_key)" : "") + ") STRICT");
  }
  db.exec("CREATE TABLE command_receipts (command_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,request_digest BLOB NOT NULL,result BLOB NOT NULL) STRICT");
}
function factSchema(db) {
  db.exec("ALTER TABLE fact_revisions ADD COLUMN fact_id TEXT; ALTER TABLE fact_revisions ADD COLUMN event_kind TEXT CHECK(event_kind IS NULL OR event_kind IN ('assertion','supersession','forget')); ALTER TABLE current_facts ADD COLUMN subject_index BLOB CHECK(subject_index IS NULL OR length(subject_index)=32)");
  db.exec("CREATE UNIQUE INDEX fact_revision_identity ON fact_revisions(scope_key,fact_id,revision,event_kind) WHERE fact_id IS NOT NULL; CREATE UNIQUE INDEX current_subject_identity ON current_facts(scope_key,subject_index) WHERE state='active' AND subject_index IS NOT NULL");
  db.exec("CREATE TRIGGER revisions_no_update BEFORE UPDATE ON fact_revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END; CREATE TRIGGER revisions_no_delete BEFORE DELETE ON fact_revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END");
  db.exec("CREATE TRIGGER revision_identity BEFORE INSERT ON fact_revisions WHEN NEW.event_kind IS NOT NULL AND (NEW.fact_id IS NULL OR (NEW.event_kind<>'assertion' AND NOT EXISTS(SELECT 1 FROM fact_revisions WHERE id=NEW.parent_id AND scope_key=NEW.scope_key AND fact_id=NEW.fact_id AND revision=NEW.revision AND event_kind='assertion'))) BEGIN SELECT RAISE(ABORT,'revision identity'); END");
  for (const operation of ["INSERT", "UPDATE"]) {
    db.exec("CREATE TRIGGER current_identity_" + operation + " BEFORE " + operation + " ON current_facts WHEN NEW.subject_index IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fact_revisions WHERE id=NEW.parent_id AND scope_key=NEW.scope_key AND fact_id=NEW.id AND revision=NEW.revision AND event_kind='assertion') BEGIN SELECT RAISE(ABORT,'current identity'); END");
  }
  for (const table of ENTITY_TABLES) for (const operation of ["INSERT", "UPDATE"]) {
    db.exec("CREATE TRIGGER state_" + table + "_" + operation + " BEFORE " + operation + " ON " + table + " WHEN NEW.state NOT IN ('recorded','proposed','active','superseded','forgotten','pending','running','complete','invalidated') BEGIN SELECT RAISE(ABORT,'unknown state'); END");
  }
}
function initializeSchema(db, databaseId) {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (![0, 1, 2, 3, 4, 5, 6, 7, 8].includes(version)) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  if (version !== 0) {
    const metadata2 = db.prepare("SELECT database_id,key_version FROM memory_metadata WHERE singleton=1").get();
    if (metadata2?.database_id !== databaseId || metadata2.key_version !== 1) throw new Error("MEMORY_DATABASE_AUTH_MISMATCH");
  }
  if (version === 0 || version === 1) {
    if (version === 0 && db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()?.n !== 0) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
    if (version === 1 && (db.prepare("SELECT count(*) AS n FROM fact_revisions").get()?.n !== 0 || db.prepare("SELECT count(*) AS n FROM current_facts").get()?.n !== 0)) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (version === 0) baseSchema(db, databaseId);
      factSchema(db);
      db.exec("PRAGMA user_version=2; COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (version === 0 || version === 1 || version === 2) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE scope_suppression (scope_key TEXT PRIMARY KEY,generation INTEGER NOT NULL CHECK(generation>=0),payload BLOB NOT NULL) STRICT; PRAGMA user_version=3; COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (version < 4) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE source_heads (scope_key TEXT NOT NULL,locator_index BLOB NOT NULL CHECK(length(locator_index)=32),source_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('ready','pending','deleted')),payload BLOB NOT NULL,PRIMARY KEY(scope_key,locator_index),UNIQUE(source_id,scope_key),FOREIGN KEY(source_id,scope_key) REFERENCES sources(id,scope_key)) STRICT; CREATE TABLE source_generations (scope_key TEXT NOT NULL,source_id TEXT NOT NULL,generation_index BLOB NOT NULL CHECK(length(generation_index)=32),PRIMARY KEY(scope_key,source_id,generation_index),FOREIGN KEY(source_id,scope_key) REFERENCES source_heads(source_id,scope_key)) STRICT; PRAGMA user_version=4; COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (version < 5) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE policy_records (id TEXT NOT NULL,scope_key TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT; PRAGMA user_version=5; COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (version < 6) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE fact_supports(id TEXT NOT NULL,scope_key TEXT NOT NULL,fact_id TEXT NOT NULL,fact_revision INTEGER NOT NULL CHECK(fact_revision>0),payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT; CREATE INDEX supports_by_fact ON fact_supports(scope_key,fact_id); CREATE TABLE fact_reviews(id TEXT NOT NULL,scope_key TEXT NOT NULL,fact_id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT; CREATE INDEX reviews_by_fact ON fact_reviews(scope_key,fact_id); PRAGMA user_version=6; COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (version < 7) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE context_records(id TEXT NOT NULL,scope_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('snapshot','permit','transcript','summary-lease','summary')),revision INTEGER NOT NULL CHECK(revision>0),payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT;CREATE INDEX context_records_by_kind ON context_records(scope_key,kind);PRAGMA user_version=7;COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (version < 8) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE recall_records(id TEXT NOT NULL,scope_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('policy','state','use')),revision INTEGER NOT NULL CHECK(revision>0),payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT;CREATE INDEX recall_records_by_kind ON recall_records(scope_key,kind);PRAGMA user_version=8;COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const metadata = db.prepare("SELECT database_id,key_version FROM memory_metadata WHERE singleton=1").get();
  if (metadata?.database_id !== databaseId || metadata.key_version !== 1) throw new Error("MEMORY_DATABASE_AUTH_MISMATCH");
}

// src/main/memory-core/repository.ts
var STATES = /* @__PURE__ */ new Set(["recorded", "proposed", "active", "superseded", "forgotten", "pending", "running", "complete", "invalidated"]);
var MemoryRepository = class {
  constructor(db, key, databasePath, databaseId, fault, clock2 = Date.now) {
    this.db = db;
    this.key = key;
    this.databasePath = databasePath;
    this.databaseId = databaseId;
    this.fault = fault;
    this.clock = clock2;
  }
  db;
  key;
  databasePath;
  databaseId;
  fault;
  clock;
  closed = false;
  assertOpen() {
    if (this.closed) throw new Error("MEMORY_REPOSITORY_CLOSED");
  }
  binding(table, scope, id) {
    return { recordType: table, id: JSON.stringify([scope, id]), schemaVersion: 1, keyVersion: 1 };
  }
  seal(table, scope, id, payload) {
    const bytes = Buffer.from(canonicalJson(payload));
    try {
      return sealPayload(this.key, this.binding(table, scope, id), bytes);
    } finally {
      bytes.fill(0);
    }
  }
  open(table, scope, id, bytes) {
    const plain = openPayload(this.key, this.binding(table, scope, id), bytes);
    try {
      return JSON.parse(plain.toString("utf8"));
    } finally {
      plain.fill(0);
    }
  }
  jobCommand(command) {
    this.assertOpen();
    return new JobRepository(this.db, this.key, this.clock, this.fault).execute(command);
  }
  policyCommand(command) {
    this.assertOpen();
    return new PolicyRepository(this.db, this.key, this.fault).execute(command);
  }
  contextCommand(command) {
    this.assertOpen();
    return new ContextRepository(this.db, this.key, this.fault, this.clock).execute(command);
  }
  recallCommand(command) {
    this.assertOpen();
    return new RecallRepository(this.db, this.key, this.clock, this.fault).execute(command);
  }
  sourceCommand(command) {
    this.assertOpen();
    return new SourceLedger(this.db, this.key, this.fault).execute(command);
  }
  execute(command) {
    this.assertOpen();
    return new FactRepository(this.db, this.key, this.fault).execute(command);
  }
  current(scope) {
    this.assertOpen();
    return new FactRepository(this.db, this.key, this.fault).current(scope);
  }
  history(scope, factId) {
    this.assertOpen();
    return new FactRepository(this.db, this.key, this.fault).history(scope, factId);
  }
  writeBatch(command) {
    this.assertOpen();
    internalId(command?.commandId);
    internalId(command.scopeKey);
    if (!Array.isArray(command.records) || command.records.length === 0 || command.records.length > 1e3) throw new Error("MEMORY_INPUT_INVALID");
    return executeTransaction({ db: this.db, key: this.key, scope: command.scopeKey, commandId: command.commandId, request: command, fault: this.fault, apply: () => {
      for (const row of command.records) {
        entityTable(row.table);
        internalId(row.id);
        if (!Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error("MEMORY_INPUT_INVALID");
        if (row.sourceId !== void 0) internalId(row.sourceId);
        if (row.parentId !== void 0) internalId(row.parentId);
        const payloadRef = row.payload && typeof row.payload === "object" ? row.payload.sourceRef : void 0;
        const sourceIds = [row.sourceId, row.table === "sources" ? row.id : void 0, payloadRef && typeof payloadRef.sourceId === "string" ? payloadRef.sourceId : void 0];
        const ledger = new SourceLedger(this.db, this.key);
        if (sourceIds.some((id) => id !== void 0 && ledger.isManaged(command.scopeKey, id))) throw new Error("MEMORY_SOURCE_MANAGED");
        const state = row.state ?? "recorded";
        if (!STATES.has(state)) throw new Error("MEMORY_INPUT_INVALID");
        this.db.prepare("INSERT INTO " + row.table + " (id,scope_key,revision,source_id,parent_id,state,payload) VALUES (?,?,?,?,?,?,?)").run(row.id, command.scopeKey, row.revision, row.sourceId ?? null, row.parentId ?? null, state, this.seal(row.table, command.scopeKey, row.id, row.payload));
        this.fault?.("after-record");
      }
      return { inserted: command.records.length };
    } });
  }
  readRows(table, scopeKey) {
    this.assertOpen();
    entityTable(table);
    internalId(scopeKey);
    return this.db.prepare(`SELECT id,revision,source_id,parent_id,state,payload FROM ${table} WHERE scope_key=? ORDER BY id`).all(scopeKey).map((row) => ({
      id: row.id,
      revision: row.revision,
      sourceId: row.source_id,
      parentId: row.parent_id,
      state: row.state,
      payload: this.open(table, scopeKey, row.id, row.payload)
    }));
  }
  async backup(backupId = (0, import_node_crypto11.randomUUID)()) {
    this.assertOpen();
    return createMemoryBackup({ db: this.db, databasePath: this.databasePath, key: this.key, databaseId: this.databaseId, backupId });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.key.fill(0);
    }
  }
};
function openMemoryRepository(input) {
  if (!import_node_path3.default.isAbsolute(input.databasePath) || !(input.key instanceof Uint8Array) || input.key.length !== 32) throw new Error("MEMORY_INPUT_INVALID");
  const databaseId = ensureDatabaseAuth(input.databasePath, input.key);
  const key = Buffer.from(input.key);
  let db;
  try {
    db = new import_node_sqlite2.DatabaseSync(input.databasePath, { enableForeignKeyConstraints: true, allowExtension: false });
    initializeSchema(db, databaseId);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    return new MemoryRepository(db, key, input.databasePath, databaseId, input.fault, input.clock);
  } catch (error) {
    db?.close();
    key.fill(0);
    throw error;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MemoryRepository,
  openMemoryRepository
});
