import { requireSupabase, supabase, IS_SUPABASE_CONFIGURED } from './supabase';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface DatabaseErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
}

export const db = { __supabaseDb: true as const };
export type SupabaseDbHandle = typeof db;

export interface CollectionReference {
  type: 'collection';
  table: string;
  path: string;
}

export interface DocumentReference {
  type: 'doc';
  table: string;
  id: string;
  path: string;
}

export interface WhereConstraint {
  type: 'where';
  field: string;
  op: '==' | 'in' | '>=' | '<=' | '>' | '<';
  value: unknown;
}

export interface QueryReference {
  type: 'query';
  table: string;
  path: string;
  constraints: WhereConstraint[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DocumentData = Record<string, any>;

export interface DocumentSnapshot<T = DocumentData> {
  id: string;
  exists: () => boolean;
  data: () => T | undefined;
  metadata: { fromCache: boolean };
}

export interface QueryDocumentSnapshot<T = DocumentData> {
  id: string;
  data: () => T;
}

export interface QuerySnapshot<T = DocumentData> {
  docs: QueryDocumentSnapshot<T>[];
  empty: boolean;
  size: number;
}

const SERVER_TIMESTAMP_SENTINEL = { __serverTimestamp: true } as const;
const DELETE_FIELD_SENTINEL = { __deleteField: true } as const;

export function serverTimestamp(): unknown {
  return SERVER_TIMESTAMP_SENTINEL;
}

export function deleteField(): unknown {
  return DELETE_FIELD_SENTINEL;
}

function isServerTimestampSentinel(val: unknown): boolean {
  return Boolean(
    val && typeof val === 'object' && (val as { __serverTimestamp?: boolean }).__serverTimestamp === true
  );
}

function isDeleteFieldSentinel(val: unknown): boolean {
  return Boolean(
    val && typeof val === 'object' && (val as { __deleteField?: boolean }).__deleteField === true
  );
}

function getPrimaryKeyColumn(table: string): string {
  return table === 'users' || table === 'staff_directory' ? 'uid' : 'id';
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

const DATE_OR_TIMESTAMP_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'verifiedAt',
  'handoverSignedAt',
  'receivedSignedAt',
  'reviewedAt',
  'nurseSignedAt',
  'karuSignedAt',
]);

function normalizeValueForWrite(key: string, value: unknown): unknown {
  if (isServerTimestampSentinel(value)) {
    return new Date().toISOString();
  }
  if (isDeleteFieldSentinel(value)) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (
    DATE_OR_TIMESTAMP_KEYS.has(key) &&
    value &&
    typeof value === 'object' &&
    typeof (value as { toDate?: () => Date }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (value === undefined) {
    return undefined;
  }
  return value;
}

function mapPayloadToRow(
  table: string,
  payload: Record<string, unknown>,
  docId?: string
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const pkCol = getPrimaryKeyColumn(table);

  for (const [key, rawVal] of Object.entries(payload)) {
    const normalized = normalizeValueForWrite(key, rawVal);
    if (normalized === undefined) continue;
    row[camelToSnake(key)] = normalized;
  }

  if (docId && !(pkCol in row)) {
    row[pkCol] = docId;
  }

  return row;
}

function mapRowToDoc(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [col, val] of Object.entries(row)) {
    if (val === null) continue;
    obj[snakeToCamel(col)] = val;
  }
  const pkCol = getPrimaryKeyColumn(table);
  if (pkCol === 'id' && typeof row.id === 'string') {
    obj.id = row.id;
  }
  if (pkCol === 'uid' && typeof row.uid === 'string') {
    obj.uid = row.uid;
  }
  return obj;
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function collection(_db: SupabaseDbHandle, table: string): CollectionReference {
  return { type: 'collection', table, path: table };
}

export function doc(
  target: SupabaseDbHandle | CollectionReference,
  tableOrId?: string,
  maybeId?: string
): DocumentReference {
  if ('type' in target && target.type === 'collection') {
    const id = tableOrId || generateId();
    return { type: 'doc', table: target.table, id, path: `${target.table}/${id}` };
  }
  if (!tableOrId) {
    throw new Error('Nama tabel wajib diisi pada doc(db, table, id).');
  }
  const id = maybeId || generateId();
  return { type: 'doc', table: tableOrId, id, path: `${tableOrId}/${id}` };
}

export function where(
  field: string,
  op: '==' | 'in' | '>=' | '<=' | '>' | '<',
  value: unknown
): WhereConstraint {
  return { type: 'where', field, op, value };
}

export function query(
  colRef: CollectionReference,
  ...constraints: WhereConstraint[]
): QueryReference {
  return {
    type: 'query',
    table: colRef.table,
    path: colRef.path,
    constraints,
  };
}

function applyWhereConstraints<T extends { eq: any; in: any; gte: any; lte: any; gt: any; lt: any }>(
  builder: T,
  constraints: WhereConstraint[]
): T {
  let q = builder;
  for (const c of constraints) {
    const col = camelToSnake(c.field);
    if (c.op === '==') {
      q = q.eq(col, c.value);
    } else if (c.op === 'in' && Array.isArray(c.value)) {
      q = q.in(col, c.value);
    } else if (c.op === '>=') {
      q = q.gte(col, c.value);
    } else if (c.op === '<=') {
      q = q.lte(col, c.value);
    } else if (c.op === '>') {
      q = q.gt(col, c.value);
    } else if (c.op === '<') {
      q = q.lt(col, c.value);
    }
  }
  return q;
}

function matchesConstraints(docData: Record<string, unknown>, constraints: WhereConstraint[]): boolean {
  for (const c of constraints) {
    const val = docData[c.field];
    if (c.op === '==') {
      if (val !== c.value) return false;
    } else if (c.op === 'in') {
      if (!Array.isArray(c.value) || !c.value.includes(val)) return false;
    } else if (c.op === '>=') {
      if (val === undefined || val === null || String(val) < String(c.value)) return false;
    } else if (c.op === '<=') {
      if (val === undefined || val === null || String(val) > String(c.value)) return false;
    } else if (c.op === '>') {
      if (val === undefined || val === null || String(val) <= String(c.value)) return false;
    } else if (c.op === '<') {
      if (val === undefined || val === null || String(val) >= String(c.value)) return false;
    }
  }
  return true;
}

function wrapSupabaseError(error: { code?: string; message?: string; details?: string }): Error & {
  code?: string;
} {
  const pgCode = String(error.code || '');
  const msg = error.message || 'Terjadi kesalahan operasi database.';
  const err = new Error(msg) as Error & { code?: string };

  if (pgCode === '42501' || msg.toLowerCase().includes('row-level security')) {
    err.code = 'permission-denied';
  } else if (pgCode === '23505') {
    err.code = 'already-exists';
  } else if (pgCode === 'PGRST116') {
    err.code = 'not-found';
  } else {
    err.code = pgCode || 'unknown';
  }
  return err;
}

export async function getDoc<T = DocumentData>(
  docRef: DocumentReference
): Promise<DocumentSnapshot<T>> {
  const client = requireSupabase();
  if (docRef.table === 'test') {
    return {
      id: docRef.id,
      exists: () => false,
      data: () => undefined,
      metadata: { fromCache: false },
    };
  }
  const pkCol = getPrimaryKeyColumn(docRef.table);
  const { data, error } = await client
    .from(docRef.table)
    .select('*')
    .eq(pkCol, docRef.id)
    .maybeSingle();

  if (error) {
    throw wrapSupabaseError(error);
  }
  if (!data) {
    return {
      id: docRef.id,
      exists: () => false,
      data: () => undefined,
      metadata: { fromCache: false },
    };
  }
  const mapped = mapRowToDoc(docRef.table, data as Record<string, unknown>) as T;
  return {
    id: docRef.id,
    exists: () => true,
    data: () => mapped,
    metadata: { fromCache: false },
  };
}

export const getDocFromServer = getDoc;

export async function setDoc(
  docRef: DocumentReference,
  payload: Record<string, unknown>,
  options?: { merge?: boolean }
): Promise<void> {
  const client = requireSupabase();
  const row = mapPayloadToRow(docRef.table, payload, docRef.id);
  const pkCol = getPrimaryKeyColumn(docRef.table);

  if (options?.merge) {
    const existing = await getDoc(docRef);
    if (existing.exists()) {
      const { error } = await client.from(docRef.table).update(row).eq(pkCol, docRef.id);
      if (error) throw wrapSupabaseError(error);
      return;
    }
  }

  const { error } = await client
    .from(docRef.table)
    .upsert(row, { onConflict: pkCol });
  if (error) {
    throw wrapSupabaseError(error);
  }
}

export async function addDoc(
  colRef: CollectionReference,
  payload: Record<string, unknown>
): Promise<DocumentReference> {
  const newId = typeof payload.id === 'string' && payload.id ? payload.id : generateId();
  const docRef = doc(colRef, newId);
  const nowIso = new Date().toISOString();
  const enrichedPayload: Record<string, unknown> = {
    createdAt: nowIso,
    updatedAt: nowIso,
    ...payload,
  };
  await setDoc(docRef, enrichedPayload);
  return docRef;
}

export async function updateDoc(
  docRef: DocumentReference,
  payload: Record<string, unknown>
): Promise<void> {
  const client = requireSupabase();
  const row = mapPayloadToRow(docRef.table, payload);
  const pkCol = getPrimaryKeyColumn(docRef.table);
  delete row[pkCol];
  if (!('updated_at' in row)) {
    row.updated_at = new Date().toISOString();
  }
  const { error } = await client.from(docRef.table).update(row).eq(pkCol, docRef.id);
  if (error) {
    throw wrapSupabaseError(error);
  }
}

export async function deleteDoc(docRef: DocumentReference): Promise<void> {
  const client = requireSupabase();
  const pkCol = getPrimaryKeyColumn(docRef.table);
  const { error } = await client.from(docRef.table).delete().eq(pkCol, docRef.id);
  if (error) {
    throw wrapSupabaseError(error);
  }
}

type BatchOp =
  | { kind: 'set'; ref: DocumentReference; data: Record<string, unknown>; merge?: boolean }
  | { kind: 'update'; ref: DocumentReference; data: Record<string, unknown> }
  | { kind: 'delete'; ref: DocumentReference };

export function writeBatch(_db: SupabaseDbHandle) {
  const ops: BatchOp[] = [];
  return {
    set(ref: DocumentReference, data: Record<string, unknown>, options?: { merge?: boolean }) {
      ops.push({ kind: 'set', ref, data, merge: options?.merge });
    },
    update(ref: DocumentReference, data: Record<string, unknown>) {
      ops.push({ kind: 'update', ref, data });
    },
    delete(ref: DocumentReference) {
      ops.push({ kind: 'delete', ref });
    },
    async commit() {
      const client = requireSupabase();
      const bulkUpserts = new Map<string, Record<string, unknown>[]>();
      const otherOps: BatchOp[] = [];

      for (const op of ops) {
        if (op.kind === 'set' && !op.merge) {
          const list = bulkUpserts.get(op.ref.table) || [];
          list.push(mapPayloadToRow(op.ref.table, op.data, op.ref.id));
          bulkUpserts.set(op.ref.table, list);
        } else {
          otherOps.push(op);
        }
      }

      for (const [table, rows] of bulkUpserts.entries()) {
        if (rows.length === 0) continue;
        const pkCol = getPrimaryKeyColumn(table);
        const { error } = await client.from(table).upsert(rows, { onConflict: pkCol });
        if (error) throw wrapSupabaseError(error);
      }

      for (const op of otherOps) {
        if (op.kind === 'set') {
          await setDoc(op.ref, op.data, { merge: op.merge });
        } else if (op.kind === 'update') {
          await updateDoc(op.ref, op.data);
        } else if (op.kind === 'delete') {
          await deleteDoc(op.ref);
        }
      }
    },
  };
}

export async function runTransaction<T>(
  _db: SupabaseDbHandle,
  updateFunction: (tx: {
    get: (ref: DocumentReference) => Promise<DocumentSnapshot>;
    set: (ref: DocumentReference, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
    update: (ref: DocumentReference, data: Record<string, unknown>) => void;
    delete: (ref: DocumentReference) => void;
  }) => Promise<T>
): Promise<T> {
  const ops: BatchOp[] = [];
  const tx = {
    get(ref: DocumentReference) {
      return getDoc(ref);
    },
    set(ref: DocumentReference, data: Record<string, unknown>, options?: { merge?: boolean }) {
      ops.push({ kind: 'set', ref, data, merge: options?.merge });
    },
    update(ref: DocumentReference, data: Record<string, unknown>) {
      ops.push({ kind: 'update', ref, data });
    },
    delete(ref: DocumentReference) {
      ops.push({ kind: 'delete', ref });
    },
  };

  const result = await updateFunction(tx);
  for (const op of ops) {
    if (op.kind === 'set') {
      await setDoc(op.ref, op.data, { merge: op.merge });
    } else if (op.kind === 'update') {
      await updateDoc(op.ref, op.data);
    } else if (op.kind === 'delete') {
      await deleteDoc(op.ref);
    }
  }
  return result;
}

let channelSeq = 0;

export function onSnapshot<T = DocumentData>(
  target: DocumentReference,
  onNext: (snapshot: DocumentSnapshot<T>) => void,
  onError?: (error: Error) => void
): () => void;
export function onSnapshot<T = DocumentData>(
  target: CollectionReference | QueryReference,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: Error) => void
): () => void;
export function onSnapshot<T = DocumentData>(
  target: DocumentReference | CollectionReference | QueryReference,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onNext: (snapshot: any) => void,
  onError?: (error: Error) => void
): () => void {
  const client = requireSupabase();
  let disposed = false;
  const table = target.table;
  const pkCol = getPrimaryKeyColumn(table);
  const channelName = `hemolog_${table}_${++channelSeq}`;

  if (target.type === 'doc') {
    let currentDoc: Record<string, unknown> | null = null;
    const emitDoc = () => {
      if (disposed) return;
      onNext({
        id: target.id,
        exists: () => currentDoc !== null,
        data: () => (currentDoc ? ({ ...currentDoc } as T) : undefined),
        metadata: { fromCache: false },
      } as DocumentSnapshot<T>);
    };

    void getDoc<T>(target)
      .then((snap) => {
        if (disposed) return;
        currentDoc = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
        emitDoc();
      })
      .catch((err) => {
        if (!disposed) onError?.(err instanceof Error ? err : new Error(String(err)));
      });

    const channel = client
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `${pkCol}=eq.${target.id}` },
        (payload) => {
          if (disposed) return;
          if (payload.eventType === 'DELETE') {
            currentDoc = null;
          } else if (payload.new && typeof payload.new === 'object') {
            currentDoc = mapRowToDoc(table, payload.new as Record<string, unknown>);
          }
          emitDoc();
        }
      )
      .subscribe();

    return () => {
      disposed = true;
      void client.removeChannel(channel);
    };
  }

  const constraints = target.type === 'query' ? target.constraints : [];
  let rowMap = new Map<string, Record<string, unknown>>();

  const emitQuery = () => {
    if (disposed) return;
    const docs = Array.from(rowMap.entries()).map(([id, item]) => ({
      id,
      data: () => ({ ...item } as T),
    }));
    onNext({
      docs,
      empty: docs.length === 0,
      size: docs.length,
    } as QuerySnapshot<T>);
  };

  const fetchInitial = async () => {
    try {
      const baseQuery = client.from(table).select('*');
      const filtered = applyWhereConstraints(baseQuery, constraints);
      const { data, error } = await filtered;
      if (error) throw wrapSupabaseError(error);
      if (disposed) return;
      const nextMap = new Map<string, Record<string, unknown>>();
      for (const rawRow of (data || []) as Record<string, unknown>[]) {
        const mapped = mapRowToDoc(table, rawRow);
        const pk = String(rawRow[pkCol] ?? mapped.id ?? mapped.uid ?? '');
        if (pk) nextMap.set(pk, mapped);
      }
      rowMap = nextMap;
      emitQuery();
    } catch (err) {
      if (!disposed) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  void fetchInitial();

  const channel = client
    .channel(channelName)
    .on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
      if (disposed) return;
      if (payload.eventType === 'DELETE') {
        const oldRow = (payload.old || {}) as Record<string, unknown>;
        const pk = String(oldRow[pkCol] ?? oldRow.id ?? oldRow.uid ?? '');
        if (pk && rowMap.has(pk)) {
          rowMap.delete(pk);
          emitQuery();
        }
        return;
      }

      if (payload.new && typeof payload.new === 'object') {
        const rawNew = payload.new as Record<string, unknown>;
        const mapped = mapRowToDoc(table, rawNew);
        const pk = String(rawNew[pkCol] ?? mapped.id ?? mapped.uid ?? '');
        if (!pk) return;

        if (matchesConstraints(mapped, constraints)) {
          rowMap.set(pk, mapped);
          emitQuery();
        } else if (rowMap.has(pk)) {
          rowMap.delete(pk);
          emitQuery();
        }
      }
    })
    .subscribe();

  return () => {
    disposed = true;
    void client.removeChannel(channel);
  };
}

// ============================================================================
// Error & Connection Helpers
// ============================================================================

export function formatDbError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): string {
  const errInfo: DatabaseErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
  };
  const json = JSON.stringify(errInfo);
  console.error('Database Error: ', json);
  return json;
}

