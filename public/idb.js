// @ts-check
/**
 * idb.js —— 极简 IndexedDB KV 存储（讲义页配图 / 批注 / 画笔）
 *
 * 为什么不用 localStorage：配图 dataURL 约 400K 字符、批注快照上限 1.2M 字符，
 * localStorage 总配额通常只有 ~5MB（约 12 张图或 4 份批注就写满），且写满后
 * 同步 setItem 会直接抛错。IndexedDB 配额大（通常为磁盘配额的数十分之一）、
 * 异步不阻塞主线程，且天然可存 Blob。
 *
 * 可靠性策略：
 *  · 所有 API 失败都回传 false / null，不抛异常——调用方按"降级"处理；
 *  · 读取路径兼容 localStorage 旧数据（get 找不到时回退读旧键，读到即回填 IDB）；
 *  · migrateLegacy() 一次性把 localStorage 里的 lecture-img-* / lecture-draw-* /
 *    lecture-brush-* 迁进 IDB 并删除旧键（幂等：没有旧键就是空操作）。
 */

const DB_NAME = "vocab-ui";
const STORE = "kv";
const LS_PREFIXES = ["lecture-img-", "lecture-draw-", "lecture-brush-"];

/** @type {IDBDatabase | null} */
let dbPromise = null;
/** @type {Promise<IDBDatabase> | null} */
let opening = null;

export const idbAvailable = typeof indexedDB !== "undefined";

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  if (dbPromise) return Promise.resolve(dbPromise);
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (!idbAvailable) {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      dbPromise = req.result;
      resolve(req.result);
    };
    req.onerror = () => reject(req.error || new Error("idb open failed"));
  }).finally(() => {
    opening = null;
  });
  return opening;
}

/**
 * @param {"readonly"|"readwrite"} mode
 * @param {(store: IDBObjectStore) => IDBRequest} run
 */
async function tx(mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let result;
    let settled = false;
    const fail = (event) => {
      if (settled) return;
      settled = true;
      const error = event?.target?.error || event?.error;
      reject(error instanceof Error ? error : new Error("idb transaction failed"));
    };
    try {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      req.onsuccess = () => {
        result = req.result;
      };
      req.onerror = fail;
      // A successful request is not enough for a write: the transaction can
      // still abort (quota/connection loss).  Report success only after the
      // transaction commits so callers can keep their localStorage fallback.
      t.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      t.onerror = fail;
      t.onabort = fail;
    } catch (error) {
      fail({ error });
    }
  });
}

/**
 * 读取（IDB → 无则回退 localStorage 旧键并回填）
 * @param {string} key
 * @returns {Promise<string | null>}
 */
export async function idbGet(key) {
  try {
    const v = await tx("readonly", (s) => s.get(key));
    if (typeof v === "string") return v;
  } catch {
    /* 降级到 localStorage */
  }
  try {
    const legacy = localStorage.getItem(key);
    if (legacy !== null) {
      // 迁移与回填必须在同一个 readwrite 事务中完成，避免 get/put 分离产生 TOCTOU。
      const seeded = await new Promise((resolve) => {
        void openDb().then((db) => {
          const t = db.transaction(STORE, "readwrite");
          const store = t.objectStore(STORE);
          const req = store.get(key);
          req.onsuccess = () => {
            if (typeof req.result === "string") {
              resolve(req.result);
              return;
            }
            const put = store.put(legacy, key);
            put.onsuccess = () => resolve(legacy);
            put.onerror = () => resolve(legacy);
          };
          req.onerror = () => resolve(null);
        }).catch(() => resolve(null));
      });
      if (typeof seeded === "string") return seeded;
      // IndexedDB 不可用或事务失败时仍保留 localStorage 作为可读降级。
      return legacy;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 写入；失败返回 false（调用方可降级提示）
 * @param {string} key @param {string} value
 */
export async function idbPut(key, value) {
  try {
    await tx("readwrite", (s) => s.put(value, key));
    return true;
  } catch {
    return false;
  }
}

/** @param {string} key */
export async function idbDel(key) {
  try {
    await tx("readwrite", (s) => s.delete(key));
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出某前缀下的全部 key（替代"扫 localStorage 键名"的存在性索引）
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
export async function idbKeys(prefix) {
  try {
    const keys = await tx("readonly", (s) => s.getAllKeys());
    return (/** @type {IDBValidKey[]} */ (keys) || [])
      .map(String)
      .filter((k) => k.startsWith(prefix));
  } catch {
    return [];
  }
}

/**
 * 一次性迁移：localStorage → IDB（幂等）。
 * 返回迁移的键数；任何异常都吞掉（下次启动会再试）。
 */
/**
 * 将一个旧键以 compare-and-set 方式迁入 IDB：已有 canonical 值时不覆盖。
 * @param {string} key @param {string} value
 * @returns {Promise<boolean>}
 */
async function migrateOneLegacyKey(key, value) {
  try {
    return await new Promise((resolve) => {
      let result = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      void openDb()
        .then((db) => {
          const t = db.transaction(STORE, "readwrite");
          const store = t.objectStore(STORE);
          const req = store.get(key);
          req.onsuccess = () => {
            if (typeof req.result === "string") {
              result = true;
              return;
            }
            const put = store.put(value, key);
            put.onsuccess = () => {
              result = true;
            };
            put.onerror = () => {
              result = false;
            };
          };
          req.onerror = () => {
            result = false;
          };
          t.oncomplete = finish;
          t.onerror = finish;
          t.onabort = finish;
        })
        .catch(() => finish());
    });
  } catch {
    return false;
  }
}

export async function migrateLegacy() {
  if (!idbAvailable) return 0;
  let moved = 0;
  try {
    const toMove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && LS_PREFIXES.some((p) => key.startsWith(p))) toMove.push(key);
    }
    for (const key of toMove) {
      const value = localStorage.getItem(key);
      if (value === null) continue;
      const migrated = await migrateOneLegacyKey(key, value);
      if (migrated && localStorage.getItem(key) === value) {
        localStorage.removeItem(key);
        moved++;
      }
    }
  } catch {
    /* 迁移失败不影响使用：get 仍会回退读旧键 */
  }
  return moved;
}