export function handleDbError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  throw new Error(formatDbError(error, operationType, path));
}

export function isTransientDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code || '').toLowerCase();
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String((error as { message?: unknown }).message || '').toLowerCase();

  if (code === 'permission-denied' || code === '42501') return false;
  return (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network request failed') ||
    message.includes('timeout') ||
    message.includes('econnreset')
  );
}

export function isPermissionDeniedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code || '').toLowerCase();
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String((error as { message?: unknown }).message || '').toLowerCase();
  return (
    code === 'permission-denied' ||
    code === '42501' ||
    message.includes('permission denied') ||
    message.includes('row-level security')
  );
}

export function getUserFriendlyDbError(
  error: unknown,
  fallbackMessage: string
): string {
  if (isPermissionDeniedError(error)) {
    return 'Akses penyimpanan ditolak (RLS). Pastikan akun Anda aktif, memiliki peran yang sesuai, dan kebijakan RLS di supabase/schema.sql sudah dijalankan.';
  }
  if (isTransientDbError(error)) {
    return 'Koneksi ke server Supabase sedang terganggu. Periksa jaringan internet Anda lalu coba simpan kembali.';
  }
  const code = String((error as { code?: unknown })?.code || '').toLowerCase();
  if (code === 'already-exists' || code === '23505') {
    return 'Data atau kunci slot sudah digunakan oleh entri lain.';
  }
  if (code === 'not-found') {
    return 'Data tujuan tidak ditemukan di server. Muat ulang halaman lalu coba simpan kembali.';
  }
  return fallbackMessage;
}

export type ReconnectReason = 'online' | 'visibilitychange' | 'focus' | 'error' | 'manual';

export interface ReconnectEvent {
  reason: ReconnectReason;
  shouldResubscribe: boolean;
}

export interface ReconnectOptions {
  force?: boolean;
  hardReset?: boolean;
  resubscribe?: boolean;
  reason?: ReconnectReason;
}

const reconnectListeners = new Set<(event: ReconnectEvent) => void>();

export function onDbReconnect(listener: (event: ReconnectEvent) => void): () => void {
  reconnectListeners.add(listener);
  return () => {
    reconnectListeners.delete(listener);
  };
}

export async function testConnection(): Promise<boolean> {
  if (!IS_SUPABASE_CONFIGURED || !supabase) return false;
  try {
    const { error } = await supabase.from('form_templates').select('id').limit(1);
    if (error && isTransientDbError(error)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function reconnectDb(
  forceOrOptions: boolean | ReconnectOptions = false
): Promise<void> {
  const opts: ReconnectOptions =
    typeof forceOrOptions === 'boolean'
      ? { force: forceOrOptions, resubscribe: true, reason: forceOrOptions ? 'manual' : 'focus' }
      : forceOrOptions;
  const reason: ReconnectReason = opts.reason ?? (opts.force ? 'manual' : 'focus');
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  reconnectListeners.forEach((cb) => {
    try {
      cb({ reason, shouldResubscribe: opts.resubscribe ?? true });
    } catch {
      // Ignore callback error
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void reconnectDb({ force: true, resubscribe: true, reason: 'online' });
  });
}
